/**
 * Environment-variable parsing + refresh-URL derivation.
 *
 * The bridge reads:
 *
 *   - SNAPPER_BASE_URL      — required. Points at Snapper's /api/mcp endpoint.
 *   - SNAPPER_ACCESS_TOKEN  — required. JWT access token for bearer auth.
 *   - SNAPPER_REFRESH_TOKEN — optional (since v0.2.0). JWT refresh
 *     token used on 401 rotation. Omit or leave blank for long-lived
 *     PAT delegates — the bridge then skips the refresh round-trip
 *     and surfaces any 401 verbatim with a PAT-specific stderr hint.
 *     Existing rotating-token setups that keep this env var set see
 *     ZERO behaviour change.
 *
 * Validation is strict on required fields: any missing or blank
 * value throws an `EnvValidationError` whose message names the
 * exact variable, so operators debugging a misconfigured Claude
 * Desktop entry see a single actionable stderr line and exit cleanly.
 *
 * `computeRefreshUrl` derives `{origin}/api/auth/refresh?return_tokens=true`
 * from the validated base URL. Exposing this as a named helper prevents
 * two known foot-guns:
 *
 *   1. Concatenating against the `/api/mcp` path (would POST to
 *      `/api/mcp/api/auth/refresh`).
 *   2. Forgetting the `?return_tokens=true` flag — without it, the
 *      backend returns an envelope whose `access_token` and
 *      `refresh_token` fields are null, and the bridge can't rotate.
 *
 * The `watch` subcommand uses `parseWatchEnv`, which differs from
 * `parseEnv` in two ways: it forces `refreshToken = null` (the watch
 * monitor must run on a long-lived PAT — see CHANGELOG [0.5.0] for the
 * access-expiry reasoning), and it pulls credentials from a precedence
 * chain that prefers Claude Code's auto-exported `CLAUDE_PLUGIN_OPTION_<KEY>`
 * env vars (set by Claude Code for every plugin subprocess) over the
 * legacy SNAPPER_* env-var contract. Standalone hosts (Option 2 / 3
 * in README) keep the original SNAPPER_* contract via the chain's
 * fallback rungs.
 */

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
}

const REQUIRED_VARS = ["SNAPPER_BASE_URL", "SNAPPER_ACCESS_TOKEN"] as const;
const OPTIONAL_VARS = ["SNAPPER_REFRESH_TOKEN"] as const;

