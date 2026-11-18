/**
 * Subcommand entry for `snapper-mcp watch`.
 *
 * Connects to the Snapper backend's WebSocket endpoint, subscribes to
 * the configured topic prefixes, and writes one JSONL frame (or client
 * wake notice) per line to stdout.
 */

import type { WritableStream } from "node:stream/web";
import type { Writable } from "node:stream";

import {
  classifyActionableFrame,
  DEFAULT_WAKE_KINDS,
  formatClientAttentionLine,
  KIMI_EXIT_ATTENTION,
  KIMI_EXIT_DISABLED,
  KIMI_EXIT_DUPLICATE,
  KIMI_EXIT_EXPIRED,
  KIMI_EXIT_FAILED,
  KIMI_OUTCOME_LINES,
  parseWakeKind,
  SNAPPER_COPILOT_ATTENTION_LINE,
  SNAPPER_KIMI_ATTENTION_LINE,
  type WakeKind,
} from "./actionable.js";
import { ClientArgError, parseClientName, type ClientName } from "./clients.js";
import {
  computeWsUrl,
  loadConfigFile,
  parseCliFlags,
  redactCliArg,
  redactToken,
  resolveBridgeEnv,
  type BridgeEnv,
  type CliFlags,
  type ConfigFile,
} from "./env.js";
import { EnvelopeMinter } from "./envelope.js";
import { EnvValidationError } from "./errors.js";
import { inspectParentProcess, type ParentProcessInspector } from "./interactive.js";
import { createLogger, writeStderr, type Logger } from "./logger.js";
import {
  acquireSessionLock,
  defaultConfigFilePath,
  defaultIsPidAlive,
  readWakePreference,
  resolveStateDir,
  StateRecoveryRequiredError,
  type SessionLockHandle,
} from "./state_dir.js";
import { TokenStore } from "./token_store.js";
import type { AiReviewRequestFrame, ServerFrame } from "./types.js";
import {
  runAntigravityWakeCommand,
  type AntigravityWakeOptions,
} from "./wake_workers.js";
import {
  claimKimiWatcherStart,
  recordKimiWatcherFinish,
} from "./wake_state.js";
import { fetchWsToken, type WsTokenResult } from "./ws_token.js";
import {
  createWsClient,
  type WsClient,
  type WsClientOptions,
} from "./ws_client.js";

interface BuildTimeGlobals {
  readonly __PKG_NAME__?: unknown;
}

export function resolvePackageName(global: unknown): string {
  return typeof global === "string" ? global : "@mateusz-klatt/snapper-mcp";
}

const CLIENT_NAME = resolvePackageName(
  (globalThis as BuildTimeGlobals).__PKG_NAME__,
);

const DEFAULT_TOPICS: readonly string[] = [
  "signals.",
  "orders.events.",
  "ai_reviews.",
  "ai_research.",
];

const AUTH_ME_TIMEOUT_MS = 10_000;
const AI_REVIEW_FANOUT_AFTER_MS = 30_000;
const DEFAULT_ONCE_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export class WatchArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchArgsError";
  }
}

export interface WatchArgs {
  readonly topics: readonly string[];
  readonly flags: CliFlags;
  readonly client: ClientName | null;
  readonly once: boolean;
  readonly wake: boolean;
  readonly actionableOnly: boolean;
  readonly allFrames: boolean;
  readonly wakeKinds: ReadonlySet<WakeKind>;
}

export interface WatchOptions {
  readonly source?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly stdout?: Pick<Writable, "write"> | Pick<WritableStream, "getWriter">;
  readonly install?: boolean;
  readonly wsClientFactory?: (opts: WsClientOptions) => WsClient;
  readonly signalSource?: SignalSource;
  readonly onceLifetimeMs?: number;
  readonly sessionKey?: string;
  readonly pid?: number;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly inspector?: ParentProcessInspector;
  readonly antigravityOverrides?: Partial<AntigravityWakeOptions>;
}

