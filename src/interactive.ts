/**
 * Interactive-session detection for client wake hooks.
 *
 * Headless print-mode runs (`agy -p`, `grok -p`, `kimi -p`, `cursor-agent -p`,
 * `codex exec`) and subcommands (`mcp`, `acp`, `doctor`, etc.) MUST NOT receive
 * wake-arming continuation prompts, because any injected turn or stdout log line
 * alters the headless caller's output. When arguments or terminal attachment
 * cannot be verified positively, detection fails closed (`interactive: false`).
 */

import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

import type { ClientName } from "./clients.js";

const execFileAsync = promisify(execFile);

export type ParsedClientMode =
  | "unknown"
  | "print"
  | "command"
  | "interactive"
  | "input";

export interface ParentProcessSnapshot {
  readonly pid: number;
  readonly ppid?: number;
  readonly startToken: string;
  readonly executableName: string;
  readonly argv: readonly string[];
  readonly readsTerminal: boolean;
}

export type ExecCommandRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

export interface InteractiveCheckResult {
  readonly interactive: boolean;
  readonly reason: string;
  readonly parent: ParentProcessSnapshot | null;
}

export type ParentProcessInspector = (
  parentPid?: number,
) => Promise<ParentProcessSnapshot | null>;

const AGY_BOOLS: ReadonlySet<string> = new Set([
  "c",
  "continue",
  "dangerously-skip-permissions",
  "disable-slash-commands",
  "new-project",
  "remote-agent",
  "remote-control",
  "sandbox",
]);

const AGY_VALUES: ReadonlySet<string> = new Set([
  "add-dir",
  "agent",
  "conversation",
  "effort",
  "i",
  "input-format",
  "json-schema",
  "log-file",
  "mode",
  "model",
  "output-format",
  "p",
  "print",
  "print-timeout",
  "project",
  "prompt",
  "prompt-interactive",
  "settings",
]);

const AGY_PRINT: ReadonlySet<string> = new Set(["p", "print", "prompt"]);
const AGY_PROMPTED: ReadonlySet<string> = new Set(["i", "prompt-interactive"]);

export function agyMode(args: readonly string[]): ParsedClientMode {
  let mode: ParsedClientMode = "input";
  let i = 1;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") {
      if (i + 1 < args.length) return "command";
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      return "command";
    }
    const stripped = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
    if (stripped.length === 0 || stripped.startsWith("-") || stripped.startsWith("=")) {
      return "unknown";
    }
    const eqIdx = stripped.indexOf("=");
    const attached = eqIdx >= 0;
    const name = attached ? stripped.slice(0, eqIdx) : stripped;
    if (AGY_PRINT.has(name)) {
      return "print";
    }
    if (AGY_BOOLS.has(name)) {
      i += 1;
      continue;
    }
    if (AGY_VALUES.has(name)) {
      if (AGY_PROMPTED.has(name)) {
        mode = "interactive";
      }
      if (!attached) {
        i += 1;
        if (i >= args.length) return "unknown";
      }
      i += 1;
      continue;
    }
    return "unknown";
  }
  return mode;
}

const GROK_BOOLS: ReadonlySet<string> = new Set([
  "always-approve",
  "continue",
  "debug",
  "disable-web-search",
  "fork-session",
  "fullscreen",
  "help",
  "include-partial-messages",
  "minimal",
  "no-alt-screen",
  "no-plan",
  "no-subagents",
  "oauth",
  "restore-code",
  "verbatim",
  "version",
]);

const GROK_VALUES: ReadonlySet<string> = new Set([
  "add-dir",
  "agent",
  "agents",
  "allow",
  "allowed-tools",
  "allowedTools",
  "cwd",
  "debug-file",
  "deny",
  "disallowed-tools",
  "disallowedTools",
  "effort",
  "json-schema",
  "leader-socket",
  "max-turns",
  "model",
  "output-format",
  "permission-mode",
  "prompt-file",
  "prompt-json",
  "reasoning-effort",
  "ref",
  "rules",
  "sandbox",
  "session-id",
  "single",
  "system-prompt",
  "system-prompt-override",
  "tools",
  "worktree-ref",
]);

