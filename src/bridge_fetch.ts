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
 *   2. On 401: write a single-line stderr message ONCE per session
 *      (deduplicated via a session-scoped sentinel keyed on the
 *      access token bytes) and return the 401 response to the SDK.
 *      The bridge does not exit and does not throw a custom error;
 *      the MCP host surfaces the 401 as a protocol error and the
 *      operator regenerates the AI delegate to recover.
 */

import type { Logger } from "./logger.js";
import type { TokenStore } from "./token_store.js";

export function createBridgeFetch(store: TokenStore, logger: Logger): typeof fetch {
  const reportedTokens = new Set<string>();

  const bridgeFetch: typeof fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${store.accessToken()}`);
    const response = await globalThis.fetch(input, { ...init, headers });

    if (response.status === 401) {
      const tokenKey = store.accessToken();
      if (!reportedTokens.has(tokenKey)) {
        reportedTokens.add(tokenKey);
        logger.error(
          "Authentication failed for SNAPPER_ACCESS_TOKEN. The token may be revoked or expired. Recreate the AI delegate in Snapper.",
        );
      }
    }

    return response;
  };

  return bridgeFetch;
}
