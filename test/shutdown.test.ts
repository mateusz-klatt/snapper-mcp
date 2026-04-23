import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../src/logger.js";
import type { ProxyPending } from "../src/proxy.js";
import { DRAIN_TIMEOUT_MS, createShutdownHandlers } from "../src/shutdown.js";

function silentLogger() {
  return createLogger({ prefix: "shutdown-test", level: "error", timestamps: false });
}

function makeEmptyPending(): ProxyPending {
  return {
    pendingForward: new Set<Promise<unknown>>(),
    pendingReverse: new Set<Promise<unknown>>(),
  };
}

function makeCloseableClient(): Client & { close: ReturnType<typeof vi.fn> } {
  return {
    close: vi.fn(async () => undefined),
  } as unknown as Client & { close: ReturnType<typeof vi.fn> };
}

function makeCloseableServer(): Server & { close: ReturnType<typeof vi.fn> } {
  return {
    close: vi.fn(async () => undefined),
  } as unknown as Server & { close: ReturnType<typeof vi.fn> };
}

describe("createShutdownHandlers — constants + install/uninstall", () => {
  it("exports a 10-second DRAIN_TIMEOUT_MS", () => {
    expect(DRAIN_TIMEOUT_MS).toBe(10_000);
  });

  it("install() wires SIGTERM/SIGINT/uncaughtException/unhandledRejection listeners", () => {
    const pending = makeEmptyPending();
    const handlers = createShutdownHandlers({
      stdioServer: makeCloseableServer(),
      httpClient: makeCloseableClient(),
      pending,
      logger: silentLogger(),
      setShuttingDown: () => undefined,
    });
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");
    const uncaughtBefore = process.listenerCount("uncaughtException");
    const rejectedBefore = process.listenerCount("unhandledRejection");

    handlers.install();
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    expect(process.listenerCount("uncaughtException")).toBe(uncaughtBefore + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(rejectedBefore + 1);

    handlers.uninstall();
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("uncaughtException")).toBe(uncaughtBefore);
    expect(process.listenerCount("unhandledRejection")).toBe(rejectedBefore);
  });

  it("install() is idempotent — second call adds no extra listeners", () => {
    const pending = makeEmptyPending();
    const handlers = createShutdownHandlers({
      stdioServer: makeCloseableServer(),
      httpClient: makeCloseableClient(),
      pending,
      logger: silentLogger(),
      setShuttingDown: () => undefined,
    });
    const before = process.listenerCount("SIGTERM");
    handlers.install();
    handlers.install();
    handlers.install();
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    handlers.uninstall();
  });
});

