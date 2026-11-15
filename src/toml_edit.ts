/**
 * AST-validated TOML block and table surgery for Codex, Grok, and Kimi
 * configuration files using `smol-toml`.
 *
 * Every edit parses the existing document first (refusing malformed TOML),
 * applies the targeted block/table update, re-parses the resulting document,
 * and proves via `isDeepStrictEqual` that every unrelated key, table, and
 * array outside `snapper-mcp`'s owned entries remained identical.
 */

import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export const TOML_MARKER_START = "# BEGIN snapper-mcp";
export const TOML_MARKER_END = "# END snapper-mcp";

export class TomlEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlEditError";
  }
}

type TomlObject = Record<string, unknown>;

function parseStrictToml(text: string, label: string): TomlObject {
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return clonePlainObject(parseToml(text)) as TomlObject;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new TomlEditError(`${label} is not valid TOML: ${detail}`);
  }
}

function clonePlainObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => clonePlainObject(item));
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      copy[k] = clonePlainObject(v);
    }
    return copy;
  }
  return value;
}

function withoutSnapperMcpServer(doc: TomlObject): TomlObject {
  const cloned = clonePlainObject(doc) as TomlObject;
  const servers = cloned["mcp_servers"];
  if (servers !== null && typeof servers === "object" && !Array.isArray(servers)) {
    const serverMap = servers as Record<string, unknown>;
    delete serverMap["snapper"];
    if (Object.keys(serverMap).length === 0) {
      delete cloned["mcp_servers"];
    }
  }
  return cloned;
}

function isSnapperKimiHookItem(item: unknown): boolean {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return false;
  }
  const command = (item as Record<string, unknown>)["command"];
  return (
    typeof command === "string" &&
    command.includes("--client kimi") &&
    (command.includes("snapper") || command.includes("--config"))
  );
}

function withoutSnapperKimiHooks(doc: TomlObject): TomlObject {
  const cloned = clonePlainObject(doc) as TomlObject;
  const hooks = cloned["hooks"];
  if (Array.isArray(hooks)) {
    const kept = hooks.filter((item) => !isSnapperKimiHookItem(item));
    if (kept.length === 0) {
      delete cloned["hooks"];
    } else {
      cloned["hooks"] = kept;
    }
  }
  return cloned;
}

export function tomlBasicString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  out += '"';
  return out;
}

