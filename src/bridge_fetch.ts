/**
 * Custom `fetch` wrapper passed to the MCP HTTP transport via the
 * SDK v1.29 `StreamableHTTPClientTransportOptions.fetch?: FetchLike`
 * option. We deliberately do NOT use the SDK's `authProvider` option:
 * it requires an `OAuthClientProvider` (full OAuth authorization-code
 * flow), not a lightweight bearer-token hook.
 *
 * Responsibilities per request:
 *
 *   1. Inject `Authorization: Bearer <store.accessToken()>` while
 *      preserving every header the SDK set (notably Accept and
 *      Content-Type — without those, FastMCP rejects the request
 *      with 406/415).
 *   2. If the response is 401, peek at the error_code envelope on a
 *      cloned response (reading the original body would consume the
 *      stream the SDK relies on downstream).
 *   3. Only `invalid_bearer_token` triggers a refresh attempt.
 *      `user_deactivated` / `missing_bearer_token` / any other code
 *      / 503 `mcp_unavailable` (handled separately in the error
 *      mapper) fall through with the 401 unchanged.
 *   4. Refresh via `store.rotate(performRefresh)`; single-flight is
 *      owned by the TokenStore. On refresh failure, log to stderr
 *      and return the original 401 verbatim — the SDK surfaces it
 *      as a protocol error.
 *   5. Retry the original request ONCE with the rotated bearer. If
 *      the retry is also 401, surface without a second refresh
 *      (avoids refresh storms under pathological backends).
 */

import type { Logger } from "./logger.js";
import { computeRefreshUrl } from "./env.js";
import { RefreshFailedError, resolveRefreshError } from "./errors.js";
import type { RefreshFn, TokenPair, TokenStore } from "./token_store.js";

export { RefreshFailedError } from "./errors.js";

const REFRESH_TIMEOUT_MS = 10_000;

interface PayloadResponseEnvelope {
  readonly payload?: {
    readonly access_token?: string | null;
    readonly refresh_token?: string | null;
  };
}

/**
 * Read the `error_code` field from a cloned response body if present.
 * Never consumes the original response's body — the SDK still needs
 * to read it downstream.
 * Returns null on any parse failure so the caller can decide whether
 * to refresh or surface the 401 as-is.
 */
export async function peekErrorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (body !== null && typeof body === "object" && "error_code" in body) {
      const value = body.error_code;
      return typeof value === "string" ? value : null;
    }
    return null;
  } catch {
    return null;
  }
}

function mergeAuthHeader(init: RequestInit, bearer: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${bearer}`);
  return { ...init, headers };
}

export function createBridgeFetch(
  store: TokenStore,
  performRefresh: RefreshFn,
  logger: Logger,
): typeof fetch {
  const bridgeFetch: typeof fetch = async (input, init = {}) => {
    const firstAttempt = await globalThis.fetch(input, mergeAuthHeader(init, store.accessToken()));

    if (firstAttempt.status !== 401) {
      return firstAttempt;
    }

    const errorCode = await peekErrorCode(firstAttempt.clone());
    if (errorCode !== "invalid_bearer_token") {
      return firstAttempt;
    }

    try {
      await store.rotate(performRefresh);
    } catch (err) {
      logger.error(resolveRefreshError(err));
      return firstAttempt;
    }

    const retry = await globalThis.fetch(input, mergeAuthHeader(init, store.accessToken()));
    return retry;
  };

  return bridgeFetch;
}

function parseRefreshBody(raw: unknown): TokenPair {
  if (raw === null || typeof raw !== "object") {
    throw new RefreshFailedError(
      "refresh response malformed: body is not a JSON object",
      200,
      raw,
    );
  }
  const envelope = raw as PayloadResponseEnvelope;
  const access = envelope.payload?.access_token;
  const refresh = envelope.payload?.refresh_token;
  if (typeof access !== "string" || access.length === 0) {
    throw new RefreshFailedError(
      "refresh response malformed: payload.access_token missing or empty",
      200,
    );
  }
  if (typeof refresh !== "string" || refresh.length === 0) {
    throw new RefreshFailedError(
      "refresh response malformed: payload.refresh_token missing or empty",
      200,
    );
  }
  return { access, refresh };
}

export function makePerformRefresh(baseUrl: URL, logger: Logger): RefreshFn {
  const refreshUrl = computeRefreshUrl(baseUrl);
  return async function performRefresh(current: TokenPair): Promise<TokenPair> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await globalThis.fetch(refreshUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${current.refresh}`,
          "Content-Type": "application/json",
        },
        body: null,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new RefreshFailedError("refresh timeout after 10s", 0, err);
      }
      throw new RefreshFailedError("refresh network error", 0, err);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) {
      throw new RefreshFailedError("refresh rejected (401)", 401);
    }
    if (response.status >= 500) {
      throw new RefreshFailedError(`refresh server error (${response.status})`, response.status);
    }
    if (!response.ok) {
      throw new RefreshFailedError(
        `refresh unexpected status (${response.status})`,
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new RefreshFailedError("refresh response malformed: not JSON", 200, err);
    }
    const pair = parseRefreshBody(body);
    logger.debug("refresh succeeded; new token pair installed");
    return pair;
  };
}
