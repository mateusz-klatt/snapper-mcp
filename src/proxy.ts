/**
 * Bidirectional MCP proxy wiring between a stdio Server (Claude Desktop
 * side) and an HTTP Client (Snapper side).
 *
 * Forward path  (host → server): request handlers on the stdio Server
 *                                forward to `httpClient.request(...)`.
 * Reverse path  (server → host): the HTTP Client's
 *                                `fallbackNotificationHandler` forwards
 *                                every notification back to the stdio
 *                                Server verbatim. (The earlier
 *                                `onnotification(...)` API from SDK
 *                                v1.2 does not exist in SDK v1.29.)
 *
 * Capability mirroring: the caller MUST complete
 * `client.connect(transport)` first, then pass
 * `client.getServerCapabilities()` here. Only request handlers for
 * capabilities the backend advertises get registered on the stdio
 * Server. The SDK's "unsupported capability" stdout-writing debug
 * paths are therefore structurally unreachable.
 *
 * Bidirectional cancellation: the stdio Server's generic request
 * handler threads `AbortSignal` through to the HTTP Client via the
 * SDK's request-options object; incoming cancellation notifications
 * on either side are forwarded to the other side via the pair of
 * notification handlers registered at the bottom of `wireProxy`.
 *
 * Pending-request tracking: every in-flight forward-path call and
 * every outbound reverse-path notification send is pushed into the
 * caller-supplied `pendingForward` / `pendingReverse` Sets so the
 * shutdown module can `Promise.allSettled` them under the drain
 * timeout (the SDK has no built-in drain primitive).
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  Notification,
  Request,
  Result,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
  ReadResourceRequestSchema,
  ResultSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type { Logger } from "./logger.js";

export interface ProxyPending {
  readonly pendingForward: Set<Promise<unknown>>;
  readonly pendingReverse: Set<Promise<unknown>>;
}

export interface ProxyOptions {
  readonly shuttingDown: () => boolean;
}

interface RequestHandlerExtra {
  readonly signal?: AbortSignal;
}

type CapabilityGate =
  | { readonly kind: "always" }
  | { readonly kind: "family"; readonly family: "tools" | "resources" | "prompts" | "logging" | "completions" }
  | { readonly kind: "sub"; readonly family: "resources"; readonly bit: "subscribe" };

type ForwardEntry = {
  readonly gate: CapabilityGate;
  readonly schema: z.ZodTypeAny;
  readonly method: string;
};

/**
 * Methods the bridge forwards from host → server, each gated by the
 * MCP capability (or sub-capability) it depends on.
 *
 *   - `always`     — forward regardless of advertised capabilities
 *                    (ping keepalive).
 *   - `family`     — forward only when the top-level capability is
 *                    advertised (e.g. `tools/list` needs `tools`).
 *   - `sub`        — forward only when a specific sub-capability bit
 *                    is set (e.g. `resources/subscribe` needs
 *                    `capabilities.resources.subscribe === true` per
 *                    MCP spec).
 *
 * The `notifications/cancelled` schema is intentionally NOT handled
 * here. The SDK's Protocol base class already wires cancellation
 * via a built-in handler that correlates the notification's
 * `requestId` to an in-flight request and fires its `AbortSignal`.
 * Registering our own handler here would OVERRIDE that plumbing and
 * break local abort propagation. Instead, we pass
 * `extra.signal` through to `httpClient.request({signal})` so host
 * cancellations propagate to backend via the transport's own
 * AbortController. Server → host cancellations flow through
 * `fallbackNotificationHandler` below; the stdio Server's SDK
 * internals handle the host-side abort on its end.
 */
