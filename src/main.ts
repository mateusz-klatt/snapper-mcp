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
 *   8. McpServer({name, version}, {capabilities: mirrored}) — stdio
 *      side announces EXACTLY what Snapper advertised; no more, no less.
 *   9. wireProxy(...) — register handlers for advertised capabilities
 *      + fallbackNotificationHandler for reverse path.
 *  10. installShutdownHandlers(...) — SIGTERM/SIGINT drain with
 *      user-space pendingForward + pendingReverse tracking.
 *  11. stdioServer.connect(new StdioServerTransport()).
 *  12. Banner log to stderr: bridge is live.
 *
 * Errors surfaced to stderr + exit(1) happen BEFORE the stdio MCP server
 * accepts traffic, so Claude Desktop sees "MCP server failed to
 * start" with the actionable reason in the subprocess stderr tail.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createBridgeFetch } from "./bridge_fetch.js";
import { ClientArgError, parseClientName, type ClientName } from "./clients.js";
import { BridgeStartupError, EnvValidationError } from "./errors.js";
import { parseCliFlags, parseEnv, redactCliArg, type BridgeEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { supportedMirroredCapabilities, wireProxy, type ProxyPending } from "./proxy.js";
import { seedConfigFileIfPluginContext } from "./seed_config.js";
import { createShutdownHandlers } from "./shutdown.js";
import { isWakeEnabled, readWakePreference, resolveStateDir } from "./state_dir.js";
import { TokenStore } from "./token_store.js";
import {
  startCodexWakeWorker,
  startCursorWakeWorker,
  type WakeWorkerHandle,
} from "./wake_workers.js";
import type { WsClient, WsClientOptions } from "./ws_client.js";

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
  readonly wakeWsClientFactory?: (opts: WsClientOptions) => WsClient;
}

export interface ProxyWakeFlags {
  readonly client: ClientName | null;
  readonly wake: boolean | null;
  readonly filteredArgv: readonly string[];
}

export function extractProxyWakeArgs(argv: readonly string[]): ProxyWakeFlags {
  let client: ClientName | null = null;
  let wake: boolean | null = null;
  const filteredArgv: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--client") {
      const next = argv[i + 1];
      if (typeof next !== "string" || next.length === 0) {
        throw new EnvValidationError("--client requires a CLI name");
      }
      try {
        client = parseClientName(next, "--client");
      } catch (err) {
        throw new EnvValidationError(err instanceof ClientArgError ? err.message : String(err));
      }
      i += 2;
      continue;
    }
    if (arg.startsWith("--client=")) {
      try {
        client = parseClientName(arg.slice("--client=".length), "--client");
      } catch (err) {
        throw new EnvValidationError(err instanceof ClientArgError ? err.message : String(err));
      }
      i += 1;
      continue;
    }
    if (arg === "--wake" || arg === "--wake=true") {
      wake = true;
      i += 1;
      continue;
    }
    if (arg === "--no-wake" || arg === "--wake=false") {
      wake = false;
      i += 1;
      continue;
    }
    filteredArgv.push(arg);
    i += 1;
  }

  return { client, wake, filteredArgv };
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
  let proxyWake: ProxyWakeFlags;
  try {
    proxyWake = extractProxyWakeArgs(argv);
    rejectUnknownProxyArgs(proxyWake.filteredArgv);
    env = await parseEnv(source, proxyWake.filteredArgv, logger);
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
  let wakeWorker: WakeWorkerHandle | null = null;

  const stdioServer = new McpServer(
    { name: backendName, version: backendVersion },
    { capabilities: mirroredCapabilities },
  );

  wireProxy(stdioServer.server, httpClient, mirroredCapabilities, pending, logger, {
    shuttingDown: () => shuttingDown,
  });

  const handlers = createShutdownHandlers({
    stdioServer,
    httpClient,
    pending,
    logger,
    setShuttingDown: () => {
      shuttingDown = true;
      if (wakeWorker !== null) {
        const closing = wakeWorker.close();
        pending.pendingReverse.add(closing);
        void closing.finally(() => {
          pending.pendingReverse.delete(closing);
        });
      }
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

  if (proxyWake.client === "codex" || proxyWake.client === "cursor") {
    const stateDir = resolveStateDir(source);
    const pref = await readWakePreference(stateDir, proxyWake.client).catch(() => null);
    const enabled =
      proxyWake.wake === null
        ? isWakeEnabled(pref ?? "default")
        : proxyWake.wake && isWakeEnabled(pref ?? "default");
    if (enabled) {
      wakeWorker =
        proxyWake.client === "codex"
          ? await startCodexWakeWorker({
              env,
              stateDir,
              logger,
              wsClientFactory: options.wakeWsClientFactory,
            })
          : await startCursorWakeWorker({
              env,
              stateDir,
              logger,
              wsClientFactory: options.wakeWsClientFactory,
            });
    }
  }

  logger.info(
    `[${CLIENT_NAME} v${VERSION}] bridging stdio ↔ ${env.baseUrl.toString()} (${backendName} ${backendVersion})`,
  );
}