interface JsonlSink {
  write(line: string): void;
}

export interface SignalSource {
  on(signal: NodeJS.Signals, handler: () => void): void;
  off(signal: NodeJS.Signals, handler: () => void): void;
}

export function parseWatchArgs(argv: readonly string[]): WatchArgs {
  const { flags, remaining } = parseCliFlags(argv);
  const topics: string[] = [];
  const wakeKindsList: WakeKind[] = [];
  let client: ClientName | null = null;
  let once = false;
  let wake = false;
  let allFrames = false;
  let explicitActionableOnly: boolean | null = null;

  let i = 0;
  while (i < remaining.length) {
    const arg = remaining[i]!;
    if (arg === "--topic") {
      const next = remaining[i + 1];
      if (typeof next !== "string" || next.length === 0) {
        throw new WatchArgsError("--topic requires a value (e.g. --topic signals.)");
      }
      topics.push(next);
      i += 2;
      continue;
    }
    if (arg === "--client") {
      const next = remaining[i + 1];
      if (typeof next !== "string" || next.length === 0) {
        throw new WatchArgsError("--client requires a CLI name");
      }
      try {
        client = parseClientName(next, "--client");
      } catch (err) {
        throw new WatchArgsError(err instanceof ClientArgError ? err.message : String(err));
      }
      i += 2;
      continue;
    }
    if (arg.startsWith("--client=")) {
      try {
        client = parseClientName(arg.slice("--client=".length), "--client");
      } catch (err) {
        throw new WatchArgsError(err instanceof ClientArgError ? err.message : String(err));
      }
      i += 1;
      continue;
    }
    if (arg === "--once") {
      once = true;
      i += 1;
      continue;
    }
    if (arg === "--wake") {
      wake = true;
      i += 1;
      continue;
    }
    if (arg === "--actionable-only") {
      explicitActionableOnly = true;
      allFrames = false;
      i += 1;
      continue;
    }
    if (arg === "--all-frames") {
      explicitActionableOnly = false;
      allFrames = true;
      i += 1;
      continue;
    }
    if (arg === "--wake-on") {
      const next = remaining[i + 1];
      if (typeof next !== "string" || next.length === 0) {
        throw new WatchArgsError("--wake-on requires a wake kind");
      }
      try {
        wakeKindsList.push(parseWakeKind(next));
      } catch (err) {
        throw new WatchArgsError(err instanceof Error ? err.message : String(err));
      }
      i += 2;
      continue;
    }
    if (arg.startsWith("--wake-on=")) {
      try {
        wakeKindsList.push(parseWakeKind(arg.slice("--wake-on=".length)));
      } catch (err) {
        throw new WatchArgsError(err instanceof Error ? err.message : String(err));
      }
      i += 1;
      continue;
    }
    throw new WatchArgsError(
      `unknown argument ${JSON.stringify(redactCliArg(arg))} — usage: snapper-mcp watch [--config PATH] [--client CLI] [--actionable-only] [--once] [--topic PREFIX]...`,
    );
  }

  const resolved = topics.length === 0 ? [...DEFAULT_TOPICS] : topics;
  for (const topic of resolved) {
    if (!topic.endsWith(".")) {
      throw new WatchArgsError(
        `--topic value must end with '.' to address a topic family root (got ${JSON.stringify(redactToken(topic))})`,
      );
    }
  }
  const actionableOnly = explicitActionableOnly ?? (once || client !== null);
  const wakeKinds =
    wakeKindsList.length > 0
      ? new Set<WakeKind>(wakeKindsList)
      : new Set<WakeKind>(DEFAULT_WAKE_KINDS);

  return {
    topics: resolved,
    flags,
    client,
    once,
    wake,
    actionableOnly,
    allFrames,
    wakeKinds,
  };
}