const FORWARD_METHODS: readonly ForwardEntry[] = [
  { gate: { kind: "always" }, schema: PingRequestSchema, method: "ping" },
  { gate: { kind: "family", family: "tools" }, schema: ListToolsRequestSchema, method: "tools/list" },
  { gate: { kind: "family", family: "tools" }, schema: CallToolRequestSchema, method: "tools/call" },
  { gate: { kind: "family", family: "resources" }, schema: ListResourcesRequestSchema, method: "resources/list" },
  { gate: { kind: "family", family: "resources" }, schema: ListResourceTemplatesRequestSchema, method: "resources/templates/list" },
  { gate: { kind: "family", family: "resources" }, schema: ReadResourceRequestSchema, method: "resources/read" },
  { gate: { kind: "sub", family: "resources", bit: "subscribe" }, schema: SubscribeRequestSchema, method: "resources/subscribe" },
  { gate: { kind: "sub", family: "resources", bit: "subscribe" }, schema: UnsubscribeRequestSchema, method: "resources/unsubscribe" },
  { gate: { kind: "family", family: "prompts" }, schema: ListPromptsRequestSchema, method: "prompts/list" },
  { gate: { kind: "family", family: "prompts" }, schema: GetPromptRequestSchema, method: "prompts/get" },
  { gate: { kind: "family", family: "logging" }, schema: SetLevelRequestSchema, method: "logging/setLevel" },
  { gate: { kind: "family", family: "completions" }, schema: CompleteRequestSchema, method: "completion/complete" },
];

const MIRRORED_CAPABILITY_FAMILIES: ReadonlySet<string> = new Set(
  FORWARD_METHODS.flatMap((entry) =>
    entry.gate.kind === "family" || entry.gate.kind === "sub" ? [entry.gate.family] : [],
  ),
);

function hasCapability(capabilities: ServerCapabilities, gate: CapabilityGate): boolean {
  if (gate.kind === "always") return true;
  const value = (capabilities as Record<string, unknown>)[gate.family];
  if (value === undefined) return false;
  if (gate.kind === "family") return true;
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<string, unknown>)[gate.bit] === true;
}

/**
 * Return the subset of `backend` capabilities we can actually proxy.
 * main.ts uses this to construct the stdio Server so the announced
 * capabilities EXACTLY match what `wireProxy` knows how to forward —
 * if backend advertises an extension capability the bridge doesn't
 * recognise, the host must see `MethodNotFound` locally instead of a
 * capability that only half-works.
 */
export function supportedMirroredCapabilities(
  backend: ServerCapabilities,
): ServerCapabilities {
  const result: ServerCapabilities = {};
  const asRecord = backend as Record<string, unknown>;
  const asWritable = result as Record<string, unknown>;
  for (const family of MIRRORED_CAPABILITY_FAMILIES) {
    const value = asRecord[family];
    if (value !== undefined) {
      asWritable[family] = value;
    }
  }
  return result;
}

export function wireProxy(
  stdioServer: Server,
  httpClient: Client,
  capabilities: ServerCapabilities,
  pending: ProxyPending,
  logger: Logger,
  options: ProxyOptions,
): void {
  for (const entry of FORWARD_METHODS) {
    if (!hasCapability(capabilities, entry.gate)) continue;

    const method = entry.method;
    stdioServer.setRequestHandler(entry.schema, async (request, extra: RequestHandlerExtra) => {
      if (options.shuttingDown()) {
        throw new Error(`bridge shutting down — refusing new ${method} request`);
      }
      const forwarded = forwardRequest(httpClient, request as Request, extra);
      pending.pendingForward.add(forwarded);
      try {
        return await forwarded;
      } finally {
        pending.pendingForward.delete(forwarded);
      }
    });
  }

  httpClient.fallbackNotificationHandler = async (notification: Notification) => {
    // During shutdown, stop admitting new reverse-path work. drainSet
    // snapshots pending.pendingReverse at the start of the reverse drain;
    // adding notifications after that snapshot would escape the drain and
    // get cut off by the outer process.exit.
    if (options.shuttingDown()) {
      logger.debug(
        `dropping server → host notification ${notification.method} — bridge shutting down`,
      );
      return;
    }
    const send = stdioServer.notification(notification);
    pending.pendingReverse.add(send);
    try {
      await send;
    } catch (err) {
      logger.warn(`failed to forward server → host notification ${notification.method}`, err);
    } finally {
      pending.pendingReverse.delete(send);
    }
  };
}

const PassthroughResultSchema = ResultSchema.loose();

async function forwardRequest(
  httpClient: Client,
  request: Request,
  extra: RequestHandlerExtra,
): Promise<Result> {
  const options = extra.signal === undefined ? undefined : { signal: extra.signal };
  return httpClient.request(request, PassthroughResultSchema, options);
}