describe("createShutdownHandlers — drain semantics", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number): never => undefined as never) as typeof process.exit);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("happy path: awaits pending forward + reverse promises, closes client + server, exits 0", async () => {
    const pending = makeEmptyPending();
    const client = makeCloseableClient();
    const server = makeCloseableServer();
    let resolveForward!: () => void;
    let resolveReverse!: () => void;
    pending.pendingForward.add(
      new Promise<void>((resolve) => {
        resolveForward = resolve;
      }),
    );
    pending.pendingReverse.add(
      new Promise<void>((resolve) => {
        resolveReverse = resolve;
      }),
    );
    let shuttingDown = false;
    const handlers = createShutdownHandlers({
      stdioServer: server,
      httpClient: client,
      pending,
      logger: silentLogger(),
      setShuttingDown: () => {
        shuttingDown = true;
      },
    });

    const drainPromise = handlers.shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(shuttingDown).toBe(true);
    expect(client.close).not.toHaveBeenCalled();

    resolveForward();
    resolveReverse();
    await drainPromise;

    expect(client.close).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("timeout path: pending forward promise hangs → exits 1 after DRAIN_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    try {
      const pending = makeEmptyPending();
      const client = makeCloseableClient();
      const server = makeCloseableServer();
      pending.pendingForward.add(new Promise<void>(() => undefined));
      const handlers = createShutdownHandlers({
        stdioServer: server,
        httpClient: client,
        pending,
        logger: silentLogger(),
        setShuttingDown: () => undefined,
      });
      const drainPromise = handlers.shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS + 50);
      await drainPromise;
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("SIGTERM twice collapses to one drain cycle", async () => {
    const pending = makeEmptyPending();
    const client = makeCloseableClient();
    const server = makeCloseableServer();
    const handlers = createShutdownHandlers({
      stdioServer: server,
      httpClient: client,
      pending,
      logger: silentLogger(),
      setShuttingDown: () => undefined,
    });
    await Promise.all([handlers.shutdown("SIGTERM"), handlers.shutdown("SIGTERM")]);
    expect(client.close).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it("survives httpClient.close rejection — still closes stdio server + exits", async () => {
    const pending = makeEmptyPending();
    const client = makeCloseableClient();
    const server = makeCloseableServer();
    client.close.mockRejectedValueOnce(new Error("http close failed"));
    const handlers = createShutdownHandlers({
      stdioServer: server,
      httpClient: client,
      pending,
      logger: silentLogger(),
      setShuttingDown: () => undefined,
    });
    await handlers.shutdown("SIGINT");
    expect(server.close).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("no-pending short circuit: immediate drain + exit 0", async () => {
    const pending = makeEmptyPending();
    const client = makeCloseableClient();
    const server = makeCloseableServer();
    const handlers = createShutdownHandlers({
      stdioServer: server,
      httpClient: client,
      pending,
      logger: silentLogger(),
      setShuttingDown: () => undefined,
    });
    await handlers.shutdown("SIGTERM");
    expect(client.close).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("waits for in-flight forward work to settle before closing the client", async () => {
    // SIGTERM arrives while a forward-path request is pending.
    // Drain must await the pending promise BEFORE calling httpClient.close,
    // otherwise the in-flight call would be aborted mid-response.
    const pending = makeEmptyPending();
    const client = makeCloseableClient();
    const server = makeCloseableServer();
    let resolveForward!: () => void;
    const forward = new Promise<void>((resolve) => {
      resolveForward = resolve;
    });
    pending.pendingForward.add(forward);
    const handlers = createShutdownHandlers({
      stdioServer: server,
      httpClient: client,
      pending,
      logger: silentLogger(),
      setShuttingDown: () => undefined,
    });
    const drainPromise = handlers.shutdown("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.close).not.toHaveBeenCalled();
    expect(server.close).not.toHaveBeenCalled();
    resolveForward();
    await drainPromise;
    expect(client.close).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("installed SIGTERM/SIGINT handlers dispatch shutdown() when the signal fires", async () => {
    const handlers = createShutdownHandlers({
      stdioServer: makeCloseableServer(),
      httpClient: makeCloseableClient(),
      pending: makeEmptyPending(),
      logger: silentLogger(),
      setShuttingDown: () => undefined,
    });
    handlers.install();
    try {
      process.emit("SIGTERM");
      await new Promise((resolve) => setImmediate(resolve));
      process.emit("SIGINT");
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      handlers.uninstall();
    }
    // First SIGTERM triggered runShutdown → exit(0). Second SIGINT hit
    // the "draining already" guard, so exitSpy called exactly once.
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("swallows stdioServer.close() rejections with a warn log (no exit promotion)", async () => {
    const pending = makeEmptyPending();
    const client = makeCloseableClient();
    const server = makeCloseableServer();
    server.close.mockRejectedValueOnce(new Error("server close failed"));
    const handlers = createShutdownHandlers({
      stdioServer: server,
      httpClient: client,
      pending,
      logger: silentLogger(),
      setShuttingDown: () => undefined,
    });
    await handlers.shutdown("SIGTERM");
    // Even though server.close threw, drain completes and exits 0 —
    // the throw is demoted to a warn, not a hard failure.
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("forward-drain timeout flips exit code to 1 when pendingForward never settles", async () => {
    vi.useFakeTimers();
    try {
      const pending = makeEmptyPending();
      pending.pendingForward.add(new Promise<void>(() => undefined));
      const handlers = createShutdownHandlers({
        stdioServer: makeCloseableServer(),
        httpClient: makeCloseableClient(),
        pending,
        logger: silentLogger(),
        setShuttingDown: () => undefined,
      });
      const drainPromise = handlers.shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS + 50);
      await drainPromise;
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uncaughtException handler logs and exits 1 without draining", () => {
    const handlers = createShutdownHandlers({
      stdioServer: makeCloseableServer(),
      httpClient: makeCloseableClient(),
      pending: makeEmptyPending(),
      logger: silentLogger(),
      setShuttingDown: () => undefined,
    });
    handlers.install();
    try {
      // Emit synchronously to hit the onUncaught path.
      process.emit("uncaughtException", new Error("synthetic crash"));
    } finally {
      handlers.uninstall();
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("unhandledRejection handler logs and exits 1 without draining", () => {
    const handlers = createShutdownHandlers({
      stdioServer: makeCloseableServer(),
      httpClient: makeCloseableClient(),
      pending: makeEmptyPending(),
      logger: silentLogger(),
      setShuttingDown: () => undefined,
    });
    handlers.install();
    try {
      // Emit synchronously; we pass the pseudo promise argument that
      // matches the handler signature.
      process.emit(
        "unhandledRejection",
        new Error("synthetic reject"),
        Promise.resolve(),
      );
    } finally {
      handlers.uninstall();
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when runShutdown itself throws an unexpected error", async () => {
    // runShutdown already swallows close()-errors internally, so to reach
    // the outer catch we force the FINAL process.exit(0) call to throw.
    // The outer catch then logs + calls process.exit(1) — that second
    // call is what the assertion pins.
    exitSpy.mockImplementationOnce(() => {
      throw new Error("first exit threw");
    });
    const handlers = createShutdownHandlers({
      stdioServer: makeCloseableServer(),
      httpClient: makeCloseableClient(),
      pending: makeEmptyPending(),
      logger: silentLogger(),
      setShuttingDown: () => undefined,
    });
    await handlers.shutdown("SIGTERM");
    expect(exitSpy).toHaveBeenCalledTimes(2);
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });

  it("reverse-drain timeout flips exit code to 1 even if forward settled", async () => {
    vi.useFakeTimers();
    try {
      const pending = makeEmptyPending();
      const client = makeCloseableClient();
      const server = makeCloseableServer();
      // pendingForward settles immediately; pendingReverse hangs forever.
      pending.pendingReverse.add(new Promise<void>(() => undefined));
      const handlers = createShutdownHandlers({
        stdioServer: server,
        httpClient: client,
        pending,
        logger: silentLogger(),
        setShuttingDown: () => undefined,
      });
      const drainPromise = handlers.shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS + 50);
      await drainPromise;
      // Forward set was empty (not timed out), but reverse hung — exit(1).
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
