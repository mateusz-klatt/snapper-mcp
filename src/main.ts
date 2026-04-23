/**
 * Bridge lifecycle entry point.
 *
 * Sequence
 *   1. parseEnv()  — fail-fast with stderr + exit 1 on missing/invalid.
 *   2. TokenStore({access, refresh}).
 *   3. bridgeFetch = createBridgeFetch(store, performRefresh, logger).
 *   4. StreamableHTTPClientTransport(baseUrl, {fetch: bridgeFetch}) —
 *      NO authProvider; SDK v1.29's authProvider is OAuthClientProvider
 *      (full OAuth flow) and we only need a bearer-token fetch hook.
 *   5. Client.connect(transport) — completes MCP initialize against
 *      Snapper.
 *   6. client.getServerCapabilities() — CAPABILITY MIRROR input.
 *   7. Extract backend identity from client.getServerVersion()
 *      (Implementation | undefined — the older getServerName()
 *      method does not exist in SDK v1.29).
 *   8. Server({name, version}, {capabilities: mirrored}) — stdio side
 *      announces EXACTLY what Snapper advertised; no more, no less.
 *   9. wireProxy(...) — register handlers for advertised capabilities
 *      + fallbackNotificationHandler for reverse path.
 *  10. installShutdownHandlers(...) — SIGTERM/SIGINT drain with
 *      user-space pendingForward + pendingReverse tracking.
 *  11. stdioServer.connect(new StdioServerTransport()).
 *  12. Banner log to stderr: bridge is live.
 *
 * Errors surfaced to stderr + exit(1) happen BEFORE the stdio Server
 * accepts traffic, so Claude Desktop sees "MCP server failed to
 * start" with the actionable reason in the subprocess stderr tail.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createBridgeFetch, makePerformRefresh } from "./bridge_fetch.js";
import { BridgeStartupError, EnvValidationError } from "./errors.js";
import { parseEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { supportedMirroredCapabilities, wireProxy, type ProxyPending } from "./proxy.js";
import { createShutdownHandlers } from "./shutdown.js";
import { TokenStore } from "./token_store.js";

declare const __PKG_VERSION__: string | undefined;
declare const __PKG_NAME__: string | undefined;

const VERSION = typeof __PKG_VERSION__ === "string" ? __PKG_VERSION__ : "dev";
const CLIENT_NAME = typeof __PKG_NAME__ === "string" ? __PKG_NAME__ : "@mateusz-klatt/snapper-mcp";

export interface MainOptions {
  readonly source?: NodeJS.ProcessEnv;
  readonly stdioTransport?: StdioServerTransport;
  readonly install?: boolean;
}

export async function main(options: MainOptions = {}): Promise<void> {
  const source = options.source ?? process.env;
  const logger = createLogger(CLIENT_NAME, source);

  let env: ReturnType<typeof parseEnv>;
  try {
    env = parseEnv(source);
  } catch (err) {
    if (!(err instanceof EnvValidationError)) throw err;
    logger.error(err.message);
    process.exit(1);
    return;
  }

  const store = new TokenStore({ access: env.accessToken, refresh: env.refreshToken });
  const performRefresh = makePerformRefresh(env.baseUrl, logger);
  const bridgeFetch = createBridgeFetch(store, performRefresh, logger);

  const httpTransport = new StreamableHTTPClientTransport(env.baseUrl, { fetch: bridgeFetch });
  const httpClient = new Client(
    { name: CLIENT_NAME, version: VERSION },
    { capabilities: {} },
  );

  try {
    await httpClient.connect(httpTransport);
  } catch (err) {
    logger.error("MCP handshake to Snapper failed at startup", err);
    process.exit(1);
  }

  const backendCapabilities = httpClient.getServerCapabilities() ?? {};
  const mirroredCapabilities = supportedMirroredCapabilities(backendCapabilities);
  const serverImpl = httpClient.getServerVersion();
  const backendName = serverImpl?.name ?? "snapper";
  const backendVersion = serverImpl?.version ?? "unknown";

  const pending: ProxyPending = {
    pendingForward: new Set<Promise<unknown>>(),
    pendingReverse: new Set<Promise<unknown>>(),
  };
  let shuttingDown = false;

  const stdioServer = new Server(
    { name: backendName, version: backendVersion },
    { capabilities: mirroredCapabilities },
  );

  wireProxy(stdioServer, httpClient, mirroredCapabilities, pending, logger, {
    shuttingDown: () => shuttingDown,
  });

  const handlers = createShutdownHandlers({
    stdioServer,
    httpClient,
    pending,
    logger,
    setShuttingDown: () => {
      shuttingDown = true;
    },
  });

  const shouldInstall = options.install ?? true;
  if (shouldInstall) {
    handlers.install();
  }

  const stdioTransport = options.stdioTransport ?? new StdioServerTransport();
  try {
    await stdioServer.connect(stdioTransport);
  } catch (err) {
    handlers.uninstall();
    throw new BridgeStartupError("failed to attach stdio server transport", err);
  }

  logger.info(
    `[${CLIENT_NAME} v${VERSION}] bridging stdio ↔ ${env.baseUrl.toString()} (${backendName} ${backendVersion})`,
  );
}