function resolveStdout(opt: WatchOptions["stdout"]): JsonlSink {
  if (opt === undefined) {
    const stream: Writable = process.stdout;
    return { write: (line) => stream.write(line) };
  }
  if (typeof (opt as Pick<Writable, "write">).write === "function") {
    const stream = opt as Pick<Writable, "write">;
    return { write: (line) => stream.write(line) };
  }
  const webStream = opt as Pick<WritableStream, "getWriter">;
  const writer = webStream.getWriter();
  const encoder = new TextEncoder();
  let pendingWrite: Promise<void> = Promise.resolve();
  return {
    write: (line) => {
      pendingWrite = pendingWrite
        .then(() => writer.write(encoder.encode(line)))
        .catch((): void => undefined);
    },
  };
}

export function resolveSignalSource(opt: SignalSource | undefined): SignalSource {
  if (opt !== undefined) return opt;
  return {
    on: (signal, handler) => {
      process.on(signal, handler);
    },
    off: (signal, handler) => {
      process.off(signal, handler);
    },
  };
}

interface WatchSetup {
  readonly client: WsClient;
  readonly logger: Logger;
  readonly dispose: () => void;
}

interface DelegateIdentityEnvelope {
  readonly payload?: {
    readonly delegate_public_id?: unknown;
  };
}

interface FrameForwarder {
  readonly onFrame: (frame: ServerFrame) => void;
  readonly dispose: () => void;
}

async function fetchDelegatePublicId(baseUrl: URL, store: TokenStore): Promise<string> {
  const url = new URL("/api/auth/me", baseUrl.origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_ME_TIMEOUT_MS);
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${store.accessToken()}`,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("GET /api/auth/me timed out after 10s", { cause: err });
    }
    throw new Error("GET /api/auth/me failed", { cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`GET /api/auth/me returned HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("GET /api/auth/me returned malformed JSON");
  }
  if (body === null || typeof body !== "object") {
    throw new Error("GET /api/auth/me response is not a JSON object");
  }
  const delegatePublicId = (body as DelegateIdentityEnvelope).payload?.delegate_public_id;
  if (typeof delegatePublicId !== "string" || delegatePublicId.trim().length === 0) {
    throw new Error("GET /api/auth/me returned no delegate_public_id");
  }
  return delegatePublicId.trim();
}

function formatOutputLine(
  args: WatchArgs,
  frame: ServerFrame,
  kind: WakeKind | null,
): string {
  if (args.client !== null && !args.allFrames) {
    if (args.client === "copilot") {
      return `${SNAPPER_COPILOT_ATTENTION_LINE}\n`;
    }
    if (args.client === "kimi" && args.once) {
      return `${SNAPPER_KIMI_ATTENTION_LINE}\n`;
    }
    return `${formatClientAttentionLine(kind ?? "ai_review")}\n`;
  }
  return `${JSON.stringify(frame)}\n`;
}

