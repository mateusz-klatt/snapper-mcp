/**
 * Environment-variable parsing + refresh-URL derivation.
 *
 * The bridge reads exactly three env vars documented in the shipped
 * frontend snippet (`buildMcpConfigSnippet.ts`):
 *
 *   - SNAPPER_BASE_URL     — points at Snapper's /api/mcp endpoint.
 *   - SNAPPER_ACCESS_TOKEN — JWT access token for bearer auth.
 *   - SNAPPER_REFRESH_TOKEN — JWT refresh token used on 401 rotation.
 *
 * Validation is strict: any missing or blank value throws an
 * `EnvValidationError` whose message names the exact variable, so
 * operators debugging a misconfigured Claude Desktop entry see a
 * single actionable stderr line and exit cleanly.
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
  readonly refreshToken: string;
}

const REQUIRED_VARS = ["SNAPPER_BASE_URL", "SNAPPER_ACCESS_TOKEN", "SNAPPER_REFRESH_TOKEN"] as const;

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
  const refreshToken = requireNonEmpty("SNAPPER_REFRESH_TOKEN", source["SNAPPER_REFRESH_TOKEN"]);
  const baseUrl = parseUrl("SNAPPER_BASE_URL", rawBase);
  if (!baseUrl.pathname.endsWith("/")) {
    baseUrl.pathname = `${baseUrl.pathname}/`;
  }
  return { baseUrl, accessToken, refreshToken };
}

export function computeRefreshUrl(baseUrl: URL): URL {
  const refresh = new URL("/api/auth/refresh", baseUrl.origin);
  refresh.searchParams.set("return_tokens", "true");
  return refresh;
}

export const REQUIRED_ENV_VARS: readonly string[] = REQUIRED_VARS;
