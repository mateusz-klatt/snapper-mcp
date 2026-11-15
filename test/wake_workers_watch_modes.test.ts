import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KIMI_EXIT_ATTENTION,
  KIMI_EXIT_DISABLED,
  KIMI_EXIT_DUPLICATE,
  KIMI_EXIT_EXPIRED,
  KIMI_EXIT_FAILED,
  KIMI_OUTCOME_LINES,
  SNAPPER_COPILOT_ATTENTION_LINE,
  SNAPPER_KIMI_ATTENTION_LINE,
  SNAPPER_WAKE_PROMPT,
} from "../src/actionable.js";
import type { BridgeEnv } from "../src/env.js";
import type { ParentProcessSnapshot } from "../src/interactive.js";
import { createLogger, setStderrWriterForTests } from "../src/logger.js";
import { extractProxyWakeArgs } from "../src/main.js";
import { acquireSessionLock, writeWakePreference } from "../src/state_dir.js";
import type { AiReviewDecisionAckFrame, AiReviewRequestFrame, ServerFrame } from "../src/types.js";
import {
  consumeCursorFollowup,
  publishAntigravityHelper,
  readAntigravityWakeState,
  readCodexWakeState,
  recordAntigravityTurnEvent,
  recordCodexSession,
} from "../src/wake_state.js";
import {
  AGY_HELPER_ENV,
  createActionableFilter,
  probeCodexThreadIdleViaProxy,
  queueCodexWakeMessage,
  runAntigravityWakeCommand,
  sendAntigravityWakeMessage,
  startCodexWakeWorker,
  startCursorWakeWorker,
  validateLoopbackLanguageServer,
} from "../src/wake_workers.js";
import { parseWatchArgs, WatchArgsError, watchMain } from "../src/watch.js";
import type { WsClient, WsClientOptions } from "../src/ws_client.js";
import { CAN_LISTEN_ON_LOOPBACK } from "./helpers/listen_capability.js";
import { waitFor } from "./helpers/wait_for.js";

const OWN_DELEGATE = "0192f000-0000-7000-8000-dddddddddddd";
const FOREIGN_DELEGATE = "0192f000-0000-7000-8000-eeeeeeeeeeee";

function makeReviewRequest(
  overrides: Partial<AiReviewRequestFrame> = {},
): AiReviewRequestFrame {
  return {
    type: "ai_review.request",
    session_id: "0192f000-0000-7000-8000-000000000001",
    sequence_id: 1,
    public_id: "0192f000-0000-7000-8000-aaaaaaaaaaaa",
    timestamp: "2026-08-01T12:00:00.000Z",
    topic: "ai_reviews.user.strategy.request",
    review_public_id: "0192f000-0000-7000-8000-bbbbbbbbbbbb",
    user_public_id: "0192f000-0000-7000-8000-111111111111",
    strategy_public_id: "0192f000-0000-7000-8000-222222222222",
    wallet_public_id: "0192f000-0000-7000-8000-333333333333",
    instrument_public_id: "0192f000-0000-7000-8000-444444444444",
    selected_delegate_public_id: OWN_DELEGATE,
    deadline: "2026-08-01T12:01:00.000Z",
    signal_envelope: { instrument: "BTC-USD" },
    instrument_metadata: {},
    dispatch_version: 0,
    ...overrides,
  };
}

function makeDecisionAck(
  overrides: Partial<AiReviewDecisionAckFrame> = {},
): AiReviewDecisionAckFrame {
  return {
    type: "ai_review.decision_ack",
    session_id: "0192f000-0000-7000-8000-000000000001",
    sequence_id: 2,
    public_id: "0192f000-0000-7000-8000-cccccccccccc",
    timestamp: "2026-08-01T12:00:15.000Z",
    topic: "ai_reviews.user.strategy.decision_ack",
    review_public_id: "0192f000-0000-7000-8000-bbbbbbbbbbbb",
    user_public_id: "0192f000-0000-7000-8000-111111111111",
    strategy_public_id: "0192f000-0000-7000-8000-222222222222",
    wallet_public_id: "0192f000-0000-7000-8000-333333333333",
    instrument_public_id: "0192f000-0000-7000-8000-444444444444",
    responding_delegate_public_id: OWN_DELEGATE,
    decision: "approve",
    new_status: "resolved_approved",
    resolution_mode: "primary",
    rationale: "ok",
    dispatch_version: 0,
    ...overrides,
  };
}

