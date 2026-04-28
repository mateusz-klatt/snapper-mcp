import { afterEach, describe, expect, it, vi } from "vitest";

import { NoRefreshTokenError } from "../src/errors.js";
import { TokenStore } from "../src/token_store.js";
import type { ServerFrame } from "../src/types.js";
import {
  parseWatchArgs,
  WatchArgsError,
  watchMain,
  type SignalSource,
  type WatchOptions,
} from "../src/watch.js";
import type { WsClient, WsClientOptions } from "../src/ws_client.js";

describe("parseWatchArgs", () => {
  it("returns the default topic set when no --topic is supplied", () => {
    const args = parseWatchArgs([]);
    expect(args.topics).toEqual(["signals.", "orders.events."]);
  });

  it("collects a single --topic value", () => {
    const args = parseWatchArgs(["--topic", "signals."]);
    expect(args.topics).toEqual(["signals."]);
  });

  it("collects multiple --topic values in argv order", () => {
    const args = parseWatchArgs(["--topic", "signals.", "--topic", "orders.events."]);
    expect(args.topics).toEqual(["signals.", "orders.events."]);
  });

  it("rejects --topic without a following value", () => {
    expect(() => parseWatchArgs(["--topic"])).toThrow(WatchArgsError);
  });

  it("rejects --topic with an empty-string value", () => {
    expect(() => parseWatchArgs(["--topic", ""])).toThrow(WatchArgsError);
  });

  it("rejects a topic that does not end with '.'", () => {
    expect(() => parseWatchArgs(["--topic", "signals"])).toThrow(/end with '\.'/);
  });

  it("rejects an unknown argument", () => {
    expect(() => parseWatchArgs(["--unknown", "x"])).toThrow(WatchArgsError);
  });

  it("rejects when one of multiple topics fails the trailing-dot rule", () => {
    expect(() => parseWatchArgs(["--topic", "signals.", "--topic", "bad"])).toThrow(
      WatchArgsError,
    );
  });
});

interface CapturedSession {
  readonly options: WsClientOptions;
  readonly client: { run: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  resolveRun: () => void;
  rejectRun: (err: Error) => void;
}

function createCapturingFactory(): {
  factory: (opts: WsClientOptions) => WsClient;
  sessions: CapturedSession[];
} {
  const sessions: CapturedSession[] = [];
  const factory = (opts: WsClientOptions): WsClient => {
    let resolveRun: () => void = () => undefined;
    let rejectRun: (err: Error) => void = () => undefined;
    const runPromise = new Promise<void>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    const captured: CapturedSession = {
      options: opts,
      client: {
        run: vi.fn(() => runPromise),
        close: vi.fn(async () => {
          resolveRun();
        }),
      },
      resolveRun,
      rejectRun,
    };
    sessions.push(captured);
    return captured.client as unknown as WsClient;
  };
  return { factory, sessions };
}

function makeSink(): { sink: { write: (line: string) => void }; lines: string[] } {
  const lines: string[] = [];
  return {
    sink: {
      write: (line: string) => {
        lines.push(line);
      },
    },
    lines,
  };
}

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    SNAPPER_BASE_URL: "http://localhost:8000/api/mcp",
    SNAPPER_ACCESS_TOKEN: "access-tok",
    SNAPPER_REFRESH_TOKEN: "refresh-tok",
    SNAPPER_MCP_LOG_LEVEL: "error",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

class FakeSignalSource implements SignalSource {
  readonly handlers = new Map<NodeJS.Signals, Set<() => void>>();

  on(signal: NodeJS.Signals, handler: () => void): void {
    let set = this.handlers.get(signal);
    if (set === undefined) {
      set = new Set<() => void>();
      this.handlers.set(signal, set);
    }
    set.add(handler);
  }

  off(signal: NodeJS.Signals, handler: () => void): void {
    this.handlers.get(signal)?.delete(handler);
  }

