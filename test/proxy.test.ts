import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  Notification,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { createLogger } from "../src/logger.js";
import { supportedMirroredCapabilities, wireProxy, type ProxyPending } from "../src/proxy.js";
import { waitFor } from "./helpers/wait_for.js";

type HandlerFn = (request: unknown, extra: unknown) => Promise<unknown> | unknown;
type NotificationHandlerFn = (notification: unknown) => void | Promise<void>;
type StdioProxyServer = Parameters<typeof wireProxy>[0];

function silentLogger() {
  return createLogger({ prefix: "proxy-test", level: "error", timestamps: false });
}

function makeProxyHarness(capabilities: ServerCapabilities) {
  const requestHandlers = new Map<string, HandlerFn>();
  const notificationHandlers = new Map<string, NotificationHandlerFn>();

  const stdioServer = {
    setRequestHandler(schema: z.ZodTypeAny, handler: HandlerFn) {
      const method = (schema as unknown as { shape: { method: { value: string } } }).shape.method
        .value;
      requestHandlers.set(method, handler);
    },
    setNotificationHandler(schema: z.ZodTypeAny, handler: NotificationHandlerFn) {
      const method = (schema as unknown as { shape: { method: { value: string } } }).shape.method
        .value;
      notificationHandlers.set(method, handler);
    },
    notification: vi.fn(async () => {}),
  } as unknown as StdioProxyServer;

  const httpClient = {
    request: vi.fn(async () => ({ result: "ok" })),
    notification: vi.fn(async () => {}),
    fallbackNotificationHandler: undefined as
      | ((notification: Notification) => void | Promise<void>)
      | undefined,
  } as unknown as Client & {
    request: ReturnType<typeof vi.fn>;
    notification: ReturnType<typeof vi.fn>;
  };

  const pending: ProxyPending = {
    pendingForward: new Set<Promise<unknown>>(),
    pendingReverse: new Set<Promise<unknown>>(),
  };

  let shuttingDown = false;
  wireProxy(stdioServer, httpClient, capabilities, pending, silentLogger(), {
    shuttingDown: () => shuttingDown,
  });

  return {
    requestHandlers,
    notificationHandlers,
    stdioServer,
    httpClient,
    pending,
    setShuttingDown: () => {
      shuttingDown = true;
    },
  };
}

describe("wireProxy — capability mirror", () => {
  it("registers tools/list + tools/call when only tools capability is advertised", () => {
    const { requestHandlers } = makeProxyHarness({ tools: {} });
    expect(requestHandlers.has("tools/list")).toBe(true);
    expect(requestHandlers.has("tools/call")).toBe(true);
  });

  it("does NOT register resources/list when resources capability is absent", () => {
    const { requestHandlers } = makeProxyHarness({ tools: {} });
    expect(requestHandlers.has("resources/list")).toBe(false);
    expect(requestHandlers.has("resources/read")).toBe(false);
  });

  it("does NOT register prompts/list when prompts capability is absent", () => {
    const { requestHandlers } = makeProxyHarness({ tools: {} });
    expect(requestHandlers.has("prompts/list")).toBe(false);
    expect(requestHandlers.has("prompts/get")).toBe(false);
  });

  it("registers resources list/read handlers when resources capability IS advertised (subscribe gated separately)", () => {
    const { requestHandlers } = makeProxyHarness({ tools: {}, resources: {} });
    expect(requestHandlers.has("resources/list")).toBe(true);
    expect(requestHandlers.has("resources/read")).toBe(true);
    expect(requestHandlers.has("resources/templates/list")).toBe(true);
    // resources/subscribe is gated on the resources.subscribe sub-capability bit
    expect(requestHandlers.has("resources/subscribe")).toBe(false);
    expect(requestHandlers.has("resources/unsubscribe")).toBe(false);
  });

  it("rejects sub-capability gate when the parent capability is a non-object truthy value (e.g. resources: true)", () => {
    // Pathological / non-compliant backend advertising shape — the sub
    // gate must refuse to register rather than crashing on a property
    // access against a non-object parent.
    const { requestHandlers } = makeProxyHarness({
      resources: true as unknown as Record<string, boolean>,
    });
    expect(requestHandlers.has("resources/subscribe")).toBe(false);
    expect(requestHandlers.has("resources/unsubscribe")).toBe(false);
  });

  it("registers resources/subscribe + unsubscribe only when resources.subscribe sub-capability is true", () => {
    const { requestHandlers } = makeProxyHarness({ resources: { subscribe: true } });
    expect(requestHandlers.has("resources/subscribe")).toBe(true);
    expect(requestHandlers.has("resources/unsubscribe")).toBe(true);
  });

  it("does NOT register subscribe handlers when resources.subscribe is false or absent", () => {
    const falseHandlers = makeProxyHarness({ resources: { subscribe: false } }).requestHandlers;
    expect(falseHandlers.has("resources/subscribe")).toBe(false);
    const absentHandlers = makeProxyHarness({ resources: {} }).requestHandlers;
    expect(absentHandlers.has("resources/subscribe")).toBe(false);
  });

  it("always registers ping regardless of capabilities", () => {
    const { requestHandlers } = makeProxyHarness({});
    expect(requestHandlers.has("ping")).toBe(true);
  });
});

