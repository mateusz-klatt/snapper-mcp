import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { TransformStream } from "node:stream/web";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { renderCopilotExtensionEntry } from "../src/copilot_extension.js";
import { doctorMain, parseDoctorArgs } from "../src/doctor.js";
import type { BridgeEnv } from "../src/env.js";
import { hookMain, parseHookArgs } from "../src/hook.js";
import { integrateMain, parseIntegrateArgs } from "../src/integrate.js";
import {
  agyMode,
  cursorMode,
  grokMode,
  inspectDarwinProcess,
  inspectParentProcess,
  inspectWin32Process,
  kimiMode,
  type ParentProcessSnapshot,
} from "../src/interactive.js";
import { createLogger, setStderrWriterForTests } from "../src/logger.js";
import { main } from "../src/main.js";
import {
  acquireSessionLock,
  assertNotSymlinkOrSpecial,
  defaultIsPidAlive,
  loadManifest,
  mutateLockedJsonFile,
  readRuntimeJsonFile,
  readWakePreference,
  resolveHomeDir,
  resolveStateDir,
  UnsafeFileTargetError,
  unwireManagedClient,
  updateManagedFile,
  writeWakePreference,
} from "../src/state_dir.js";
import {
  inspectCodexSnapperBlock,
  inspectGrokSnapperTable,
  inspectKimiHooksBlock,
  removeCodexSnapperBlock,
  removeGrokSnapperTable,
  removeKimiHooksBlock,
  removeMarkedBlock,
  TomlEditError,
  upsertCodexSnapperBlock,
  upsertGrokSnapperTable,
  upsertKimiHooksBlock,
  upsertMarkedBlock,
  validateKimiHooksBlock,
} from "../src/toml_edit.js";
import type { AiReviewRequestFrame, ServerFrame } from "../src/types.js";
import {
  publishAntigravityHelper,
  recordAntigravityTurnEvent,
  recordCodexSession,
} from "../src/wake_state.js";
import {
  AGY_HELPER_ENV,
  createActionableFilter,
  probeCodexThreadIdleViaProxy,
  runAntigravityWakeCommand,
  startCodexWakeWorker,
  startCursorWakeWorker,
  validateLoopbackLanguageServer,
} from "../src/wake_workers.js";
import { parseWatchArgs, watchMain } from "../src/watch.js";
import type { WsClient, WsClientOptions } from "../src/ws_client.js";
import { CAN_LISTEN_ON_LOOPBACK } from "./helpers/listen_capability.js";
import { makeMockSnapperServer, type MockSnapperServer } from "./helpers/mock_snapper_server.js";
import { waitFor } from "./helpers/wait_for.js";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll(/=+$/g, "");
}

function makeJwt(expOffsetSec: number): string {
  const h = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = encodeBase64Url(
    JSON.stringify({
      sub: "u-1",
      role: "AI_DELEGATE",
      exp: Math.floor(Date.now() / 1000) + expOffsetSec,
    }),
  );
  return `${h}.${p}.sig`;
}

function makeReviewRequest(): AiReviewRequestFrame {
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
    selected_delegate_public_id: "0192f000-0000-7000-8000-dddddddddddd",
    deadline: "2026-08-01T12:01:00.000Z",
    signal_envelope: { instrument: "BTC-USD" },
    instrument_metadata: {},
    dispatch_version: 0,
  };
}