function requireNonEmpty(name: string, raw: string | undefined): string {
  if (raw === undefined) {
    throw new EnvValidationError(
      `Missing required environment variable ${name}. Set it via your Claude Desktop / Claude Code .mcp-config.json and restart the MCP host.`,
      name,
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new EnvValidationError(
      `Environment variable ${name} is set but empty. Provide a non-blank value.`,
      name,
    );
  }
  return trimmed;
}

function parseOptional(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseUrl(name: string, raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new EnvValidationError(
      `Environment variable ${name} is not a valid URL (got ${JSON.stringify(raw)}). Expected e.g. http://localhost:8000/api/mcp or https://snapper.example.com/api/mcp.`,
      name,
    );
  }
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): BridgeEnv {
  const rawBase = requireNonEmpty("SNAPPER_BASE_URL", source["SNAPPER_BASE_URL"]);
  const accessToken = requireNonEmpty("SNAPPER_ACCESS_TOKEN", source["SNAPPER_ACCESS_TOKEN"]);
  const refreshToken = parseOptional(source["SNAPPER_REFRESH_TOKEN"]);
  const baseUrl = parseUrl("SNAPPER_BASE_URL", rawBase);
  if (!baseUrl.pathname.endsWith("/")) {
    baseUrl.pathname = `${baseUrl.pathname}/`;
  }
  return { baseUrl, accessToken, refreshToken };
}

/**
 * Detect whether the current process was spawned by Claude Code as
 * part of a plugin (mcpServer, hook, or monitor).
 *
 * Two signals are accepted, either is sufficient:
 *
 *   1. `CLAUDE_PLUGIN_OPTION_SNAPPER_BASE_URL` is set — Claude Code
 *      auto-exports every userConfig field as `CLAUDE_PLUGIN_OPTION_<KEY>`
 *      to plugin subprocesses (documented at
 *      https://code.claude.com/docs/en/plugins-reference under
 *      *userConfig*). Our manifest declares SNAPPER_BASE_URL as a
 *      required userConfig field, so its presence is a reliable
 *      plugin-context signal that does not depend on undocumented
 *      Claude-Code-internal env-var conventions.
 *   2. `CLAUDE_PLUGIN_ROOT` is set — documented as a substitution
 *      token for hook + monitor + mcpServer command strings; some
 *      Claude Code versions also export it as an env var on the
 *      spawned subprocess. Used here as a defensive-belt fallback.
 *
 * Absence of both indicates a standalone CLI host (Claude Desktop
 * manual config, direct CLI, systemd, launchd, etc.).
 *
 * The watch subcommand uses this to differentiate two missing-
 * credential failure modes: an unattended plugin monitor whose
 * SNAPPER_WATCH_ACCESS_TOKEN field is blank should sit idle and
 * exit cleanly (the proxy MCP server is the operator's primary
 * surface; spamming stderr with "missing env var" every restart
 * is hostile UX), while a standalone host with no access token
 * configured is a misconfiguration and must surface a hard error.
 */
export function isClaudeCodePluginContext(source: NodeJS.ProcessEnv = process.env): boolean {
  return (
    typeof source["CLAUDE_PLUGIN_OPTION_SNAPPER_BASE_URL"] === "string" ||
    typeof source["CLAUDE_PLUGIN_ROOT"] === "string"
  );
}

function readChainedEnv(
  source: NodeJS.ProcessEnv,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const raw = source[name];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * Resolve the access token the watch subcommand should authenticate
 * with. The resolution differs between plugin and standalone
 * contexts on purpose:
 *
 *   - **Plugin context** (Claude Code auto-spawns the monitor): only
 *     the dedicated `*_WATCH_ACCESS_TOKEN` rungs are consulted.
 *     Falling back to the proxy delegate's access token would
 *     re-introduce v0.4.0's access-expiry death — the proxy
 *     delegate is rotating by default and its access token expires
 *     after ~15 minutes, after which the watch monitor cannot
 *     refresh without colliding with the proxy MCP server's refresh
 *     JTI. Decline the fallback and let the caller's
 *     graceful-skip gate fire instead.
 *
 *   - **Standalone context** (Claude Desktop manual config, systemd,
 *     launchd, direct CLI): the operator owns the credential
 *     selection, so falling back to `SNAPPER_ACCESS_TOKEN` is
 *     supported. Operators who want a separate watch-only PAT set
 *     `SNAPPER_WATCH_ACCESS_TOKEN`; operators who just want the
 *     existing access bearer to power both proxy + watch leave the
 *     watch field unset and watch picks up `SNAPPER_ACCESS_TOKEN`.
 *
 * Precedence order:
 *
 *   1. `CLAUDE_PLUGIN_OPTION_SNAPPER_WATCH_ACCESS_TOKEN` — Claude Code
 *      auto-exports user_config values to plugin subprocesses under
 *      this prefix; the cleanest delivery channel for the watch
 *      monitor's dedicated PAT (no argv exposure, no shell wrapping,
 *      no env-file footprint).
 *   2. `SNAPPER_WATCH_ACCESS_TOKEN` — operator-set explicit watch
 *      token in standalone deployments, parallel to (1) but outside
 *      the plugin host.
 *   3. `SNAPPER_ACCESS_TOKEN` — standalone-only fallback (skipped in
 *      plugin context to avoid the rotating-delegate access-expiry
 *      death described above).
 *
 * Returns `null` if no rung resolves OR if the only resolution is
 * the standalone fallback while in plugin context.
 */
export function watchAccessToken(source: NodeJS.ProcessEnv = process.env): string | null {
  const watchOnly = readChainedEnv(source, [
    "CLAUDE_PLUGIN_OPTION_SNAPPER_WATCH_ACCESS_TOKEN",
    "SNAPPER_WATCH_ACCESS_TOKEN",
  ]);
  if (watchOnly !== null) return watchOnly;
  if (isClaudeCodePluginContext(source)) return null;
  return readChainedEnv(source, ["SNAPPER_ACCESS_TOKEN"]);
}

function watchBaseUrl(source: NodeJS.ProcessEnv): string | null {
  return readChainedEnv(source, [
    "CLAUDE_PLUGIN_OPTION_SNAPPER_BASE_URL",
    "SNAPPER_BASE_URL",
  ]);
}

/**
 * Watch-subcommand env parser. See module docstring for the rationale
 * behind the precedence chain. Forces `refreshToken` to `null` because
 * the watch monitor MUST run in PAT mode — refresh-token rotation from
 * the watch session would race the proxy MCP server's refresh-JTI
 * (the original v0.4.0 deferral reason).
 *
 * Throws `EnvValidationError` when access-token or base-URL resolution
 * yields nothing on any rung. Callers running inside Claude Code's
 * plugin sandbox should pre-check `isClaudeCodePluginContext` +
 * `watchAccessToken === null` and exit 0 gracefully BEFORE invoking
 * this parser, so an unattended monitor with a blank watch-token
 * field stays idle instead of restart-looping the throw path.
 */
export function parseWatchEnv(source: NodeJS.ProcessEnv = process.env): BridgeEnv {
  const accessToken = watchAccessToken(source);
  if (accessToken === null) {
    throw new EnvValidationError(
      "Missing required environment variable SNAPPER_ACCESS_TOKEN. Set it via your Claude Desktop / Claude Code .mcp-config.json and restart the MCP host.",
      "SNAPPER_ACCESS_TOKEN",
    );
  }
  const rawBase = watchBaseUrl(source);
  if (rawBase === null) {
    throw new EnvValidationError(
      "Missing required environment variable SNAPPER_BASE_URL. Set it via your Claude Desktop / Claude Code .mcp-config.json and restart the MCP host.",
      "SNAPPER_BASE_URL",
    );
  }
  const baseUrl = parseUrl("SNAPPER_BASE_URL", rawBase);
  if (!baseUrl.pathname.endsWith("/")) {
    baseUrl.pathname = `${baseUrl.pathname}/`;
  }
  return { baseUrl, accessToken, refreshToken: null };
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
      `snapper-mcp watch requires an http:// or https:// base URL; got ${JSON.stringify(baseUrl.protocol)}.`,
      "SNAPPER_BASE_URL",
    );
  }
  const normalised = baseUrl.pathname.endsWith("/")
    ? baseUrl.pathname.slice(0, -1)
    : baseUrl.pathname;
  if (normalised !== "/api/mcp") {
    throw new EnvValidationError(
      `snapper-mcp watch requires SNAPPER_BASE_URL pathname /api/mcp; got ${JSON.stringify(baseUrl.pathname)}.`,
      "SNAPPER_BASE_URL",
    );
  }
  const wsScheme = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = new URL(`${wsScheme}//${baseUrl.host}/api/ws`);
  return wsUrl;
}

export const REQUIRED_ENV_VARS: readonly string[] = REQUIRED_VARS;
export const OPTIONAL_ENV_VARS: readonly string[] = OPTIONAL_VARS;
