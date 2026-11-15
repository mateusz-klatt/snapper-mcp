import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SNAPPER_WAKE_PROMPT } from "../src/actionable.js";
import { formatCliCommand, hookMain, parseHookArgs } from "../src/hook.js";
import type { ParentProcessSnapshot } from "../src/interactive.js";
import { writeWakePreference } from "../src/state_dir.js";
import {
  claimKimiWatcherStart,
  clearKimiSession,
  consumeCursorFollowup,
  isAntigravityHelperLive,
  latchAntigravityFailed,
  publishAntigravityHelper,
  readAntigravityWakeState,
  readCodexWakeState,
  recordAntigravityTurnEvent,
  recordCodexActionableEvent,
  recordCodexSession,
  recordCursorActionableEvent,
  recordKimiSessionStart,
  recordKimiWatcherFinish,
  requestKimiArm,
  setAntigravityReservation,
  settleCodexReservation,
  tryReserveCodexWake,
} from "../src/wake_state.js";

class OutputBuffer {
  private readonly parts: string[] = [];

  write = (chunk: string | Uint8Array): boolean => {
    this.parts.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  };

  text(): string {
    return this.parts.join("");
  }
}

describe("wake_state stores", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "snapper-wake-state-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("tracks Cursor sequence numbers and consumes follow-ups once", async () => {
    expect(await consumeCursorFollowup(tempDir, 100)).toBe(false);
    expect(await recordCursorActionableEvent(tempDir, 200)).toBe(1);
    expect(await recordCursorActionableEvent(tempDir, 250)).toBe(2);
    expect(await consumeCursorFollowup(tempDir, 300)).toBe(true);
    expect(await consumeCursorFollowup(tempDir, 350)).toBe(false);
  });

  it("coordinates Codex session binding, reservation, and settlement", async () => {
    const emptyReserve = await tryReserveCodexWake({
      stateDir: tempDir,
      isPidAlive: () => true,
      nowMs: 1000,
    });
    expect(emptyReserve.reserved).toBe(false);

    const threadA = "11111111-1111-4111-8111-111111111111";
    const threadB = "22222222-2222-4222-8222-222222222222";

    await recordCodexSession({
      stateDir: tempDir,
      codexPid: 4242,
      codexStartToken: "tok-1",
      threadId: threadA,
      consumeReservation: false,
    });

    const noPending = await tryReserveCodexWake({
      stateDir: tempDir,
      isPidAlive: () => true,
      nowMs: 1100,
    });
    expect(noPending.reserved).toBe(false);

    await recordCodexActionableEvent(tempDir);

    const deadPid = await tryReserveCodexWake({
      stateDir: tempDir,
      isPidAlive: () => false,
      nowMs: 1200,
    });
    expect(deadPid.reserved).toBe(false);

    const res1 = await tryReserveCodexWake({
      stateDir: tempDir,
      isPidAlive: () => true,
      nowMs: 1300,
    });
    expect(res1.reserved).toBe(true);
    expect(res1.threadId).toBe(threadA);

    const dupReserve = await tryReserveCodexWake({
      stateDir: tempDir,
      isPidAlive: () => true,
      nowMs: 1400,
    });
    expect(dupReserve.reserved).toBe(false);

    await settleCodexReservation({
      stateDir: tempDir,
      reservationId: "other-id",
      submitted: false,
    });
    expect((await readCodexWakeState(tempDir)).reservationId).toBe(res1.reservationId);

    await settleCodexReservation({
      stateDir: tempDir,
      reservationId: res1.reservationId,
      submitted: false,
    });
    expect((await readCodexWakeState(tempDir)).reservationId).toBeNull();

    const res2 = await tryReserveCodexWake({
      stateDir: tempDir,
      isPidAlive: () => true,
      nowMs: 1500,
    });
    expect(res2.reserved).toBe(true);

    await settleCodexReservation({
      stateDir: tempDir,
      reservationId: res2.reservationId,
      submitted: true,
    });
    const afterSubmit = await readCodexWakeState(tempDir);
    expect(afterSubmit.deliveredSeq).toBe(1);
    expect(afterSubmit.reservationId).toBe(res2.reservationId);

    await recordCodexSession({
      stateDir: tempDir,
      codexPid: 4242,
      codexStartToken: "tok-1",
      threadId: threadA,
      consumeReservation: true,
    });
    expect((await readCodexWakeState(tempDir)).reservationId).toBeNull();

    await recordCodexActionableEvent(tempDir);
    await recordCodexSession({
      stateDir: tempDir,
      codexPid: 4242,
      codexStartToken: "tok-1",
      threadId: threadB,
      consumeReservation: false,
    });
    const switched = await readCodexWakeState(tempDir);
    expect(switched.threadId).toBe(threadB);
    expect(switched.deliveredSeq).toBe(switched.latestSeq);
  });

  it("coordinates Antigravity helper ownership, turn state, reservation, and failure latch", async () => {
    const convA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const convB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const initial = await readAntigravityWakeState(tempDir);
    expect(isAntigravityHelperLive(initial, 100, "s1", convA, () => true)).toBe(false);
    expect(await setAntigravityReservation(tempDir, convA, true)).toBe(false);

    await recordAntigravityTurnEvent({
      stateDir: tempDir,
      agyPid: 100,
      agyStartToken: "s1",
      conversationId: convA,
      idle: false,
      clearReservation: true,
    });
    expect(await setAntigravityReservation(tempDir, convA, true)).toBe(false);

    const idleState = await recordAntigravityTurnEvent({
      stateDir: tempDir,
      agyPid: 100,
      agyStartToken: "s1",
      conversationId: convA,
      idle: true,
      clearReservation: false,
    });
    expect(idleState.idle).toBe(true);
    expect(await setAntigravityReservation(tempDir, convA, true)).toBe(true);
    expect(await setAntigravityReservation(tempDir, convA, true)).toBe(false);
    expect(await setAntigravityReservation(tempDir, convA, false)).toBe(true);

    const pub1 = await publishAntigravityHelper({
      stateDir: tempDir,
      record: {
        agyPid: 100,
        agyStartToken: "s1",
        helperPid: 500,
        conversationId: convA,
        attemptId: "att-1",
      },
      isPidAlive: (pid) => pid === 500,
    });
    expect(pub1.alreadyLive).toBe(false);

    const pubDup = await publishAntigravityHelper({
      stateDir: tempDir,
      record: {
        agyPid: 100,
        agyStartToken: "s1",
        helperPid: 501,
        conversationId: convA,
        attemptId: "att-2",
      },
      isPidAlive: (pid) => pid === 500,
    });
    expect(pubDup.alreadyLive).toBe(true);

    await latchAntigravityFailed({
      stateDir: tempDir,
      agyPid: 100,
      agyStartToken: "s1",
      conversationId: convA,
    });
    expect((await readAntigravityWakeState(tempDir)).latchedFailed).toBe(true);

    const resetState = await recordAntigravityTurnEvent({
      stateDir: tempDir,
      agyPid: 100,
      agyStartToken: "s1",
      conversationId: convB,
      idle: false,
      clearReservation: true,
    });
    expect(resetState.latchedFailed).toBe(false);
    expect(resetState.helper).toBeNull();
  });

  it("coordinates Kimi one-shot arming, unanswered latch, watcher lifecycle, and clear", async () => {
    await recordKimiSessionStart({
      stateDir: tempDir,
      pid: 700,
      startToken: "st-700",
      sessionId: "sess-1",
    });

    expect(
      await requestKimiArm({
        stateDir: tempDir,
        pid: 700,
        startToken: "st-700",
        sessionId: "sess-1",
        isPidAlive: () => true,
      }),
    ).toBe(true);

    expect(
      await requestKimiArm({
        stateDir: tempDir,
        pid: 700,
        startToken: "st-700",
        sessionId: "sess-1",
        isPidAlive: () => true,
      }),
    ).toBe(false);

    expect(
      await requestKimiArm({
        stateDir: tempDir,
        pid: 700,
        startToken: "st-700",
        sessionId: "sess-1",
        isPidAlive: () => true,
      }),
    ).toBe(false);

    await recordKimiSessionStart({
      stateDir: tempDir,
      pid: 700,
      startToken: "st-700",
      sessionId: "sess-1",
    });

    expect(
      await requestKimiArm({
        stateDir: tempDir,
        pid: 700,
        startToken: "st-700",
        sessionId: "sess-1",
        isPidAlive: () => true,
      }),
    ).toBe(true);

    await claimKimiWatcherStart({
      stateDir: tempDir,
      parentPid: 700,
      parentStartToken: "st-700",
      watcherPid: 801,
    });

    expect(
      await requestKimiArm({
        stateDir: tempDir,
        pid: 700,
        startToken: "st-700",
        sessionId: "sess-1",
        isPidAlive: (pid) => pid === 801,
      }),
    ).toBe(false);

    await recordKimiWatcherFinish({
      stateDir: tempDir,
      parentPid: 700,
      parentStartToken: "st-700",
      watcherPid: 999,
      latchReason: "failed",
    });

    await recordKimiWatcherFinish({
      stateDir: tempDir,
      parentPid: 700,
      parentStartToken: "st-700",
      watcherPid: 801,
      latchReason: null,
    });

    expect(
      await requestKimiArm({
        stateDir: tempDir,
        pid: 700,
        startToken: "st-700",
        sessionId: "sess-1",
        isPidAlive: () => false,
      }),
    ).toBe(true);

    await clearKimiSession({
      stateDir: tempDir,
      pid: 700,
      startToken: "st-700",
    });
  });
});