const GROK_OPTIONAL: ReadonlySet<string> = new Set(["resume", "worktree"]);
const GROK_PRINT: ReadonlySet<string> = new Set(["single", "prompt-file", "prompt-json"]);
const GROK_COMMANDS: ReadonlySet<string> = new Set([
  "agent",
  "clone",
  "completions",
  "dashboard",
  "disk-usage",
  "doctor",
  "du",
  "export",
  "help",
  "inspect",
  "leader",
  "login",
  "logout",
  "mcp",
  "memory",
  "models",
  "plugin",
  "sessions",
  "setup",
  "trace",
  "update",
  "usage",
  "v",
  "version",
  "worker",
  "worktree",
  "wrap",
]);

function grokShorts(
  group: string,
  args: readonly string[],
  index: number,
): readonly [ParsedClientMode, number] {
  for (let j = 0; j < group.length; j += 1) {
    const ch = group[j]!;
    if (ch === "p") return ["print", index];
    if (ch === "c" || ch === "h" || ch === "v") continue;
    if (ch === "m" || ch === "s") {
      if (j + 1 === group.length) {
        if (index + 1 >= args.length) return ["unknown", index + 1];
        return ["input", index + 1];
      }
      return ["input", index];
    }
    if (ch === "r" || ch === "w") {
      const next = args[index + 1];
      if (j + 1 === group.length && next !== undefined && !next.startsWith("-")) {
        return ["input", index + 1];
      }
      return ["input", index];
    }
    return ["unknown", index];
  }
  return ["input", index];
}

export function grokMode(args: readonly string[]): ParsedClientMode {
  let promptSeen = false;
  let i = 1;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") return "input";
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eqIdx = body.indexOf("=");
      const attached = eqIdx >= 0;
      const name = attached ? body.slice(0, eqIdx) : body;
      if (GROK_PRINT.has(name)) return "print";
      if (GROK_BOOLS.has(name)) {
        i += 1;
        continue;
      }
      if (GROK_VALUES.has(name)) {
        if (!attached) {
          i += 1;
          if (i >= args.length) return "unknown";
        }
        i += 1;
        continue;
      }
      if (GROK_OPTIONAL.has(name)) {
        const next = args[i + 1];
        if (!attached && next !== undefined && !next.startsWith("-")) {
          i += 1;
        }
        i += 1;
        continue;
      }
      return "unknown";
    }
    if (arg.length > 1 && arg.startsWith("-")) {
      const [shortMode, nextIdx] = grokShorts(arg.slice(1), args, i);
      if (shortMode !== "input") return shortMode;
      i = nextIdx + 1;
      continue;
    }
    if (GROK_COMMANDS.has(arg)) return "command";
    if (promptSeen) return "unknown";
    promptSeen = true;
    i += 1;
  }
  return "input";
}

const KIMI_BOOLS: ReadonlySet<string> = new Set([
  "auto",
  "continue",
  "help",
  "plan",
  "version",
  "yolo",
]);

const KIMI_VALUES: ReadonlySet<string> = new Set([
  "add-dir",
  "agent",
  "agent-file",
  "model",
  "output-format",
  "prompt",
  "skills-dir",
]);

const KIMI_OPTIONAL: ReadonlySet<string> = new Set(["session"]);
const KIMI_COMMANDS: ReadonlySet<string> = new Set([
  "acp",
  "app",
  "doctor",
  "export",
  "fork",
  "help",
  "import-sessions",
  "install-desktop",
  "login",
  "migrate",
  "provider",
  "rc",
  "remote",
  "server",
  "session",
  "update",
  "upgrade",
  "vis",
  "web",
]);

function isKimiRewritten(args: readonly string[]): boolean {
  if (args.length < 2 || args[0] !== "kimi-code") return false;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] !== "") return false;
  }
  return true;
}