  fire(signal: NodeJS.Signals): void {
    const set = this.handlers.get(signal);
    if (set === undefined) return;
    for (const handler of set) handler();
  }
}

describe("watchMain — lifecycle integration", () => {
  it("constructs the WsClient with the parsed topics + parsed env + JSONL onFrame", async () => {
    const { factory, sessions } = createCapturingFactory();
    const { sink, lines } = makeSink();
    const signalSource = new FakeSignalSource();
    const options: WatchOptions = {
      source: baseEnv(),
      argv: ["--topic", "signals."],
      stdout: sink,
      install: false,
      wsClientFactory: factory,
      signalSource,
    };
    const runPromise = watchMain(options);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5);
      if (typeof timer.unref === "function") timer.unref();
    });
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session?.options.topics).toEqual(["signals."]);
    expect(session?.options.tokenStore).toBeInstanceOf(TokenStore);
    session?.options.onFrame({
      type: "signal",
      session_id: "0192f000-0000-7000-8000-000000000001",
      sequence_id: 1,
      public_id: "0192f000-0000-7000-8000-aaaaaaaaaaaa",
      timestamp: "2026-04-28T12:00:00.000Z",
      topic: "signals.kraken.BTC-USD.rsi",
      instrument: "BTC-USD",
      exchange: "kraken",
      side: "buy",
      strength: 0.5,
      reason: "test",
      price: 100,
      strategy_name: null,
      fired_at: "2026-04-28T12:00:00.000Z",
      wallet_public_id: "0192f000-0000-7000-8000-bbbbbbbbbbbb",
      operator_public_id: null,
      user_public_id: null,
    } as ServerFrame);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "") as { type: string; topic: string };
    expect(parsed.type).toBe("signal");
    expect(parsed.topic).toBe("signals.kraken.BTC-USD.rsi");
    expect(lines[0]?.endsWith("\n")).toBe(true);
    session?.resolveRun();
    await runPromise;
  });

  it("uses the default topic set when --topic is omitted", async () => {
    const { factory, sessions } = createCapturingFactory();
    const { sink } = makeSink();
    const runPromise = watchMain({
      source: baseEnv(),
      argv: [],
      stdout: sink,
      install: false,
      wsClientFactory: factory,
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5);
      if (typeof timer.unref === "function") timer.unref();
    });
    expect(sessions[0]?.options.topics).toEqual(["signals.", "orders.events."]);
    sessions[0]?.resolveRun();
    await runPromise;
  });

  it("registers SIGTERM/SIGINT handlers when install is true and tears them down on exit", async () => {
    const { factory, sessions } = createCapturingFactory();
    const { sink } = makeSink();
    const signalSource = new FakeSignalSource();
    const runPromise = watchMain({
      source: baseEnv(),
      argv: [],
      stdout: sink,
      install: true,
      wsClientFactory: factory,
      signalSource,
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5);
      if (typeof timer.unref === "function") timer.unref();
    });
    expect(signalSource.handlers.get("SIGTERM")?.size).toBe(1);
    expect(signalSource.handlers.get("SIGINT")?.size).toBe(1);
    signalSource.fire("SIGTERM");
    await runPromise;
    expect(sessions[0]?.client.close).toHaveBeenCalledTimes(1);
    expect(signalSource.handlers.get("SIGTERM")?.size ?? 0).toBe(0);
    expect(signalSource.handlers.get("SIGINT")?.size ?? 0).toBe(0);
  });

  it("close() is idempotent across repeated SIGTERM signals", async () => {
    const { factory, sessions } = createCapturingFactory();
    const { sink } = makeSink();
    const signalSource = new FakeSignalSource();
    const runPromise = watchMain({
      source: baseEnv(),
      argv: [],
      stdout: sink,
      install: true,
      wsClientFactory: factory,
      signalSource,
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5);
      if (typeof timer.unref === "function") timer.unref();
    });
    signalSource.fire("SIGTERM");
    signalSource.fire("SIGINT");
    signalSource.fire("SIGTERM");
    await runPromise;
    expect(sessions[0]?.client.close).toHaveBeenCalledTimes(1);
  });
});

