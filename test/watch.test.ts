import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { TokenStore } from "../src/token_store.js";
import { setStderrWriterForTests } from "../src/logger.js";
import type { ServerFrame } from "../src/types.js";
import {
  parseWatchArgs,
  resolvePackageName,
  resolveSignalSource,
  WatchArgsError,
  watchMain,
  type SignalSource,
  type WatchOptions,
} from "../src/watch.js";
import type { WsClient, WsClientOptions } from "../src/ws_client.js";
import { CAN_LISTEN_ON_LOOPBACK } from "./helpers/listen_capability.js";
import { makeMockWsServer, type ConnectionScript } from "./helpers/mock_ws_server.js";
import { waitFor } from "./helpers/wait_for.js";

describe("resolvePackageName", () => {
  it("returns the build-time global verbatim when it is a string", () => {
    expect(resolvePackageName("@scope/watch")).toBe("@scope/watch");
  });

  it("falls back to the in-source default when the global is undefined or non-string", () => {
    expect(resolvePackageName(undefined)).toBe("@mateusz-klatt/snapper-mcp");
    expect(resolvePackageName(42)).toBe("@mateusz-klatt/snapper-mcp");
  });
});

describe("parseWatchArgs", () => {
  it("returns the default topic set when no --topic is supplied", () => {
    const args = parseWatchArgs([]);
    expect(args.topics).toEqual([
      "signals.",
      "orders.events.",
      "ai_reviews.",
      "ai_research.",
    ]);
  });

  it("collects a single --topic value", () => {
    const args = parseWatchArgs(["--topic", "signals."]);
    expect(args.topics).toEqual(["signals."]);
  });

  it("collects multiple --topic values in argv order", () => {
    const args = parseWatchArgs(["--topic", "signals.", "--topic", "orders.events."]);
    expect(args.topics).toEqual(["signals.", "orders.events."]);
  });

  it("extracts config flags before parsing topic arguments", () => {
    const args = parseWatchArgs([
      "--config=/tmp/env.json",
      "--topic",
      "signals.",
      "--access-token",
      "explicit",
      "--base-url=https://snapper.example.com/api/mcp",
    ]);
    expect(args.topics).toEqual(["signals."]);
    expect(args.flags.configPath).toBe("/tmp/env.json");
    expect(args.flags.accessToken).toBe("explicit");
    expect(args.flags.baseUrl).toBe("https://snapper.example.com/api/mcp");
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

  it("redacts JWT-shaped values in unknown arguments", () => {
    const token = `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    expect(() => parseWatchArgs([`--secret=${token}`])).toThrow(/<jwt-/);
    expect(() => parseWatchArgs([`--secret=${token}`])).not.toThrow(token);
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
    SNAPPER_MCP_LOG_LEVEL: "error",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function captureStderr(): { text: () => string; restore: () => void } {
  let text = "";
  setStderrWriterForTests((line) => {
    text += line;
  });

  return {
    text: () => text,
    restore: () => {
      setStderrWriterForTests(undefined);
    },
  };
}

function watchProtocolScript(): ConnectionScript {
  return {
    onConnect: (socket) => {
      socket.send(JSON.stringify({ type: "auth_required", timeout: 10 }));
    },
    handlers: {
      authenticate: ({ socket }) => {
        socket.send(JSON.stringify({ type: "auth_ok", exp: "2026-04-28T13:00:00.000Z" }));
        socket.send(
          JSON.stringify({
            type: "auth_complete",
            available_topics: ["signals."],
            user_role: "ai_delegate",
            session_expires_at: "2026-04-28T20:00:00.000Z",
            ws_token_exp: "2026-04-28T13:00:00.000Z",
          }),
        );
      },
      subscribe: ({ socket }) => {
        socket.send(
          JSON.stringify({
            type: "subscription_success",
            action: "subscribe",
            status: "subscribed",
            topics: ["signals."],
            denied_topics: [],
            active_subscriptions: ["signals."],
            message: null,
          }),
        );
      },
    },
  };
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
    await waitFor(() => sessions.length > 0, {
      message: "watch session to be created",
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
    await waitFor(() => sessions.length > 0, {
      message: "watch session to be created",
    });
    expect(sessions[0]?.options.topics).toEqual([
      "signals.",
      "orders.events.",
      "ai_reviews.",
      "ai_research.",
    ]);
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
    await waitFor(
      () =>
        (signalSource.handlers.get("SIGTERM")?.size ?? 0) > 0 &&
        (signalSource.handlers.get("SIGINT")?.size ?? 0) > 0,
      {
        message: "watch signal handlers to be registered",
      },
    );
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
    await waitFor(
      () =>
        (signalSource.handlers.get("SIGTERM")?.size ?? 0) > 0 &&
        (signalSource.handlers.get("SIGINT")?.size ?? 0) > 0,
      {
        message: "watch signal handlers to be registered",
      },
    );
    signalSource.fire("SIGTERM");
    signalSource.fire("SIGINT");
    signalSource.fire("SIGTERM");
    await runPromise;
    expect(sessions[0]?.client.close).toHaveBeenCalledTimes(1);
  });
});

describe("watchMain — error paths", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrCapture: ReturnType<typeof captureStderr> | undefined;

  afterEach(() => {
    exitSpy?.mockRestore();
    stderrCapture?.restore();
  });

  it("exits 1 with stderr message when argv parsing fails", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    stderrCapture = captureStderr();
    await expect(
      watchMain({
        source: baseEnv(),
        argv: ["--topic", "no-trailing-dot"],
        install: false,
      }),
    ).rejects.toThrow("exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrCapture.text()).toMatch(/end with '\.'/);
  });

  it("exits 1 with stderr message when SNAPPER_BASE_URL is missing", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    stderrCapture = captureStderr();
    await expect(
      watchMain({
        source: baseEnv({ SNAPPER_BASE_URL: undefined }),
        argv: [],
        install: false,
      }),
    ).rejects.toThrow("exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrCapture.text()).toMatch(/SNAPPER_BASE_URL/);
  });

  it("exits 1 with diagnostic stderr when run() rejects with a generic error", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    stderrCapture = captureStderr();
    const { factory, sessions } = createCapturingFactory();
    const watchPromise = watchMain({
      source: baseEnv(),
      argv: [],
      install: false,
      wsClientFactory: factory,
      stdout: { write: () => undefined },
    });
    await waitFor(() => sessions.length > 0, {
      message: "watch session to be created",
    });
    sessions[0]?.rejectRun(new Error("websocket exploded"));
    await expect(watchPromise).rejects.toThrow("exit(1)");
    expect(stderrCapture.text()).toMatch(/websocket exploded/);
  });

  it("uninstalls SIGTERM/SIGINT handlers before exit on a fatal run() rejection", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    stderrCapture = captureStderr();
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
    await waitFor(() => (signalSource.handlers.get("SIGTERM")?.size ?? 0) > 0, {
      message: "watch SIGTERM handler to be registered",
    });
    expect(signalSource.handlers.get("SIGTERM")?.size).toBe(1);
    sessions[0]?.rejectRun(new Error("kapow"));
    await expect(watchPromise).rejects.toThrow("exit(1)");
    expect(signalSource.handlers.get("SIGTERM")?.size ?? 0).toBe(0);
    expect(signalSource.handlers.get("SIGINT")?.size ?? 0).toBe(0);
  });

  it("uses process.argv.slice(3) when no argv option is supplied", async () => {
    const originalArgv = process.argv;
    process.argv = ["/usr/bin/node", "/usr/local/bin/snapper-mcp", "watch"];
    try {
      const { factory, sessions } = createCapturingFactory();
      const runPromise = watchMain({
        source: baseEnv(),
        install: false,
        wsClientFactory: factory,
        stdout: { write: () => undefined },
      });
      await waitFor(() => sessions.length > 0, {
        message: "watch session to be created",
      });
      expect(sessions[0]?.options.topics).toEqual([
        "signals.",
        "orders.events.",
        "ai_reviews.",
        "ai_research.",
      ]);
      sessions[0]?.resolveRun();
      await runPromise;
    } finally {
      process.argv = originalArgv;
    }
  });

  it("uses process.env when no source option is supplied", async () => {
    const previousBaseUrl = process.env.SNAPPER_BASE_URL;
    const previousAccess = process.env.SNAPPER_ACCESS_TOKEN;
    const previousLogLevel = process.env.SNAPPER_MCP_LOG_LEVEL;
    process.env.SNAPPER_BASE_URL = "http://localhost:8000/api/mcp";
    process.env.SNAPPER_ACCESS_TOKEN = "access-tok";
    process.env.SNAPPER_MCP_LOG_LEVEL = "error";
    try {
      const { factory, sessions } = createCapturingFactory();
      const runPromise = watchMain({
        argv: [],
        install: false,
        wsClientFactory: factory,
        stdout: { write: () => undefined },
      });
      await waitFor(() => sessions.length > 0, {
        message: "watch session to be created",
      });
      expect(sessions[0]?.options.tokenStore.accessToken()).toBe("access-tok");
      sessions[0]?.resolveRun();
      await runPromise;
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.SNAPPER_BASE_URL;
      } else {
        process.env.SNAPPER_BASE_URL = previousBaseUrl;
      }
      if (previousAccess === undefined) {
        delete process.env.SNAPPER_ACCESS_TOKEN;
      } else {
        process.env.SNAPPER_ACCESS_TOKEN = previousAccess;
      }
      if (previousLogLevel === undefined) {
        delete process.env.SNAPPER_MCP_LOG_LEVEL;
      } else {
        process.env.SNAPPER_MCP_LOG_LEVEL = previousLogLevel;
      }
    }
  });

  it("install defaults to true when no install option is supplied", async () => {
    const { factory, sessions } = createCapturingFactory();
    const signalSource = new FakeSignalSource();
    const runPromise = watchMain({
      source: baseEnv(),
      argv: [],
      wsClientFactory: factory,
      signalSource,
      stdout: { write: () => undefined },
    });
    await waitFor(
      () =>
        (signalSource.handlers.get("SIGTERM")?.size ?? 0) > 0 &&
        (signalSource.handlers.get("SIGINT")?.size ?? 0) > 0,
      {
        message: "watch signal handlers to be registered",
      },
    );
    expect(signalSource.handlers.get("SIGTERM")?.size).toBe(1);
    expect(signalSource.handlers.get("SIGINT")?.size).toBe(1);
    sessions[0]?.resolveRun();
    await runPromise;
  });

  it.skipIf(!CAN_LISTEN_ON_LOOPBACK)("uses the default WsClient factory when none is supplied", async () => {
    const server = await makeMockWsServer([watchProtocolScript()]);
    const signalSource = new FakeSignalSource();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          payload: {
            ws_token: "ws-token-abc",
            ws_token_exp: "2026-04-28T13:00:00.000Z",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    let runPromise: Promise<void> | null = null;
    try {
      const baseUrl = new URL(server.url.toString());
      baseUrl.protocol = "http:";
      baseUrl.pathname = "/api/mcp";
      runPromise = watchMain({
        source: baseEnv({ SNAPPER_BASE_URL: baseUrl.toString() }),
        argv: ["--topic", "signals."],
        stdout: { write: () => undefined },
        install: true,
        signalSource,
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("timed out waiting for default WsClient subscription"));
        }, 2_000);
        const poll = setInterval(() => {
          if (server.received.some((r) => r.parsed.type === "subscribe")) {
            clearInterval(poll);
            clearTimeout(timer);
            resolve();
          }
        }, 5);
      });
      expect(fetchMock).toHaveBeenCalled();
      signalSource.fire("SIGTERM");
      await runPromise;
    } finally {
      signalSource.fire("SIGTERM");
      vi.unstubAllGlobals();
      await server.close();
      if (runPromise !== null) {
        await runPromise.catch(() => undefined);
      }
    }
  });

  it("exits 1 with stringified diagnostic when run() rejects with a non-Error value", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    stderrCapture = captureStderr();
    const { factory, sessions } = createCapturingFactory();
    const watchPromise = watchMain({
      source: baseEnv(),
      argv: [],
      install: false,
      wsClientFactory: factory,
      stdout: { write: () => undefined },
    });
    await waitFor(() => sessions.length > 0, {
      message: "watch session to be created",
    });
    sessions[0]?.rejectRun("plain string boom" as unknown as Error);
    await expect(watchPromise).rejects.toThrow("exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
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

describe("watchMain — config-file startup", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrCapture: ReturnType<typeof captureStderr> | undefined;
  const roots: string[] = [];

  afterEach(async () => {
    exitSpy?.mockRestore();
    stderrCapture?.restore();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "snapper-mcp-watch-"));
    roots.push(root);
    return root;
  }

  it("starts from a config file when --config is present", async () => {
    const root = await tempRoot();
    const configPath = path.join(root, "env.json");
    await writeFile(
      configPath,
      JSON.stringify({
        SNAPPER_BASE_URL: "http://localhost:8000/api/mcp",
        SNAPPER_ACCESS_TOKEN: "config-access",
      }),
      { mode: 0o600 },
    );
    const { factory, sessions } = createCapturingFactory();
    const runPromise = watchMain({
      source: { SNAPPER_MCP_LOG_LEVEL: "error" } as NodeJS.ProcessEnv,
      argv: [`--config=${configPath}`],
      install: false,
      wsClientFactory: factory,
      stdout: { write: () => undefined },
    });
    await waitFor(() => sessions.length > 0, {
      message: "watch session to be created",
    });
    expect(sessions).toHaveLength(1);
    sessions[0]?.resolveRun();
    await runPromise;
  });

  it("waits for a config file that appears during startup", async () => {
    const root = await tempRoot();
    const configPath = path.join(root, "delayed-env.json");
    const timer = setTimeout(() => {
      void writeFile(
        configPath,
        JSON.stringify({
          SNAPPER_BASE_URL: "http://localhost:8000/api/mcp",
          SNAPPER_ACCESS_TOKEN: "config-access",
        }),
        { mode: 0o600 },
      );
    }, 100);
    const { factory, sessions } = createCapturingFactory();
    try {
      const runPromise = watchMain({
        source: { SNAPPER_MCP_LOG_LEVEL: "error" } as NodeJS.ProcessEnv,
        argv: [`--config=${configPath}`],
        install: false,
        wsClientFactory: factory,
        stdout: { write: () => undefined },
      });
      await waitFor(() => sessions.length > 0, {
        message: "watch session to be created after the config file appears",
      });
      expect(sessions).toHaveLength(1);
      sessions[0]?.resolveRun();
      await runPromise;
    } finally {
      clearTimeout(timer);
    }
  });

  it("falls through to environment variables when a config file remains missing", async () => {
    const root = await tempRoot();
    const { factory, sessions } = createCapturingFactory();
    const runPromise = watchMain({
      source: baseEnv(),
      argv: [`--config=${path.join(root, "missing-env.json")}`],
      install: false,
      wsClientFactory: factory,
      stdout: { write: () => undefined },
    });
    await waitFor(() => sessions.length > 0, {
      message: "watch session to be created after config-file retries",
    });
    expect(sessions).toHaveLength(1);
    sessions[0]?.resolveRun();
    await runPromise;
  });

  it("hard-fails when a missing config file leaves no watch token source", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit-was-called");
    });
    stderrCapture = captureStderr();
    const root = await tempRoot();
    await expect(
      watchMain({
        source: {
          SNAPPER_BASE_URL: "http://localhost:8000/api/mcp",
          SNAPPER_MCP_LOG_LEVEL: "error",
        } as NodeJS.ProcessEnv,
        argv: [`--config=${path.join(root, "missing-env.json")}`],
        install: false,
        wsClientFactory: () => ({
          run: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }) as unknown as WsClient,
        stdout: { write: () => undefined },
      }),
    ).rejects.toThrow("exit-was-called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderrText = stderrCapture.text();
    expect(stderrText).toMatch(/SNAPPER_ACCESS_TOKEN/);
    expect(stderrText).toMatch(/was not found after 1500ms/);
  });
});

describe("resolveSignalSource — default delegates to process.on/off", () => {
  it("returns the operator-supplied source unchanged when defined", () => {
    const fake = new FakeSignalSource();
    expect(resolveSignalSource(fake)).toBe(fake);
  });

  it("on/off methods call through to process.on/off when no source is supplied", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    const offSpy = vi.spyOn(process, "off").mockImplementation(() => process);
    try {
      const source = resolveSignalSource(undefined);
      const handler = (): void => undefined;
      source.on("SIGUSR2", handler);
      source.off("SIGUSR2", handler);
      expect(onSpy).toHaveBeenCalledWith("SIGUSR2", handler);
      expect(offSpy).toHaveBeenCalledWith("SIGUSR2", handler);
    } finally {
      onSpy.mockRestore();
      offSpy.mockRestore();
    }
  });
});

describe("watchMain — fetchWsToken wiring", () => {
  it("the captured fetchWsToken closure delegates to the underlying ws_token fetcher", async () => {
    const { factory, sessions } = createCapturingFactory();
    const runPromise = watchMain({
      source: baseEnv(),
      argv: [],
      install: false,
      wsClientFactory: factory,
      stdout: { write: () => undefined },
    });
    await waitFor(() => sessions.length > 0, {
      message: "watch session to be created",
    });
    const session = sessions[0];
    expect(session).toBeDefined();
    const fetchSpy = vi.fn().mockResolvedValue({
      access: "fresh",
      refresh: "fresh-refresh",
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await session?.options
        .fetchWsToken()
        .catch(() => undefined);
      expect(fetchSpy).toHaveBeenCalled();
      const callArgs = fetchSpy.mock.calls[0];
      const url = String(callArgs?.[0]);
      expect(url).toContain("/api/auth/ws_token");
    } finally {
      vi.unstubAllGlobals();
    }
    session?.resolveRun();
    await runPromise;
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
      await waitFor(() => sessions.length > 0, {
        message: "watch session to be created",
      });
      sessions[0]?.options.onFrame({
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
    await waitFor(() => sessions.length > 0, {
      message: "watch session to be created",
    });
    sessions[0]?.options.onFrame({
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
    await waitFor(() => chunks.length > 0, {
      message: "signal frame to reach the Web Streams stdout target",
    });
    expect(chunks.join("")).toContain('"type":"signal"');
    sessions[0]?.resolveRun();
    await runPromise;
  });

  it("swallows rejected writes from a Web Streams stdout target", async () => {
    const write = vi.fn().mockRejectedValue(new Error("closed"));
    const writableStream = {
      getWriter: () => ({
        write,
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
    await waitFor(() => sessions.length > 0, {
      message: "watch session to be created",
    });
    sessions[0]?.options.onFrame({
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
    await waitFor(() => write.mock.calls.length > 0, {
      message: "Web Streams stdout write to be recorded",
    });
    expect(write).toHaveBeenCalled();
    sessions[0]?.resolveRun();
    await runPromise;
  });
});