function kimiShorts(
  group: string,
  args: readonly string[],
  index: number,
): readonly [ParsedClientMode, number] {
  for (let j = 0; j < group.length; j += 1) {
    const ch = group[j]!;
    if (ch === "p") return ["print", index];
    if (ch === "c" || ch === "h" || ch === "V" || ch === "y") continue;
    if (ch === "m") {
      if (j + 1 === group.length) {
        if (index + 1 >= args.length) return ["unknown", index + 1];
        return ["input", index + 1];
      }
      return ["input", index];
    }
    if (ch === "S") {
      const next = args[index + 1];
      if (j + 1 === group.length && next !== undefined && !next.startsWith("-")) {
        return ["input", index + 1];
      }
      return ["input", index];
    }
    return ["unknown", index];
  }
  return ["input", index];
}

export function kimiMode(args: readonly string[]): ParsedClientMode {
  if (isKimiRewritten(args)) return "input";
  let i = 1;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") {
      return i + 1 < args.length ? "command" : "input";
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eqIdx = body.indexOf("=");
      const attached = eqIdx >= 0;
      const name = attached ? body.slice(0, eqIdx) : body;
      if (name === "prompt") return "print";
      if (KIMI_BOOLS.has(name) && !attached) {
        i += 1;
        continue;
      }
      if (KIMI_VALUES.has(name)) {
        if (!attached) {
          i += 1;
          if (i >= args.length) return "unknown";
        }
        i += 1;
        continue;
      }
      if (KIMI_OPTIONAL.has(name)) {
        const next = args[i + 1];
        if (!attached && next !== undefined && !next.startsWith("-")) {
          i += 1;
        }
        i += 1;
        continue;
      }
      return "unknown";
    }
    if (arg.length > 1 && arg.startsWith("-")) {
      const [shortMode, nextIdx] = kimiShorts(arg.slice(1), args, i);
      if (shortMode !== "input") return shortMode;
      i = nextIdx + 1;
      continue;
    }
    if (KIMI_COMMANDS.has(arg)) return "command";
    return "unknown";
  }
  return "input";
}

const CURSOR_BOOLS: ReadonlySet<string> = new Set([
  "use-system-ca",
  "disable-auto-update",
  "stream-partial-output",
  "plan",
  "force",
  "yolo",
  "auto-review",
  "approve-mcps",
  "trust",
  "list-models",
  "skip-worktree-setup",
  "help",
  "version",
  "continue",
]);

const CURSOR_VALUES: ReadonlySet<string> = new Set([
  "api-key",
  "header",
  "endpoint",
  "output-format",
  "mode",
  "model",
  "sandbox",
  "workspace",
  "add-dir",
  "plugin-dir",
  "worktree-base",
]);

const CURSOR_OPTIONAL: ReadonlySet<string> = new Set(["resume", "worktree"]);
const CURSOR_COMMANDS: ReadonlySet<string> = new Set([
  "persist",
  "install-shell-integration",
  "uninstall-shell-integration",
  "login",
  "logout",
  "mcp",
  "plugin",
  "worker",
  "status",
  "whoami",
  "models",
  "team",
  "bedrock",
  "about",
  "update",
  "create-chat",
  "generate-rule",
  "rule",
  "agent",
  "ls",
  "resume",
  "help",
]);

function cursorShorts(
  group: string,
  args: readonly string[],
  index: number,
): readonly [ParsedClientMode, number] {
  for (let j = 0; j < group.length; j += 1) {
    const ch = group[j]!;
    if (ch === "p") return ["print", index];
    if (ch === "f" || ch === "h" || ch === "v") continue;
    if (ch === "H" || ch === "e") {
      if (j + 1 === group.length) {
        if (index + 1 >= args.length) return ["unknown", index + 1];
        return ["input", index + 1];
      }
      return ["input", index];
    }
    if (ch === "w") {
      const next = args[index + 1];
      if (j + 1 === group.length && next !== undefined && !next.startsWith("-")) {
        return ["input", index + 1];
      }
      return ["input", index];
    }
    return ["unknown", index];
  }
  return ["input", index];
}