describe("watchMain — error paths", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    exitSpy?.mockRestore();
    stderrSpy?.mockRestore();
  });

  it("exits 1 with stderr message when argv parsing fails", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      watchMain({
        source: baseEnv(),
        argv: ["--topic", "no-trailing-dot"],
        install: false,
      }),
    ).rejects.toThrow("exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderrText = stderrSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : String(c[0])))
      .join("");
    expect(stderrText).toMatch(/end with '\.'/);
  });

  it("exits 1 with stderr message when SNAPPER_BASE_URL is missing", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      watchMain({
        source: baseEnv({ SNAPPER_BASE_URL: undefined }),
        argv: [],
        install: false,
      }),
    ).rejects.toThrow("exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderrText = stderrSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : String(c[0])))
      .join("");
    expect(stderrText).toMatch(/SNAPPER_BASE_URL/);
  });

  it("exits 1 silently when run() rejects with NoRefreshTokenError (PAT mode)", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { factory, sessions } = createCapturingFactory();
    const watchPromise = watchMain({
      source: baseEnv(),
      argv: [],
      install: false,
      wsClientFactory: factory,
      stdout: { write: () => undefined },
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5);
      if (typeof timer.unref === "function") timer.unref();
    });
    sessions[0]?.rejectRun(new NoRefreshTokenError());
    await expect(watchPromise).rejects.toThrow("exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderrText = stderrSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : String(c[0])))
      .join("");
    expect(stderrText).not.toMatch(/watch session ended unexpectedly/);
  });

  it("exits 1 with diagnostic stderr when run() rejects with a generic error", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { factory, sessions } = createCapturingFactory();
    const watchPromise = watchMain({
      source: baseEnv(),
      argv: [],
      install: false,
      wsClientFactory: factory,
      stdout: { write: () => undefined },
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5);
      if (typeof timer.unref === "function") timer.unref();
    });
    sessions[0]?.rejectRun(new Error("websocket exploded"));
    await expect(watchPromise).rejects.toThrow("exit(1)");
    const stderrText = stderrSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : String(c[0])))
      .join("");
    expect(stderrText).toMatch(/websocket exploded/);
  });

  it("uninstalls SIGTERM/SIGINT handlers before exit on a fatal run() rejection", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { factory, sessions } = createCapturingFactory();
    const signalSource = new FakeSignalSource();
    const watchPromise = watchMain({
      source: baseEnv(),
      argv: [],
      install: true,
      wsClientFactory: factory,
      signalSource,
      stdout: { write: () => undefined },
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5);
      if (typeof timer.unref === "function") timer.unref();
    });
    expect(signalSource.handlers.get("SIGTERM")?.size).toBe(1);
    sessions[0]?.rejectRun(new Error("kapow"));
    await expect(watchPromise).rejects.toThrow("exit(1)");
    expect(signalSource.handlers.get("SIGTERM")?.size ?? 0).toBe(0);
    expect(signalSource.handlers.get("SIGINT")?.size ?? 0).toBe(0);
  });

  it("re-throws non-EnvValidation errors raised from buildWatchSetup", async () => {
    const factory = (): WsClient => {
      throw new Error("synthetic boom");
    };
    await expect(
      watchMain({
        source: baseEnv(),
        argv: [],
        install: false,
        wsClientFactory: factory,
        stdout: { write: () => undefined },
      }),
    ).rejects.toThrow("synthetic boom");
  });
});

describe("watchMain — stdout sink resolution", () => {
  it("falls back to the real process.stdout when no stdout option is supplied", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { factory, sessions } = createCapturingFactory();
      const runPromise = watchMain({
        source: baseEnv(),
        argv: [],
        install: false,
        wsClientFactory: factory,
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5);
        if (typeof timer.unref === "function") timer.unref();
      });
      sessions[0]?.options.onFrame({
        type: "pong",
        session_id: "0192f000-0000-7000-8000-000000000001",
        sequence_id: 1,
        public_id: "0192f000-0000-7000-8000-aaaaaaaaaaaa",
        timestamp: "2026-04-28T12:00:00.000Z",
        topic: null,
        active_connections: 1,
      } as ServerFrame);
      expect(writeSpy).toHaveBeenCalled();
      sessions[0]?.resolveRun();
      await runPromise;
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("supports a Web Streams writable as a stdout target", async () => {
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    const writableStream = {
      getWriter: () => ({
        write: (chunk: Uint8Array): Promise<void> => {
          chunks.push(decoder.decode(chunk));
          return Promise.resolve();
        },
      }),
    };
    const { factory, sessions } = createCapturingFactory();
    const runPromise = watchMain({
      source: baseEnv(),
      argv: [],
      install: false,
      wsClientFactory: factory,
      stdout: writableStream as unknown as Pick<WritableStream, "getWriter">,
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5);
      if (typeof timer.unref === "function") timer.unref();
    });
    sessions[0]?.options.onFrame({
      type: "pong",
      session_id: "0192f000-0000-7000-8000-000000000001",
      sequence_id: 1,
      public_id: "0192f000-0000-7000-8000-aaaaaaaaaaaa",
      timestamp: "2026-04-28T12:00:00.000Z",
      topic: null,
      active_connections: 1,
    } as ServerFrame);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5);
      if (typeof timer.unref === "function") timer.unref();
    });
    expect(chunks.join("")).toContain('"type":"pong"');
    sessions[0]?.resolveRun();
    await runPromise;
  });
});