function createFakeWsFactory(): {
  readonly factory: (opts: WsClientOptions) => WsClient;
  readonly isReady: () => boolean;
  readonly emit: (frame: ServerFrame) => void;
} {
  let activeOpts: WsClientOptions | null = null;
  let resolveRun: (() => void) | null = null;
  const factory = (opts: WsClientOptions): WsClient => {
    activeOpts = opts;
    return {
      run: () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
      close: () => {
        resolveRun?.();
        return Promise.resolve();
      },
    };
  };
  return {
    factory,
    isReady: () => activeOpts !== null,
    emit: (frame: ServerFrame) => {
      activeOpts?.onFrame(frame);
    },
  };
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

beforeEach(() => {
  setStderrWriterForTests(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ payload: { delegate_public_id: OWN_DELEGATE } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  );
});

afterEach(() => {
  setStderrWriterForTests(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createActionableFilter", () => {
  it("emits own requests immediately and holds foreign requests for 30s unless acked", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:05.000Z"));
    const seen: string[] = [];
    const filter = createActionableFilter({
      delegatePublicId: OWN_DELEGATE,
      onActionable: (kind) => seen.push(kind),
    });

    filter.onFrame(makeReviewRequest({ review_public_id: "r-own" }));
    expect(seen).toEqual(["ai_review"]);

    filter.onFrame(
      makeReviewRequest({
        review_public_id: "r-foreign-acked",
        selected_delegate_public_id: FOREIGN_DELEGATE,
      }),
    );
    filter.onFrame(makeDecisionAck({ review_public_id: "r-foreign-acked" }));
    vi.advanceTimersByTime(35_000);
    expect(seen).toEqual(["ai_review"]);

    vi.setSystemTime(new Date("2026-08-01T12:00:05.000Z"));
    filter.onFrame(
      makeReviewRequest({
        review_public_id: "r-foreign-released",
        selected_delegate_public_id: FOREIGN_DELEGATE,
      }),
    );
    vi.advanceTimersByTime(30_000);
    expect(seen).toEqual(["ai_review", "ai_review"]);

    filter.onFrame(
      makeReviewRequest({
        review_public_id: "r-bad-ts",
        selected_delegate_public_id: FOREIGN_DELEGATE,
        timestamp: "not-a-date",
      }),
    );
    expect(seen).toHaveLength(3);

    filter.dispose();
  });
});

describe("Cursor and Codex wake workers", () => {
  let stateDir: string;
  let bridgeEnv: BridgeEnv;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "snapper-workers-"));
    bridgeEnv = {
      baseUrl: new URL("http://localhost:8000/api/mcp/"),
      accessToken: "tok",
    };
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("updates Cursor sequence state when startCursorWakeWorker receives actionable frames", async () => {
    const { factory, emit } = createFakeWsFactory();
    const logger = createLogger("test-cursor", { SNAPPER_MCP_LOG_LEVEL: "error" });
    const worker = await startCursorWakeWorker({
      env: bridgeEnv,
      stateDir,
      logger,
      wsClientFactory: factory,
    });
    emit(makeReviewRequest());
    let consumed = false;
    for (let i = 0; i < 100 && !consumed; i += 1) {
      consumed = await consumeCursorFollowup(stateDir);
      if (!consumed) await new Promise((r) => setTimeout(r, 10));
    }
    expect(consumed).toBe(true);
    await worker.close();
  });

  it("probes Codex idle state, retries when busy, and queues wake prompt when idle", async () => {
    const threadId = "11111111-1111-4111-8111-111111111111";
    await recordCodexSession({
      stateDir,
      codexPid: 9000,
      codexStartToken: "tok-9000",
      threadId,
      consumeReservation: false,
    });

    let probeCount = 0;
    const queuedMessages: Array<{ threadId: string; msg: string }> = [];
    const { factory, emit } = createFakeWsFactory();
    const logger = createLogger("test-codex", { SNAPPER_MCP_LOG_LEVEL: "error" });

    const worker = await startCodexWakeWorker({
      env: bridgeEnv,
      stateDir,
      logger,
      wsClientFactory: factory,
      isPidAlive: () => true,
      settleMs: 10,
      pollMs: 15,
      idleProbe: () => {
        probeCount += 1;
        return Promise.resolve(probeCount >= 2);
      },
      queueSender: (tid, msg) => {
        queuedMessages.push({ threadId: tid, msg });
        return Promise.resolve(true);
      },
    });

    emit(makeReviewRequest());
    await waitFor(
      async () =>
        queuedMessages.length === 1 &&
        (await readCodexWakeState(stateDir)).deliveredSeq === 1,
      { message: "Codex wake message queued and settled" },
    );
    expect(queuedMessages[0]).toEqual({ threadId, msg: SNAPPER_WAKE_PROMPT });
    await worker.close();
  });

  it("runs probeCodexThreadIdleViaProxy and queueCodexWakeMessage against local mock scripts", async () => {
    const threadId = "22222222-2222-4222-8222-222222222222";
    expect(
      await probeCodexThreadIdleViaProxy(threadId, "/nonexistent/codex-bin", 500),
    ).toBe(false);

    if (CAN_LISTEN_ON_LOOPBACK) {
      let currentStatus = "idle";
      const httpServer = http.createServer();
      const wss = new WebSocketServer({ server: httpServer });
      wss.on("connection", (ws) => {
        ws.on("message", (raw) => {
          const text =
            typeof raw === "string"
              ? raw
              : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : Buffer.from(raw as ArrayBuffer).toString("utf8");
          const msg = JSON.parse(text) as {
            readonly id?: number;
            readonly params?: { readonly threadId?: string };
          };
          if (msg.id === 1) {
            ws.send(JSON.stringify({ id: 1, result: { serverInfo: { name: "mock" } } }));
          } else if (msg.id === 2) {
            ws.send(
              JSON.stringify({
                id: 2,
                result: {
                  thread: {
                    id: msg.params?.threadId,
                    status: { type: currentStatus },
                  },
                },
              }),
            );
          }
        });
      });
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      const port = (httpServer.address() as net.AddressInfo).port;

      const proxyScript = path.join(stateDir, "mock-codex-proxy.mjs");
      await writeFile(
        proxyScript,
        [
          "#!/usr/bin/env node",
          `import net from "node:net";`,
          `const sock = net.createConnection({ host: "127.0.0.1", port: ${port} });`,
          `process.stdin.pipe(sock);`,
          `sock.pipe(process.stdout);`,
          `sock.on("close", () => process.exit(0));`,
        ].join("\n"),
        { mode: 0o755 },
      );
      await chmod(proxyScript, 0o755);

      try {
        expect(await probeCodexThreadIdleViaProxy(threadId, proxyScript, 2_000)).toBe(true);
        currentStatus = "active";
        expect(await probeCodexThreadIdleViaProxy(threadId, proxyScript, 2_000)).toBe(false);
      } finally {
        wss.close();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    }

    const queueScript = path.join(stateDir, "mock-codex-queue.mjs");
    await writeFile(
      queueScript,
      [
        "#!/usr/bin/env node",
        `const idx = process.argv.indexOf("--thread");`,
        `const tid = idx >= 0 ? process.argv[idx + 1] : "none";`,
        `process.stdout.write(\`Queued message m_1 for thread \${tid}.\\n\`);`,
      ].join("\n"),
      { mode: 0o755 },
    );
    await chmod(queueScript, 0o755);

    expect(await queueCodexWakeMessage(threadId, "hello", queueScript, 2_000)).toBe(true);
    expect(
      await queueCodexWakeMessage(threadId, "hello", "/nonexistent/codex-bin", 500),
    ).toBe(false);
  });
});