export function cursorMode(args: readonly string[]): ParsedClientMode {
  let i = 1;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") return "input";
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eqIdx = body.indexOf("=");
      const attached = eqIdx >= 0;
      const name = attached ? body.slice(0, eqIdx) : body;
      if (name === "print") {
        return attached ? "unknown" : "print";
      }
      if (CURSOR_BOOLS.has(name)) {
        if (attached) return "unknown";
        i += 1;
        continue;
      }
      if (CURSOR_VALUES.has(name)) {
        if (!attached) {
          i += 1;
          if (i >= args.length) return "unknown";
        }
        i += 1;
        continue;
      }
      if (CURSOR_OPTIONAL.has(name)) {
        const next = args[i + 1];
        if (!attached && next !== undefined && !next.startsWith("-")) {
          i += 1;
        }
        i += 1;
        continue;
      }
      return "unknown";
    }
    if (arg.length > 1 && arg.startsWith("-")) {
      const [shortMode, nextIdx] = cursorShorts(arg.slice(1), args, i);
      if (shortMode !== "input") return shortMode;
      i = nextIdx + 1;
      continue;
    }
    if (CURSOR_COMMANDS.has(arg)) return "command";
    i += 1;
  }
  return "input";
}

const CODEX_BOOLS: ReadonlySet<string> = new Set([
  "full-auto",
  "dangerously-bypass-approvals-and-sandbox",
  "yolo",
  "oss",
  "search",
  "no-alt-screen",
  "help",
  "version",
]);

const CODEX_VALUES: ReadonlySet<string> = new Set([
  "model",
  "config",
  "profile",
  "sandbox",
  "ask-for-approval",
  "cd",
  "image",
  "add-dir",
  "enable",
  "disable",
  "local-provider",
  "color",
]);

const CODEX_COMMANDS: ReadonlySet<string> = new Set([
  "exec",
  "e",
  "review",
  "login",
  "logout",
  "mcp",
  "mcp-server",
  "app-server",
  "completion",
  "sandbox",
  "debug",
  "apply",
  "a",
  "cloud",
  "features",
  "help",
  "queue",
  "doctor",
  "fork",
]);

function codexShorts(
  group: string,
  args: readonly string[],
  index: number,
): readonly [ParsedClientMode, number] {
  for (let j = 0; j < group.length; j += 1) {
    const ch = group[j]!;
    if (ch === "h" || ch === "V") continue;
    if (
      ch === "m" ||
      ch === "c" ||
      ch === "p" ||
      ch === "s" ||
      ch === "a" ||
      ch === "C" ||
      ch === "i"
    ) {
      if (j + 1 === group.length) {
        if (index + 1 >= args.length) return ["unknown", index + 1];
        return ["input", index + 1];
      }
      return ["input", index];
    }
    return ["unknown", index];
  }
  return ["input", index];
}

export function codexMode(args: readonly string[]): ParsedClientMode {
  let promptSeen = false;
  let i = 1;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") {
      const rest = args.length - (i + 1);
      return rest === 0 || (!promptSeen && rest === 1) ? "input" : "unknown";
    }
    if (arg === "-") return "unknown";
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eqIdx = body.indexOf("=");
      const attached = eqIdx >= 0;
      const name = attached ? body.slice(0, eqIdx) : body;
      if (CODEX_BOOLS.has(name)) {
        if (attached) return "unknown";
        i += 1;
        continue;
      }
      if (CODEX_VALUES.has(name)) {
        if (!attached) {
          i += 1;
          if (i >= args.length) return "unknown";
        }
        i += 1;
        continue;
      }
      return "unknown";
    }
    if (arg.length > 1 && arg.startsWith("-")) {
      const [shortMode, nextIdx] = codexShorts(arg.slice(1), args, i);
      if (shortMode !== "input") return shortMode;
      i = nextIdx + 1;
      continue;
    }
    if (!promptSeen && CODEX_COMMANDS.has(arg)) return "command";
    if (promptSeen) return "unknown";
    promptSeen = true;
    i += 1;
  }
  return "input";
}

