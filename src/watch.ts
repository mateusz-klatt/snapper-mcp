/**
 * Subcommand entry for `snapper-mcp watch`.
 *
 * Connects to the Snapper backend's WebSocket endpoint, subscribes to
 * the configured topic prefixes, and writes one JSONL frame per line
 * to stdout. A Claude Code Monitor primitive wired at the host layer
 * reads each stdout line and surfaces it as a notification inside an
 * active conversation, giving the AI delegate push-style wakeup on
 * backend events without polling REST.
 *
 * Argument syntax:
 *
 *     snapper-mcp watch [--topic PREFIX]...
 *
 * `--topic` is repeatable. Each PREFIX MUST end with `.` so it
 * subscribes to a topic family root rather than a single path —
 * the backend rejects anything else as a non-registry-root pattern.
 * If no `--topic` is given, the default subscription is the union
 * of `signals.` and `orders.events.`, matching the two production
 * topic roots most useful for an AI delegate's situational
 * awareness.
 *
 * Lifecycle:
 *
 *   1. Parse argv → `parseWatchArgs`.
 *   2. Resolve credentials from CLI flags, an optional config file,
 *      then environment variables.
 *   3. Construct `TokenStore`, fetch the delegate's own identity once
 *      from `GET /api/auth/me`, and bind a `fetchWsToken` closure that
 *      reads the same access bearer from the store. `fetchWsToken`
 *      calls `POST /api/auth/ws_token` to mint a one-shot WebSocket
 *      token from the access bearer's session.
 *   4. Construct `EnvelopeMinter` (one per process — a stable
 *      session_id across the whole watch run lets server-side gap
 *      detection observe a clean per-client provenance).
 *   5. Construct the `WsClient` with a cheap `onFrame` address filter.
 *      Own AI-review requests pass immediately; foreign requests are
 *      held until the backend's fanout boundary and cancelled if a
 *      matching decision acknowledgement arrives first. Stderr is the
 *      diagnostic channel; stdout is reserved for the JSONL stream.
 *   6. Install one-shot SIGTERM/SIGINT handlers that call
 *      `client.close()` once and resolve the run promise.
 *   7. Await `client.run()` until either the runner exits with an
 *      unrecoverable error or shutdown is requested. Exit code
 *      reflects the path taken: 0 on graceful drain, 1 on fatal
 *      startup or an unrecoverable session error.
 *
 * Test-injection points (all in `WatchOptions`):
 *
 *   - `source`        — replace `process.env`.
 *   - `argv`          — replace argv slice (default `process.argv.slice(3)`).
 *   - `stdout`        — replace the JSONL writer (default
 *                       `process.stdout`).
 *   - `install`       — `false` skips signal handler registration so
 *                       in-process tests don't accidentally trap
 *                       Vitest's own SIGTERM.
 *   - `wsClientFactory` — replace the WS client construction; the
 *                       tests use a real `WebSocketServer` from `ws`
 *                       and inject a wrapped factory that captures
 *                       lifecycle hooks.
 */

import type { WritableStream } from "node:stream/web";
import type { Writable } from "node:stream";

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
import { createLogger, writeStderr, type Logger } from "./logger.js";
import { TokenStore } from "./token_store.js";
import type { AiReviewRequestFrame, ServerFrame } from "./types.js";
import { fetchWsToken, type WsTokenResult } from "./ws_token.js";
import {
  createWsClient,
  type WsClient,
  type WsClientOptions,
} from "./ws_client.js";

/**
 * `tsup` injects __PKG_NAME__ into the bundled dist via its
 * `define` option. In raw-source test runs the global does not
 * exist, so resolution goes through globalThis to avoid a
 * ReferenceError.
 */
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

export class WatchArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchArgsError";
  }
}

export interface WatchArgs {
  readonly topics: readonly string[];
  readonly flags: CliFlags;
}

