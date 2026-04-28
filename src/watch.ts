/**
 * Subcommand entry for `snapper-mcp watch`.
 *
 * Connects to the Snapper backend's WebSocket endpoint, subscribes to
 * the configured topic prefixes, and writes one JSONL frame per line
 * to stdout. The Claude Code Monitor primitive (per the plugin
 * manifest) reads each stdout line and surfaces it as a notification
 * inside an active conversation, giving the AI delegate push-style
 * wakeup on backend events without polling REST.
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
 *   2. Parse env → `parseEnv` (same contract as the proxy mode).
 *   3. Construct `TokenStore` + bind a `fetchWsToken` closure that
 *      shares the store (so the watch session and any concurrent
 *      proxy session see consistent token rotation, even though
 *      this entry point only spawns one of the two at a time).
 *   4. Construct `EnvelopeMinter` (one per process — a stable
 *      session_id across the whole watch run lets server-side gap
 *      detection observe a clean per-client provenance).
 *   5. Construct the `WsClient` with `onFrame = (frame) =>
 *      stdout.write(JSON.stringify(frame) + "\n")`. Stderr is the
 *      logger channel; stdout is reserved for the JSONL stream.
 *   6. Install one-shot SIGTERM/SIGINT handlers that call
 *      `client.close()` once and resolve the run promise.
 *   7. Await `client.run()` until either the runner exits naturally
 *      (PAT-mode fatal — see `ws_client.ts`) or shutdown is
 *      requested. Exit code reflects the path taken: 0 on graceful
 *      drain, 1 on fatal startup or unrecoverable session error.
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

import { computeWsUrl, parseEnv } from "./env.js";
import { EnvelopeMinter } from "./envelope.js";
import { EnvValidationError, NoRefreshTokenError } from "./errors.js";
import { createLogger, type Logger } from "./logger.js";
import { TokenStore } from "./token_store.js";
import { fetchWsToken, type WsTokenResult } from "./ws_token.js";
import {
  createWsClient,
  type WsClient,
  type WsClientOptions,
} from "./ws_client.js";

declare const __PKG_NAME__: string | undefined;

const CLIENT_NAME = typeof __PKG_NAME__ === "string" ? __PKG_NAME__ : "@mateusz-klatt/snapper-mcp";

const DEFAULT_TOPICS: readonly string[] = ["signals.", "orders.events."];

export class WatchArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchArgsError";
  }
}

export interface WatchArgs {
  readonly topics: readonly string[];
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
  const topics: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--topic") {
      const next = argv[i + 1];
      if (typeof next !== "string" || next.length === 0) {
        throw new WatchArgsError("--topic requires a value (e.g. --topic signals.)");
      }
      topics.push(next);
      i += 1;
      continue;
    }
    throw new WatchArgsError(
      `unknown argument ${JSON.stringify(arg)} — usage: snapper-mcp watch [--topic PREFIX]...`,
    );
  }
  const resolved = topics.length === 0 ? [...DEFAULT_TOPICS] : topics;
  for (const topic of resolved) {
    if (!topic.endsWith(".")) {
      throw new WatchArgsError(
        `--topic value must end with '.' to address a topic family root (got ${JSON.stringify(topic)})`,
      );
    }
  }
  return { topics: resolved };
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
  return {
    write: (line) => {
      void writer.write(encoder.encode(line));
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
}

function buildWatchSetup(args: WatchArgs, options: WatchOptions, sink: JsonlSink): WatchSetup {
  const source = options.source ?? process.env;
  const logger = createLogger(`${CLIENT_NAME} watch`, source);
  const env = parseEnv(source);
  const wsUrl = computeWsUrl(env.baseUrl);
  const store = new TokenStore({ access: env.accessToken, refresh: env.refreshToken });
  const minter = new EnvelopeMinter();
  const fetchToken = (): Promise<WsTokenResult> => fetchWsToken(env.baseUrl, store, logger);
  const wsOptions: WsClientOptions = {
    wsUrl,
    tokenStore: store,
    fetchWsToken: fetchToken,
    topics: args.topics,
    minter,
    logger,
    onFrame: (frame) => sink.write(`${JSON.stringify(frame)}\n`),
  };
  const factory = options.wsClientFactory ?? createWsClient;
  const client = factory(wsOptions);
  return { client, logger };
}

export async function watchMain(options: WatchOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(3);
  let args: WatchArgs;
  try {
    args = parseWatchArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[${CLIENT_NAME} watch] ${message}\n`);
    process.exit(1);
    return;
  }
  const sink = resolveStdout(options.stdout);

  let setup: WatchSetup;
  try {
    setup = buildWatchSetup(args, options, sink);
  } catch (err) {
    if (!(err instanceof EnvValidationError)) throw err;
    process.stderr.write(`[${CLIENT_NAME} watch] ${err.message}\n`);
    process.exit(1);
    return;
  }
  const { client, logger } = setup;

  const signalSource = resolveSignalSource(options.signalSource);
  const shouldInstall = options.install ?? true;

  logger.info(`subscribing to topics: ${args.topics.join(", ")}`);
  const exitCode = await runWatchSession(client, logger, signalSource, shouldInstall);
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
    if (err instanceof NoRefreshTokenError) {
      return 1;
    }
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