const SHELL_WRAPPERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "dash",
  "ash",
  "zsh",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "cmd",
  "powershell",
  "pwsh",
  "busybox",
  "npx",
  "npm",
]);

const KNOWN_CLIENTS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "copilot",
  "cursor",
  "cursor-agent",
  "agy",
  "antigravity",
  "grok",
  "kimi",
  "kimi-code",
]);

function normalizeExecutableBase(raw: string): string {
  const normalized = raw.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

export function matchesExpectedExecutable(
  client: ClientName,
  executableName: string,
  argv0?: string,
): boolean {
  const candidates = [normalizeExecutableBase(executableName)];
  if (typeof argv0 === "string" && argv0.length > 0) {
    candidates.push(normalizeExecutableBase(argv0));
  }
  const matchesOne = (base: string): boolean => {
    switch (client) {
      case "antigravity":
        return base === "agy" || base === "antigravity";
      case "grok":
        return base === "grok";
      case "kimi":
        return base === "kimi" || base === "kimi-code";
      case "cursor":
        return base === "cursor-agent" || base === "node";
      case "codex":
        return base === "codex";
      case "claude":
        return base === "claude";
      case "copilot":
        return base === "copilot";
    }
  };
  return candidates.some((base) => matchesOne(base));
}

function isShellSnapshot(snap: ParentProcessSnapshot): boolean {
  const argv0Base = normalizeExecutableBase(snap.argv[0] ?? "");
  if (KNOWN_CLIENTS.has(argv0Base)) {
    return false;
  }
  const exeBase = normalizeExecutableBase(snap.executableName);
  return SHELL_WRAPPERS.has(exeBase) || SHELL_WRAPPERS.has(argv0Base);
}

function isKnownClientSnapshot(snap: ParentProcessSnapshot): boolean {
  const exeBase = normalizeExecutableBase(snap.executableName);
  const argv0Base = normalizeExecutableBase(snap.argv[0] ?? "");
  return KNOWN_CLIENTS.has(exeBase) || KNOWN_CLIENTS.has(argv0Base);
}

export function parseLinuxStat(
  statText: string,
): { readonly state: string; readonly ppid: number; readonly startToken: string } | null {
  const closeParen = statText.lastIndexOf(")");
  if (closeParen < 0) return null;
  const fields = statText
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const startTime = fields[19];
  if (
    typeof state !== "string" ||
    state.length === 0 ||
    state === "Z" ||
    state === "X" ||
    state === "x" ||
    !Number.isInteger(ppid) ||
    typeof startTime !== "string" ||
    startTime.length === 0
  ) {
    return null;
  }
  return { state, ppid, startToken: startTime };
}

function isLinuxTerminalLink(target: string): boolean {
  return (
    target.startsWith("/dev/pts/") ||
    target.startsWith("/dev/tty") ||
    target === "/dev/console"
  );
}

const defaultExecRunner: ExecCommandRunner = async (file, args, timeoutMs) => {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: timeoutMs,
    windowsHide: true,
  });
  return stdout;
};

export async function inspectLinuxProcess(
  pid: number,
  procRoot = "/proc",
): Promise<ParentProcessSnapshot | null> {
  const pidDir = `${procRoot}/${pid}`;
  try {
    const [cmdRaw, statText] = await Promise.all([
      readFile(`${pidDir}/cmdline`),
      readFile(`${pidDir}/stat`, "utf8"),
    ]);
    const parsedStat = parseLinuxStat(statText);
    if (parsedStat === null || cmdRaw.length === 0) return null;
    const parts = cmdRaw.toString("utf8").split("\0");
    if (parts.length > 0 && parts[parts.length - 1] === "") {
      parts.pop();
    }
    if (parts.length === 0) return null;

    let exeName = parts[0]!;
    try {
      exeName = await readlink(`${pidDir}/exe`);
    } catch {
      // Fallback to argv[0] when /proc/<pid>/exe cannot be read.
    }

    const fd0Link = await readlink(`${pidDir}/fd/0`).catch(() => "");
    return {
      pid,
      ppid: parsedStat.ppid,
      startToken: parsedStat.startToken,
      executableName: exeName,
      argv: parts,
      readsTerminal: isLinuxTerminalLink(fd0Link),
    };
  } catch {
    return null;
  }
}

