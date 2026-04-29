/**
 * Credential parsing + URL derivation for the bridge.
 *
 * Runtime credentials resolve per key from CLI flags, an optional JSON
 * config file, then the legacy SNAPPER_* environment variables. Required
 * failures name the missing key so MCP hosts surface actionable startup
 * diagnostics without exposing token values.
 */

import { readFile, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type { Stats } from "node:fs";
import type { Logger } from "./logger.js";

export class EnvValidationError extends Error {
  constructor(
    message: string,
    public readonly variable?: string,
  ) {
    super(message);
    this.name = "EnvValidationError";
  }
}

export interface BridgeEnv {
  readonly baseUrl: URL;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly watchAccessToken: string | null;
}

export interface CliFlags {
  readonly configPath: string | null;
  readonly accessToken: string | null;
  readonly baseUrl: string | null;
  readonly refreshToken: string | null;
  readonly watchAccessToken: string | null;
}

export interface ConfigFile {
  readonly SNAPPER_BASE_URL?: string;
  readonly SNAPPER_ACCESS_TOKEN?: string;
  readonly SNAPPER_REFRESH_TOKEN?: string;
  readonly SNAPPER_WATCH_ACCESS_TOKEN?: string;
}

const REQUIRED_VARS = ["SNAPPER_BASE_URL", "SNAPPER_ACCESS_TOKEN"] as const;
const OPTIONAL_VARS = ["SNAPPER_REFRESH_TOKEN", "SNAPPER_WATCH_ACCESS_TOKEN"] as const;
const CONFIG_KEYS = [
  "SNAPPER_BASE_URL",
  "SNAPPER_ACCESS_TOKEN",
  "SNAPPER_REFRESH_TOKEN",
  "SNAPPER_WATCH_ACCESS_TOKEN",
] as const;
const CONFIG_FILE_MAX_BYTES = 1024 * 1024;
const CONFIG_FILE_RETRIES = 3;
const CONFIG_FILE_RETRY_DELAY_MS = 500;

type ConfigKey = (typeof CONFIG_KEYS)[number];
type BridgeMode = "proxy" | "watch";
type CliFlagKey = keyof CliFlags;
type MutableCliFlags = Record<CliFlagKey, string | null>;

const EMPTY_FLAGS: CliFlags = {
  configPath: null,
  accessToken: null,
  baseUrl: null,
  refreshToken: null,
  watchAccessToken: null,
};

const FLAG_NAMES: ReadonlyMap<string, CliFlagKey> = new Map([
  ["--config", "configPath"],
  ["--access-token", "accessToken"],
  ["--base-url", "baseUrl"],
  ["--refresh-token", "refreshToken"],
  ["--watch-access-token", "watchAccessToken"],
]);

const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface ResolvedValue {
  readonly value: string | null;
}

interface MissingDetail {
  readonly variable: ConfigKey;
  readonly flagNames: readonly string[];
  readonly envNames: readonly string[];
  readonly configPath: string | null;
  readonly configLoaded: boolean;
}

function asPresent(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseUrl(name: string, raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new EnvValidationError(
      `${name} is not a valid URL (got ${JSON.stringify(redactToken(raw))}). Expected e.g. http://localhost:8000/api/mcp or https://snapper.example.com/api/mcp.`,
      name,
    );
  }
}

function normalizeBridgeUrl(raw: string): URL {
  const baseUrl = parseUrl("SNAPPER_BASE_URL", raw);
  if (!baseUrl.pathname.endsWith("/")) {
    baseUrl.pathname = `${baseUrl.pathname}/`;
  }
  return baseUrl;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error;
}

function configValue(configFile: ConfigFile | null, key: ConfigKey): string | null {
  if (configFile === null) return null;
  return asPresent(configFile[key]);
}

function envValue(source: NodeJS.ProcessEnv, key: ConfigKey): string | null {
  return asPresent(source[key]);
}

function resolveFirst(
  candidates: readonly [string, string | null | undefined][],
  logger: Logger,
  label: string,
): ResolvedValue {
  for (const [sourceName, raw] of candidates) {
    const value = asPresent(raw);
    if (value === null) continue;
    logger.info(`${label} resolved from ${sourceName}`);
    return { value };
  }
  return { value: null };
}

function flagSource(flagName: string): string {
  return `${flagName} CLI flag`;
}

function configSource(key: ConfigKey): string {
  return `--config file key ${key}`;
}

function envSource(key: ConfigKey): string {
  return `${key} env var`;
}

function missingConfigRung(configPath: string | null, configLoaded: boolean): string {
  if (configPath === null) return "--config file not given";
  if (configLoaded) return `--config=${configPath} did not contain a non-blank value`;
  return `--config=${configPath} was not found after 1500ms (ENOENT)`;
}

function missingMessage(detail: MissingDetail): string {
  const flagPart =
    detail.flagNames.length === 1
      ? `${detail.flagNames[0]} CLI flag not given`
      : `${detail.flagNames.join(" / ")} CLI flags not given`;
  const envPart =
    detail.envNames.length === 1
      ? `${detail.envNames[0]} env var unset`
      : `${detail.envNames.join(" / ")} env vars unset`;
  const attempted = [flagPart, missingConfigRung(detail.configPath, detail.configLoaded), envPart];
  return (
    `Missing required ${detail.variable}: ${attempted.join(", ")}. ` +
    "Set it via CLI flags, your MCP host's .mcp.json, claude_desktop_config.json for Claude Desktop, or environment variables."
  );
}

function requireResolved(resolved: ResolvedValue, detail: MissingDetail): string {
  if (resolved.value !== null) return resolved.value;
  throw new EnvValidationError(missingMessage(detail), detail.variable);
}

function validateKnownConfigValue(key: ConfigKey, value: unknown, path: string): string {
  if (typeof value === "string") return value;
  throw new EnvValidationError(
    `Config file ${path} has non-string value for ${key}; expected a string.`,
    key,
  );
}

function formatConfigStatError(path: string, err: unknown): EnvValidationError {
  const message = err instanceof Error ? err.message : String(err);
  return new EnvValidationError(`Cannot read config file ${path}: ${message}`);
}

function assertConfigFileHardening(path: string, stats: Stats, logger: Logger): void {
  if (!stats.isFile()) {
    throw new EnvValidationError(`Config file ${path} must be a regular file.`);
  }
  if ((stats.mode & 0o002) !== 0) {
    throw new EnvValidationError(`Config file ${path} is world-writable; refusing to read it.`);
  }
  if (stats.size > CONFIG_FILE_MAX_BYTES) {
    throw new EnvValidationError(`Config file ${path} exceeds the 1 MiB size limit.`);
  }
  if (process.platform !== "win32" && (stats.mode & 0o044) !== 0) {
    logger.warn(`config file ${path} is group- or world-readable; mode 0600 is recommended`);
  }
}

function parseConfigJson(path: string, text: string): ConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EnvValidationError(`Config file ${path} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EnvValidationError(`Config file ${path} must contain a JSON object.`);
  }
  const raw = parsed as Record<string, unknown>;
  const config: Partial<Record<ConfigKey, string>> = {};
  for (const key of CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    config[key] = validateKnownConfigValue(key, raw[key], path);
  }
  return config;
}

export function redactToken(value: string): string {
  if (/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}$/.test(value)) {
    return `<jwt-${value.length}-chars-ending-${value.slice(-8)}>`;
  }
  return value;
}

export function redactCliArg(value: string): string {
  const eq = value.indexOf("=");
  if (eq === -1) return redactToken(value);
  const prefix = value.slice(0, eq + 1);
  const suffix = value.slice(eq + 1);
  return `${prefix}${redactToken(suffix)}`;
}

export function parseCliFlags(argv: readonly string[]): { flags: CliFlags; remaining: string[] } {
  const flags: MutableCliFlags = { ...EMPTY_FLAGS };
  const remaining: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const eq = arg.indexOf("=");
    const flagName = eq === -1 ? arg : arg.slice(0, eq);
    const key = FLAG_NAMES.get(flagName);
    if (key === undefined) {
      remaining.push(arg);
      continue;
    }
    if (eq !== -1) {
      flags[key] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    flags[key] = typeof next === "string" ? next : "";
    if (typeof next === "string") i += 1;
  }
  return { flags, remaining };
}

export async function loadConfigFile(path: string, logger: Logger = NOOP_LOGGER): Promise<ConfigFile | null> {
  let stats: Stats | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      stats = await stat(path);
      break;
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        if (attempt >= CONFIG_FILE_RETRIES) return null;
        await sleep(CONFIG_FILE_RETRY_DELAY_MS);
        continue;
      }
      throw formatConfigStatError(path, err);
    }
  }

  if (stats === undefined) {
    throw new EnvValidationError(`Cannot read config file ${path}: stat did not complete.`);
  }
  assertConfigFileHardening(path, stats, logger);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw formatConfigStatError(path, err);
  }
  return parseConfigJson(path, text);
}

export function resolveBridgeEnv(
  source: NodeJS.ProcessEnv,
  flags: CliFlags,
  configFile: ConfigFile | null,
  mode: BridgeMode,
  logger: Logger = NOOP_LOGGER,
): BridgeEnv {
  const configLoaded = configFile !== null;
  const base = requireResolved(
    resolveFirst(
      [
        [flagSource("--base-url"), flags.baseUrl],
        [configSource("SNAPPER_BASE_URL"), configValue(configFile, "SNAPPER_BASE_URL")],
        [envSource("SNAPPER_BASE_URL"), envValue(source, "SNAPPER_BASE_URL")],
      ],
      logger,
      "SNAPPER_BASE_URL",
    ),
    {
      variable: "SNAPPER_BASE_URL",
      flagNames: ["--base-url"],
      envNames: ["SNAPPER_BASE_URL"],
      configPath: flags.configPath,
      configLoaded,
    },
  );

  const accessCandidates: readonly [string, string | null | undefined][] =
    mode === "watch"
      ? [
          [flagSource("--watch-access-token"), flags.watchAccessToken],
          [flagSource("--access-token"), flags.accessToken],
          [
            configSource("SNAPPER_WATCH_ACCESS_TOKEN"),
            configValue(configFile, "SNAPPER_WATCH_ACCESS_TOKEN"),
          ],
          [envSource("SNAPPER_WATCH_ACCESS_TOKEN"), envValue(source, "SNAPPER_WATCH_ACCESS_TOKEN")],
        ]
      : [
          [flagSource("--access-token"), flags.accessToken],
          [configSource("SNAPPER_ACCESS_TOKEN"), configValue(configFile, "SNAPPER_ACCESS_TOKEN")],
          [envSource("SNAPPER_ACCESS_TOKEN"), envValue(source, "SNAPPER_ACCESS_TOKEN")],
        ];
  const accessVariable: ConfigKey =
    mode === "watch" ? "SNAPPER_WATCH_ACCESS_TOKEN" : "SNAPPER_ACCESS_TOKEN";
  const access = requireResolved(
    resolveFirst(accessCandidates, logger, accessVariable),
    {
      variable: accessVariable,
      flagNames: mode === "watch" ? ["--watch-access-token", "--access-token"] : ["--access-token"],
      envNames: [accessVariable],
      configPath: flags.configPath,
      configLoaded,
    },
  );

  const refreshToken =
    mode === "watch"
      ? null
      : resolveFirst(
          [
            [flagSource("--refresh-token"), flags.refreshToken],
            [configSource("SNAPPER_REFRESH_TOKEN"), configValue(configFile, "SNAPPER_REFRESH_TOKEN")],
            [envSource("SNAPPER_REFRESH_TOKEN"), envValue(source, "SNAPPER_REFRESH_TOKEN")],
          ],
          logger,
          "SNAPPER_REFRESH_TOKEN",
        ).value;

  const watchAccessToken =
    mode === "watch"
      ? access
      : resolveFirst(
          [
            [flagSource("--watch-access-token"), flags.watchAccessToken],
            [
              configSource("SNAPPER_WATCH_ACCESS_TOKEN"),
              configValue(configFile, "SNAPPER_WATCH_ACCESS_TOKEN"),
            ],
            [envSource("SNAPPER_WATCH_ACCESS_TOKEN"), envValue(source, "SNAPPER_WATCH_ACCESS_TOKEN")],
          ],
          logger,
          "SNAPPER_WATCH_ACCESS_TOKEN",
        ).value;

  return {
    baseUrl: normalizeBridgeUrl(base),
    accessToken: access,
    refreshToken,
    watchAccessToken,
  };
}

async function parseBridgeEnv(
  source: NodeJS.ProcessEnv,
  argv: readonly string[],
  mode: BridgeMode,
  logger: Logger,
): Promise<BridgeEnv> {
  const { flags } = parseCliFlags(argv);
  const configFile =
    flags.configPath === null ? null : await loadConfigFile(flags.configPath, logger);
  return resolveBridgeEnv(source, flags, configFile, mode, logger);
}

export async function parseEnv(
  source: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
  logger: Logger = NOOP_LOGGER,
): Promise<BridgeEnv> {
  return parseBridgeEnv(source, argv, "proxy", logger);
}

export async function parseWatchEnv(
  source: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(3),
  logger: Logger = NOOP_LOGGER,
): Promise<BridgeEnv> {
  return parseBridgeEnv(source, argv, "watch", logger);
}

export function computeRefreshUrl(baseUrl: URL): URL {
  const refresh = new URL("/api/auth/refresh", baseUrl.origin);
  refresh.searchParams.set("return_tokens", "true");
  return refresh;
}

/**
 * Derive the dedicated ws_token-issuance endpoint URL from the
 * validated `/api/mcp` base URL.
 *
 * The Snapper backend exposes `POST /api/auth/ws_token` so a
 * long-running watch client can mint one-shot WebSocket tokens via
 * its access bearer WITHOUT rotating the shared refresh-token pair.
 * That decoupling lets a host-level watch process run alongside the
 * proxy MCP server against the same delegate's access bearer
 * without the watch flow touching `/api/auth/refresh`.
 *
 * Returns a URL on the same origin as `baseUrl`, mirrors the
 * `computeRefreshUrl` shape exactly so error mapping / logging in
 * the call sites stays uniform.
 */
export function computeWsTokenUrl(baseUrl: URL): URL {
  return new URL("/api/auth/ws_token", baseUrl.origin);
}

/**
 * Derive the WS endpoint URL for the upcoming `snapper-mcp watch`
 * subcommand from the validated `/api/mcp` base URL.
 *
 * Rejects any base URL whose pathname is not exactly `/api/mcp`
 * (with or without a trailing slash). This prevents two foot-guns:
 *
 *   1. Silently appending `/api/ws` to a misconfigured base such as
 *      `http://localhost:8000/api/mcp/api/ws`, which would 404 on
 *      every connect.
 *   2. Letting an operator who set `SNAPPER_BASE_URL` to the wrong
 *      origin (e.g. the bare host without `/api/mcp`) ship a
 *      partially functional bridge — the proxy path would still
 *      authenticate, but the watch subcommand would silently drop
 *      events.
 *
 * Scheme conversion: `http` → `ws`, `https` → `wss`. Any other
 * scheme throws — `wss://` and `ws://` baseUrls are rejected
 * symmetrically because Snapper's combined MCP + WS API runs over
 * HTTP(S) and the bridge MUST not be configured against a bare WS
 * host.
 *
 * Strips any query string + hash. The caller adds connect-time
 * authentication credentials separately (the WebSocket wire
 * contract delivers the ws_token via the post-upgrade `authenticate`
 * frame, not as a URL parameter).
 */
export function computeWsUrl(baseUrl: URL): URL {
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new EnvValidationError(
      `snapper-mcp watch requires an http:// or https:// base URL; got ${JSON.stringify(redactToken(baseUrl.protocol))}.`,
      "SNAPPER_BASE_URL",
    );
  }
  const normalised = baseUrl.pathname.endsWith("/")
    ? baseUrl.pathname.slice(0, -1)
    : baseUrl.pathname;
  if (normalised !== "/api/mcp") {
    throw new EnvValidationError(
      `snapper-mcp watch requires SNAPPER_BASE_URL pathname /api/mcp; got ${JSON.stringify(redactToken(baseUrl.pathname))}.`,
      "SNAPPER_BASE_URL",
    );
  }
  const wsScheme = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = new URL(`${wsScheme}//${baseUrl.host}/api/ws`);
  return wsUrl;
}

export const REQUIRED_ENV_VARS: readonly string[] = REQUIRED_VARS;
export const OPTIONAL_ENV_VARS: readonly string[] = OPTIONAL_VARS;