export interface WatchOptions {
  readonly source?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly stdout?: Pick<Writable, "write"> | Pick<WritableStream, "getWriter">;
  readonly install?: boolean;
  readonly wsClientFactory?: (opts: WsClientOptions) => WsClient;
  readonly signalSource?: SignalSource;
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
  for (let i = 0; i < remaining.length; i += 1) {
    const arg = remaining[i]!;
    if (arg === "--topic") {
      const next = remaining[i + 1];
      if (typeof next !== "string" || next.length === 0) {
        throw new WatchArgsError("--topic requires a value (e.g. --topic signals.)");
      }
      topics.push(next);
      i += 1;
      continue;
    }
    throw new WatchArgsError(
      `unknown argument ${JSON.stringify(redactCliArg(arg))} — usage: snapper-mcp watch [--config PATH] [--topic PREFIX]...`,
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
  return { topics: resolved, flags };
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
      /*
       * The Web Streams writer rejects on a closed/errored stream;
       * swallow the rejection so a failing operator-supplied sink
       * cannot crash the watch loop with an unhandled rejection.
       * The watch run continues to call `write` for subsequent
       * frames — those will reject identically, leaving the rest
       * of the lifecycle (reconnect, heartbeat, shutdown) intact.
       */
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

function writeFrame(sink: JsonlSink, frame: ServerFrame): void {
  sink.write(`${JSON.stringify(frame)}\n`);
}

function createFrameForwarder(
  sink: JsonlSink,
  delegatePublicId: string | null,
): FrameForwarder {
  if (delegatePublicId === null) {
    return {
      onFrame: (frame) => writeFrame(sink, frame),
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
      writeFrame(sink, frame);
      return;
    }

    const releaseAtMs = createdAtMs + AI_REVIEW_FANOUT_AFTER_MS;
    const nowMs = Date.now();
    if (deadlineMs <= nowMs || deadlineMs <= releaseAtMs) {
      return;
    }
    if (releaseAtMs <= nowMs) {
      writeFrame(sink, frame);
      return;
    }

    cancelHeld(frame.review_public_id);
    const timer = setTimeout(() => {
      held.delete(frame.review_public_id);
      if (Date.now() < deadlineMs) {
        writeFrame(sink, frame);
      }
    }, releaseAtMs - nowMs);
    timer.unref();
    held.set(frame.review_public_id, timer);
  };

  return {
    onFrame: (frame) => {
      if (frame.type === "ai_review.decision_ack") {
        cancelHeld(frame.review_public_id);
        writeFrame(sink, frame);
        return;
      }
      if (frame.type !== "ai_review.request") {
        writeFrame(sink, frame);
        return;
      }

      const selected = (frame as { readonly selected_delegate_public_id?: unknown })
        .selected_delegate_public_id;
      if (
        typeof selected !== "string" ||
        selected.length === 0 ||
        selected === delegatePublicId
      ) {
        writeFrame(sink, frame);
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

async function buildWatchSetup(
  args: WatchArgs,
  options: WatchOptions,
  sink: JsonlSink,
  env: BridgeEnv,
  logger: Logger,
): Promise<WatchSetup> {
  const wsUrl = computeWsUrl(env.baseUrl);
  const store = new TokenStore({ access: env.accessToken });
  let delegatePublicId: string | null = null;
  let filterStatus: string;
  try {
    delegatePublicId = await fetchDelegatePublicId(env.baseUrl, store);
    filterStatus =
      `INFO ai_review delegate filter enabled: ` +
      `delegate_public_id=${JSON.stringify(delegatePublicId)}`;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    filterStatus =
      `WARN ai_review delegate filter disabled: ${reason}; forwarding all frames`;
  }
  writeStderr(`[${CLIENT_NAME} watch] ${filterStatus}\n`);

  const forwarder = createFrameForwarder(sink, delegatePublicId);
  const minter = new EnvelopeMinter();
  const fetchToken = (): Promise<WsTokenResult> => fetchWsToken(env.baseUrl, store, logger);
  const wsOptions: WsClientOptions = {
    wsUrl,
    tokenStore: store,
    fetchWsToken: fetchToken,
    topics: args.topics,
    minter,
    logger,
    onFrame: forwarder.onFrame,
  };
  const factory = options.wsClientFactory ?? createWsClient;
  const client = factory(wsOptions);
  return { client, logger, dispose: forwarder.dispose };
}

export async function watchMain(options: WatchOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(3);
  const source = options.source ?? process.env;
  const logger = createLogger(`${CLIENT_NAME} watch`, source);
  let args: WatchArgs;
  try {
    args = parseWatchArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeStderr(`[${CLIENT_NAME} watch] ${message}\n`);
    process.exit(1);
    return;
  }
  const sink = resolveStdout(options.stdout);

  let setup: WatchSetup;
  try {
    const configFile: ConfigFile | null =
      args.flags.configPath === null ? null : await loadConfigFile(args.flags.configPath, logger);
    const env = resolveBridgeEnv(source, args.flags, configFile, logger);
    setup = await buildWatchSetup(args, options, sink, env, logger);
  } catch (err) {
    if (!(err instanceof EnvValidationError)) throw err;
    writeStderr(`[${CLIENT_NAME} watch] ${err.message}\n`);
    process.exit(1);
    return;
  }
  const { client, dispose } = setup;

  const signalSource = resolveSignalSource(options.signalSource);
  const shouldInstall = options.install ?? true;

  logger.info(`subscribing to topics: ${args.topics.join(", ")}`);
  let exitCode: number | null;
  try {
    exitCode = await runWatchSession(client, logger, signalSource, shouldInstall);
  } finally {
    dispose();
  }
  if (exitCode !== null) {
    process.exit(exitCode);
  }
}

/**
 * Run the WS client to completion, draining cleanly on signal,
 * exit-coding bad-error rejections.
 *
 * `process.exit()` does NOT run `finally` blocks before terminating,
 * so signal-handler uninstall MUST complete before any exit call.
 * This helper captures the desired exit code, lets the `finally`
 * uninstall handlers, and returns the code to the caller — which
 * is the only place allowed to invoke `process.exit`.
 */
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