function createFrameForwarder(params: {
  readonly sink: JsonlSink;
  readonly delegatePublicId: string | null;
  readonly args: WatchArgs;
  readonly onOnceEmitted: () => void;
}): FrameForwarder {
  let onceDone = false;

  const deliverFrame = (frame: ServerFrame): void => {
    if (onceDone) return;
    const kind = classifyActionableFrame(frame, params.args.wakeKinds);
    if (params.args.actionableOnly && kind === null) {
      return;
    }
    params.sink.write(formatOutputLine(params.args, frame, kind));
    if (params.args.once) {
      onceDone = true;
      params.onOnceEmitted();
    }
  };

  if (params.delegatePublicId === null) {
    return {
      onFrame: (frame) => deliverFrame(frame),
      dispose: () => undefined,
    };
  }

  const held = new Map<string, ReturnType<typeof setTimeout>>();
  const cancelHeld = (reviewPublicId: string): void => {
    const timer = held.get(reviewPublicId);
    if (timer === undefined) return;
    clearTimeout(timer);
    held.delete(reviewPublicId);
  };

  const holdForeignRequest = (frame: AiReviewRequestFrame): void => {
    const createdAtMs = Date.parse(frame.timestamp);
    const deadlineMs = Date.parse(frame.deadline);
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(deadlineMs)) {
      deliverFrame(frame);
      return;
    }

    const releaseAtMs = createdAtMs + AI_REVIEW_FANOUT_AFTER_MS;
    const nowMs = Date.now();
    if (deadlineMs <= nowMs || deadlineMs <= releaseAtMs) {
      return;
    }
    if (releaseAtMs <= nowMs) {
      deliverFrame(frame);
      return;
    }

    cancelHeld(frame.review_public_id);
    const timer = setTimeout(() => {
      held.delete(frame.review_public_id);
      if (Date.now() < deadlineMs) {
        deliverFrame(frame);
      }
    }, releaseAtMs - nowMs);
    timer.unref();
    held.set(frame.review_public_id, timer);
  };

  return {
    onFrame: (frame) => {
      if (frame.type === "ai_review.decision_ack") {
        cancelHeld(frame.review_public_id);
        deliverFrame(frame);
        return;
      }
      if (frame.type !== "ai_review.request") {
        deliverFrame(frame);
        return;
      }

      const selected = (frame as { readonly selected_delegate_public_id?: unknown })
        .selected_delegate_public_id;
      if (
        typeof selected !== "string" ||
        selected.length === 0 ||
        selected === params.delegatePublicId
      ) {
        deliverFrame(frame);
        return;
      }
      holdForeignRequest(frame);
    },
    dispose: () => {
      for (const timer of held.values()) clearTimeout(timer);
      held.clear();
    },
  };
}

async function buildWatchSetup(params: {
  readonly args: WatchArgs;
  readonly options: WatchOptions;
  readonly sink: JsonlSink;
  readonly env: BridgeEnv;
  readonly logger: Logger;
  readonly onOnceEmitted: () => void;
}): Promise<WatchSetup> {
  const wsUrl = computeWsUrl(params.env.baseUrl);
  const store = new TokenStore({ access: params.env.accessToken });
  let delegatePublicId: string | null = null;
  let filterStatus: string;
  try {
    delegatePublicId = await fetchDelegatePublicId(params.env.baseUrl, store);
    filterStatus =
      `INFO ai_review delegate filter enabled: ` +
      `delegate_public_id=${JSON.stringify(delegatePublicId)}`;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    filterStatus =
      `WARN ai_review delegate filter disabled: ${reason}; forwarding all frames`;
  }
  writeStderr(`[${CLIENT_NAME} watch] ${filterStatus}\n`);

  const forwarder = createFrameForwarder({
    sink: params.sink,
    delegatePublicId,
    args: params.args,
    onOnceEmitted: params.onOnceEmitted,
  });
  const minter = new EnvelopeMinter();
  const fetchToken = (): Promise<WsTokenResult> =>
    fetchWsToken(params.env.baseUrl, store, params.logger);
  const wsOptions: WsClientOptions = {
    wsUrl,
    tokenStore: store,
    fetchWsToken: fetchToken,
    topics: params.args.topics,
    minter,
    logger: params.logger,
    onFrame: forwarder.onFrame,
  };
  const factory = params.options.wsClientFactory ?? createWsClient;
  const client = factory(wsOptions);
  return { client, logger: params.logger, dispose: forwarder.dispose };
}

function looksLikeKimiOnceArgv(argv: readonly string[]): boolean {
  const hasOnce = argv.includes("--once");
  if (!hasOnce) return false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--client" && argv[i + 1]?.toLowerCase() === "kimi") return true;
    if (argv[i]?.toLowerCase() === "--client=kimi") return true;
  }
  return false;
}

