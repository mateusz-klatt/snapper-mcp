/**
 * WebSocket-token fetcher for the upcoming `snapper-mcp watch` subcommand.
 *
 * The Snapper backend delivers the one-shot `ws_token` (and its
 * `ws_token_exp` ISO 8601 datetime) inside the `payload` envelope of
 * every successful `POST /api/auth/refresh?return_tokens=true` call,
 * alongside the rotated access + refresh JWTs. This module piggybacks
 * on that route via the existing `TokenStore.rotate()` single-flight
 * machinery, so the watch subcommand obtains a ws_token while keeping
 * the access pair fresh.
 *
 * Hard constraint — PAT mode incompatibility:
 *
 *   PAT-only delegates (configured without `SNAPPER_REFRESH_TOKEN`)
 *   cannot rotate, so they cannot mint a ws_token either. We surface
 *   `NoRefreshTokenError` immediately rather than burning an HTTP
 *   round-trip; the watch subcommand reports this as a fatal startup
 *   error to operators ("regenerate the delegate as rotating-token").
 *
 * Race-tightness — ws_token capture vs TokenStore single-flight:
 *
 *   `TokenStore.rotate(via)` coalesces N concurrent rotate attempts
 *   into ONE invocation of the supplied `via` function; every other
 *   caller awaits the same promise and observes the same rotated
 *   pair. If another rotate caller (a non-ws bridge_fetch refresh
 *   OR a competing `fetchWsToken` call) wins the race, OUR `via`
 *   never runs and `captureCell.value` stays `null`. We surface this
 *   as an explicit `RefreshFailedError` so the watch subcommand can
 *   retry the ws_token fetch on the next session attempt rather than
 *   silently skipping authentication.
 *
 *   Today, watch and proxy are dispatched as alternative subcommands
 *   (per `src/index.ts` argv handling), so this race cannot trigger.
 *   The defensive surfacing future-proofs against a unified entry
 *   point.
 *
 * Burned-refresh safety — pair install vs ws_token validation:
 *
 *   The server rotates the refresh JTI BEFORE returning the response.
 *   If we threw on a malformed `ws_token` field BEFORE returning the
 *   new pair from the rotate function, `TokenStore.pair` would stay
 *   at the old (now-revoked) refresh — the bridge would then 401 on
 *   its next refresh attempt and PAT-mode-eject. To avoid burning a
 *   refresh token over a ws_token field issue, we always return the
 *   parsed `TokenPair` from the rotate function (so the store
 *   publishes it) and bubble any ws_token-specific failure AFTER
 *   `await store.rotate(...)` resolves.
 */

import { computeRefreshUrl } from "./env.js";
import { NoRefreshTokenError, RefreshFailedError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { RefreshFn, TokenPair, TokenStore } from "./token_store.js";

const REFRESH_TIMEOUT_MS = 10_000;

/**
 * Loose ISO 8601 datetime regex. Matches the Pydantic default datetime
 * serialization the Snapper backend produces for `RefreshData.ws_token_exp`
 * (e.g. "2026-04-27T12:00:00Z" or "2026-04-27T12:00:00.123456+00:00").
 * `Date.parse()` alone is too permissive (accepts e.g. "2026-04-27" and
 * "April 27, 2026"); a regex pre-check tightens protocol-drift
 * detection without depending on a third-party ISO 8601 validator.
 */
const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export interface WsTokenResult {
  readonly ws_token: string;
  readonly ws_token_exp: string;
}

interface RefreshPayloadEnvelope {
  readonly payload?: {
    readonly access_token?: unknown;
    readonly refresh_token?: unknown;
    readonly ws_token?: unknown;
    readonly ws_token_exp?: unknown;
  };
}

type CapturedWsFields =
  | { readonly ok: true; readonly ws_token: string; readonly ws_token_exp: string }
  | { readonly ok: false; readonly error: RefreshFailedError };

function parseTokenPair(raw: unknown): {
  readonly pair: TokenPair;
  readonly envelope: RefreshPayloadEnvelope;
} {
  if (raw === null || typeof raw !== "object") {
    throw new RefreshFailedError(
      "refresh response malformed: body is not a JSON object",
      200,
      raw,
    );
  }
  const envelope = raw as RefreshPayloadEnvelope;
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
  return { pair: { access, refresh }, envelope };
}

function captureWsFields(envelope: RefreshPayloadEnvelope): CapturedWsFields {
  const wsToken = envelope.payload?.ws_token;
  if (typeof wsToken !== "string" || wsToken.length === 0) {
    return {
      ok: false,
      error: new RefreshFailedError(
        "refresh response malformed: payload.ws_token missing or empty",
        200,
      ),
    };
  }
  const wsTokenExp = envelope.payload?.ws_token_exp;
  if (typeof wsTokenExp !== "string" || wsTokenExp.length === 0) {
    return {
      ok: false,
      error: new RefreshFailedError(
        "refresh response malformed: payload.ws_token_exp missing or empty",
        200,
      ),
    };
  }
  if (!ISO_8601_PATTERN.test(wsTokenExp) || Number.isNaN(Date.parse(wsTokenExp))) {
    return {
      ok: false,
      error: new RefreshFailedError(
        `refresh response malformed: payload.ws_token_exp is not a parseable ISO 8601 datetime (got ${JSON.stringify(wsTokenExp)})`,
        200,
      ),
    };
  }
  return { ok: true, ws_token: wsToken, ws_token_exp: wsTokenExp };
}

export async function fetchWsToken(
  baseUrl: URL,
  store: TokenStore,
  logger: Logger,
): Promise<WsTokenResult> {
  if (!store.hasRefreshToken()) {
    throw new NoRefreshTokenError();
  }

  const captureCell: { value: CapturedWsFields | null } = { value: null };

  const refreshFn: RefreshFn = async (current) => {
    const url = computeRefreshUrl(baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await globalThis.fetch(url, {
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
      throw new RefreshFailedError(
        `refresh server error (${response.status})`,
        response.status,
      );
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
    const { pair, envelope } = parseTokenPair(body);
    const captured = captureWsFields(envelope);
    captureCell.value = captured;
    if (captured.ok) {
      logger.debug("ws_token: refresh succeeded; ws_token captured");
    } else {
      logger.debug(
        `ws_token: refresh succeeded but ws_token capture failed: ${captured.error.message}`,
      );
    }
    return pair;
  };

  await store.rotate(refreshFn);

  const result = captureCell.value;
  if (result === null) {
    throw new RefreshFailedError(
      "ws_token: rotate joined an existing refresh without ws_token capture; retry the watch session",
      200,
    );
  }
  if (!result.ok) {
    throw result.error;
  }
  return { ws_token: result.ws_token, ws_token_exp: result.ws_token_exp };
}