export function splitPosixCommandLine(line: string): string[] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let tokenStarted = false;
  let i = 0;

  while (i < trimmed.length) {
    const ch = trimmed[i]!;
    if (quote === null && (ch === " " || ch === "\t")) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      i += 1;
      continue;
    }
    tokenStarted = true;
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      i += 1;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= trimmed.length) return null;
      current += trimmed[i + 1]!;
      i += 2;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }

  if (quote !== null) return null;
  if (tokenStarted) args.push(current);
  return args.length > 0 ? args : null;
}

export async function inspectDarwinProcess(
  pid: number,
  execRunner: ExecCommandRunner = defaultExecRunner,
): Promise<ParentProcessSnapshot | null> {
  try {
    const [ppidRaw, ttyRaw, startRaw, cmdRaw] = await Promise.all([
      execRunner("ps", ["-o", "ppid=", "-p", String(pid)], 1_000),
      execRunner("ps", ["-o", "tty=", "-p", String(pid)], 1_000),
      execRunner("ps", ["-o", "lstart=", "-p", String(pid)], 1_000),
      execRunner("ps", ["-o", "command=", "-p", String(pid)], 1_000),
    ]);
    const commandLine = cmdRaw.trim();
    const startToken = startRaw.trim();
    const tty = ttyRaw.trim();
    const ppid = Number(ppidRaw.trim());
    if (commandLine.length === 0 || startToken.length === 0) return null;
    const argv = splitPosixCommandLine(commandLine);
    if (argv === null) return null;
    return {
      pid,
      ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : 0,
      startToken,
      executableName: argv[0] ?? "",
      argv,
      readsTerminal: tty.length > 0 && tty !== "??" && tty !== "?",
    };
  } catch {
    return null;
  }
}

export function splitWindowsCommandLine(line: string): string[] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.includes('""')) {
    return null;
  }
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let tokenStarted = false;
  let i = 0;

  while (i < trimmed.length) {
    const ch = trimmed[i]!;
    if (!inQuotes && (ch === " " || ch === "\t")) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      i += 1;
      continue;
    }
    tokenStarted = true;
    if (ch === "\\") {
      let backslashes = 0;
      while (i < trimmed.length && trimmed[i] === "\\") {
        backslashes += 1;
        i += 1;
      }
      if (i < trimmed.length && trimmed[i] === '"') {
        current += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 0) {
          inQuotes = !inQuotes;
        } else {
          current += '"';
        }
        i += 1;
      } else {
        current += "\\".repeat(backslashes);
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }

  if (inQuotes) return null;
  if (tokenStarted) args.push(current);
  return args.length > 0 ? args : null;
}

