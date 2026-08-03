/**
 * SIGTERM/SIGINT drain sequence.
 *
 * SDK v1.30 does NOT provide a drain primitive — `McpServer.close()`
 * delegates to the underlying transport's `close()`, which aborts
 * pending work rather than awaiting it. All drain coordination is
 * therefore app-owned:
 *
 *   1. Flip `isShuttingDown` so proxy request handlers respond
 *      "server shutting down" to LATE arrivals (proxy.ts checks
 *      the flag at handler entry — see `ProxyOptions.shuttingDown`).
 *   2. Await every in-flight forward-path request promise in
 *      `pendingForward` via `Promise.allSettled` under
 *      `DRAIN_TIMEOUT_MS`.
 *   3. Await every outbound reverse-path notification send promise
 *      in `pendingReverse` with the remaining timeout budget.
 *   4. Close the HTTP client transport (safe now — nothing in flight).
 *   5. Close the stdio server.
 *   6. `process.exit(0)`.
 *
 * Timeout path: when `DRAIN_TIMEOUT_MS` elapses, log + `exit(1)`.
 * Uncaught-exception path: log + `exit(1)` without draining (state
 * is corrupt; best to fail fast).
 *
 * Handlers are idempotent — multiple signals collapse to a single
 * drain cycle.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { Logger } from "./logger.js";
import type { ProxyPending } from "./proxy.js";

export const DRAIN_TIMEOUT_MS = 10_000;

interface CloseableServer {
  close(): Promise<void>;
}

export interface ShutdownContext {
  readonly stdioServer: CloseableServer;
  readonly httpClient: Client;
  readonly pending: ProxyPending;
  readonly logger: Logger;
  readonly setShuttingDown: () => void;
}

export interface ShutdownHandlers {
  readonly shutdown: (signal: NodeJS.Signals | "uncaughtException") => Promise<void>;
  readonly install: () => void;
  readonly uninstall: () => void;
}

function raceWithTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

async function drainSet(
  label: string,
  set: ReadonlySet<Promise<unknown>>,
  budgetMs: number,
  logger: Logger,
): Promise<{ timedOut: boolean; elapsed: number }> {
  if (set.size === 0) return { timedOut: false, elapsed: 0 };
  const start = Date.now();
  // Snapshot the pending set to a fixed array up front. Items added to the
  // live Set AFTER drain starts (e.g. reverse-path notifications still
  // arriving in the moment setShuttingDown flips) would otherwise be missed
  // by allSettled and escape the drain budget.
  const pending = Array.from(set);
  const settle = Promise.allSettled(pending).then(() => "settled" as const);
  const outcome = await raceWithTimeout(settle, budgetMs, () => "timeout" as const);
  const elapsed = Date.now() - start;
  if (outcome === "timeout") {
    logger.warn(`drain ${label} timed out after ${budgetMs}ms (${pending.length} pending)`);
  } else {
    logger.debug(`drain ${label} settled in ${elapsed}ms`);
  }
  return { timedOut: outcome === "timeout", elapsed };
}

async function runShutdown(
  signal: NodeJS.Signals | "uncaughtException",
  ctx: ShutdownContext,
): Promise<void> {
  ctx.logger.info(`received ${signal}, draining (timeout ${DRAIN_TIMEOUT_MS}ms)`);
  ctx.setShuttingDown();

  const forwardBudget = DRAIN_TIMEOUT_MS;
  const forwardResult = await drainSet(
    "forward",
    ctx.pending.pendingForward,
    forwardBudget,
    ctx.logger,
  );

  const reverseBudget = Math.max(0, DRAIN_TIMEOUT_MS - forwardResult.elapsed);
  const reverseResult = await drainSet(
    "reverse",
    ctx.pending.pendingReverse,
    reverseBudget,
    ctx.logger,
  );

  try {
    await ctx.httpClient.close();
  } catch (err) {
    ctx.logger.warn("httpClient.close threw during shutdown", err);
  }
  try {
    await ctx.stdioServer.close();
  } catch (err) {
    ctx.logger.warn("stdioServer.close threw during shutdown", err);
  }

  const exitCode = forwardResult.timedOut || reverseResult.timedOut ? 1 : 0;
  ctx.logger.info(`drain complete — exiting with code ${exitCode}`);
  process.exit(exitCode);
}

export function createShutdownHandlers(ctx: ShutdownContext): ShutdownHandlers {
  let draining = false;
  let installed = false;

  const shutdown = async (
    signal: NodeJS.Signals | "uncaughtException",
  ): Promise<void> => {
    if (draining) {
      ctx.logger.debug(`ignoring duplicate ${signal} — already draining`);
      return;
    }
    draining = true;
    try {
      await runShutdown(signal, ctx);
    } catch (err) {
      ctx.logger.error("unexpected error during drain", err);
      process.exit(1);
    }
  };

  const onSigterm = (): void => {
    void shutdown("SIGTERM");
  };
  const onSigint = (): void => {
    void shutdown("SIGINT");
  };
  const onUncaught = (err: unknown): void => {
    ctx.logger.error("uncaughtException — exiting without drain", err);
    process.exit(1);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    ctx.logger.error("unhandledRejection — exiting without drain", reason);
    process.exit(1);
  };

  return {
    shutdown,
    install: () => {
      if (installed) return;
      installed = true;
      process.on("SIGTERM", onSigterm);
      process.on("SIGINT", onSigint);
      process.on("uncaughtException", onUncaught);
      process.on("unhandledRejection", onUnhandledRejection);
    },
    uninstall: () => {
      if (!installed) return;
      installed = false;
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandledRejection);
    },
  };
}