export function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((v) => tomlBasicString(v)).join(", ")}]`;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) return count;
    count += 1;
    pos = idx + needle.length;
  }
}

export function wrapMarkedBlock(inner: string): string {
  const trimmed = inner.trim();
  return `${TOML_MARKER_START}\n${trimmed}\n${TOML_MARKER_END}`;
}

interface MarkedSpan {
  readonly start: number;
  readonly end: number;
  readonly inner: string;
}

function locateMarkedSpan(text: string): MarkedSpan | null {
  const startCount = countOccurrences(text, TOML_MARKER_START);
  const endCount = countOccurrences(text, TOML_MARKER_END);
  if (startCount === 0 && endCount === 0) return null;
  if (startCount !== 1 || endCount !== 1) {
    throw new TomlEditError("unbalanced or duplicate snapper-mcp TOML markers");
  }
  const start = text.indexOf(TOML_MARKER_START);
  const endMarkerIdx = text.indexOf(TOML_MARKER_END);
  if (endMarkerIdx < start) {
    throw new TomlEditError("reversed snapper-mcp TOML markers");
  }
  const end = endMarkerIdx + TOML_MARKER_END.length;
  const inner = text.slice(start + TOML_MARKER_START.length, endMarkerIdx).trim();
  return { start, end, inner };
}

export function readMarkedBlock(existing: string): string | null {
  const span = locateMarkedSpan(existing);
  return span === null ? null : span.inner;
}

function detectLineEnding(text: string): "\r\n" | "\n" {
  const crlfCount = countOccurrences(text, "\r\n");
  if (crlfCount === 0) return "\n";
  const bareLf = countOccurrences(text.replaceAll("\r\n", ""), "\n");
  return bareLf === 0 ? "\r\n" : "\n";
}

function applyLineEnding(lfText: string, eol: "\r\n" | "\n"): string {
  return eol === "\r\n" ? lfText.replaceAll("\n", "\r\n") : lfText;
}

function trimLeadingLf(text: string): string {
  let start = 0;
  while (start < text.length && text.charCodeAt(start) === 10) {
    start += 1;
  }
  return text.slice(start);
}

function trimTrailingLf(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) {
    end -= 1;
  }
  return text.slice(0, end);
}

export function upsertMarkedBlock(existing: string, block: string): string {
  parseStrictToml(existing, "existing TOML");
  const eol = detectLineEnding(existing);
  const normalized = existing.replaceAll("\r\n", "\n");
  const wrapped = block.startsWith(TOML_MARKER_START) ? block.trim() : wrapMarkedBlock(block);
  const span = locateMarkedSpan(normalized);
  let candidate: string;
  if (span !== null) {
    const before = normalized.slice(0, span.start);
    const after = normalized.slice(span.end);
    const joined = `${before}${wrapped}${after}`;
    candidate = joined.endsWith("\n") ? joined : `${joined}\n`;
  } else if (normalized.trim().length === 0) {
    candidate = `${wrapped}\n`;
  } else {
    const base = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
    candidate = `${base}\n${wrapped}\n`;
  }
  parseStrictToml(candidate, "generated TOML");
  return applyLineEnding(candidate, eol);
}

export function removeMarkedBlock(existing: string): string {
  parseStrictToml(existing, "existing TOML");
  const eol = detectLineEnding(existing);
  const normalized = existing.replaceAll("\r\n", "\n");
  const span = locateMarkedSpan(normalized);
  if (span === null) return existing;
  const before = trimTrailingLf(normalized.slice(0, span.start));
  const after = trimLeadingLf(normalized.slice(span.end));
  let candidate: string;
  if (before.length === 0 && after.length === 0) candidate = "";
  else if (before.length === 0) candidate = after.endsWith("\n") ? after : `${after}\n`;
  else if (after.length === 0) candidate = `${before}\n`;
  else candidate = `${before}\n\n${after.endsWith("\n") ? after : `${after}\n`}`;
  parseStrictToml(candidate, "stripped TOML");
  return applyLineEnding(candidate, eol);
}

function stripUnmarkedSnapperTableFromText(text: string): string {
  const eol = detectLineEnding(text);
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const kept: string[] = [];
  let inSnapperTable = false;
  let removedAny = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeader =
      trimmed.startsWith("[") && !trimmed.startsWith("#") && trimmed.includes("]");
    if (isHeader) {
      if (
        trimmed === "[mcp_servers.snapper]" ||
        trimmed === '[mcp_servers."snapper"]' ||
        trimmed.startsWith("[mcp_servers.snapper.") ||
        trimmed.startsWith('[mcp_servers."snapper".')
      ) {
        inSnapperTable = true;
        removedAny = true;
        continue;
      }
      if (
        inSnapperTable &&
        kept.length >= 2 &&
        kept[kept.length - 1] === "" &&
        kept[kept.length - 2] === ""
      ) {
        kept.pop();
      }
      inSnapperTable = false;
    }
    if (!inSnapperTable) {
      kept.push(line);
    }
  }
  if (!removedAny) return text;
  const joined = trimTrailingLf(trimLeadingLf(kept.join("\n")));
  return joined.length === 0 ? "" : applyLineEnding(`${joined}\n`, eol);
}

function removeSnapperServerPreservingAst(existing: string): string {
  const beforeAst = parseStrictToml(existing, "existing TOML");
  const expectedWithoutSnapper = withoutSnapperMcpServer(beforeAst);

  const withoutMarked = removeMarkedBlock(existing);
  const textCandidate = stripUnmarkedSnapperTableFromText(withoutMarked);
  try {
    const candidateAst = parseStrictToml(textCandidate, "stripped TOML");
    if (isDeepStrictEqual(candidateAst, expectedWithoutSnapper)) {
      return textCandidate;
    }
  } catch {
    // Fallback to canonical AST re-serialization when inline dotted keys such as
    // `mcp_servers.snapper = { ... }` were used outside standard section headers.
  }

  if (Object.keys(expectedWithoutSnapper).length === 0) {
    return "";
  }
  const serialized = stringifyToml(expectedWithoutSnapper);
  return serialized.endsWith("\n") ? serialized : `${serialized}\n`;
}

export interface CodexSnapperTomlOptions {
  readonly command: string;
  readonly prefixArgs?: readonly string[];
  readonly configPath: string;
  readonly wake: boolean;
}

export function renderCodexSnapperBlock(opts: CodexSnapperTomlOptions): string {
  const args = [
    ...(opts.prefixArgs ?? []),
    "--client",
    "codex",
    opts.wake ? "--wake" : "--wake=false",
    "--config",
    opts.configPath,
  ];
  const envVars = [
    "SNAPPER_BASE_URL",
    "SNAPPER_ACCESS_TOKEN",
    "SNAPPER_PROFILE",
    "CODEX_HOME",
  ];
  const body = [
    "[mcp_servers.snapper]",
    `command = ${tomlBasicString(opts.command)}`,
    `args = ${tomlStringArray(args)}`,
    `env_vars = ${tomlStringArray(envVars)}`,
  ].join("\n");
  return wrapMarkedBlock(body);
}

function hasSnapperServerInAst(doc: TomlObject): boolean {
  const servers = doc["mcp_servers"];
  return (
    servers !== null &&
    typeof servers === "object" &&
    !Array.isArray(servers) &&
    "snapper" in (servers as Record<string, unknown>)
  );
}

export function upsertCodexSnapperBlock(
  existing: string,
  opts: CodexSnapperTomlOptions,
): string {
  const beforeAst = parseStrictToml(existing, "Codex config.toml");
  const withoutMarkedText = removeMarkedBlock(existing);
  const withoutMarkedAst = parseStrictToml(withoutMarkedText, "Codex config.toml");
  if (hasSnapperServerInAst(withoutMarkedAst)) {
    throw new TomlEditError(
      "Codex config.toml already has an unmanaged [mcp_servers.snapper] entry outside snapper-mcp markers",
    );
  }
  const next = upsertMarkedBlock(existing, renderCodexSnapperBlock(opts));
  const afterAst = parseStrictToml(next, "updated Codex config.toml");
  if (!isDeepStrictEqual(withoutSnapperMcpServer(beforeAst), withoutSnapperMcpServer(afterAst))) {
    throw new TomlEditError("Codex config.toml edit altered unrelated TOML keys");
  }
  return next;
}

export function removeCodexSnapperBlock(existing: string): string {
  const beforeAst = parseStrictToml(existing, "Codex config.toml");
  const next = removeMarkedBlock(existing);
  const afterAst = parseStrictToml(next, "updated Codex config.toml");
  if (!isDeepStrictEqual(withoutSnapperMcpServer(beforeAst), withoutSnapperMcpServer(afterAst))) {
    throw new TomlEditError("Codex config.toml removal altered unrelated TOML keys");
  }
  return next;
}

export function inspectCodexSnapperBlock(existing: string): {
  readonly configured: boolean;
  readonly wakeEnabled: boolean;
} {
  try {
    const ast = parseStrictToml(existing, "Codex config.toml");
    const servers = ast["mcp_servers"];
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
      return { configured: false, wakeEnabled: false };
    }
    const snapper = (servers as Record<string, unknown>)["snapper"];
    if (snapper === null || typeof snapper !== "object" || Array.isArray(snapper)) {
      return { configured: false, wakeEnabled: false };
    }
    const args = (snapper as Record<string, unknown>)["args"];
    const command = (snapper as Record<string, unknown>)["command"];
    if (typeof command !== "string" || command.length === 0 || !Array.isArray(args)) {
      return { configured: false, wakeEnabled: false };
    }
    const strArgs = args.filter((item): item is string => typeof item === "string");
    if (strArgs.length !== args.length) {
      return { configured: false, wakeEnabled: false };
    }
    const clientIdx = strArgs.indexOf("--client");
    if (clientIdx < 0 || strArgs[clientIdx + 1] !== "codex") {
      return { configured: false, wakeEnabled: false };
    }
    const wakeDisabled = strArgs.includes("--wake=false") || strArgs.includes("--no-wake");
    const wakeEnabled = !wakeDisabled && strArgs.includes("--wake");
    if (!wakeDisabled && !wakeEnabled) {
      return { configured: false, wakeEnabled: false };
    }
    return { configured: true, wakeEnabled };
  } catch {
    return { configured: false, wakeEnabled: false };
  }
}

export interface GrokSnapperTomlOptions {
  readonly command: string;
  readonly prefixArgs?: readonly string[];
  readonly configPath: string;
}

export function renderGrokSnapperBlock(opts: GrokSnapperTomlOptions): string {
  const args = [...(opts.prefixArgs ?? []), "--config", opts.configPath];
  const body = [
    "[mcp_servers.snapper]",
    `command = ${tomlBasicString(opts.command)}`,
    `args = ${tomlStringArray(args)}`,
    "enabled = true",
  ].join("\n");
  return wrapMarkedBlock(body);
}

export function upsertGrokSnapperTable(
  existing: string,
  opts: GrokSnapperTomlOptions,
): string {
  const stripped = removeSnapperServerPreservingAst(existing);
  return upsertMarkedBlock(stripped, renderGrokSnapperBlock(opts));
}

export function removeGrokSnapperTable(existing: string): string {
  return removeSnapperServerPreservingAst(existing);
}

export function inspectGrokSnapperTable(existing: string): boolean {
  try {
    const ast = parseStrictToml(existing, "Grok config.toml");
    const servers = ast["mcp_servers"];
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
      return false;
    }
    const snapper = (servers as Record<string, unknown>)["snapper"];
    if (snapper === null || typeof snapper !== "object" || Array.isArray(snapper)) {
      return false;
    }
    const command = (snapper as Record<string, unknown>)["command"];
    return typeof command === "string" && command.length > 0;
  } catch {
    return false;
  }
}

export function extractTomlSnapperInvocation(existing: string): {
  readonly command: string;
  readonly args: readonly string[];
} | null {
  try {
    const ast = parseStrictToml(existing, "MCP config.toml");
    const servers = ast["mcp_servers"];
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
      return null;
    }
    const snapper = (servers as Record<string, unknown>)["snapper"];
    if (snapper === null || typeof snapper !== "object" || Array.isArray(snapper)) {
      return null;
    }
    const command = (snapper as Record<string, unknown>)["command"];
    if (typeof command !== "string" || command.length === 0) {
      return null;
    }
    const rawArgs = (snapper as Record<string, unknown>)["args"];
    const args = Array.isArray(rawArgs)
      ? rawArgs.filter((item): item is string => typeof item === "string")
      : [];
    return { command, args };
  } catch {
    return null;
  }
}

export interface KimiHookEntry {
  readonly event: string;
  readonly command: string;
  readonly timeout: number;
}

const ALLOWED_KIMI_HOOK_KEYS: ReadonlySet<string> = new Set([
  "event",
  "command",
  "timeout",
]);

export function validateKimiHooksBlock(block: string): void {
  const ast = parseStrictToml(block, "Kimi [[hooks]] block");
  const hooks = ast["hooks"];
  if (!Array.isArray(hooks) || Object.keys(ast).some((k) => k !== "hooks")) {
    throw new TomlEditError("Kimi hooks block must define only [[hooks]] entries");
  }
  for (const item of hooks) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TomlEditError("invalid [[hooks]] item in Kimi hooks block");
    }
    for (const key of Object.keys(item as Record<string, unknown>)) {
      if (!ALLOWED_KIMI_HOOK_KEYS.has(key)) {
        throw new TomlEditError(`unsupported key ${JSON.stringify(key)} in Kimi [[hooks]] block`);
      }
    }
  }
}

export function renderKimiHooksBlock(entries: readonly KimiHookEntry[]): string {
  const sections = entries.map((entry) =>
    [
      "[[hooks]]",
      `event = ${tomlBasicString(entry.event)}`,
      `command = ${tomlBasicString(entry.command)}`,
      `timeout = ${entry.timeout}`,
    ].join("\n"),
  );
  const block = wrapMarkedBlock(sections.join("\n\n"));
  validateKimiHooksBlock(block);
  return block;
}

function hasSnapperKimiHooksInAst(doc: TomlObject): boolean {
  const hooks = doc["hooks"];
  return Array.isArray(hooks) && hooks.some((item) => isSnapperKimiHookItem(item));
}

function removeKimiHooksPreservingAst(existing: string): string {
  const beforeAst = parseStrictToml(existing, "Kimi config.toml");
  const expectedWithoutSnapper = withoutSnapperKimiHooks(beforeAst);
  const withoutMarked = removeMarkedBlock(existing);
  const afterMarkedAst = parseStrictToml(withoutMarked, "updated Kimi config.toml");
  if (!isDeepStrictEqual(expectedWithoutSnapper, withoutSnapperKimiHooks(afterMarkedAst))) {
    throw new TomlEditError("Kimi config.toml removal altered unrelated TOML keys");
  }
  if (!hasSnapperKimiHooksInAst(afterMarkedAst)) {
    return withoutMarked;
  }
  const eol = detectLineEnding(existing);
  if (Object.keys(expectedWithoutSnapper).length === 0) {
    return "";
  }
  const serialized = stringifyToml(expectedWithoutSnapper);
  const withLf = serialized.endsWith("\n") ? serialized : `${serialized}\n`;
  return applyLineEnding(withLf, eol);
}

export function upsertKimiHooksBlock(
  existing: string,
  entries: readonly KimiHookEntry[],
): string {
  const beforeAst = parseStrictToml(existing, "Kimi config.toml");
  const cleaned =
    locateMarkedSpan(existing.replaceAll("\r\n", "\n")) !== null
      ? existing
      : removeKimiHooksPreservingAst(existing);
  const next = upsertMarkedBlock(cleaned, renderKimiHooksBlock(entries));
  const afterAst = parseStrictToml(next, "updated Kimi config.toml");
  if (!isDeepStrictEqual(withoutSnapperKimiHooks(beforeAst), withoutSnapperKimiHooks(afterAst))) {
    throw new TomlEditError("Kimi config.toml edit altered unrelated TOML keys");
  }
  return next;
}

export function removeKimiHooksBlock(existing: string): string {
  return removeKimiHooksPreservingAst(existing);
}

export function inspectKimiHooksBlock(existing: string): boolean {
  try {
    const ast = parseStrictToml(existing, "Kimi config.toml");
    const hooks = ast["hooks"];
    if (!Array.isArray(hooks)) return false;
    return hooks.some((item) => isSnapperKimiHookItem(item));
  } catch {
    return false;
  }
}