describe("formatCliCommand & parseHookArgs", () => {
  it("quotes POSIX and Windows arguments deterministically", () => {
    const posix = formatCliCommand(
      { command: "/usr/local/bin/node", prefixArgs: ["/opt/my app/index.js"] },
      ["watch", "--config", "/tmp/it's/config.json"],
      "linux",
    );
    expect(posix).toBe(
      "/usr/local/bin/node '/opt/my app/index.js' watch --config '/tmp/it'\\''s/config.json'",
    );

    const win = formatCliCommand(
      { command: "C:\\Program Files\\nodejs\\node.exe", prefixArgs: ["C:\\app\\index.js"] },
      ["watch", "--config", 'C:\\Users\\me\\my "cfg".json'],
      "win32",
    );
    expect(win).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" C:\\app\\index.js watch --config "C:\\Users\\me\\my \\"cfg\\".json"',
    );
  });

  it("parses valid hook flags and rejects missing or unknown flags", () => {
    const parsed = parseHookArgs(
      ["--client=grok", "--event=Stop", "--bin=/usr/local/bin/snapper-mcp", "--config=/tmp/c.json"],
      {},
      "linux",
    );
    expect(parsed.client).toBe("grok");
    expect(parsed.event).toBe("Stop");
    expect(parsed.configPath).toBe("/tmp/c.json");
    expect(parsed.invocation).toEqual({ command: "/usr/local/bin/snapper-mcp" });

    const parsedSpace = parseHookArgs(
      ["--client", "codex", "--event", "SessionStart", "--bin", "snapper-mcp"],
      { SNAPPER_MCP_HOME: "/tmp/state" },
      "linux",
    );
    expect(parsedSpace.client).toBe("codex");
    expect(parsedSpace.configPath).toBe("/tmp/state/config.json");

    expect(() => parseHookArgs(["--event", "Stop"])).toThrow(/--client is required/);
    expect(() => parseHookArgs(["--client", "grok"])).toThrow(/--event is required/);
    expect(() => parseHookArgs(["--client", "grok", "--event", "Stop", "--bad"])).toThrow(
      /unknown hook argument/,
    );
  });
});

