import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { SNAPPER_COPILOT_ATTENTION_LINE } from "../src/actionable.js";
import {
  renderCopilotExtensionEntry,
  renderCopilotWatcherModule,
  verifyCopilotOwnedFile,
} from "../src/copilot_extension.js";
import {
  agyMode,
  checkInteractiveSession,
  codexMode,
  cursorMode,
  grokMode,
  inspectDarwinProcess,
  inspectLinuxProcess,
  inspectParentProcess,
  inspectWin32Process,
  kimiMode,
  matchesExpectedExecutable,
  parseLinuxStat,
  splitWindowsCommandLine,
  walkNearestAncestor,
  type ParentProcessSnapshot,
} from "../src/interactive.js";

describe("interactive argv grammars & process inspection", () => {
  it("classifies Antigravity (agy) invocations", () => {
    expect(agyMode(["agy"])).toBe("input");
    expect(agyMode(["agy", "-c", "--sandbox"])).toBe("input");
    expect(agyMode(["agy", "--model", "gemini-3", "-i", "hi"])).toBe("interactive");
    expect(agyMode(["agy", "--prompt-interactive=hello"])).toBe("interactive");
    expect(agyMode(["agy", "-p", "do work"])).toBe("print");
    expect(agyMode(["agy", "--print=work"])).toBe("print");
    expect(agyMode(["agy", "--prompt", "work"])).toBe("print");
    expect(agyMode(["agy", "chat"])).toBe("command");
    expect(agyMode(["agy", "--", "sub"])).toBe("command");
    expect(agyMode(["agy", "--"])).toBe("input");
    expect(agyMode(["agy", "--model"])).toBe("unknown");
    expect(agyMode(["agy", "--unknown-flag"])).toBe("unknown");
    expect(agyMode(["agy", "---"])).toBe("unknown");
  });

  it("classifies Grok invocations", () => {
    expect(grokMode(["grok"])).toBe("input");
    expect(grokMode(["grok", "-c", "-m", "grok-4", "-r", "sess1", "initial prompt"])).toBe(
      "input",
    );
    expect(grokMode(["grok", "-ms", "val", "--resume", "s1", "--"])).toBe("input");
    expect(grokMode(["grok", "-p", "headless"])).toBe("print");
    expect(grokMode(["grok", "-cp"])).toBe("print");
    expect(grokMode(["grok", "--single", "one"])).toBe("print");
    expect(grokMode(["grok", "--prompt-file=/tmp/p"])).toBe("print");
    expect(grokMode(["grok", "mcp"])).toBe("command");
    expect(grokMode(["grok", "-m"])).toBe("unknown");
    expect(grokMode(["grok", "--model"])).toBe("unknown");
    expect(grokMode(["grok", "-z"])).toBe("unknown");
    expect(grokMode(["grok", "--bogus"])).toBe("unknown");
    expect(grokMode(["grok", "p1", "p2"])).toBe("unknown");
  });

  it("classifies Kimi invocations including rewritten argv", () => {
    expect(kimiMode(["kimi"])).toBe("input");
    expect(kimiMode(["kimi-code", "", ""])).toBe("input");
    expect(kimiMode(["kimi", "--yolo", "-m", "k2", "-S", "s1"])).toBe("input");
    expect(kimiMode(["kimi", "--session", "s2", "--"])).toBe("input");
    expect(kimiMode(["kimi", "--", "extra"])).toBe("command");
    expect(kimiMode(["kimi", "-p", "hi"])).toBe("print");
    expect(kimiMode(["kimi", "--prompt=hi"])).toBe("print");
    expect(kimiMode(["kimi", "acp"])).toBe("command");
    expect(kimiMode(["kimi", "-m"])).toBe("unknown");
    expect(kimiMode(["kimi", "--model"])).toBe("unknown");
    expect(kimiMode(["kimi", "-x"])).toBe("unknown");
    expect(kimiMode(["kimi", "--yolo=true"])).toBe("unknown");
    expect(kimiMode(["kimi", "positional"])).toBe("unknown");
  });

  it("classifies Cursor invocations including Linux node wrapper", () => {
    expect(cursorMode(["cursor-agent"])).toBe("input");
    expect(
      cursorMode([
        "cursor-agent",
        "--use-system-ca",
        "/opt/cursor/index.js",
        "--resume",
        "chat1",
        "-f",
        "-e",
        "https://api",
        "-w",
        "wt",
      ]),
    ).toBe("input");
    expect(cursorMode(["cursor-agent", "--"])).toBe("input");
    expect(cursorMode(["cursor-agent", "-pf"])).toBe("print");
    expect(cursorMode(["cursor-agent", "--print"])).toBe("print");
    expect(cursorMode(["cursor-agent", "--print=bad"])).toBe("unknown");
    expect(cursorMode(["cursor-agent", "--trust=true"])).toBe("unknown");
    expect(cursorMode(["cursor-agent", "--model"])).toBe("unknown");
    expect(cursorMode(["cursor-agent", "-H"])).toBe("unknown");
    expect(cursorMode(["cursor-agent", "-z"])).toBe("unknown");
    expect(cursorMode(["cursor-agent", "--unknown"])).toBe("unknown");
    expect(cursorMode(["cursor-agent", "mcp"])).toBe("command");
  });

  it("classifies Codex invocations", () => {
    expect(codexMode(["codex"])).toBe("input");
    expect(codexMode(["codex", "-m", "gpt-5", "-C", "/repo", "fix bug"])).toBe("input");
    expect(codexMode(["codex", "--"])).toBe("input");
    expect(codexMode(["codex", "exec", "headless prompt"])).toBe("command");
    expect(codexMode(["codex", "mcp"])).toBe("command");
    expect(codexMode(["codex", "-m"])).toBe("unknown");
  });

  it("splits Windows command lines strictly and refuses doubled quotes", () => {
    expect(
      splitWindowsCommandLine(
        '"C:\\Program Files\\Codex\\codex.exe" --model "gpt 5" \\"q\\" \\\\"r"',
      ),
    ).toEqual(["C:\\Program Files\\Codex\\codex.exe", "--model", "gpt 5", '"q"', "\\r"]);
    expect(splitWindowsCommandLine("")).toBeNull();
    expect(splitWindowsCommandLine('codex "" --flag')).toBeNull();
    expect(splitWindowsCommandLine('codex "unterminated')).toBeNull();
  });

  it("inspects Linux, Darwin, and Windows processes and walks past shell wrappers", async () => {
    expect(matchesExpectedExecutable("cursor", "/opt/cursor/node", "/bin/cursor-agent")).toBe(
      true,
    );
    expect(matchesExpectedExecutable("claude", "C:\\bin\\claude.exe")).toBe(true);
    expect(matchesExpectedExecutable("copilot", "/usr/bin/copilot")).toBe(true);

    expect(parseLinuxStat("bad stat")).toBeNull();
    const zombieStat =
      "42 (sh) Z 1 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 98765 0 0";
    expect(parseLinuxStat(zombieStat)).toBeNull();
    const liveStat =
      "42 (agy) S 10 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 98765 0 0";
    expect(parseLinuxStat(liveStat)).toEqual({
      state: "S",
      ppid: 10,
      startToken: "98765",
    });

    if (process.platform === "linux") {
      const selfSnap = await inspectLinuxProcess(process.pid);
      expect(selfSnap).not.toBeNull();
      expect(selfSnap?.pid).toBe(process.pid);
    }
    expect(await inspectLinuxProcess(999_999_999)).toBeNull();

    const darwinSnap = await inspectDarwinProcess(500, async (_file, args) => {
      const fmt = args[1];
      if (fmt === "ppid=") return "100\n";
      if (fmt === "tty=") return "ttys002\n";
      if (fmt === "lstart=") return "Sun Nov 15 16:00:00 2026\n";
      return "/usr/local/bin/grok --continue\n";
    });
    expect(darwinSnap).toEqual({
      pid: 500,
      ppid: 100,
      startToken: "Sun Nov 15 16:00:00 2026",
      executableName: "/usr/local/bin/grok",
      argv: ["/usr/local/bin/grok", "--continue"],
      readsTerminal: true,
    });
    expect(
      await inspectDarwinProcess(500, async () => {
        throw new Error("ps failed");
      }),
    ).toBeNull();

    const winSnap = await inspectWin32Process(600, async () =>
      JSON.stringify({
        ParentProcessId: 200,
        SessionId: 1,
        ExecutablePath: "C:\\Users\\dev\\bin\\codex.exe",
        CommandLine: '"C:\\Users\\dev\\bin\\codex.exe" --model gpt-5',
        CreationDate: "20261115160000.000000+000",
      }),
    );
    expect(winSnap).toEqual({
      pid: 600,
      ppid: 200,
      startToken: "20261115160000.000000+000",
      executableName: "C:\\Users\\dev\\bin\\codex.exe",
      argv: ["C:\\Users\\dev\\bin\\codex.exe", "--model", "gpt-5"],
      readsTerminal: true,
    });
    expect(await inspectWin32Process(600, async () => "")).toBeNull();

    // Ancestor walk skips bash wrapper and finds client process:
    const table = new Map<number, ParentProcessSnapshot>([
      [
        300,
        {
          pid: 300,
          ppid: 250,
          startToken: "t300",
          executableName: "/bin/bash",
          argv: ["/bin/bash", "-c", "snapper-mcp hook"],
          readsTerminal: false,
        },
      ],
      [
        250,
        {
          pid: 250,
          ppid: 100,
          startToken: "t250",
          executableName: "/usr/local/bin/agy",
          argv: ["agy"],
          readsTerminal: true,
        },
      ],
    ]);
    const nearest = await walkNearestAncestor(300, async (p) => table.get(p) ?? null);
    expect(nearest?.pid).toBe(250);

    expect(await inspectParentProcess(0, "linux")).toBeNull();
    expect(await inspectParentProcess(200, "aix")).toBeNull();
  });

  it("enforces interactive session checks across positive and negative controls", async () => {
    expect((await checkInteractiveSession("grok", async () => null)).interactive).toBe(false);
    expect(
      (
        await checkInteractiveSession("grok", async () => ({
          pid: 10,
          startToken: "1",
          executableName: "python",
          argv: ["python"],
          readsTerminal: true,
        }))
      ).reason,
    ).toBe("no grok process");

    expect(
      (
        await checkInteractiveSession("grok", async () => ({
          pid: 10,
          startToken: "1",
          executableName: "grok",
          argv: ["grok", "-p", "hi"],
          readsTerminal: true,
        }))
      ).reason,
    ).toBe("print mode");

    expect(
      (
        await checkInteractiveSession("codex", async () => ({
          pid: 10,
          startToken: "1",
          executableName: "codex",
          argv: ["codex", "exec", "hi"],
          readsTerminal: true,
        }))
      ).reason,
    ).toBe("subcommand");

    expect(
      (
        await checkInteractiveSession("kimi", async () => ({
          pid: 10,
          startToken: "1",
          executableName: "kimi",
          argv: ["kimi", "--bogus"],
          readsTerminal: true,
        }))
      ).reason,
    ).toBe("unknown argument");

    expect(
      (
        await checkInteractiveSession("cursor", async () => ({
          pid: 10,
          startToken: "1",
          executableName: "cursor-agent",
          argv: ["cursor-agent"],
          readsTerminal: false,
        }))
      ).reason,
    ).toBe("input is not a terminal");

    expect(
      (
        await checkInteractiveSession("antigravity", async () => ({
          pid: 10,
          startToken: "1",
          executableName: "agy",
          argv: ["agy", "-i", "start"],
          readsTerminal: false,
        }))
      ).interactive,
    ).toBe(true);

    expect(
      (
        await checkInteractiveSession("claude", async () => ({
          pid: 10,
          startToken: "1",
          executableName: "claude",
          argv: ["claude"],
          readsTerminal: true,
        }))
      ).interactive,
    ).toBe(true);
  });
});