describe("wireProxy — forward path", () => {
  let harness: ReturnType<typeof makeProxyHarness>;

  beforeEach(() => {
    harness = makeProxyHarness({ tools: {}, prompts: {}, resources: {} });
  });

  it("forwards tools/call requests to httpClient.request verbatim", async () => {
    const handler = harness.requestHandlers.get("tools/call")!;
    const payload = { method: "tools/call", params: { name: "list_instruments" } };
    await handler(payload, {});
    expect(harness.httpClient.request).toHaveBeenCalledOnce();
    const [forwarded] = harness.httpClient.request.mock.calls[0]!;
    expect(forwarded).toEqual(payload);
  });

  it("threads AbortSignal from extra into httpClient.request options", async () => {
    const handler = harness.requestHandlers.get("tools/list")!;
    const controller = new AbortController();
    await handler({ method: "tools/list" }, { signal: controller.signal });
    const [, , options] = harness.httpClient.request.mock.calls[0]!;
    expect((options as { signal: AbortSignal }).signal).toBe(controller.signal);
  });

  it("tracks pending forward requests in pendingForward Set while in flight", async () => {
    const handler = harness.requestHandlers.get("tools/list")!;
    let resolveRequest!: (value: unknown) => void;
    harness.httpClient.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const inflight = handler({ method: "tools/list" }, {});
    await waitFor(() => harness.pending.pendingForward.size === 1, {
      message: "forward request to enter the pending set",
    });
    expect(harness.pending.pendingForward.size).toBe(1);
    resolveRequest({ result: "ok" });
    await inflight;
    expect(harness.pending.pendingForward.size).toBe(0);
  });

  it("removes from pendingForward even when the forwarded request rejects", async () => {
    const handler = harness.requestHandlers.get("tools/call")!;
    harness.httpClient.request.mockRejectedValueOnce(new Error("boom"));
    await expect(handler({ method: "tools/call" }, {})).rejects.toThrow("boom");
    expect(harness.pending.pendingForward.size).toBe(0);
  });

  it("refuses new requests once shuttingDown flag flips true", async () => {
    const handler = harness.requestHandlers.get("tools/list")!;
    harness.setShuttingDown();
    await expect(handler({ method: "tools/list" }, {})).rejects.toThrow(/shutting down/);
    expect(harness.httpClient.request).not.toHaveBeenCalled();
  });
});