describe("hookMain client handlers", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "snapper-hook-"));
    env = {
      SNAPPER_MCP_HOME: stateDir,
    };
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  function makeParent(
    exe: string,
    argv: readonly string[],
    readsTerminal = true,
  ): ParentProcessSnapshot {
    return {
      pid: 3100,
      ppid: 100,
      startToken: "tok-3100",
      executableName: exe,
      argv,
      readsTerminal,
    };
  }

  it("handles Grok Stop hook in interactive vs headless, active monitor, and wake=off modes", async () => {
    const out1 = new OutputBuffer();
    const code1 = await hookMain({
      argv: ["--client", "grok", "--event", "Stop"],
      source: env,
      platform: "linux",
      invocation: { command: "snapper-mcp" },
      stdin: JSON.stringify({ reason: "end_turn", backgroundTasks: [] }),
      stdout: out1,
      inspector: () => Promise.resolve(makeParent("grok", ["grok"])),
    });
    expect(code1).toBe(0);
    const decision = JSON.parse(out1.text()) as { decision: string; reason: string };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("snapper-mcp watch --client grok --actionable-only");

    const outActive = new OutputBuffer();
    await hookMain({
      argv: ["--client", "grok", "--event", "Stop"],
      source: env,
      platform: "linux",
      stdin: JSON.stringify({
        reason: "end_turn",
        background_tasks: [{ type: "monitor" }],
      }),
      stdout: outActive,
      inspector: () => Promise.resolve(makeParent("grok", ["grok"])),
    });
    expect(outActive.text()).toBe("");

    const outMalformed = new OutputBuffer();
    await hookMain({
      argv: ["--client", "grok", "--event", "Stop"],
      source: env,
      platform: "linux",
      stdin: JSON.stringify({
        reason: "end_turn",
        backgroundTasks: "not-an-array",
      }),
      stdout: outMalformed,
      inspector: () => Promise.resolve(makeParent("grok", ["grok"])),
    });
    expect(outMalformed.text()).toBe("");

    const outHeadless = new OutputBuffer();
    await hookMain({
      argv: ["--client", "grok", "--event", "Stop"],
      source: env,
      platform: "linux",
      stdin: JSON.stringify({ reason: "end_turn" }),
      stdout: outHeadless,
      inspector: () => Promise.resolve(makeParent("grok", ["grok", "-p", "task"])),
    });
    expect(outHeadless.text()).toBe("");

    await writeWakePreference(stateDir, "grok", "off", "linux");
    const outOff = new OutputBuffer();
    await hookMain({
      argv: ["--client", "grok", "--event", "Stop"],
      source: env,
      platform: "linux",
      stdin: JSON.stringify({ reason: "end_turn" }),
      stdout: outOff,
      inspector: () => Promise.resolve(makeParent("grok", ["grok"])),
    });
    expect(outOff.text()).toBe("");
  });

  it("handles Antigravity SessionStart, PreInvocation, and Stop hooks", async () => {
    const convId = "12345678-1234-4234-8234-123456789abc";
    await writeWakePreference(stateDir, "antigravity", "on", "linux");

    const startOut = new OutputBuffer();
    await hookMain({
      argv: ["--client", "antigravity", "--event", "SessionStart"],
      source: env,
      platform: "linux",
      stdin: Readable.from([Buffer.from(JSON.stringify({ conversation_id: convId }))]),
      stdout: startOut,
      inspector: () => Promise.resolve(makeParent("agy", ["agy", "chat"])),
    });
    expect(startOut.text()).toBe("");

    const stopOut = new OutputBuffer();
    await hookMain({
      argv: ["--client", "antigravity", "--event", "Stop"],
      source: env,
      platform: "linux",
      invocation: { command: "snapper-mcp" },
      stdin: JSON.stringify({ conversation_id: convId }),
      stdout: stopOut,
      inspector: () => Promise.resolve(makeParent("agy", ["agy"])),
      isPidAlive: () => false,
    });
    const parsed = JSON.parse(stopOut.text()) as { decision: string; reason: string };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("snapper-mcp watch --client antigravity --wake");

    const headlessOut = new OutputBuffer();
    await hookMain({
      argv: ["--client", "antigravity", "--event", "Stop"],
      source: env,
      platform: "linux",
      stdin: JSON.stringify({ conversation_id: convId }),
      stdout: headlessOut,
      inspector: () => Promise.resolve(makeParent("agy", ["agy", "chat", "-p", "hi"])),
    });
    expect(headlessOut.text()).toBe("");
  });

  it("handles Kimi SessionStart, UserPromptSubmit, subagent skip, and SessionEnd hooks", async () => {
    await writeWakePreference(stateDir, "kimi", "on", "linux");

    await hookMain({
      argv: ["--client", "kimi", "--event", "SessionStart"],
      source: env,
      platform: "linux",
      stdin: JSON.stringify({ session_id: "kimi-s1" }),
      inspector: () => Promise.resolve(makeParent("kimi", ["kimi"])),
    });

    const subagentOut = new OutputBuffer();
    await hookMain({
      argv: ["--client", "kimi", "--event", "UserPromptSubmit"],
      source: env,
      platform: "linux",
      stdin: JSON.stringify({ session_id: "kimi-s1", parent_session_id: "root-1" }),
      stdout: subagentOut,
      inspector: () => Promise.resolve(makeParent("kimi", ["kimi"])),
    });
    expect(subagentOut.text()).toBe("");

    const promptOut = new OutputBuffer();
    await hookMain({
      argv: ["--client", "kimi", "--event", "UserPromptSubmit"],
      source: env,
      platform: "linux",
      invocation: { command: "snapper-mcp" },
      stdin: JSON.stringify({ session_id: "kimi-s1" }),
      stdout: promptOut,
      inspector: () => Promise.resolve(makeParent("kimi", ["kimi"])),
    });
    expect(promptOut.text()).toContain("snapper-mcp watch --client kimi --once");

    await hookMain({
      argv: ["--client", "kimi", "--event", "SessionEnd"],
      source: env,
      platform: "linux",
      stdin: JSON.stringify({ session_id: "kimi-s1" }),
      inspector: () => Promise.resolve(makeParent("kimi", ["kimi"])),
    });
  });

  it("handles Cursor stop hook follow-up consumption and loop_count guard", async () => {
    await recordCursorActionableEvent(stateDir, 500);

    const loopOut = new OutputBuffer();
    await hookMain({
      argv: ["--client", "cursor", "--event", "stop"],
      source: env,
      platform: "linux",
      stdin: JSON.stringify({ loop_count: 1 }),
      stdout: loopOut,
      inspector: () => Promise.resolve(makeParent("cursor-agent", ["cursor-agent"])),
    });
    expect(loopOut.text()).toBe("{}\n");

    const wakeOut = new OutputBuffer();
    await hookMain({
      argv: ["--client", "cursor", "--event", "stop"],
      source: env,
      platform: "linux",
      stdin: JSON.stringify({ loop_count: 0 }),
      stdout: wakeOut,
      inspector: () => Promise.resolve(makeParent("cursor-agent", ["cursor-agent"])),
    });
    expect(JSON.parse(wakeOut.text())).toEqual({ followup_message: SNAPPER_WAKE_PROMPT });

    const secondOut = new OutputBuffer();
    await hookMain({
      argv: ["--client", "cursor", "--event", "stop"],
      source: env,
      platform: "linux",
      stdin: "{}",
      stdout: secondOut,
      inspector: () => Promise.resolve(makeParent("cursor-agent", ["cursor-agent"])),
    });
    expect(secondOut.text()).toBe("{}\n");
  });

  it("records Codex interactive root thread and ignores headless/claude/copilot/malformed inputs", async () => {
    const threadId = "99999999-9999-4999-8999-999999999999";
    await hookMain({
      argv: ["--client", "codex", "--event", "UserPromptSubmit"],
      source: env,
      platform: "linux",
      stdin: JSON.stringify({ thread_id: threadId }),
      inspector: () => Promise.resolve(makeParent("codex", ["codex"])),
    });
    expect((await readCodexWakeState(stateDir)).threadId).toBe(threadId);

    await hookMain({
      argv: ["--client", "codex", "--event", "SessionStart"],
      source: env,
      platform: "linux",
      stdin: JSON.stringify({ thread_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      inspector: () => Promise.resolve(makeParent("codex", ["codex", "exec", "run"])),
    });
    expect((await readCodexWakeState(stateDir)).threadId).toBe(threadId);

    const claudeOut = new OutputBuffer();
    expect(
      await hookMain({
        argv: ["--client", "claude", "--event", "Stop"],
        source: env,
        stdout: claudeOut,
      }),
    ).toBe(0);
    expect(claudeOut.text()).toBe("");

    const failOpenOut = new OutputBuffer();
    expect(
      await hookMain({
        argv: ["--client", "grok", "--event", "Stop"],
        source: env,
        stdin: "{malformed-json",
        stdout: failOpenOut,
      }),
    ).toBe(0);
    expect(failOpenOut.text()).toBe("");
  });
});
