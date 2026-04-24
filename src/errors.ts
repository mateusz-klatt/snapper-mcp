/**
 * Error types + stderr-message mapping for the bridge's refresh flow.
 *
 * Scope:
 *
 *   (a) Transport-layer errors — emitted by Snapper's middleware
 *       BEFORE the request reaches a tool. The bridge does NOT
 *       re-map these at runtime. The SDK surfaces HTTP / JSON-RPC
 *       errors via its own protocol machinery (`McpError`,
 *       `CallToolResult.isError`), which we pass through to the MCP
 *       host verbatim. See README troubleshooting table for the
 *       user-facing meaning of each backend `error_code`. Keeping
 *       a TypeScript table here in v1.0 would only be shadow
 *       documentation of the backend contract.
 *
 *   (b) Tool-layer errors — passed through as
 *       `CallToolResult.isError=true` by design. No bridge mapping.
 *
 *   (c) Refresh-path errors — emitted by `performRefresh` in
 *       `bridge_fetch.ts`. `REFRESH_ERROR_MAPPINGS` below maps each
 *       `RefreshFailedError` message stem to an actionable stderr
 *       message that `createBridgeFetch` logs before returning the
 *       original 401 to the SDK.
 *
 *   (d) SDK / transport-construction — pre-initialize failures.
 *       The runtime paths in `main.ts` + `index.ts` log the actual
 *       cause (`EnvValidationError.message` at env failures,
 *       `logger.error("MCP handshake to Snapper failed at startup", err)`
 *       at initialize failures, `BridgeStartupError` + fatal stderr
 *       in `index.ts` for stdio attach failures). These produce
 *       concrete runtime messages that name the failing variable /
 *       URL / cause directly — a duplicate message table here would
 *       drift.
 */

export { EnvValidationError } from "./env.js";

export class RefreshFailedError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RefreshFailedError";
  }
}

export class BridgeStartupError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BridgeStartupError";
  }
}

/**
 * Raised when the bridge is configured in long-lived PAT mode (no
 * SNAPPER_REFRESH_TOKEN) AND the backend rejects the access token
 * with a 401 `invalid_bearer_token`. The bridge cannot auto-refresh
 * because there is no refresh token to trade in; callers see the
 * 401 verbatim and this class is used by `TokenStore.rotate()` to
 * guard against accidental rotation attempts in PAT mode.
 */
export class NoRefreshTokenError extends Error {
  constructor() {
    super("no SNAPPER_REFRESH_TOKEN configured — long-lived PAT cannot auto-refresh");
    this.name = "NoRefreshTokenError";
  }
}

export interface RefreshErrorMapping {
  readonly pattern: RegExp;
  readonly message: string;
}

/**
 * Refresh-path error mapping. Each row matches a variant of
 * `RefreshFailedError` thrown by `performRefresh`. Pattern matches
 * the first message fragment the error is constructed with.
 *
 * Consumed at runtime by `createBridgeFetch` in `bridge_fetch.ts`.
 */
export const REFRESH_ERROR_MAPPINGS: readonly RefreshErrorMapping[] = Object.freeze([
  {
    pattern: /^refresh rejected/i,
    message:
      "Refresh rejected — your refresh token may be expired or revoked. Regenerate tokens in the Snapper UI and update SNAPPER_REFRESH_TOKEN.",
  },
  {
    pattern: /^refresh response malformed/i,
    message:
      "Refresh response malformed — expected `{payload: {access_token, refresh_token}}` envelope. Check the Snapper backend version matches this client's contract.",
  },
  {
    pattern: /^refresh server error/i,
    message:
      "Refresh failed with a server error. The backend may be transiently unhealthy. Retrying may work; no auto-retry to avoid storms.",
  },
  {
    pattern: /^refresh network error/i,
    message:
      "Cannot reach the refresh endpoint. Check your network and that SNAPPER_BASE_URL points at a live Snapper instance.",
  },
  {
    pattern: /^refresh timeout/i,
    message:
      "Refresh timed out after 10s. Network latency or backend unreachability. Retry when the backend is responsive.",
  },
]);

/**
 * Resolve a refresh failure to its stderr message. Accepts `unknown` —
 * the Promise contract permits rejecting with any value, so callers
 * (notably `createBridgeFetch`) should not have to type-guard before
 * invoking us. Falls back to "Refresh failed: <stringified>" for
 * anything that doesn't match a known pattern.
 */
export function resolveRefreshError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  for (const mapping of REFRESH_ERROR_MAPPINGS) {
    if (mapping.pattern.test(message)) {
      return mapping.message;
    }
  }
  return `Refresh failed: ${message}`;
}