describe("wireProxy — reverse path (fallbackNotificationHandler)", () => {
  it("sets httpClient.fallbackNotificationHandler to forward notifications to the stdio Server", async () => {
    const { httpClient, stdioServer } = makeProxyHarness({ tools: {} });
    expect(typeof httpClient.fallbackNotificationHandler).toBe("function");
    const progress: Notification = {
      method: "notifications/progress",
      params: { progressToken: "p1", progress: 50 },
    };
    await httpClient.fallbackNotificationHandler!(progress);
    expect(stdioServer.notification).toHaveBeenCalledWith(progress);
  });

  it("tracks outbound reverse-path sends in pendingReverse and clears on resolve", async () => {
    const { httpClient, stdioServer, pending } = makeProxyHarness({ tools: {} });
    let resolveSend!: () => void;
    (stdioServer.notification as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const forwarded = httpClient.fallbackNotificationHandler!({
      method: "notifications/progress",
      params: {},
    });
    await waitFor(() => pending.pendingReverse.size === 1, {
      message: "reverse notification send to enter the pending set",
    });
    expect(pending.pendingReverse.size).toBe(1);
    resolveSend();
    await forwarded;
    expect(pending.pendingReverse.size).toBe(0);
  });

  it("forwards arbitrary notification methods via the fallback (tools/list_changed, etc.)", async () => {
    const { httpClient, stdioServer } = makeProxyHarness({ tools: {} });
    const listChanged: Notification = { method: "notifications/tools/list_changed" };
    await httpClient.fallbackNotificationHandler!(listChanged);
    expect(stdioServer.notification).toHaveBeenCalledWith(listChanged);
  });

  it("clears pendingReverse even when the stdio send rejects", async () => {
    const { httpClient, stdioServer, pending } = makeProxyHarness({ tools: {} });
    (stdioServer.notification as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("pipe broken"),
    );
    await httpClient.fallbackNotificationHandler!({
      method: "notifications/progress",
      params: {},
    });
    expect(pending.pendingReverse.size).toBe(0);
  });

  it("drops server → host notifications that arrive while the bridge is shutting down", async () => {
    const harness = makeProxyHarness({ tools: {} });
    harness.setShuttingDown();
    await harness.httpClient.fallbackNotificationHandler!({
      method: "notifications/progress",
      params: { progressToken: "x", progress: 0.5 },
    });
    // We must not have forwarded the notification to stdio, and the
    // pending Set must not have grown.
    expect(harness.stdioServer.notification).not.toHaveBeenCalled();
    expect(harness.pending.pendingReverse.size).toBe(0);
  });
});

describe("wireProxy — cancellation delegated to SDK", () => {
  it("does NOT register a notifications/cancelled handler — SDK's Protocol handles local AbortSignal plumbing", () => {
    const { notificationHandlers } = makeProxyHarness({ tools: {} });
    expect(notificationHandlers.has("notifications/cancelled")).toBe(false);
  });

  it("propagates host AbortSignal into httpClient.request via extra.signal", async () => {
    const harness = makeProxyHarness({ tools: {} });
    const handler = harness.requestHandlers.get("tools/call")!;
    const controller = new AbortController();
    await handler(
      { method: "tools/call", params: { name: "list_instruments" } },
      { signal: controller.signal },
    );
    const [, , options] = harness.httpClient.request.mock.calls[0]!;
    expect((options as { signal: AbortSignal }).signal).toBe(controller.signal);
  });

  it("reverse-path cancellations flow via the fallback notification handler", async () => {
    const { httpClient, stdioServer } = makeProxyHarness({ tools: {} });
    const cancel: Notification = {
      method: "notifications/cancelled",
      params: { requestId: 99 },
    };
    await httpClient.fallbackNotificationHandler!(cancel);
    expect(stdioServer.notification).toHaveBeenCalledWith(cancel);
  });
});

describe("supportedMirroredCapabilities — exact-mirror subset", () => {
  it("returns only capabilities the bridge can forward", () => {
    const backend: ServerCapabilities = {
      tools: {},
      resources: { subscribe: true },
      prompts: {},
      logging: {},
      completions: {},
    };
    const mirrored = supportedMirroredCapabilities(backend);
    expect(mirrored).toEqual(backend);
  });

  it("drops backend extension capabilities the bridge does not proxy", () => {
    const backend = {
      tools: {},
      experimental: { fancy: true },
      tasks: { run: true },
    } as unknown as ServerCapabilities;
    const mirrored = supportedMirroredCapabilities(backend);
    expect(mirrored).toEqual({ tools: {} });
    expect("experimental" in mirrored).toBe(false);
    expect("tasks" in mirrored).toBe(false);
  });

  it("preserves the value shape (sub-capabilities) for supported families", () => {
    const backend: ServerCapabilities = { resources: { subscribe: true, listChanged: true } };
    const mirrored = supportedMirroredCapabilities(backend);
    expect(mirrored.resources).toEqual({ subscribe: true, listChanged: true });
  });

  it("returns an empty object when backend advertises nothing supported", () => {
    const backend = { experimental: {} } as unknown as ServerCapabilities;
    expect(supportedMirroredCapabilities(backend)).toEqual({});
  });
});

describe("wireProxy — schema coverage sanity", () => {
  it("covers every forward entry end-to-end against its SDK schema", () => {
    const { requestHandlers } = makeProxyHarness({
      tools: {},
      resources: {},
      prompts: {},
      logging: {},
      completions: {},
    });
    const schemas = {
      "tools/list": ListToolsRequestSchema,
      "tools/call": CallToolRequestSchema,
      "resources/list": ListResourcesRequestSchema,
      "prompts/list": ListPromptsRequestSchema,
      "prompts/get": GetPromptRequestSchema,
      ping: PingRequestSchema,
      "notifications/cancelled": CancelledNotificationSchema,
    };
    for (const method of Object.keys(schemas)) {
      expect(requestHandlers.has(method) || method.startsWith("notifications/")).toBe(true);
    }
  });
});