async function deriveSessionKey(
  client: ClientName,
  source: NodeJS.ProcessEnv,
  options: WatchOptions,
): Promise<{ readonly key: string; readonly parentPid: number; readonly parentStartToken: string }> {
  if (typeof options.sessionKey === "string" && options.sessionKey.length > 0) {
    return { key: options.sessionKey, parentPid: process.ppid, parentStartToken: "0" };
  }
  if (client === "copilot") {
    const copilotId = source["COPILOT_AGENT_SESSION_ID"];
    if (typeof copilotId === "string" && copilotId.trim().length > 0) {
      return { key: copilotId.trim(), parentPid: process.ppid, parentStartToken: "0" };
    }
  }
  const inspector = options.inspector ?? (() => inspectParentProcess());
  const parent = await inspector();
  if (parent !== null) {
    return {
      key: `${parent.pid}:${parent.startToken}`,
      parentPid: parent.pid,
      parentStartToken: parent.startToken,
    };
  }
  return {
    key: `ppid:${process.ppid}`,
    parentPid: process.ppid,
    parentStartToken: "0",
  };
}

export async function watchMain(options: WatchOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(3);
  const source = options.source ?? process.env;
  const logger = createLogger(`${CLIENT_NAME} watch`, source);
  const sink = resolveStdout(options.stdout);
  const isKimiOnce = looksLikeKimiOnceArgv(argv);

  let args: WatchArgs;
  try {
    args = parseWatchArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeStderr(`[${CLIENT_NAME} watch] ${message}\n`);
    if (isKimiOnce) {
      sink.write(`${KIMI_OUTCOME_LINES[KIMI_EXIT_FAILED]}\n`);
      process.exit(KIMI_EXIT_FAILED);
      return;
    }
    process.exit(1);
    return;
  }

  const stateDir = resolveStateDir(source);
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const selfPid = options.pid ?? process.pid;

  let env: BridgeEnv;
  const resolvedConfigPath =
    args.flags.configPath ?? (args.client !== null ? defaultConfigFilePath(source) : null);
  try {
    const configFile: ConfigFile | null =
      resolvedConfigPath === null ? null : await loadConfigFile(resolvedConfigPath, logger);
    env = resolveBridgeEnv(
      source,
      { ...args.flags, configPath: resolvedConfigPath },
      configFile,
      logger,
    );
  } catch (err) {
    if (!(err instanceof EnvValidationError)) throw err;
    writeStderr(`[${CLIENT_NAME} watch] ${err.message}\n`);
    if (args.client === "kimi" && args.once) {
      sink.write(`${KIMI_OUTCOME_LINES[KIMI_EXIT_FAILED]}\n`);
      process.exit(KIMI_EXIT_FAILED);
      return;
    }
    process.exit(1);
    return;
  }

  if (args.client === "antigravity" && args.wake) {
    const code = await runAntigravityWakeCommand({
      env,
      configPath: resolvedConfigPath ?? defaultConfigFilePath(source),
      stateDir,
      source,
      logger,
      inspector: options.inspector,
      isPidAlive,
      wsClientFactory: options.wsClientFactory,
      ...options.antigravityOverrides,
    });
    if (code !== 0) {
      process.exit(code);
    }
    return;
  }

  let sessionLock: SessionLockHandle | null = null;
  let kimiParentInfo: { readonly parentPid: number; readonly parentStartToken: string } | null = null;

  try {
    if (args.client !== null) {
      const pref = await readWakePreference(stateDir, args.client);
      if (pref === "off") {
        if (args.client === "kimi" && args.once) {
          sink.write(`${KIMI_OUTCOME_LINES[KIMI_EXIT_DISABLED]}\n`);
        }
        process.exit(KIMI_EXIT_DISABLED);
        return;
      }

      const sessionInfo = await deriveSessionKey(args.client, source, options);
      sessionLock = await acquireSessionLock({
        stateDir,
        client: args.client,
        sessionKey: sessionInfo.key,
        pid: selfPid,
        isPidAlive,
      });
      if (!sessionLock.acquired) {
        if (args.client === "kimi" && args.once) {
          sink.write(`${KIMI_OUTCOME_LINES[KIMI_EXIT_DUPLICATE]}\n`);
        }
        process.exit(KIMI_EXIT_DUPLICATE);
        return;
      }

      if (args.client === "kimi" && args.once) {
        kimiParentInfo = {
          parentPid: sessionInfo.parentPid,
          parentStartToken: sessionInfo.parentStartToken,
        };
        await claimKimiWatcherStart({
          stateDir,
          parentPid: sessionInfo.parentPid,
          parentStartToken: sessionInfo.parentStartToken,
          watcherPid: selfPid,
        });
      }
    }
  } catch (err) {
    if (!(err instanceof StateRecoveryRequiredError)) throw err;
    logger.error(err.message);
    if (sessionLock !== null) {
      await sessionLock.release();
    }
    if (args.client === "kimi" && args.once) {
      sink.write(`${KIMI_OUTCOME_LINES[KIMI_EXIT_FAILED]}\n`);
    }
    process.exit(KIMI_EXIT_FAILED);
    return;
  }

  let activeClient: WsClient | null = null;
  let onceCompleted = false;
  let onceExpired = false;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const setup = await buildWatchSetup({
    args,
    options,
    sink,
    env,
    logger,
    onOnceEmitted: () => {
      onceCompleted = true;
      if (activeClient !== null) {
        void activeClient.close();
      }
    },
  });
  activeClient = setup.client;
  if (onceCompleted) {
    void activeClient.close();
  }

  if (args.once && !onceCompleted) {
    const lifetimeMs = options.onceLifetimeMs ?? DEFAULT_ONCE_LIFETIME_MS;
    expiryTimer = setTimeout(() => {
      if (!onceCompleted) {
        onceExpired = true;
        void setup.client.close();
      }
    }, lifetimeMs);
    if (lifetimeMs >= 60_000) {
      expiryTimer.unref();
    }
  }

  const signalSource = resolveSignalSource(options.signalSource);
  const shouldInstall = options.install ?? true;

  logger.info(`subscribing to topics: ${args.topics.join(", ")}`);
  let exitCode: number | null = 1;
  try {
    exitCode = await runWatchSession(setup.client, logger, signalSource, shouldInstall);
  } finally {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    setup.dispose();
    if (kimiParentInfo !== null) {
      const latchReason = onceExpired
        ? "expired"
        : exitCode !== null
          ? "failed"
          : null;
      await recordKimiWatcherFinish({
        stateDir,
        parentPid: kimiParentInfo.parentPid,
        parentStartToken: kimiParentInfo.parentStartToken,
        watcherPid: selfPid,
        latchReason,
      }).catch((err: unknown) => {
        if (err instanceof StateRecoveryRequiredError) {
          logger.error(err.message);
        }
      });
    }
    if (sessionLock !== null) {
      await sessionLock.release();
    }
  }

  if (onceCompleted) {
    process.exit(KIMI_EXIT_ATTENTION);
    return;
  }
  if (onceExpired) {
    if (args.client === "kimi") {
      sink.write(`${KIMI_OUTCOME_LINES[KIMI_EXIT_EXPIRED]}\n`);
    }
    process.exit(KIMI_EXIT_EXPIRED);
    return;
  }
  if (exitCode !== null) {
    if (args.client === "kimi" && args.once) {
      sink.write(`${KIMI_OUTCOME_LINES[KIMI_EXIT_FAILED]}\n`);
      process.exit(KIMI_EXIT_FAILED);
      return;
    }
    process.exit(exitCode);
  }
}

async function runWatchSession(
  client: WsClient,
  logger: Logger,
  signalSource: SignalSource,
  shouldInstall: boolean,
): Promise<number | null> {
  let shutdownRequested = false;
  const onSignal = (): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    logger.info("shutdown requested; closing watch session");
    void client.close();
  };

  if (shouldInstall) {
    signalSource.on("SIGTERM", onSignal);
    signalSource.on("SIGINT", onSignal);
  }

  try {
    await client.run();
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`watch session ended unexpectedly: ${message}`);
    return 1;
  } finally {
    if (shouldInstall) {
      signalSource.off("SIGTERM", onSignal);
      signalSource.off("SIGINT", onSignal);
    }
  }
}