describe("copilot_extension", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("verifies SHA-256 ownership headers and runs the generated watcher module", async () => {
    const entry = renderCopilotExtensionEntry({
      command: "snapper-mcp",
      configPath: "/etc/snapper/config.json",
    });
    const watcherSource = renderCopilotWatcherModule();

    expect(verifyCopilotOwnedFile(entry)).toBe(true);
    expect(verifyCopilotOwnedFile(watcherSource)).toBe(true);
    expect(verifyCopilotOwnedFile(`${watcherSource}// user edit\n`)).toBe(false);
    expect(verifyCopilotOwnedFile("no header")).toBe(false);

    // Dynamically import generated watcher.mjs to verify runtime behavior!
    const dir = await mkdtemp(path.join(os.tmpdir(), "snapper-copilot-ext-"));
    tempDirs.push(dir);
    const modPath = path.join(dir, "watcher.mjs");
    await writeFile(modPath, watcherSource, "utf8");
    const mod = (await import(pathToFileURL(modPath).href)) as {
      interactiveHost: (s: unknown) => boolean;
      runExtension: (opts: Record<string, unknown>) => Promise<() => void>;
    };

    // Headless `copilot -p` (`canvases: false`) -> silent no-op, zero spawns, zero logs:
    let spawnedCount = 0;
    const headlessStop = await mod.runExtension({
      joinSession: async () => ({
        sessionId: "sess-headless",
        capabilities: { ui: { canvases: false } },
      }),
      command: "snapper-mcp",
      args: ["watch"],
      spawn: () => {
        spawnedCount += 1;
        return {};
      },
    });
    expect(spawnedCount).toBe(0);
    headlessStop();

    // Interactive TUI (`canvases: true`) -> coalesces while busy, dispatches on session.idle:
    const sessionEvents = new EventEmitter();
    const sentPrompts: unknown[] = [];
    const childStdout = new PassThrough();
    const childStderr = new PassThrough();
    const childEmitter = Object.assign(new EventEmitter(), {
      stdout: childStdout,
      stderr: childStderr,
      kill: () => undefined,
    });
    const signals = new EventEmitter();

    const stop = await mod.runExtension({
      joinSession: async () => ({
        sessionId: "sess-tui-1",
        capabilities: { ui: { canvases: true } },
        on: (ev: string, fn: () => void) => sessionEvents.on(ev, fn),
        send: async (payload: unknown) => {
          sentPrompts.push(payload);
        },
        log: async () => undefined,
      }),
      command: "snapper-mcp",
      args: ["watch", "--client", "copilot"],
      signals,
      spawn: () => {
        spawnedCount += 1;
        return childEmitter;
      },
    });

    expect(spawnedCount).toBe(1);
    sessionEvents.emit("assistant.turn_start");
    childStdout.write(`${SNAPPER_COPILOT_ATTENTION_LINE}\n`);
    childStdout.write(`${SNAPPER_COPILOT_ATTENTION_LINE}\n`);
    await new Promise((r) => setTimeout(r, 25));
    expect(sentPrompts).toHaveLength(0);

    sessionEvents.emit("session.idle");
    await new Promise((r) => setTimeout(r, 25));
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toMatchObject({
      source: "automation-snapper",
      mode: "enqueue",
    });

    stop();
  });
});