describe("Antigravity loopback validation, sender, launcher, and helper", () => {
  let stateDir: string;
  let bridgeEnv: BridgeEnv;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "snapper-agy-"));
    bridgeEnv = {
      baseUrl: new URL("http://localhost:8000/api/mcp/"),
      accessToken: "tok",
    };
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("validates loopback addresses and rejects non-loopback or unreachable targets", async () => {
    await expect(validateLoopbackLanguageServer(undefined)).rejects.toThrow(/missing/);
    await expect(validateLoopbackLanguageServer("bad")).rejects.toThrow(/invalid/);
    await expect(validateLoopbackLanguageServer("[::1]")).rejects.toThrow(/invalid IPv6/);
    await expect(validateLoopbackLanguageServer("127.0.0.1:99999")).rejects.toThrow(/port/);
    await expect(validateLoopbackLanguageServer("192.168.1.5:4000")).rejects.toThrow(/loopback/);

    const ipv6Resolved = await validateLoopbackLanguageServer(
      "localhost:4321",
      (host) => Promise.resolve(host === "::1"),
    );
    expect(ipv6Resolved).toBe("[::1]:4321");

    await expect(
      validateLoopbackLanguageServer("127.0.0.1:4321", () => Promise.resolve(false)),
    ).rejects.toThrow(/unreachable/);

    if (CAN_LISTEN_ON_LOOPBACK) {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address() as net.AddressInfo;
      try {
        const canonical = await validateLoopbackLanguageServer(`127.0.0.1:${addr.port}`);
        expect(canonical).toBe(`127.0.0.1:${addr.port}`);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("sends Antigravity wake message via mock agy executable", async () => {
    const convId = "33333333-3333-4333-8333-333333333333";
    const agyScript = path.join(stateDir, "mock-agy.mjs");
    await writeFile(
      agyScript,
      [
        "#!/usr/bin/env node",
        `const id = process.argv[4];`,
        `process.stdout.write(JSON.stringify({ response: { sendMessage: { recipientId: id } } }));`,
      ].join("\n"),
      { mode: 0o755 },
    );
    await chmod(agyScript, 0o755);

    expect(
      await sendAntigravityWakeMessage({
        agyExecutable: agyScript,
        conversationId: convId,
        message: SNAPPER_WAKE_PROMPT,
        env: process.env,
      }),
    ).toBe(true);

    expect(
      await sendAntigravityWakeMessage({
        agyExecutable: "/nonexistent/agy",
        conversationId: convId,
        message: SNAPPER_WAKE_PROMPT,
        env: process.env,
      }),
    ).toBe(false);
  });

  it("launches Antigravity helper once, latches on failure, and delivers in helper mode", async () => {
    const convId = "44444444-4444-4444-8444-444444444444";
    const logger = createLogger("test-agy", { SNAPPER_MCP_LOG_LEVEL: "error" });
    const parent: ParentProcessSnapshot = {
      pid: 6100,
      ppid: 1,
      startToken: "st-6100",
      executableName: "agy",
      argv: ["agy"],
      readsTerminal: true,
    };

    const codeDisabled = await runAntigravityWakeCommand({
      env: bridgeEnv,
      configPath: path.join(stateDir, "config.json"),
      stateDir,
      source: {
        ANTIGRAVITY_CONVERSATION_ID: convId,
        ANTIGRAVITY_CSRF_TOKEN: "csrf-ok",
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
      },
      logger,
      inspector: () => Promise.resolve(parent),
      dialTcp: () => Promise.resolve(true),
    });
    expect(codeDisabled).toBe(1);
    expect((await readAntigravityWakeState(stateDir)).latchedFailed).toBe(true);

    await writeWakePreference(stateDir, "antigravity", "on", "linux");
    await recordAntigravityTurnEvent({
      stateDir,
      agyPid: 6100,
      agyStartToken: "st-6100",
      conversationId: convId,
      idle: true,
      clearReservation: true,
    });

    let spawnedEnv: NodeJS.ProcessEnv | null = null;
    const codeLaunch = await runAntigravityWakeCommand({
      env: bridgeEnv,
      configPath: path.join(stateDir, "config.json"),
      stateDir,
      source: {
        ANTIGRAVITY_CONVERSATION_ID: convId,
        ANTIGRAVITY_CSRF_TOKEN: "csrf-ok",
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
      },
      logger,
      inspector: () => Promise.resolve(parent),
      isPidAlive: () => true,
      dialTcp: () => Promise.resolve(true),
      spawnDetached: ({ env }) => {
        spawnedEnv = env;
        return 7777;
      },
    });
    expect(codeLaunch).toBe(0);
    expect(spawnedEnv).not.toBeNull();

    const codeAlreadyLive = await runAntigravityWakeCommand({
      env: bridgeEnv,
      configPath: path.join(stateDir, "config.json"),
      stateDir,
      source: {
        ANTIGRAVITY_CONVERSATION_ID: convId,
        ANTIGRAVITY_CSRF_TOKEN: "csrf-ok",
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
      },
      logger,
      inspector: () => Promise.resolve(parent),
      isPidAlive: (pid) => pid === 7777,
      dialTcp: () => Promise.resolve(true),
    });
    expect(codeAlreadyLive).toBe(0);

    await publishAntigravityHelper({
      stateDir,
      record: {
        agyPid: 6100,
        agyStartToken: "st-6100",
        helperPid: 7777,
        conversationId: convId,
        attemptId: "att",
      },
    });

    let parentAlive = true;
    const delivered: string[] = [];
    const { factory, isReady, emit } = createFakeWsFactory();
    const helperPromise = runAntigravityWakeCommand({
      env: bridgeEnv,
      configPath: path.join(stateDir, "config.json"),
      stateDir,
      source: spawnedEnv!,
      logger,
      isPidAlive: () => parentAlive,
      dialTcp: () => Promise.resolve(true),
      wsClientFactory: factory,
      settleMs: 10,
      pollMs: 15,
      sendMessage: ({ message }) => {
        delivered.push(message);
        parentAlive = false;
        return Promise.resolve(true);
      },
    });

    await waitFor(isReady, { message: "Antigravity helper stream ready" });
    emit(makeReviewRequest());
    expect(await helperPromise).toBe(0);
    expect(delivered).toEqual([SNAPPER_WAKE_PROMPT]);

    expect(
      await runAntigravityWakeCommand({
        env: bridgeEnv,
        configPath: path.join(stateDir, "config.json"),
        stateDir,
        source: { [AGY_HELPER_ENV]: "{invalid-json" },
        logger,
      }),
    ).toBe(1);
  });
});

describe("watchMain & extractProxyWakeArgs multi-client modes", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "snapper-watch-modes-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("parses watch client/wake flags and proxy wake flags", () => {
    const parsed = parseWatchArgs([
      "--client=kimi",
      "--once",
      "--wake",
      "--wake-on",
      "signal",
      "--wake-on=order_event",
    ]);
    expect(parsed.client).toBe("kimi");
    expect(parsed.once).toBe(true);
    expect(parsed.wake).toBe(true);
    expect(parsed.actionableOnly).toBe(true);
    expect([...parsed.wakeKinds]).toEqual(["signal", "order_event"]);

    const allFrames = parseWatchArgs(["--client", "copilot", "--all-frames"]);
    expect(allFrames.client).toBe("copilot");
    expect(allFrames.actionableOnly).toBe(false);

    expect(() => parseWatchArgs(["--client"])).toThrow(WatchArgsError);
    expect(() => parseWatchArgs(["--client=invalid"])).toThrow(WatchArgsError);
    expect(() => parseWatchArgs(["--wake-on"])).toThrow(WatchArgsError);
    expect(() => parseWatchArgs(["--wake-on=bad"])).toThrow(WatchArgsError);

    const proxy = extractProxyWakeArgs(["--client", "codex", "--wake", "--config", "/tmp/c.json"]);
    expect(proxy).toEqual({
      client: "codex",
      wake: true,
      filteredArgv: ["--config", "/tmp/c.json"],
    });
    const proxyOff = extractProxyWakeArgs(["--client=cursor", "--no-wake"]);
    expect(proxyOff).toEqual({
      client: "cursor",
      wake: false,
      filteredArgv: [],
    });
    expect(() => extractProxyWakeArgs(["--client"])).toThrow(/requires a CLI name/);
    expect(() => extractProxyWakeArgs(["--client=bad"])).toThrow(/unsupported --client value/);
  });

  it("enforces Kimi exit codes (0, 10, 11, 12, 13) and Copilot/Kimi attention lines", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never);

    const runExpectingExit = async (run: () => Promise<void>): Promise<number> => {
      try {
        await run();
        return -1;
      } catch (err) {
        if (err instanceof ExitSignal) return err.code;
        throw err;
      }
    };

    const badArgLines: string[] = [];
    expect(
      await runExpectingExit(() =>
        watchMain({
          argv: ["--client", "kimi", "--once", "--unknown-flag"],
          source: { SNAPPER_MCP_HOME: stateDir },
          stdout: { write: (s: string) => badArgLines.push(s) },
          install: false,
        }),
      ),
    ).toBe(KIMI_EXIT_FAILED);
    expect(badArgLines).toEqual([`${KIMI_OUTCOME_LINES[KIMI_EXIT_FAILED]}\n`]);

    const missingEnvLines: string[] = [];
    const emptyCfgPath = path.join(stateDir, "empty-config.json");
    await writeFile(emptyCfgPath, "{}", { mode: 0o600 });
    await chmod(emptyCfgPath, 0o600);
    expect(
      await runExpectingExit(() =>
        watchMain({
          argv: ["--client=kimi", "--once", "--config", emptyCfgPath],
          source: { SNAPPER_MCP_HOME: stateDir },
          stdout: { write: (s: string) => missingEnvLines.push(s) },
          install: false,
        }),
      ),
    ).toBe(KIMI_EXIT_FAILED);
    expect(missingEnvLines).toEqual([`${KIMI_OUTCOME_LINES[KIMI_EXIT_FAILED]}\n`]);

    await writeFile(
      path.join(stateDir, "config.json"),
      JSON.stringify({
        SNAPPER_BASE_URL: "http://localhost:8000/api/mcp",
        SNAPPER_ACCESS_TOKEN: "tok",
      }),
      { mode: 0o600 },
    );
    await chmod(path.join(stateDir, "config.json"), 0o600);
    const baseSource = {
      SNAPPER_MCP_HOME: stateDir,
    };

    await writeWakePreference(stateDir, "kimi", "off", "linux");
    const disabledLines: string[] = [];
    expect(
      await runExpectingExit(() =>
        watchMain({
          argv: ["--client", "kimi", "--once"],
          source: baseSource,
          stdout: { write: (s: string) => disabledLines.push(s) },
          install: false,
        }),
      ),
    ).toBe(KIMI_EXIT_DISABLED);
    expect(disabledLines).toEqual([`${KIMI_OUTCOME_LINES[KIMI_EXIT_DISABLED]}\n`]);

    await writeWakePreference(stateDir, "kimi", "on", "linux");
    const heldLock = await acquireSessionLock({
      stateDir,
      client: "kimi",
      sessionKey: "sess-dup",
      pid: 4000,
      isPidAlive: () => true,
    });
    const dupLines: string[] = [];
    expect(
      await runExpectingExit(() =>
        watchMain({
          argv: ["--client", "kimi", "--once"],
          source: baseSource,
          sessionKey: "sess-dup",
          pid: 4001,
          isPidAlive: () => true,
          stdout: { write: (s: string) => dupLines.push(s) },
          install: false,
        }),
      ),
    ).toBe(KIMI_EXIT_DUPLICATE);
    expect(dupLines).toEqual([`${KIMI_OUTCOME_LINES[KIMI_EXIT_DUPLICATE]}\n`]);
    await heldLock.release();

    const expWs = createFakeWsFactory();
    const expLines: string[] = [];
    expect(
      await runExpectingExit(() =>
        watchMain({
          argv: ["--client", "kimi", "--once"],
          source: baseSource,
          sessionKey: "sess-exp",
          onceLifetimeMs: 20,
          wsClientFactory: expWs.factory,
          stdout: { write: (s: string) => expLines.push(s) },
          install: false,
        }),
      ),
    ).toBe(KIMI_EXIT_EXPIRED);
    expect(expLines).toEqual([`${KIMI_OUTCOME_LINES[KIMI_EXIT_EXPIRED]}\n`]);

    const okWs = createFakeWsFactory();
    const okLines: string[] = [];
    const okRun = runExpectingExit(() =>
      watchMain({
        argv: ["--client", "kimi", "--once"],
        source: baseSource,
        sessionKey: "sess-ok",
        wsClientFactory: okWs.factory,
        stdout: { write: (s: string) => okLines.push(s) },
        install: false,
      }),
    );
    await waitFor(okWs.isReady, { message: "Kimi once ws ready" });
    okWs.emit(makeDecisionAck());
    okWs.emit(makeReviewRequest());
    expect(await okRun).toBe(KIMI_EXIT_ATTENTION);
    expect(okLines).toEqual([`${SNAPPER_KIMI_ATTENTION_LINE}\n`]);

    const copilotWs = createFakeWsFactory();
    const copilotLines: string[] = [];
    const copilotRun = runExpectingExit(() =>
      watchMain({
        argv: ["--client", "copilot", "--once"],
        source: { ...baseSource, COPILOT_AGENT_SESSION_ID: "cp-1" },
        wsClientFactory: copilotWs.factory,
        stdout: { write: (s: string) => copilotLines.push(s) },
        install: false,
      }),
    );
    await waitFor(copilotWs.isReady, { message: "Copilot once ws ready" });
    copilotWs.emit(makeReviewRequest());
    expect(await copilotRun).toBe(0);
    expect(copilotLines).toEqual([`${SNAPPER_COPILOT_ATTENTION_LINE}\n`]);

    exitSpy.mockRestore();
  });
});
