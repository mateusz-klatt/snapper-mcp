/**
 * WebSocket-token fetcher for the `snapper-mcp watch` subcommand.
 *
 * Calls `POST /api/auth/ws_token` with the caller's access bearer
 * and returns the minted one-shot token + its absolute expiration.
 *
 * Failure surfaces:
 *
 *   - `401` → `AuthFailedError("ws_token rejected (401)", 401)`.
 *     The access bearer is wrong or expired. The watch loop logs
 *     the failure and reconnects with backoff; once the operator
 *     supplies a valid access bearer (typically by recreating the
 *     AI delegate in Snapper), the next ws_token mint succeeds.
 *   - `429` → `AuthFailedError("ws_token rate-limited", 429)`.
 *     Bubbled as transient; the reconnect backoff already paces
 *     re-attempts.
 *   - 5xx / network → `AuthFailedError(...)` retried by the
 *     reconnect loop.
 */

import { computeWsTokenUrl } from "./env.js";
import { AuthFailedError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { TokenStore } from "./token_store.js";

const WS_TOKEN_TIMEOUT_MS = 10_000;

/**
 * Loose ISO 8601 datetime regex. Matches the Pydantic default
 * datetime serialization the Snapper backend produces for
 * `WsTokenData.ws_token_exp` (e.g. "2026-04-27T12:00:00Z" or
 * "2026-04-27T12:00:00.123456+00:00"). `Date.parse()` alone is
 * too permissive (accepts e.g. "2026-04-27" and "April 27,
 * 2026"); a regex pre-check tightens protocol-drift detection
 * without depending on a third-party ISO 8601 validator.
 */
const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export interface WsTokenResult {
  readonly ws_token: string;
  readonly ws_token_exp: string;
}

interface WsTokenPayloadEnvelope {
  readonly payload?: {
    readonly ws_token?: unknown;
    readonly ws_token_exp?: unknown;
    readonly expires_in?: unknown;
  };
}

function parseWsTokenBody(raw: unknown, status: number): WsTokenResult {
  if (raw === null || typeof raw !== "object") {
    throw new AuthFailedError(
      "ws_token response malformed: body is not a JSON object",
      status,
      raw,
    );
  }
  const envelope = raw as WsTokenPayloadEnvelope;
  const wsToken = envelope.payload?.ws_token;
  if (typeof wsToken !== "string" || wsToken.length === 0) {
    throw new AuthFailedError(
      "ws_token response malformed: payload.ws_token missing or empty",
      status,
    );
  }
  const wsTokenExp = envelope.payload?.ws_token_exp;
  if (typeof wsTokenExp !== "string" || wsTokenExp.length === 0) {
    throw new AuthFailedError(
      "ws_token response malformed: payload.ws_token_exp missing or empty",
      status,
    );
  }
  if (!ISO_8601_PATTERN.test(wsTokenExp) || Number.isNaN(Date.parse(wsTokenExp))) {
    throw new AuthFailedError(
      `ws_token response malformed: payload.ws_token_exp is not a parseable ISO 8601 datetime (got ${JSON.stringify(wsTokenExp)})`,
      status,
    );
  }
  return { ws_token: wsToken, ws_token_exp: wsTokenExp };
}

export async function fetchWsToken(
  baseUrl: URL,
  store: TokenStore,
  logger: Logger,
): Promise<WsTokenResult> {
  const url = computeWsTokenUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WS_TOKEN_TIMEOUT_MS);
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${store.accessToken()}`,
      },
      body: null,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AuthFailedError("ws_token timeout after 10s", 0, err);
    }
    throw new AuthFailedError("ws_token network error", 0, err);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) {
    throw new AuthFailedError("ws_token rejected (401)", 401);
  }
  if (response.status === 429) {
    throw new AuthFailedError("ws_token rate-limited", 429);
  }
  if (response.status >= 500) {
    throw new AuthFailedError(
      `ws_token server error (${response.status})`,
      response.status,
    );
  }
  if (!response.ok) {
    throw new AuthFailedError(
      `ws_token unexpected status (${response.status})`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new AuthFailedError("ws_token response malformed: not JSON", response.status, err);
  }
  const result = parseWsTokenBody(body, response.status);
  logger.debug("ws_token: minted via /api/auth/ws_token");
  return result;
}
