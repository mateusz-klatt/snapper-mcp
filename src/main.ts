/**
 * Bridge lifecycle entry point.
 *
 * Sequence
 *   1. parseEnv()  — fail-fast with stderr + exit 1 on missing/invalid.
 *   2. TokenStore({access}).
 *   3. bridgeFetch = createBridgeFetch(store, logger).
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

import { createBridgeFetch } from "./bridge_fetch.js";
import { BridgeStartupError, EnvValidationError } from "./errors.js";
import { parseCliFlags, parseEnv, redactCliArg, type BridgeEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { supportedMirroredCapabilities, wireProxy, type ProxyPending } from "./proxy.js";
import { seedConfigFileIfPluginContext } from "./seed_config.js";
import { createShutdownHandlers } from "./shutdown.js";
import { TokenStore } from "./token_store.js";

/**
 * `tsup` injects __PKG_VERSION__ / __PKG_NAME__ into the bundled
 * dist via its `define` option. In raw-source test runs the
 * globals do not exist, so resolution goes through globalThis to
 * avoid a ReferenceError.
 */
interface BuildTimeGlobals {
  readonly __PKG_VERSION__?: unknown;
  readonly __PKG_NAME__?: unknown;
}

export function resolvePackageVersion(global: unknown): string {
  return typeof global === "string" ? global : "dev";
}

export function resolvePackageName(global: unknown): string {
  return typeof global === "string" ? global : "@mateusz-klatt/snapper-mcp";
}

const buildGlobals = globalThis as BuildTimeGlobals;
const VERSION = resolvePackageVersion(buildGlobals.__PKG_VERSION__);
const CLIENT_NAME = resolvePackageName(buildGlobals.__PKG_NAME__);

export interface MainOptions {
  readonly source?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly stdioTransport?: StdioServerTransport;
  readonly install?: boolean;
}

function rejectUnknownProxyArgs(argv: readonly string[]): void {
  const { remaining } = parseCliFlags(argv);
  if (remaining.length === 0) return;
  const rendered = remaining.map((arg) => JSON.stringify(redactCliArg(arg))).join(", ");
  throw new EnvValidationError(
    `Unknown argument ${rendered} — usage: snapper-mcp [--config PATH] [--base-url URL] [--access-token VALUE]`,
  );
}

export async function main(options: MainOptions = {}): Promise<void> {
  const source = options.source ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const logger = createLogger(CLIENT_NAME, source);

  let env: BridgeEnv;
  try {
    rejectUnknownProxyArgs(argv);
    env = await parseEnv(source, argv, logger);
  } catch (err) {
    if (!(err instanceof EnvValidationError)) throw err;
    logger.error(err.message);
    process.exit(1);
    return;
  }

  await seedConfigFileIfPluginContext(env, source, logger);

  const store = new TokenStore({ access: env.accessToken });
  const bridgeFetch = createBridgeFetch(store, logger);

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