export async function inspectWin32Process(
  pid: number,
  execRunner: ExecCommandRunner = defaultExecRunner,
): Promise<ParentProcessSnapshot | null> {
  try {
    const script =
      `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | ` +
      "Select-Object ParentProcessId,SessionId,ExecutablePath,CommandLine,CreationDate | " +
      "ConvertTo-Json -Compress";
    const stdout = await execRunner(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      1_500,
    );
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return null;
    const parsed = JSON.parse(trimmed) as {
      readonly ParentProcessId?: unknown;
      readonly SessionId?: unknown;
      readonly ExecutablePath?: unknown;
      readonly CommandLine?: unknown;
      readonly CreationDate?: unknown;
    };
    const cmdLine = typeof parsed.CommandLine === "string" ? parsed.CommandLine : "";
    const argv = splitWindowsCommandLine(cmdLine);
    if (argv === null) return null;
    const startToken =
      typeof parsed.CreationDate === "string" && parsed.CreationDate.trim().length > 0
        ? parsed.CreationDate.trim()
        : String(pid);
    const exePath =
      typeof parsed.ExecutablePath === "string" && parsed.ExecutablePath.trim().length > 0
        ? parsed.ExecutablePath.trim()
        : argv[0]!;
    const ppid =
      typeof parsed.ParentProcessId === "number" && Number.isInteger(parsed.ParentProcessId)
        ? parsed.ParentProcessId
        : 0;
    const sessionId =
      typeof parsed.SessionId === "number" && Number.isInteger(parsed.SessionId)
        ? parsed.SessionId
        : 0;
    return {
      pid,
      ppid,
      startToken,
      executableName: exePath,
      argv,
      readsTerminal: sessionId > 0,
    };
  } catch {
    return null;
  }
}

export async function walkNearestAncestor(
  startPid: number,
  lookup: (pid: number) => Promise<ParentProcessSnapshot | null>,
): Promise<ParentProcessSnapshot | null> {
  let pid = startPid;
  let fallback: ParentProcessSnapshot | null = null;
  for (let depth = 0; depth < 16; depth += 1) {
    if (!Number.isInteger(pid) || pid <= 1) break;
    const snap = await lookup(pid);
    if (snap === null) break;
    if (!isShellSnapshot(snap)) {
      fallback ??= snap;
      if (isKnownClientSnapshot(snap)) {
        return snap;
      }
    }
    const nextPid = snap.ppid ?? 0;
    if (nextPid <= 1 || nextPid === pid) break;
    pid = nextPid;
  }
  return fallback;
}

export async function inspectParentProcess(
  parentPid: number = process.ppid,
  platform: NodeJS.Platform = process.platform,
  execRunner: ExecCommandRunner = defaultExecRunner,
): Promise<ParentProcessSnapshot | null> {
  if (!Number.isInteger(parentPid) || parentPid <= 1) return null;
  const lookup = (pid: number): Promise<ParentProcessSnapshot | null> => {
    if (platform === "linux") return inspectLinuxProcess(pid);
    if (platform === "darwin") return inspectDarwinProcess(pid, execRunner);
    if (platform === "win32") return inspectWin32Process(pid, execRunner);
    return Promise.resolve(null);
  };
  return walkNearestAncestor(parentPid, lookup);
}

function parserForClient(client: ClientName): (args: readonly string[]) => ParsedClientMode {
  switch (client) {
    case "antigravity":
      return agyMode;
    case "grok":
      return grokMode;
    case "kimi":
      return kimiMode;
    case "cursor":
      return cursorMode;
    case "codex":
      return codexMode;
    case "claude":
    case "copilot":
      return () => "input";
  }
}

export async function checkInteractiveSession(
  client: ClientName,
  inspector: ParentProcessInspector = inspectParentProcess,
): Promise<InteractiveCheckResult> {
  const parent = await inspector();
  if (parent === null || parent.argv.length === 0) {
    return { interactive: false, reason: "arguments unreadable", parent: null };
  }
  if (!matchesExpectedExecutable(client, parent.executableName, parent.argv[0])) {
    return { interactive: false, reason: `no ${client} process`, parent };
  }
  const mode = parserForClient(client)(parent.argv);
  if (mode === "print") {
    return { interactive: false, reason: "print mode", parent };
  }
  if (mode === "command") {
    return { interactive: false, reason: "subcommand", parent };
  }
  if (mode === "unknown") {
    return { interactive: false, reason: "unknown argument", parent };
  }
  if (mode === "interactive") {
    return { interactive: true, reason: "", parent };
  }
  if (!parent.readsTerminal) {
    return { interactive: false, reason: "input is not a terminal", parent };
  }
  return { interactive: true, reason: "", parent };
}