class TextSink {
  private readonly chunks: string[] = [];
  write = (c: string | Uint8Array): boolean => {
    this.chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  };
  text(): string {
    return this.chunks.join("");
  }
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

describe("state_dir & toml_edit edge cases", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "snapper-edges-state-"));
    setStderrWriterForTests(() => undefined);
  });

  afterEach(async () => {
    setStderrWriterForTests(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("covers PID liveness, home/state resolution across OSes, symlinks, stale locks, and manifests", async () => {
    expect(defaultIsPidAlive(0)).toBe(false);
    expect(defaultIsPidAlive(-5)).toBe(false);
    expect(defaultIsPidAlive(process.pid)).toBe(true);
    expect(defaultIsPidAlive(999_999_999)).toBe(false);

    expect(resolveHomeDir({}, "linux").length).toBeGreaterThan(0);
    expect(resolveHomeDir({ USERPROFILE: "/win/home" }, "win32")).toBe(
      path.resolve("/win/home"),
    );
    expect(resolveStateDir({ HOME: "/u" }, "darwin")).toBe(
      path.join(path.resolve("/u"), "Library", "Application Support", "snapper-mcp"),
    );
    expect(resolveStateDir({ USERPROFILE: "/u", APPDATA: "/app" }, "win32")).toBe(
      path.resolve("/app", "snapper-mcp"),
    );
    expect(resolveStateDir({ USERPROFILE: "/u" }, "win32")).toBe(
      path.join(path.resolve("/u"), "AppData", "Roaming", "snapper-mcp"),
    );
    expect(resolveStateDir({ HOME: "/u", XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(
      path.resolve("/xdg", "snapper-mcp"),
    );
    expect(resolveStateDir({ HOME: "/u" }, "linux")).toBe(
      path.join(path.resolve("/u"), ".config", "snapper-mcp"),
    );

    const targetFile = path.join(dir, "real.txt");
    await writeFile(targetFile, "hi", "utf8");
    const symPath = path.join(dir, "sym.txt");
    await symlink(targetFile, symPath);
    await expect(assertNotSymlinkOrSpecial(symPath)).rejects.toThrow(UnsafeFileTargetError);
    await expect(assertNotSymlinkOrSpecial(dir, false)).rejects.toThrow(UnsafeFileTargetError);

    const locksDir = path.join(dir, "locks");
    await mkdir(locksDir, { recursive: true });
    const firstLock = await acquireSessionLock({
      stateDir: dir,
      client: "kimi",
      sessionKey: "s-corrupt",
      pid: 999_999_999,
      isPidAlive: () => false,
    });
    expect(firstLock.acquired).toBe(true);
    const recoveredLock = await acquireSessionLock({
      stateDir: dir,
      client: "kimi",
      sessionKey: "s-corrupt",
      pid: process.pid,
      isPidAlive: (pid) => pid === process.pid,
    });
    expect(recoveredLock.acquired).toBe(true);
    await recoveredLock.release();

    const runtimeDir = path.join(dir, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "sample.mutex"), "{corrupt", "utf8");
    await writeFile(path.join(runtimeDir, "sample.json"), "{corrupt", "utf8");
    const val = await mutateLockedJsonFile({
      stateDir: dir,
      name: "sample",
      initial: () => ({ n: 1 }),
      mutate: (cur) => ({ next: { n: cur.n + 1 }, result: cur.n + 1 }),
    });
    expect(val).toBe(2);

    await writeFile(path.join(runtimeDir, "bad-rt.json"), "{corrupt", "utf8");
    expect(await readRuntimeJsonFile(dir, "bad-rt", () => ({ ok: true }))).toEqual({
      ok: true,
    });

    await mkdir(path.join(dir, "wake"), { recursive: true });
    await writeFile(path.join(dir, "wake", "grok.pref"), "bogus\n", "utf8");
    await expect(readWakePreference(dir, "grok")).rejects.toThrow(/invalid wake preference/);

    await writeFile(path.join(dir, "manifest.json"), "{bad", "utf8");
    await expect(loadManifest(dir)).rejects.toThrow(/not valid JSON/);
    await writeFile(path.join(dir, "manifest.json"), '{"version":2}', "utf8");
    await expect(loadManifest(dir)).rejects.toThrow(/unsupported format/);
    await unlink(path.join(dir, "manifest.json"));

    const managed = path.join(dir, "sub", "managed.json");
    await updateManagedFile({
      stateDir: dir,
      client: "grok",
      targetPath: managed,
      render: () => '{"a":1}\n',
    });
    await updateManagedFile({
      stateDir: dir,
      client: "grok",
      targetPath: managed,
      render: () => '{"a":1}\n',
    });
    await writeFile(managed, '{"a":2}\n', "utf8");
    await unwireManagedClient({
      stateDir: dir,
      client: "grok",
      strip: () => null,
    });
  });

  it("covers toml_edit Date cloning and inspection/marker error branches", () => {
    const withDate = upsertMarkedBlock("ts = 2026-08-01T12:00:00Z\n", 'foo = "bar"');
    expect(removeMarkedBlock(withDate)).toContain("2026-08-01T12:00:00Z");
    expect(
      removeMarkedBlock("a = 1\n# BEGIN snapper-mcp\nx = 2\n# END snapper-mcp\nb = 3\n"),
    ).toBe("a = 1\n\nb = 3\n");

    expect(() =>
      removeMarkedBlock("# BEGIN snapper-mcp\na = 1\n# BEGIN snapper-mcp\n# END snapper-mcp\n"),
    ).toThrow(TomlEditError);
    expect(() =>
      removeMarkedBlock("# END snapper-mcp\na = 1\n# BEGIN snapper-mcp\n"),
    ).toThrow(TomlEditError);

    expect(inspectCodexSnapperBlock("a = 1")).toEqual({
      configured: false,
      wakeEnabled: false,
    });
    expect(inspectCodexSnapperBlock("[mcp_servers]\nsnapper = 1\n")).toEqual({
      configured: false,
      wakeEnabled: false,
    });
    expect(
      inspectCodexSnapperBlock('[mcp_servers.snapper]\ncommand = ""\nargs = []\n'),
    ).toEqual({ configured: false, wakeEnabled: false });
    expect(
      inspectCodexSnapperBlock('[mcp_servers.snapper]\ncommand = "x"\nargs = [1]\n'),
    ).toEqual({ configured: false, wakeEnabled: false });
    expect(
      inspectCodexSnapperBlock('[mcp_servers.snapper]\ncommand = "x"\nargs = ["--foo"]\n'),
    ).toEqual({ configured: false, wakeEnabled: false });
    expect(
      inspectCodexSnapperBlock(
        '[mcp_servers.snapper]\ncommand = "x"\nargs = ["--client", "codex"]\n',
      ),
    ).toEqual({ configured: false, wakeEnabled: false });
    expect(inspectCodexSnapperBlock("bad = [")).toEqual({
      configured: false,
      wakeEnabled: false,
    });

    expect(inspectGrokSnapperTable("a = 1")).toBe(false);
    expect(inspectGrokSnapperTable("[mcp_servers]\nsnapper = 1\n")).toBe(false);
    expect(inspectGrokSnapperTable("bad = [")).toBe(false);
    expect(inspectKimiHooksBlock("a = 1")).toBe(false);
    expect(inspectKimiHooksBlock("hooks = [1]\n")).toBe(false);
    expect(inspectKimiHooksBlock("bad = [")).toBe(false);
    expect(() => validateKimiHooksBlock("hooks = [1]\n")).toThrow(TomlEditError);
    expect(() => validateKimiHooksBlock("other = 1\n")).toThrow(TomlEditError);
    expect(() => validateKimiHooksBlock('[[hooks]]\nevent = "Stop"\nbad = 1\n')).toThrow(
      TomlEditError,
    );

    const poisonedMarked = "# BEGIN snapper-mcp\nuser_secret = 42\n# END snapper-mcp\n";
    expect(() =>
      upsertCodexSnapperBlock(poisonedMarked, {
        command: "snapper-mcp",
        configPath: "/c",
        wake: true,
      }),
    ).toThrow(TomlEditError);
    expect(() => removeCodexSnapperBlock(poisonedMarked)).toThrow(TomlEditError);
    expect(
      upsertGrokSnapperTable(poisonedMarked, { command: "snapper-mcp", configPath: "/c" }),
    ).toContain("user_secret = 42");
    expect(removeGrokSnapperTable(poisonedMarked)).toContain("user_secret = 42");
    expect(() =>
      upsertKimiHooksBlock(poisonedMarked, [
        { event: "Stop", command: "snapper-mcp hook --client kimi", timeout: 5 },
      ]),
    ).toThrow(TomlEditError);
    expect(() => removeKimiHooksBlock(poisonedMarked)).toThrow(TomlEditError);

    // Inline dotted snapper table forces canonical AST re-serialization fallback:
    const inlineGrok = 'other = 1\nmcp_servers.snapper = { command = "old", enabled = true }\n';
    const strippedInline = removeGrokSnapperTable(inlineGrok);
    expect(strippedInline).toContain("other = 1");
    expect(strippedInline).not.toContain("snapper");
    expect(removeGrokSnapperTable('mcp_servers.snapper = { command = "old" }\n')).toBe("");
  });
});

describe("interactive, hook, integrate, and doctor remaining branches", () => {
  let root: string;
  let home: string;
  let state: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "snapper-edges-int-"));
    home = path.join(root, "home");
    state = path.join(root, "state");
    await mkdir(home, { recursive: true });
    setStderrWriterForTests(() => undefined);
  });

  afterEach(async () => {
    setStderrWriterForTests(undefined);
    await rm(root, { recursive: true, force: true });
  });

  it("covers interactive mode parsers and OS process fallbacks", async () => {
    expect(agyMode(["agy", "--", "sub"])).toBe("command");
    expect(agyMode(["agy", "--"])).toBe("input");
    expect(agyMode(["agy", "---"])).toBe("unknown");
    expect(agyMode(["agy", "--unknown-flag"])).toBe("unknown");

    expect(grokMode(["grok", "-r", "sess-1"])).toBe("input");
    expect(grokMode(["grok", "-r"])).toBe("input");
    expect(grokMode(["grok", "-mval"])).toBe("input");
    expect(grokMode(["grok", "-m"])).toBe("unknown");
    expect(grokMode(["grok", "-z"])).toBe("unknown");
    expect(grokMode(["grok", "--resume", "s1"])).toBe("input");
    expect(grokMode(["grok", "--model"])).toBe("unknown");
    expect(grokMode(["grok", "--bad"])).toBe("unknown");
    expect(grokMode(["grok", "one", "two"])).toBe("unknown");

    expect(kimiMode(["kimi-code", "", ""])).toBe("input");
    expect(kimiMode(["kimi", "--", "sub"])).toBe("command");
    expect(kimiMode(["kimi", "--"])).toBe("input");
    expect(kimiMode(["kimi", "-mval"])).toBe("input");
    expect(kimiMode(["kimi", "-m"])).toBe("unknown");
    expect(kimiMode(["kimi", "-S", "s1"])).toBe("input");
    expect(kimiMode(["kimi", "-S"])).toBe("input");
    expect(kimiMode(["kimi", "-z"])).toBe("unknown");
    expect(kimiMode(["kimi", "--session", "s1"])).toBe("input");
    expect(kimiMode(["kimi", "--model"])).toBe("unknown");
    expect(kimiMode(["kimi", "extra-positional"])).toBe("unknown");

    expect(cursorMode(["cursor-agent", "--"])).toBe("input");
    expect(cursorMode(["cursor-agent", "--print=1"])).toBe("unknown");
    expect(cursorMode(["cursor-agent", "--yolo=1"])).toBe("unknown");
    expect(cursorMode(["cursor-agent", "--model"])).toBe("unknown");
    expect(cursorMode(["cursor-agent", "--resume", "r1"])).toBe("input");
    expect(cursorMode(["cursor-agent", "-Hval"])).toBe("input");
    expect(cursorMode(["cursor-agent", "-H"])).toBe("unknown");
    expect(cursorMode(["cursor-agent", "-w", "dir"])).toBe("input");
    expect(cursorMode(["cursor-agent", "-w"])).toBe("input");
    expect(cursorMode(["cursor-agent", "-z"])).toBe("unknown");

    expect(await inspectDarwinProcess(123, () => Promise.reject(new Error("ps failed")))).toBeNull();
    expect(await inspectDarwinProcess(123, () => Promise.resolve(""))).toBeNull();
    expect(await inspectWin32Process(123, () => Promise.reject(new Error("pwsh failed")))).toBeNull();
    expect(await inspectWin32Process(123, () => Promise.resolve(""))).toBeNull();
    expect(await inspectParentProcess(1, "linux")).toBeNull();
    expect(await inspectParentProcess(100, "aix")).toBeNull();
  });

  it("covers hookMain defensive branches across clients", async () => {
    const env = { SNAPPER_MCP_HOME: state };
    const parent = (exe: string, argv: string[], readsTerminal = true): ParentProcessSnapshot => ({
      pid: 4100,
      ppid: 1,
      startToken: "t1",
      executableName: exe,
      argv,
      readsTerminal,
    });

    const out = new TextSink();
    await hookMain({
      argv: ["--client", "grok", "--event", "SessionStart"],
      source: env,
      stdin: "[]",
      stdout: out,
      inspector: () => Promise.resolve(parent("grok", ["grok"])),
    });
    await hookMain({
      argv: ["--client", "grok", "--event", "Stop"],
      source: env,
      stdin: JSON.stringify({ reason: "other" }),
      stdout: out,
      inspector: () => Promise.resolve(parent("grok", ["grok"])),
    });
    await hookMain({
      argv: ["--client", "grok", "--event", "Stop"],
      source: env,
      stdin: JSON.stringify({ reason: "end_turn", backgroundTasks: [123] }),
      stdout: out,
      inspector: () => Promise.resolve(parent("grok", ["grok"])),
    });

    const bigStream = Readable.from([Buffer.alloc(300 * 1024, 65)]);
    expect(
      await hookMain({
        argv: ["--client", "grok", "--event", "Stop"],
        source: env,
        stdin: bigStream,
        stdout: out,
      }),
    ).toBe(0);

    const convId = "55555555-5555-4555-8555-555555555555";
    await hookMain({
      argv: ["--client", "antigravity", "--event", "Stop"],
      source: env,
      stdin: "{}",
      stdout: out,
    });
    await hookMain({
      argv: ["--client", "antigravity", "--event", "PreInvocation"],
      source: env,
      stdin: JSON.stringify({ conversationId: convId }),
      stdout: out,
      inspector: () => Promise.resolve(parent("agy", ["agy"])),
    });
    await hookMain({
      argv: ["--client", "antigravity", "--event", "OtherEvent"],
      source: env,
      stdin: JSON.stringify({ conversationId: convId }),
      stdout: out,
      inspector: () => Promise.resolve(parent("agy", ["agy"])),
    });
    await hookMain({
      argv: ["--client", "antigravity", "--event", "Stop"],
      source: env,
      stdin: JSON.stringify({ conversationId: convId, stopHookActive: true }),
      stdout: out,
      inspector: () => Promise.resolve(parent("agy", ["agy"])),
    });
    // Stop before wake is enabled (hits !isWakeEnabled(pref) in handleAntigravityHook):
    await hookMain({
      argv: ["--client", "antigravity", "--event", "Stop"],
      source: env,
      stdin: JSON.stringify({ conversationId: convId }),
      stdout: out,
      inspector: () => Promise.resolve(parent("agy", ["agy"])),
    });
    await writeWakePreference(state, "antigravity", "on", "linux");
    await publishAntigravityHelper({
      stateDir: state,
      record: {
        agyPid: 4100,
        agyStartToken: "t1",
        helperPid: 9100,
        conversationId: convId,
        attemptId: "a1",
      },
      isPidAlive: () => true,
    });
    await hookMain({
      argv: ["--client", "antigravity", "--event", "Stop"],
      source: env,
      stdin: JSON.stringify({ conversationId: convId }),
      stdout: out,
      inspector: () => Promise.resolve(parent("agy", ["agy"])),
      isPidAlive: () => true,
    });

    await hookMain({
      argv: ["--client", "kimi", "--event", "UserPromptSubmit"],
      source: env,
      stdin: "{}",
      stdout: out,
    });
    await hookMain({
      argv: ["--client", "kimi", "--event", "UserPromptSubmit"],
      source: env,
      stdin: JSON.stringify({ session_id: "s" }),
      stdout: out,
      inspector: () => Promise.resolve(null),
    });
    await hookMain({
      argv: ["--client", "kimi", "--event", "UserPromptSubmit"],
      source: env,
      stdin: JSON.stringify({ session_id: "s", steer: true }),
      stdout: out,
      inspector: () => Promise.resolve(parent("kimi", ["kimi"])),
    });
    await writeWakePreference(state, "kimi", "off", "linux");
    await hookMain({
      argv: ["--client", "kimi", "--event", "UserPromptSubmit"],
      source: env,
      stdin: JSON.stringify({ session_id: "s" }),
      stdout: out,
      inspector: () => Promise.resolve(parent("kimi", ["kimi"])),
    });
    await writeWakePreference(state, "kimi", "on", "linux");
    await hookMain({
      argv: ["--client", "kimi", "--event", "UserPromptSubmit"],
      source: env,
      stdin: JSON.stringify({ session_id: "s" }),
      stdout: out,
      inspector: () => Promise.resolve(parent("kimi", ["kimi", "-p", "hi"])),
    });
    const kimiOut = new TextSink();
    await hookMain({
      argv: ["--client", "kimi", "--event", "UserPromptSubmit"],
      source: env,
      stdin: JSON.stringify({ session_id: "s-arm" }),
      stdout: kimiOut,
      inspector: () => Promise.resolve(parent("kimi", ["kimi"])),
    });
    await hookMain({
      argv: ["--client", "kimi", "--event", "UserPromptSubmit"],
      source: env,
      stdin: JSON.stringify({ session_id: "s-arm" }),
      stdout: kimiOut,
      inspector: () => Promise.resolve(parent("kimi", ["kimi"])),
    });

    await hookMain({
      argv: ["--client", "cursor", "--event", "other"],
      source: env,
      stdin: "{}",
      stdout: out,
    });
    await writeWakePreference(state, "cursor", "off", "linux");
    const curOff = new TextSink();
    await hookMain({
      argv: ["--client", "cursor", "--event", "stop"],
      source: env,
      stdin: "{}",
      stdout: curOff,
      inspector: () => Promise.resolve(parent("cursor-agent", ["cursor-agent"])),
    });
    expect(curOff.text()).toBe("{}\n");

    await writeWakePreference(state, "cursor", "on", "linux");
    const curHeadless = new TextSink();
    await hookMain({
      argv: ["--client", "cursor", "--event", "stop"],
      source: env,
      stdin: "{}",
      stdout: curHeadless,
      inspector: () => Promise.resolve(parent("cursor-agent", ["cursor-agent", "-p", "x"])),
    });
    expect(curHeadless.text()).toBe("{}\n");

    await hookMain({
      argv: ["--client", "codex", "--event", "Stop"],
      source: env,
      stdin: JSON.stringify({ thread_id: "not-a-uuid" }),
      stdout: out,
    });
    expect(out.text()).toBe("");
  });

  it("exercises surgical buildStripper paths across modified hooks, TOMLs, skills, and doctor broken shapes", async () => {
    const token = makeJwt(3600);
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      SNAPPER_MCP_HOME: state,
      CODEX_HOME: path.join(home, "custom-codex"),
      COPILOT_HOME: path.join(home, "custom-copilot"),
      KIMI_CODE_HOME: path.join(home, "custom-kimi"),
      GROK_HOME: path.join(home, "custom-grok"),
      SNAPPER_BASE_URL: "https://snapper.example.com/api/mcp",
      SNAPPER_ACCESS_TOKEN: token,
    };

    await mkdir(path.join(home, "custom-codex"), { recursive: true });
    await writeFile(
      path.join(home, "custom-codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: "iris hook --client codex", timeout: 5 },
                { type: "command", command: "old --client codex --event SessionStart", timeout: 5 },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    await mkdir(path.join(home, ".cursor"), { recursive: true });
    await writeFile(
      path.join(home, ".cursor", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [
            { command: "iris hook --client cursor --event stop", timeout: 5 },
            { command: "old --client cursor --event stop", timeout: 5 },
          ],
        },
      }),
      "utf8",
    );

    expect(
      await integrateMain({
        argv: ["all"],
        source: env,
        platform: "linux",
        invocation: { command: "snapper-mcp" },
      }),
    ).toBe(0);

    // Modify every managed file so --remove exercises buildStripper surgical stripping:
    for (const hookFile of [
      path.join(home, "custom-codex", "hooks.json"),
      path.join(home, ".gemini", "config", "hooks.json"),
      path.join(home, "custom-grok", "hooks", "snapper.json"),
      path.join(home, ".cursor", "hooks.json"),
    ]) {
      const parsed = JSON.parse(await readFile(hookFile, "utf8")) as Record<string, unknown>;
      parsed["extraUserNote"] = "keep-me";
      await writeFile(hookFile, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    }

    for (const tomlFile of [
      path.join(home, "custom-codex", "config.toml"),
      path.join(home, "custom-grok", "config.toml"),
      path.join(home, "custom-kimi", "config.toml"),
    ]) {
      const text = await readFile(tomlFile, "utf8");
      await writeFile(tomlFile, `user_flag = true\n\n${text}`, "utf8");
    }

    for (const skillFile of [
      path.join(home, "custom-grok", "skills", "snapper", "SKILL.md"),
      path.join(home, "custom-kimi", "skills", "snapper", "SKILL.md"),
    ]) {
      const text = await readFile(skillFile, "utf8");
      await writeFile(skillFile, `${text}\nCustom note.\n`, "utf8");
    }

    expect(
      await integrateMain({
        argv: ["all", "--remove"],
        source: env,
        platform: "linux",
      }),
    ).toBe(0);

    expect(await integrateMain({ argv: ["--bad-flag"], source: env })).toBe(1);
    expect(await doctorMain({ argv: ["--bad-flag"], source: env })).toBe(1);

    // Doctor broken shapes across JSON MCP files and expired JWT:
    await mkdir(path.join(home, "custom-copilot"), { recursive: true });
    await writeFile(path.join(home, "custom-copilot", "mcp-config.json"), "[]", "utf8");
    await mkdir(path.join(home, "custom-kimi"), { recursive: true });
    await writeFile(
      path.join(home, "custom-kimi", "mcp.json"),
      '{"mcpServers": []}',
      "utf8",
    );
    await writeFile(
      path.join(home, ".cursor", "mcp.json"),
      '{"mcpServers": {"snapper": {"args": []}}}',
      "utf8",
    );
    await mkdir(path.join(state, "wake"), { recursive: true });
    await writeFile(path.join(state, "wake", "grok.pref"), "invalid-pref", "utf8");

    const docOut = new TextSink();
    const expiredToken = makeJwt(-3600);
    expect(
      await doctorMain({
        argv: [
          "--base-url",
          "https://snapper.example.com/api/mcp",
          "--access-token",
          expiredToken,
          "--profile",
          "dev",
        ],
        source: {
          ...env,
          SNAPPER_PROFILE_DEV_BASE_URL: "https://snapper.example.com/api/mcp",
          SNAPPER_PROFILE_DEV_ACCESS_TOKEN: expiredToken,
        },
        platform: "linux",
        stdout: docOut,
      }),
    ).toBe(1);
    expect(docOut.text()).toContain("copilot: BROKEN");
    expect(docOut.text()).toContain("kimi: BROKEN");
    expect(docOut.text()).toContain("cursor: BROKEN");
    expect(docOut.text()).toContain("grok: BROKEN");

    // Argument validation & --no-wake unwiring + malformed JSON/shape error branches:
    expect(() => parseIntegrateArgs(["codex", "--bin"])).toThrow(/--bin requires/);
    expect(() => parseIntegrateArgs(["codex", "--bin="])).toThrow(/--bin requires/);
    expect(parseIntegrateArgs(["codex", "--bin", "/opt/bin"]).invocation.command).toBe(
      "/opt/bin",
    );
    expect(parseIntegrateArgs(["codex", "--bin=/opt/bin2"]).invocation.command).toBe(
      "/opt/bin2",
    );
    expect(() => parseDoctorArgs(["--client"])).toThrow(/--client requires/);
    expect(() => parseDoctorArgs(["--client="])).toThrow(/--client requires/);
    expect(parseDoctorArgs(["--client=codex"]).clients).toEqual(["codex"]);

    const cleanHome = path.join(root, "clean-home");
    const cleanState = path.join(root, "clean-state");
    await mkdir(cleanHome, { recursive: true });
    const cleanEnv: NodeJS.ProcessEnv = {
      HOME: cleanHome,
      SNAPPER_MCP_HOME: cleanState,
      SNAPPER_BASE_URL: "https://snapper.example.com/api/mcp",
      SNAPPER_ACCESS_TOKEN: token,
    };
    expect(
      await integrateMain({
        argv: ["all"],
        source: cleanEnv,
        platform: "linux",
        invocation: { command: "snapper-mcp" },
      }),
    ).toBe(0);
    // Toggle all 7 clients to --no-wake (covers every installer's wakeEnabled=false branch):
    expect(
      await integrateMain({
        argv: [
          "all",
          "--no-wake",
          "--base-url",
          "https://snapper.example.com/api/mcp",
          "--access-token",
          token,
        ],
        source: cleanEnv,
        platform: "linux",
        invocation: { command: "snapper-mcp" },
      }),
    ).toBe(0);
    // Windows Cursor hook rendering + Codex commandWindows:
    expect(
      await integrateMain({
        argv: ["codex", "cursor"],
        source: { ...cleanEnv, USERPROFILE: cleanHome },
        platform: "win32",
        invocation: { command: "C:\\Program Files\\Node\\node.exe", prefixArgs: ["C:\\cli.js"] },
      }),
    ).toBe(0);

    // Malformed / non-object JSON shapes in integrate targets:
    const badHome = path.join(root, "bad-home");
    await mkdir(path.join(badHome, ".cursor"), { recursive: true });
    const badEnv: NodeJS.ProcessEnv = {
      HOME: badHome,
      SNAPPER_MCP_HOME: path.join(root, "bad-state"),
      SNAPPER_BASE_URL: "https://snapper.example.com/api/mcp",
      SNAPPER_ACCESS_TOKEN: token,
    };
    await writeFile(path.join(badHome, ".cursor", "mcp.json"), "{bad", "utf8");
    expect(await integrateMain({ argv: ["cursor"], source: badEnv, platform: "linux" })).toBe(1);
    await writeFile(path.join(badHome, ".cursor", "mcp.json"), "[]", "utf8");
    expect(await integrateMain({ argv: ["cursor"], source: badEnv, platform: "linux" })).toBe(1);
    await writeFile(path.join(badHome, ".cursor", "mcp.json"), '{"mcpServers":[]}', "utf8");
    expect(await integrateMain({ argv: ["cursor"], source: badEnv, platform: "linux" })).toBe(1);

    await writeFile(
      path.join(badHome, ".cursor", "mcp.json"),
      '{"other":1,"mcpServers":{"iris":{"command":"iris"}}}\n',
      "utf8",
    );
    await writeFile(path.join(badHome, ".cursor", "hooks.json"), '{"version":2}', "utf8");
    expect(await integrateMain({ argv: ["cursor"], source: badEnv, platform: "linux" })).toBe(1);
    await writeFile(path.join(badHome, ".cursor", "hooks.json"), '{"version":1,"hooks":[]}', "utf8");
    expect(await integrateMain({ argv: ["cursor"], source: badEnv, platform: "linux" })).toBe(1);
    await writeFile(
      path.join(badHome, ".cursor", "hooks.json"),
      '{"version":1,"hooks":{"stop":1}}',
      "utf8",
    );
    expect(await integrateMain({ argv: ["cursor"], source: badEnv, platform: "linux" })).toBe(1);
    await writeFile(
      path.join(badHome, ".cursor", "hooks.json"),
      '{"version":1,"hooks":{"stop":[{"command":"iris"}],"other":123}}',
      "utf8",
    );
    expect(await integrateMain({ argv: ["cursor"], source: badEnv, platform: "linux" })).toBe(0);
    // Modify both files so stripMcpServerEntry (keeping iris) and stripHooksJson (keeping non-array other) run:
    const curMcp = JSON.parse(await readFile(path.join(badHome, ".cursor", "mcp.json"), "utf8")) as Record<string, unknown>;
    curMcp["userAdded"] = true;
    await writeFile(path.join(badHome, ".cursor", "mcp.json"), JSON.stringify(curMcp), "utf8");
    const curHooks = JSON.parse(await readFile(path.join(badHome, ".cursor", "hooks.json"), "utf8")) as Record<string, unknown>;
    curHooks["userAdded"] = true;
    await writeFile(path.join(badHome, ".cursor", "hooks.json"), JSON.stringify(curHooks), "utf8");
    expect(
      await integrateMain({ argv: ["cursor", "--remove"], source: badEnv, platform: "linux" }),
    ).toBe(0);

    await mkdir(path.join(badHome, ".codex"), { recursive: true });
    await writeFile(path.join(badHome, ".codex", "hooks.json"), '{"hooks":[]}', "utf8");
    expect(await integrateMain({ argv: ["codex"], source: badEnv, platform: "linux" })).toBe(1);
    await writeFile(
      path.join(badHome, ".codex", "hooks.json"),
      '{"hooks":{"SessionStart":1}}',
      "utf8",
    );
    expect(await integrateMain({ argv: ["codex"], source: badEnv, platform: "linux" })).toBe(1);
    await writeFile(
      path.join(badHome, ".codex", "hooks.json"),
      '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"iris"}]}]}}',
      "utf8",
    );
    expect(await integrateMain({ argv: ["codex"], source: badEnv, platform: "linux" })).toBe(0);

    // Additional surgical strip + doctor + parseWatchArgs/parseHookArgs/parseIntegrateArgs edges:
    const savedArgv1 = process.argv[1];
    process.argv[1] = "";
    try {
      expect(parseIntegrateArgs(["codex"]).invocation).toEqual({ command: "snapper-mcp" });
      expect(parseHookArgs(["--client", "grok", "--event", "Stop"]).invocation).toEqual({
        command: "snapper-mcp",
      });
    } finally {
      process.argv[1] = savedArgv1 ?? "";
    }
    expect(() => parseWatchArgs(["--client", "invalid"])).toThrow();
    expect(() => parseWatchArgs(["--wake-on", "invalid"])).toThrow();
    expect(parseWatchArgs(["--actionable-only"]).actionableOnly).toBe(true);

    // Surgical strip: empty mcpServers deletion, nested dropHookItems keeping foreign, replaced SKILL.md,
    // deleted file before --remove, modified Claude bundle files, and valid-owned modified Copilot extension:
    const surgHome = path.join(root, "surg-home");
    const surgState = path.join(root, "surg-state");
    await mkdir(path.join(surgHome, ".cursor"), { recursive: true });
    await writeFile(path.join(surgHome, ".cursor", "mcp.json"), '{"keep":1}\n', "utf8");
    const surgEnv: NodeJS.ProcessEnv = {
      HOME: surgHome,
      SNAPPER_MCP_HOME: surgState,
      SNAPPER_BASE_URL: "https://snapper.example.com/api/mcp",
      SNAPPER_ACCESS_TOKEN: token,
    };
    expect(
      await integrateMain({ argv: ["all"], source: surgEnv, platform: "linux" }),
    ).toBe(0);

    // Doctor when extension.mjs is tampered while watcher.mjs is intact, plus empty/{}/iris/invalid snapper JSONs:
    await writeFile(
      path.join(surgHome, ".copilot", "extensions", "snapper", "extension.mjs"),
      "// tampered\n",
      "utf8",
    );
    const errSink = new TextSink();
    const outSink = new TextSink();
    expect(await doctorMain({ argv: ["--bad"], source: surgEnv, stderr: errSink })).toBe(1);
    expect(
      await doctorMain({
        argv: ["--access-token", makeJwt(-60)],
        source: surgEnv,
        platform: "linux",
        stdout: outSink,
        stderr: errSink,
      }),
    ).toBe(1);
    expect(outSink.text()).toContain("extension.mjs failed SHA-256");

    // Replace tampered extension.mjs with another valid snapper-owned entry so --remove hits line 509:
    await writeFile(
      path.join(surgHome, ".copilot", "extensions", "snapper", "extension.mjs"),
      renderCopilotExtensionEntry({ command: "other-bin", configPath: "/other" }),
      "utf8",
    );
    // Modify cursor mcp.json (only snapper in mcpServers + keep:2) so stripMcpServerEntry deletes mcpServers:
    const sCurMcp = JSON.parse(
      await readFile(path.join(surgHome, ".cursor", "mcp.json"), "utf8"),
    ) as Record<string, unknown>;
    sCurMcp["keep"] = 2;
    await writeFile(
      path.join(surgHome, ".cursor", "mcp.json"),
      JSON.stringify(sCurMcp),
      "utf8",
    );
    // Modify codex hooks.json so one group contains BOTH iris and snapper (dropHookItems innerKept > 0):
    await writeFile(
      path.join(surgHome, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: "iris" },
                { type: "command", command: "snapper --client codex" },
              ],
            },
          ],
        },
      }),
      "utf8",
    );
    // Replace grok SKILL.md completely without template, delete kimi SKILL.md before --remove,
    // and modify Claude SKILL.md + monitors.json:
    await writeFile(
      path.join(surgHome, ".grok", "skills", "snapper", "SKILL.md"),
      "Completely custom user skill\n",
      "utf8",
    );
    await unlink(path.join(surgHome, ".kimi-code", "skills", "snapper", "SKILL.md"));
    const claudePluginRoot = path.join(
      surgState,
      "plugins",
      "claude-marketplace",
      "plugins",
      "snapper",
    );
    await writeFile(
      path.join(claudePluginRoot, "monitors", "monitors.json"),
      "[]\n",
      "utf8",
    );
    await writeFile(
      path.join(claudePluginRoot, "skills", "wake", "SKILL.md"),
      "custom claude skill without marker\n",
      "utf8",
    );
    expect(
      await integrateMain({ argv: ["all", "--remove"], source: surgEnv, platform: "linux" }),
    ).toBe(0);

    // Doctor on {}, {"mcpServers":{"iris":{}}}, and {"mcpServers":{"snapper":123}}:
    await mkdir(path.join(surgHome, ".cursor"), { recursive: true });
    await writeFile(path.join(surgHome, ".cursor", "mcp.json"), "{}\n", "utf8");
    await mkdir(path.join(surgHome, ".kimi-code"), { recursive: true });
    await writeFile(
      path.join(surgHome, ".kimi-code", "mcp.json"),
      '{"mcpServers":{"iris":{"command":"iris"}}}\n',
      "utf8",
    );
    await mkdir(path.join(surgHome, ".gemini", "config"), { recursive: true });
    await writeFile(
      path.join(surgHome, ".gemini", "config", "mcp_config.json"),
      '{"mcpServers":{"snapper":123}}\n',
      "utf8",
    );
    expect(
      await doctorMain({
        argv: ["--base-url", "not-a-valid-url"],
        source: surgEnv,
        platform: "linux",
        stdout: outSink,
        stderr: errSink,
      }),
    ).toBe(1);
  });
});

