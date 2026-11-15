/**
 * User-scoped GitHub Copilot CLI extension templates and SHA-256
 * ownership verification.
 */

import {
  SNAPPER_COPILOT_ATTENTION_LINE,
  SNAPPER_WAKE_PROMPT,
} from "./actionable.js";
import { sha256Hex } from "./state_dir.js";

const HEADER_PREFIX = "// snapper-mcp-sha256: ";

export interface CopilotExtensionSpec {
  readonly command: string;
  readonly prefixArgs?: readonly string[];
  readonly configPath: string;
}

function wrapWithOwnershipHeader(body: string): string {
  const normalized = body.endsWith("\n") ? body : `${body}\n`;
  const digest = sha256Hex(normalized);
  return `${HEADER_PREFIX}${digest}\n${normalized}`;
}

export function verifyCopilotOwnedFile(content: string): boolean {
  const newlineIdx = content.indexOf("\n");
  if (newlineIdx < 0 || !content.startsWith(HEADER_PREFIX)) {
    return false;
  }
  const recorded = content.slice(HEADER_PREFIX.length, newlineIdx).trim();
  const body = content.slice(newlineIdx + 1);
  return recorded.length === 64 && sha256Hex(body) === recorded;
}

export function renderCopilotExtensionEntry(spec: CopilotExtensionSpec): string {
  const watchArgs = [
    ...(spec.prefixArgs ?? []),
    "watch",
    "--client",
    "copilot",
    "--config",
    spec.configPath,
  ];
  const body = [
    'import { joinSession } from "@github/copilot-sdk/extension";',
    'import { runExtension } from "./watcher.mjs";',
    "",
    `await runExtension({ joinSession, command: ${JSON.stringify(spec.command)}, args: ${JSON.stringify(watchArgs)} });`,
  ].join("\n");
  return wrapWithOwnershipHeader(body);
}

export function renderCopilotWatcherModule(): string {
  const body = [
    'import { spawn as spawnProcess } from "node:child_process";',
    'import { createInterface } from "node:readline";',
    "",
    `export const attentionPrompt = ${JSON.stringify(SNAPPER_WAKE_PROMPT)};`,
    `export const attentionLine = ${JSON.stringify(SNAPPER_COPILOT_ATTENTION_LINE)};`,
    "",
    "export function isAttentionLine(line) {",
    "  return line.trim() === attentionLine;",
    "}",
    "",
    "export function interactiveHost(session) {",
    "  try {",
    "    return session?.capabilities?.ui?.canvases === true;",
    "  } catch {",
    "    return false;",
    "  }",
    "}",
    "",
    "export function startWatcher({ command, args, session, sessionId, spawn = spawnProcess, environment = process.env }) {",
    "  if (!command || !Array.isArray(args) || !session || !sessionId) {",
    '    throw new Error("Snapper Copilot watcher requires a command, args, and joined session.");',
    "  }",
    "  const child = spawn(command, args, {",
    "    env: { ...environment, COPILOT_AGENT_SESSION_ID: sessionId },",
    '    stdio: ["ignore", "pipe", "pipe"],',
    "    windowsHide: true,",
    "  });",
    "  const stdout = createInterface({ input: child.stdout });",
    "  let busy = false;",
    "  let pending = false;",
    "  let stopped = false;",
    "  let reported = false;",
    "",
    '  const log = (message, level = "warning") => {',
    "    void session.log(message, { level }).catch(() => undefined);",
    "  };",
    "",
    "  const dispatch = () => {",
    "    if (stopped || busy || !pending) return;",
    "    pending = false;",
    "    busy = true;",
    "    void session",
    '      .send({ prompt: attentionPrompt, source: "automation-snapper", mode: "enqueue" })',
    "      .catch((error) => {",
    "        busy = false;",
    '        const detail = error instanceof Error && error.message ? ` ${error.message}` : "";',
    '        log(`Snapper could not confirm that Copilot accepted the wake.${detail}`, "error");',
    "      });",
    "  };",
    "",
    '  session.on("assistant.turn_start", () => {',
    "    busy = true;",
    "  });",
    '  session.on("session.idle", () => {',
    "    busy = false;",
    "    dispatch();",
    "  });",
    "",
    '  stdout.on("line", (line) => {',
    "    if (isAttentionLine(line)) {",
    "      pending = true;",
    "      dispatch();",
    "    }",
    "  });",
    "  child.stderr.resume();",
    '  child.once("error", () => {',
    "    if (!stopped && !reported) {",
    "      reported = true;",
    '      log("Snapper could not start its Copilot monitor. Run `snapper-mcp doctor`.", "error");',
    "    }",
    "  });",
    '  child.once("exit", () => {',
    "    if (!stopped && !reported) {",
    "      reported = true;",
    '      log("Snapper Copilot monitor exited unexpectedly. Run `snapper-mcp doctor`.", "error");',
    "    }",
    "  });",
    "",
    "  return () => {",
    "    if (stopped) return;",
    "    stopped = true;",
    "    stdout.close();",
    "    child.kill();",
    "  };",
    "}",
    "",
    "export async function runExtension({ joinSession, command, args, signals = process, ...options }) {",
    "  const session = await joinSession();",
    "  if (!interactiveHost(session)) {",
    "    return () => {};",
    "  }",
    "  const stop = startWatcher({ command, args, session, sessionId: session.sessionId, ...options });",
    '  signals.once("SIGINT", stop);',
    '  signals.once("SIGTERM", stop);',
    "  return stop;",
    "}",
  ].join("\n");
  return wrapWithOwnershipHeader(body);
}