describe.skipIf(!CAN_LISTEN_ON_LOOPBACK)("main proxy wake workers & watch/worker edges", () => {
  let server: MockSnapperServer;
  let dir: string;

  beforeAll(async () => {
    server = await makeMockSnapperServer({
      capabilities: { tools: {} },
      serverInfo: { name: "snapper", version: "1.0.0" },
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "snapper-edges-main-"));
    setStderrWriterForTests(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const urlStr =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (urlStr.endsWith("/api/auth/me")) {
          return Promise.resolve(new Response("unavailable", { status: 503 }));
        }
        return globalThis.fetch(input);
      }),
    );
  });

  afterEach(async () => {
    setStderrWriterForTests(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("starts and drains Cursor/Codex wake workers inside main()", async () => {
    vi.unstubAllGlobals();
    let closedCount = 0;
    const fakeWsFactory = (_opts: WsClientOptions): WsClient => {
      let resolveRun: (() => void) | null = null;
      return {
        run: () =>
          new Promise<void>((r) => {
            resolveRun = r;
          }),
        close: () => {
          closedCount += 1;
          resolveRun?.();
          return Promise.resolve();
        },
      };
    };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const [stdioCursor] = InMemoryTransport.createLinkedPair();
    const beforeTerm = process.listenerCount("SIGTERM");
    await main({
      source: {
        SNAPPER_MCP_HOME: dir,
        SNAPPER_BASE_URL: server.baseUrl.toString(),
        SNAPPER_ACCESS_TOKEN: "tok",
        SNAPPER_MCP_LOG_LEVEL: "error",
      },
      argv: ["--client", "cursor", "--wake"],
      stdioTransport: stdioCursor,
      install: true,
      wakeWsClientFactory: fakeWsFactory,
    });

    const termListener = process.listeners("SIGTERM")[beforeTerm];
    expect(termListener).toBeDefined();
    termListener?.("SIGTERM");
    await waitFor(() => closedCount >= 1, { message: "cursor worker closed on SIGTERM" });

    while (process.listenerCount("SIGTERM") > beforeTerm) {
      const l = process.listeners("SIGTERM").pop();
      if (l) process.removeListener("SIGTERM", l);
    }
    while (process.listenerCount("SIGINT") > 0) {
      const l = process.listeners("SIGINT").pop();
      if (l) process.removeListener("SIGINT", l);
    }

    const [stdioCodex] = InMemoryTransport.createLinkedPair();
    await main({
      source: {
        SNAPPER_MCP_HOME: dir,
        SNAPPER_BASE_URL: server.baseUrl.toString(),
        SNAPPER_ACCESS_TOKEN: "tok",
        SNAPPER_MCP_LOG_LEVEL: "error",
      },
      argv: ["--client", "codex"],
      stdioTransport: stdioCodex,
      install: false,
      wakeWsClientFactory: fakeWsFactory,
    });
    exitSpy.mockRestore();
  });

  it("covers watchMain Web WritableStream sink, antigravity --wake delegation, and worker retry branches", async () => {
    const bridgeEnv: BridgeEnv = {
      baseUrl: new URL("http://localhost:8000/api/mcp/"),
      accessToken: "tok",
    };
    const logger = createLogger("edge", { SNAPPER_MCP_LOG_LEVEL: "error" });

    // Codex worker when queueSender fails and when idleProbe throws:
    await recordCodexSession({
      stateDir: dir,
      codexPid: 5100,
      codexStartToken: "s5100",
      threadId: "77777777-7777-4777-8777-777777777777",
      consumeReservation: false,
    });
    let activeCodexOpts: WsClientOptions | null = null;
    const codexWorker = await startCodexWakeWorker({
      env: bridgeEnv,
      stateDir: dir,
      logger,
      isPidAlive: () => true,
      wsClientFactory: (opts) => {
        activeCodexOpts = opts;
        let finishRun: (() => void) | null = null;
        return {
          run: () =>
            new Promise<void>((r) => {
              finishRun = r;
            }),
          close: () => {
            finishRun?.();
            return Promise.resolve();
          },
        };
      },
      settleMs: 10,
      pollMs: 200,
      idleProbe: () => Promise.reject(new Error("probe boom")),
    });
    await waitFor(() => activeCodexOpts !== null, { message: "codex ws ready" });
    (activeCodexOpts as WsClientOptions | null)?.onFrame(makeReviewRequest());
    await new Promise((r) => setTimeout(r, 25));
    await codexWorker.close();

    // Antigravity helper retry when sendMessage returns false and wake=off stops helper:
    const convId = "66666666-6666-4666-8666-666666666666";
    await writeWakePreference(dir, "antigravity", "on", "linux");
    await recordAntigravityTurnEvent({
      stateDir: dir,
      agyPid: 5000,
      agyStartToken: "s5000",
      conversationId: convId,
      idle: true,
      clearReservation: true,
    });

    let agyOpts: WsClientOptions | null = null;
    let sendCalls = 0;
    const helperRun = runAntigravityWakeCommand({
      env: bridgeEnv,
      configPath: path.join(dir, "config.json"),
      stateDir: dir,
      source: {
        ANTIGRAVITY_CONVERSATION_ID: convId,
        ANTIGRAVITY_CSRF_TOKEN: "csrf",
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
        [AGY_HELPER_ENV]: JSON.stringify({
          agyPid: 5000,
          agyStartToken: "s5000",
          attemptId: "a1",
          agyExe: "agy",
        }),
      },
      logger,
      isPidAlive: () => true,
      dialTcp: () => Promise.resolve(true),
      settleMs: 10,
      pollMs: 15,
      wsClientFactory: (opts) => {
        agyOpts = opts;
        let finishRun: (() => void) | null = null;
        return {
          run: () =>
            new Promise<void>((r) => {
              finishRun = r;
            }),
          close: () => {
            finishRun?.();
            return Promise.resolve();
          },
        };
      },
      sendMessage: async () => {
        sendCalls += 1;
        await writeWakePreference(dir, "antigravity", "off", "linux");
        return false;
      },
    });
    await waitFor(() => agyOpts !== null, { message: "agy ws ready" });
    (agyOpts as WsClientOptions | null)?.onFrame(makeReviewRequest());
    expect(await helperRun).toBe(0);
    expect(sendCalls).toBe(1);

    // watchMain with Web WritableStream and antigravity --wake delegation:
    const cfgPath = path.join(dir, "config.json");
    await writeFile(
      cfgPath,
      JSON.stringify({
        SNAPPER_BASE_URL: "http://localhost:8000/api/mcp",
        SNAPPER_ACCESS_TOKEN: "tok",
      }),
      { mode: 0o600 },
    );
    await chmod(cfgPath, 0o600);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never);

    await expect(
      watchMain({
        argv: ["--client", "antigravity", "--wake", "--config", cfgPath],
        source: { SNAPPER_MCP_HOME: dir },
        inspector: () => Promise.resolve(null),
        install: false,
      }),
    ).rejects.toThrow("exit(1)");

    await writeWakePreference(dir, "antigravity", "on", "linux");
    await watchMain({
      argv: ["--client", "antigravity", "--wake", "--config", cfgPath],
      source: {
        SNAPPER_MCP_HOME: dir,
        ANTIGRAVITY_CONVERSATION_ID: convId,
        ANTIGRAVITY_CSRF_TOKEN: "csrf",
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
      },
      inspector: () =>
        Promise.resolve({
          pid: 5000,
          ppid: 1,
          startToken: "s5000",
          executableName: "agy",
          argv: ["agy"],
          readsTerminal: true,
        }),
      antigravityOverrides: {
        dialTcp: () => Promise.resolve(true),
        spawnDetached: () => 999_999_997,
      },
      install: false,
    });

    const ts = new TransformStream<Uint8Array, Uint8Array>();
    const reader = ts.readable.getReader();
    let wsEmit: ((f: ServerFrame) => void) | null = null;
    await expect(
      watchMain({
        argv: ["--client", "kimi", "--once", "--config", cfgPath],
        source: { SNAPPER_MCP_HOME: dir },
        stdout: ts.writable,
        inspector: () =>
          Promise.resolve({
            pid: 5001,
            ppid: 1,
            startToken: "s5001",
            executableName: "kimi",
            argv: ["kimi"],
            readsTerminal: true,
          }),
        wsClientFactory: () => ({
          run: () => Promise.reject(new Error("ws boom")),
          close: () => Promise.resolve(),
        }),
        install: false,
      }),
    ).rejects.toThrow(`exit(${12})`);
    void reader.cancel();
    expect(wsEmit).toBeNull();
    exitSpy.mockRestore();
  });

  it("covers remaining wake_workers edges (loopback dial, proxy timeout/malformed, launcher/helper guards)", async () => {
    const bridgeEnv: BridgeEnv = {
      baseUrl: new URL("http://localhost:8000/api/mcp/"),
      accessToken: "tok",
    };
    const logger = createLogger("edge2", { SNAPPER_MCP_LOG_LEVEL: "error" });

    // ActionableFilter: invalid timestamps, already-released foreign request, and dispose with held timer:
    const seen: string[] = [];
    const filter = createActionableFilter({
      delegatePublicId: "0192f000-0000-7000-8000-0000000000aa",
      onActionable: (k) => seen.push(k),
    });
    filter.onFrame({ ...makeReviewRequest(), timestamp: "not-a-date" });
    const now = Date.now();
    filter.onFrame({
      ...makeReviewRequest(),
      review_public_id: "0192f000-0000-7000-8000-eeeeeeeeeeee",
      timestamp: new Date(now - 60_000).toISOString(),
      deadline: new Date(now + 60_000).toISOString(),
    });
    filter.onFrame({
      ...makeReviewRequest(),
      review_public_id: "0192f000-0000-7000-8000-ffffffffffff",
      timestamp: new Date(now).toISOString(),
      deadline: new Date(now + 120_000).toISOString(),
    });
    filter.dispose();
    expect(seen).toEqual(["ai_review", "ai_review"]);

    // Real TCP loopback dial (connect + error) and validation failures:
    await expect(validateLoopbackLanguageServer("")).rejects.toThrow(/missing/);
    await expect(validateLoopbackLanguageServer("[::1")).rejects.toThrow(/IPv6/);
    await expect(validateLoopbackLanguageServer("127.0.0.1")).rejects.toThrow(/invalid/);
    await expect(validateLoopbackLanguageServer("127.0.0.1:70000")).rejects.toThrow(/port/);
    await expect(validateLoopbackLanguageServer("10.0.0.1:5000")).rejects.toThrow(/loopback/);
    expect(
      await validateLoopbackLanguageServer("[::1]:5123", () => Promise.resolve(true)),
    ).toBe("[::1]:5123");

    const tcpSrv = net.createServer((s) => s.end());
    await new Promise<void>((r) => tcpSrv.listen(0, "127.0.0.1", () => r()));
    const tcpPort = (tcpSrv.address() as net.AddressInfo).port;
    expect(await validateLoopbackLanguageServer(`127.0.0.1:${tcpPort}`)).toBe(
      `127.0.0.1:${tcpPort}`,
    );
    await new Promise<void>((r) => tcpSrv.close(() => r()));
    await expect(validateLoopbackLanguageServer(`127.0.0.1:${tcpPort}`)).rejects.toThrow(
      /unreachable/,
    );

    // probeCodexThreadIdleViaProxy timeout and malformed WS payload:
    const sleeper = path.join(dir, "sleep-codex.mjs");
    await writeFile(sleeper, "#!/usr/bin/env node\nsetTimeout(() => {}, 5000);\n", {
      mode: 0o755,
    });
    await chmod(sleeper, 0o755);
    expect(await probeCodexThreadIdleViaProxy("t-timeout", sleeper, 25)).toBe(false);

    const badWsProxy = path.join(dir, "bad-ws-codex.mjs");
    await writeFile(
      badWsProxy,
      [
        "#!/usr/bin/env node",
        'import { createHash } from "node:crypto";',
        "let buf = '';",
        "process.stdin.on('data', (c) => {",
        "  buf += c.toString('utf8');",
        "  if (!buf.includes('\\r\\n\\r\\n')) return;",
        "  const m = /Sec-WebSocket-Key:\\s*([^\\r\\n]+)/i.exec(buf);",
        "  if (!m) return;",
        "  buf = '';",
        "  const accept = createHash('sha1').update(m[1].trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');",
        "  process.stdout.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');",
        "  process.stdout.write(Buffer.from([0x81, 0x08, ...Buffer.from('not-json')]));",
        "});",
      ].join("\n"),
      { mode: 0o755 },
    );
    await chmod(badWsProxy, 0o755);
    expect(await probeCodexThreadIdleViaProxy("t-bad", badWsProxy, 2000)).toBe(false);

    // startCursorWakeWorker run() rejection + fetchWsToken + stateDir write failure:
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net down"))));
    const fileAsDir = path.join(dir, "not-a-dir");
    await writeFile(fileAsDir, "x", "utf8");
    let cursorOpts: WsClientOptions | null = null;
    const cursorW = await startCursorWakeWorker({
      env: bridgeEnv,
      stateDir: fileAsDir,
      logger,
      wsClientFactory: (opts) => {
        cursorOpts = opts;
        return {
          run: () => Promise.reject(new Error("stream died")),
          close: () => Promise.resolve(),
        };
      },
    });
    await expect(
      (cursorOpts as WsClientOptions | null)?.fetchWsToken(),
    ).rejects.toThrow();
    (cursorOpts as WsClientOptions | null)?.onFrame(makeReviewRequest());
    await new Promise((r) => setTimeout(r, 20));
    await cursorW.close();

    // startCodexWakeWorker queueSender=false + close() clearing pending stepTimer + default probes:
    const codexDir = path.join(dir, "codex-edge");
    await recordCodexSession({
      stateDir: codexDir,
      codexPid: 6100,
      codexStartToken: "s6100",
      threadId: "88888888-8888-4888-8888-888888888888",
      consumeReservation: false,
    });
    let codexOpts2: WsClientOptions | null = null;
    let queueCalled = false;
    const codexW2 = await startCodexWakeWorker({
      env: bridgeEnv,
      stateDir: codexDir,
      logger,
      isPidAlive: () => true,
      settleMs: 5,
      pollMs: 5000,
      idleProbe: () => Promise.resolve(true),
      queueSender: () => {
        queueCalled = true;
        return Promise.resolve(false);
      },
      wsClientFactory: (opts) => {
        codexOpts2 = opts;
        return { run: () => Promise.resolve(), close: () => Promise.resolve() };
      },
    });
    (codexOpts2 as WsClientOptions | null)?.onFrame(makeReviewRequest());
    await waitFor(() => queueCalled, { message: "queueSender called" });
    await new Promise((r) => setTimeout(r, 20));
    await codexW2.close();

    // Antigravity launcher error branches + duplicate helper cleanup + defaultSpawnDetached:
    const agyDir = path.join(dir, "agy-edge");
    await writeWakePreference(agyDir, "antigravity", "on", "linux");
    const convId = "99999999-9999-4999-8999-999999999999";
    const agyParent: ParentProcessSnapshot = {
      pid: 7100,
      ppid: 1,
      startToken: "s7100",
      executableName: "agy",
      argv: ["agy"],
      readsTerminal: true,
    };
    expect(
      await runAntigravityWakeCommand({
        env: bridgeEnv,
        configPath: "/c",
        stateDir: agyDir,
        source: {
          ANTIGRAVITY_CONVERSATION_ID: convId,
          ANTIGRAVITY_CSRF_TOKEN: "",
          ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
        },
        logger,
        inspector: () => Promise.resolve({ ...agyParent, argv: ["agy", "chat", "hi"] }),
      }),
    ).toBe(1);
    expect(
      await runAntigravityWakeCommand({
        env: bridgeEnv,
        configPath: "/c",
        stateDir: agyDir,
        source: {
          ANTIGRAVITY_CONVERSATION_ID: convId,
          ANTIGRAVITY_CSRF_TOKEN: "",
          ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
        },
        logger,
        inspector: () => Promise.resolve(agyParent),
      }),
    ).toBe(1);
    expect(
      await runAntigravityWakeCommand({
        env: bridgeEnv,
        configPath: "/c",
        stateDir: agyDir,
        source: {
          ANTIGRAVITY_CONVERSATION_ID: convId,
          ANTIGRAVITY_CSRF_TOKEN: "bad\x01csrf",
          ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
        },
        logger,
        inspector: () => Promise.resolve(agyParent),
      }),
    ).toBe(1);
    expect(
      await runAntigravityWakeCommand({
        env: bridgeEnv,
        configPath: "/c",
        stateDir: agyDir,
        source: {
          ANTIGRAVITY_CONVERSATION_ID: convId,
          ANTIGRAVITY_CSRF_TOKEN: "csrf",
          ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
        },
        logger,
        inspector: () => Promise.resolve(agyParent),
        dialTcp: () => Promise.resolve(false),
      }),
    ).toBe(1);
    expect(
      await runAntigravityWakeCommand({
        env: bridgeEnv,
        configPath: "/c",
        stateDir: agyDir,
        source: {
          ANTIGRAVITY_CONVERSATION_ID: convId,
          ANTIGRAVITY_CSRF_TOKEN: "csrf",
          ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
        },
        logger,
        inspector: () => Promise.resolve(agyParent),
        dialTcp: () => Promise.resolve(true),
        spawnDetached: () => {
          throw new Error("spawn boom");
        },
      }),
    ).toBe(1);

    // Seed live helper, make first isPidAlive false (pre-check) and second true (publish check):
    await publishAntigravityHelper({
      stateDir: agyDir,
      record: {
        agyPid: 7100,
        agyStartToken: "s7100",
        helperPid: 999_999_998,
        conversationId: convId,
        attemptId: "existing",
      },
      isPidAlive: () => true,
    });
    let aliveCall = 0;
    expect(
      await runAntigravityWakeCommand({
        env: bridgeEnv,
        configPath: "/c",
        stateDir: agyDir,
        source: {
          ANTIGRAVITY_CONVERSATION_ID: convId,
          ANTIGRAVITY_CSRF_TOKEN: "csrf",
          ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
        },
        logger,
        inspector: () => Promise.resolve(agyParent),
        dialTcp: () => Promise.resolve(true),
        isPidAlive: () => {
          aliveCall += 1;
          return aliveCall >= 2;
        },
        spawnDetached: () => 999_999_999,
      }),
    ).toBe(0);

    // Exercise real defaultSpawnDetached safely using a fast-exiting script at process.argv[1]:
    const noopHelper = path.join(dir, "noop-helper.mjs");
    await writeFile(noopHelper, "process.exit(0);\n", "utf8");
    const origArgv1 = process.argv[1];
    process.argv[1] = noopHelper;
    try {
      expect(
        await runAntigravityWakeCommand({
          env: bridgeEnv,
          configPath: "/c",
          stateDir: path.join(dir, "agy-real-spawn"),
          source: {
            ANTIGRAVITY_CONVERSATION_ID: convId,
            ANTIGRAVITY_CSRF_TOKEN: "csrf",
            ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
          },
          logger,
          inspector: () => Promise.resolve(agyParent),
          dialTcp: () => Promise.resolve(true),
        }),
      ).toBe(1);
    } finally {
      process.argv[1] = origArgv1 ?? "";
    }
    await writeWakePreference(path.join(dir, "agy-real-spawn"), "antigravity", "on", "linux");
    process.argv[1] = noopHelper;
    try {
      expect(
        await runAntigravityWakeCommand({
          env: bridgeEnv,
          configPath: "/c",
          stateDir: path.join(dir, "agy-real-spawn"),
          source: {
            ANTIGRAVITY_CONVERSATION_ID: convId,
            ANTIGRAVITY_CSRF_TOKEN: "csrf",
            ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
          },
          logger,
          inspector: () => Promise.resolve(agyParent),
          dialTcp: () => Promise.resolve(true),
        }),
      ).toBe(0);
    } finally {
      process.argv[1] = origArgv1 ?? "";
    }

    // Child helper invalid handshake, invalid convId, unreachable LS, busy retry + dead parent stop:
    expect(
      await runAntigravityWakeCommand({
        env: bridgeEnv,
        configPath: "/c",
        stateDir: agyDir,
        source: { [AGY_HELPER_ENV]: "{bad" },
        logger,
      }),
    ).toBe(1);
    expect(
      await runAntigravityWakeCommand({
        env: bridgeEnv,
        configPath: "/c",
        stateDir: agyDir,
        source: {
          [AGY_HELPER_ENV]: JSON.stringify({
            agyPid: 7100,
            agyStartToken: "s7100",
            attemptId: "a",
            agyExe: "agy",
          }),
          ANTIGRAVITY_CONVERSATION_ID: "not-uuid",
          ANTIGRAVITY_CSRF_TOKEN: "csrf",
        },
        logger,
      }),
    ).toBe(1);
    expect(
      await runAntigravityWakeCommand({
        env: bridgeEnv,
        configPath: "/c",
        stateDir: agyDir,
        source: {
          [AGY_HELPER_ENV]: JSON.stringify({
            agyPid: 7100,
            agyStartToken: "s7100",
            attemptId: "a",
            agyExe: "agy",
          }),
          ANTIGRAVITY_CONVERSATION_ID: convId,
          ANTIGRAVITY_CSRF_TOKEN: "csrf",
          ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
        },
        logger,
        dialTcp: () => Promise.resolve(false),
      }),
    ).toBe(1);

    await recordAntigravityTurnEvent({
      stateDir: agyDir,
      agyPid: 7100,
      agyStartToken: "s7100",
      conversationId: convId,
      idle: false,
      clearReservation: true,
    });
    let agyBusyOpts: WsClientOptions | null = null;
    let parentAlive = true;
    const busyHelper = runAntigravityWakeCommand({
      env: bridgeEnv,
      configPath: "/c",
      stateDir: agyDir,
      source: {
        [AGY_HELPER_ENV]: JSON.stringify({
          agyPid: 7100,
          agyStartToken: "s7100",
          attemptId: "a",
          agyExe: "agy",
        }),
        ANTIGRAVITY_CONVERSATION_ID: convId,
        ANTIGRAVITY_CSRF_TOKEN: "csrf",
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:5000",
      },
      logger,
      dialTcp: () => Promise.resolve(true),
      isPidAlive: () => parentAlive,
      settleMs: 5,
      pollMs: 20,
      wsClientFactory: (opts) => {
        agyBusyOpts = opts;
        let finish: (() => void) | null = null;
        return {
          run: () =>
            new Promise<void>((r) => {
              finish = r;
            }),
          close: () => {
            finish?.();
            return Promise.resolve();
          },
        };
      },
    });
    await waitFor(() => agyBusyOpts !== null, { message: "agy busy ws ready" });
    (agyBusyOpts as WsClientOptions | null)?.onFrame(makeReviewRequest());
    await new Promise((r) => setTimeout(r, 15));
    parentAlive = false;
    expect(await busyHelper).toBe(0);
  });
});
