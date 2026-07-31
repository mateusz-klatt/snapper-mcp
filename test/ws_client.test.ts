import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { EnvelopeMinter } from "../src/envelope.js";
import { createLogger } from "../src/logger.js";
import { TokenStore } from "../src/token_store.js";
import type { ServerFrame } from "../src/types.js";
import { createWsClient, toBuffer, type WsClientOptions } from "../src/ws_client.js";
import {
  makeMockWsServer,
  type ConnectionScript,
  type MockWsServer,
} from "./helpers/mock_ws_server.js";
import { CAN_LISTEN_ON_LOOPBACK } from "./helpers/listen_capability.js";
import { waitFor } from "./helpers/wait_for.js";

const SILENT_LOGGER = createLogger({ prefix: "ws-client-test", level: "error", timestamps: false });
const describeWithTcp = CAN_LISTEN_ON_LOOPBACK ? describe : describe.skip;

function envelopeStub(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "0192f000-0000-7000-8000-000000000001",
    sequence_id: 1,
    public_id: "0192f000-0000-7000-8000-aaaaaaaaaaaa",
    timestamp: "2026-04-28T12:00:00.000Z",
    topic: null,
    ...extra,
  };
}

function authPair(): {
  authRequired: Record<string, unknown>;
  authOk: Record<string, unknown>;
  authComplete: Record<string, unknown>;
} {
  return {
    authRequired: { type: "auth_required", timeout: 10, ...envelopeStub() },
    authOk: { type: "auth_ok", exp: "2026-04-28T13:00:00.000Z", ...envelopeStub() },
    authComplete: {
      type: "auth_complete",
      available_topics: ["signals."],
      user_role: "ai_delegate",
      session_expires_at: "2026-04-28T20:00:00.000Z",
      ws_token_exp: "2026-04-28T13:00:00.000Z",
      ...envelopeStub(),
    },
  };
}

function subscriptionSuccess(topics: readonly string[] = ["signals."]): Record<string, unknown> {
  return {
    type: "subscription_success",
    action: "subscribe",
    status: "subscribed",
    topics: [...topics],
    denied_topics: [],
    active_subscriptions: [...topics],
    message: null,
    ...envelopeStub(),
  };
}

function happyPathScript(): ConnectionScript {
  const { authRequired, authOk, authComplete } = authPair();
  return {
    onConnect: (socket) => {
      socket.send(JSON.stringify(authRequired));
    },
    handlers: {
      authenticate: ({ socket }) => {
        socket.send(JSON.stringify(authOk));
        socket.send(JSON.stringify(authComplete));
      },
      subscribe: ({ socket }) => {
        socket.send(JSON.stringify(subscriptionSuccess()));
      },
    },
  };
}

function makeOptions(
  server: MockWsServer,
  overrides: Partial<WsClientOptions> = {},
): WsClientOptions {
  return {
    wsUrl: server.url,
    tokenStore: new TokenStore({ access: "access-1", refresh: "refresh-1" }),
    fetchWsToken: vi.fn().mockResolvedValue({
      ws_token: "ws-tok-1",
      ws_token_exp: "2026-04-28T13:00:00.000Z",
    }),
    topics: ["signals."],
    minter: new EnvelopeMinter(),
    onFrame: vi.fn(),
    logger: SILENT_LOGGER,
    heartbeatIntervalMs: 30_000,
    reconnectBackoffBaseMs: 5,
    reconnectBackoffMaxMs: 25,
    reconnectJitterFraction: 0,
    authHandshakeTimeoutMs: 500,
    subscribeTimeoutMs: 500,
    dedupPruneIntervalMs: 1_000_000,
    random: () => 0.5,
    ...overrides,
  };
}

let activeServers: MockWsServer[] = [];

async function startServer(scripts: readonly ConnectionScript[]): Promise<MockWsServer> {
  const server = await makeMockWsServer(scripts);
  activeServers.push(server);
  return server;
}

afterEach(async () => {
  for (const server of activeServers) {
    await server.close();
  }
  activeServers = [];
});

describeWithTcp("ws_client — happy path lifecycle", () => {
  it("connects, authenticates, subscribes, and forwards a data frame", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const client = createWsClient(makeOptions(server, { onFrame }));
    const runPromise = client.run();
    await waitFor(
      () => {
        const types = server.received.map((rec) => rec.parsed.type);
        return types.includes("subscribe");
      },
      { message: "client subscription request to reach the websocket server" },
    );
    const subSent = server.received.find((r) => r.parsed.type === "subscribe");
    expect(subSent?.parsed.topics).toEqual(["signals."]);
    server.emit(0, {
      type: "signal",
      instrument: "BTC-USD",
      exchange: "kraken",
      side: "buy",
      strength: 0.8,
      reason: "rsi-30",
      price: 65_000,
      strategy_name: "rsi-mr",
      fired_at: "2026-04-28T12:00:00.000Z",
      wallet_public_id: "0192f000-0000-7000-8000-bbbbbbbbbbbb",
      operator_public_id: null,
      user_public_id: null,
      ...envelopeStub({ topic: "signals.kraken.BTC-USD.rsi" }),
    });
    await waitFor(
      () => onFrame.mock.calls.some((c) => (c[0] as { type: string }).type === "signal"),
      { message: "signal frame to reach the websocket consumer" },
    );
    server.closeConnection(0, 1000, "test done");
    await client.close();
    await runPromise;
  });

  it("forwards an AI-research request to the JSONL consumer", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const client = createWsClient(
      makeOptions(server, { onFrame, topics: ["ai_research."] }),
    );
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    const roundPublicId = "0192f000-0000-7000-8000-dddddddddddd";
    server.emit(0, {
      type: "ai_research.request",
      round_public_id: roundPublicId,
      trigger: "periodic",
      ...envelopeStub({ topic: `ai_research.${roundPublicId}.request` }),
    });

    await waitFor(
      () =>
        onFrame.mock.calls.some(
          (call) => (call[0] as { type: string }).type === "ai_research.request",
        ),
      { message: "AI-research request to reach the websocket consumer" },
    );
    expect(onFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ai_research.request",
        round_public_id: roundPublicId,
        trigger: "periodic",
      }),
    );
    server.closeConnection(0, 1000, "test done");
    await client.close();
    await runPromise;
  });

  it("opens with Authorization: Bearer access on the upgrade request", async () => {
    const server = await startServer([happyPathScript()]);
    const store = new TokenStore({ access: "access-bearer", refresh: "refresh-1" });
    const client = createWsClient(makeOptions(server, { tokenStore: store }));
    const runPromise = client.run();
    await server.awaitConnection(0);
    expect(server.upgradeHeaders[0]?.authorization).toBe("Bearer access-bearer");
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });

  it("does not propagate exceptions from onFrame on signal/order_event delivery", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>().mockImplementation((frame) => {
      if (frame.type === "signal") {
        throw new Error("downstream EPIPE");
      }
    });
    const client = createWsClient(makeOptions(server, { onFrame }));
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    server.emit(0, {
      type: "signal",
      instrument: "BTC-USD",
      exchange: "kraken",
      side: "buy",
      strength: 0.5,
      reason: "test",
      price: 100,
      strategy_name: null,
      fired_at: "2026-04-28T12:00:00.000Z",
      wallet_public_id: "0192f000-0000-7000-8000-bbbbbbbbbbbb",
      operator_public_id: null,
      user_public_id: null,
      ...envelopeStub({ topic: "signals.kraken.BTC-USD.rsi" }),
    });
    server.emit(0, {
      type: "order_event",
      exchange_order_id: "ex-1",
      client_order_id: "cli-1",
      exchange: "paper",
      instrument: "BTC-USD",
      event: "submitted",
      reason: null,
      wallet_public_id: "0192f000-0000-7000-8000-cccccccccccc",
      operator_public_id: null,
      user_public_id: null,
      ...envelopeStub({ topic: "orders.events.paper.BTC-USD" }),
    });
    await waitFor(
      () => onFrame.mock.calls.some((c) => (c[0] as { type: string }).type === "order_event"),
      { message: "order-event frame to reach the websocket consumer" },
    );
    expect(onFrame).toHaveBeenCalledTimes(2);
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });

  it("forwards data frames (signal, order_event) but NOT control frames (pong, error, subscription_success) to onFrame", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const client = createWsClient(makeOptions(server, { onFrame }));
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    server.emit(0, { type: "pong", active_connections: 3, ...envelopeStub() });
    server.emit(0, { type: "error", message: "boom", ...envelopeStub() });
    server.emit(0, {
      type: "order_event",
      exchange_order_id: "ex-1",
      client_order_id: "cli-1",
      exchange: "paper",
      instrument: "BTC-USD",
      event: "submitted",
      reason: null,
      wallet_public_id: "0192f000-0000-7000-8000-cccccccccccc",
      operator_public_id: null,
      user_public_id: null,
      ...envelopeStub({ topic: "orders.events.paper.BTC-USD" }),
    });
    await waitFor(
      () => onFrame.mock.calls.some((c) => (c[0] as { type: string }).type === "order_event"),
      { message: "order-event frame to reach the websocket consumer" },
    );
    const types = onFrame.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain("order_event");
    expect(types).not.toContain("subscription_success");
    expect(types).not.toContain("pong");
    expect(types).not.toContain("error");
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });
});

describeWithTcp("ws_client — heartbeat", () => {
  it("emits ping frames at the configured cadence", async () => {
    const server = await startServer([happyPathScript()]);
    const client = createWsClient(makeOptions(server, { heartbeatIntervalMs: 30 }));
    const runPromise = client.run();
    await waitFor(
      () => server.received.filter((r) => r.parsed.type === "ping").length >= 2,
      { timeoutMs: 2_000, message: "two heartbeat pings to reach the websocket server" },
    );
    expect(server.received.filter((r) => r.parsed.type === "ping").length).toBeGreaterThanOrEqual(2);
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });
});

describeWithTcp("ws_client — failure paths during handshake", () => {
  it("rejects via session error when server fails to send auth_required in time", async () => {
    const server = await startServer([{}]);
    const client = createWsClient(
      makeOptions(server, {
        authHandshakeTimeoutMs: 30,
        reconnectBackoffBaseMs: 1,
        reconnectBackoffMaxMs: 5,
      }),
    );
    const runPromise = client.run();
    await waitFor(() => server.connections.length >= 2, {
      timeoutMs: 2_000,
      message: "client to reconnect after the auth_required timeout",
    });
    expect(server.connections.length).toBeGreaterThanOrEqual(2);
    await client.close();
    await runPromise;
  });

  it("treats auth_failed as a session error and reconnects", async () => {
    const failScript: ConnectionScript = {
      onConnect: (socket) => {
        socket.send(
          JSON.stringify({ type: "auth_required", timeout: 10, ...envelopeStub() }),
        );
      },
      handlers: {
        authenticate: ({ socket }) => {
          socket.send(
            JSON.stringify({ type: "auth_failed", reason: "invalid_token", ...envelopeStub() }),
          );
        },
      },
    };
    const server = await startServer([failScript, happyPathScript()]);
    const client = createWsClient(
      makeOptions(server, { reconnectBackoffBaseMs: 1, reconnectBackoffMaxMs: 5 }),
    );
    const runPromise = client.run();
    await server.awaitConnection(1, 3_000);
    expect(server.connections.length).toBeGreaterThanOrEqual(2);
    server.closeConnection(1);
    await client.close();
    await runPromise;
  });

  it("reconnects with zero backoff and handles auth_failed without a reason", async () => {
    const failScript: ConnectionScript = {
      onConnect: (socket) => {
        socket.send(
          JSON.stringify({ type: "auth_required", timeout: 10, ...envelopeStub() }),
        );
      },
      handlers: {
        authenticate: ({ socket }) => {
          socket.send(JSON.stringify({ type: "auth_failed", ...envelopeStub() }));
        },
      },
    };
    const server = await startServer([failScript, happyPathScript()]);
    const client = createWsClient(
      makeOptions(server, {
        reconnectBackoffBaseMs: 0,
        reconnectBackoffMaxMs: 0,
      }),
    );
    const runPromise = client.run();
    await server.awaitConnection(1, 3_000);
    expect(server.connections.length).toBeGreaterThanOrEqual(2);
    server.closeConnection(1);
    await client.close();
    await runPromise;
  });

  it("treats subscription_success with status=denied as a session error and reconnects", async () => {
    const deniedScript: ConnectionScript = {
      onConnect: (socket) => {
        const { authRequired, authOk, authComplete } = authPair();
        socket.send(JSON.stringify(authRequired));
        socket.once("message", () => {
          socket.send(JSON.stringify(authOk));
          socket.send(JSON.stringify(authComplete));
        });
      },
      handlers: {
        subscribe: ({ socket }) => {
          socket.send(
            JSON.stringify({
              type: "subscription_success",
              action: "subscribe",
              status: "denied",
              topics: [],
              denied_topics: ["signals."],
              active_subscriptions: [],
              message: "wallet scope rejects topic",
              ...envelopeStub(),
            }),
          );
        },
      },
    };
    const server = await startServer([deniedScript, happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const client = createWsClient(
      makeOptions(server, {
        onFrame,
        reconnectBackoffBaseMs: 1,
        reconnectBackoffMaxMs: 5,
      }),
    );
    const runPromise = client.run();
    await server.awaitConnection(1, 3_000);
    expect(
      onFrame.mock.calls
        .map((c) => (c[0] as { type: string }).type)
        .filter((t) => t === "subscription_success"),
    ).toHaveLength(0);
    server.closeConnection(1);
    await client.close();
    await runPromise;
  });

  it("times out waiting for subscription_success and reconnects", async () => {
    const stuckScript: ConnectionScript = {
      onConnect: (socket) => {
        const { authRequired, authOk, authComplete } = authPair();
        socket.send(JSON.stringify(authRequired));
        socket.once("message", () => {
          socket.send(JSON.stringify(authOk));
          socket.send(JSON.stringify(authComplete));
        });
      },
    };
    const server = await startServer([stuckScript, happyPathScript()]);
    const client = createWsClient(
      makeOptions(server, {
        subscribeTimeoutMs: 30,
        reconnectBackoffBaseMs: 1,
        reconnectBackoffMaxMs: 5,
      }),
    );
    const runPromise = client.run();
    await server.awaitConnection(1, 3_000);
    expect(server.connections.length).toBeGreaterThanOrEqual(2);
    server.closeConnection(1);
    await client.close();
    await runPromise;
  });
});

describeWithTcp("ws_client — reauth flow", () => {
  it("ignores unsolicited reauth_ok frames when no reauth is pending", async () => {
    const script: ConnectionScript = {
      onConnect: (socket) => {
        const { authRequired, authOk, authComplete } = authPair();
        socket.send(JSON.stringify(authRequired));
        socket.once("message", () => {
          socket.send(JSON.stringify(authOk));
          socket.send(JSON.stringify(authComplete));
        });
      },
      handlers: {
        subscribe: ({ socket }) => {
          socket.send(JSON.stringify(subscriptionSuccess()));
          socket.send(
            JSON.stringify({
              type: "reauth_ok",
              exp: "2026-04-28T14:00:00.000Z",
              ...envelopeStub(),
            }),
          );
        },
      },
    };
    const server = await startServer([script]);
    const client = createWsClient(makeOptions(server));
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    server.closeConnection(0);
    await client.close();
    await runPromise;
    expect(server.received.some((r) => r.parsed.type === "reauth")).toBe(false);
  });

  it("on reauth_required, mints a fresh ws_token and sends a reauth frame", async () => {
    const reauthScript: ConnectionScript = {
      onConnect: (socket) => {
        const { authRequired, authOk, authComplete } = authPair();
        socket.send(JSON.stringify(authRequired));
        socket.once("message", () => {
          socket.send(JSON.stringify(authOk));
          socket.send(JSON.stringify(authComplete));
        });
      },
      handlers: {
        subscribe: ({ socket }) => {
          socket.send(JSON.stringify(subscriptionSuccess()));
          socket.send(
            JSON.stringify({
              type: "reauth_required",
              deadline: "2026-04-28T13:00:00.000Z",
              ...envelopeStub(),
            }),
          );
        },
        reauth: ({ socket }) => {
          socket.send(
            JSON.stringify({
              type: "reauth_ok",
              exp: "2026-04-28T14:00:00.000Z",
              ...envelopeStub(),
            }),
          );
        },
      },
    };
    const server = await startServer([reauthScript]);
    const fetchWsToken = vi
      .fn()
      .mockResolvedValueOnce({ ws_token: "ws-tok-1", ws_token_exp: "2026-04-28T13:00:00Z" })
      .mockResolvedValueOnce({ ws_token: "ws-tok-2", ws_token_exp: "2026-04-28T14:00:00Z" });
    const client = createWsClient(makeOptions(server, { fetchWsToken }));
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "reauth"), {
      message: "reauth frame to reach the websocket server",
    });
    expect(fetchWsToken).toHaveBeenCalledTimes(2);
    const reauthFrame = server.received.find((r) => r.parsed.type === "reauth");
    expect(reauthFrame?.parsed.ws_token).toBe("ws-tok-2");
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });

  it("on reauth fetch failure, closes the socket so the outer loop reconnects", async () => {
    const reauthScript: ConnectionScript = {
      onConnect: (socket) => {
        const { authRequired, authOk, authComplete } = authPair();
        socket.send(JSON.stringify(authRequired));
        socket.once("message", () => {
          socket.send(JSON.stringify(authOk));
          socket.send(JSON.stringify(authComplete));
        });
      },
      handlers: {
        subscribe: ({ socket }) => {
          socket.send(JSON.stringify(subscriptionSuccess()));
          socket.send(
            JSON.stringify({
              type: "reauth_required",
              deadline: "2026-04-28T13:00:00.000Z",
              ...envelopeStub(),
            }),
          );
        },
      },
    };
    const server = await startServer([reauthScript, happyPathScript()]);
    const fetchWsToken = vi
      .fn()
      .mockResolvedValueOnce({ ws_token: "ws-tok-1", ws_token_exp: "2026-04-28T13:00:00Z" })
      .mockRejectedValueOnce(new Error("refresh blew up"))
      .mockResolvedValueOnce({ ws_token: "ws-tok-3", ws_token_exp: "2026-04-28T15:00:00Z" });
    const client = createWsClient(
      makeOptions(server, {
        fetchWsToken,
        reconnectBackoffBaseMs: 1,
        reconnectBackoffMaxMs: 5,
      }),
    );
    const runPromise = client.run();
    await server.awaitConnection(1, 3_000);
    expect(server.connections.length).toBeGreaterThanOrEqual(2);
    server.closeConnection(1);
    await client.close();
    await runPromise;
  });

  it("does not send reauth when the socket closes before a fresh token arrives", async () => {
    let resolveFresh: (value: { ws_token: string; ws_token_exp: string }) => void = () => undefined;
    let freshTokenPromise!: Promise<{ ws_token: string; ws_token_exp: string }>;
    let closedSessionHandledLateToken = false;
    let freshResolved = false;
    const reauthScript: ConnectionScript = {
      onConnect: (socket) => {
        const { authRequired, authOk, authComplete } = authPair();
        socket.send(JSON.stringify(authRequired));
        socket.once("message", () => {
          socket.send(JSON.stringify(authOk));
          socket.send(JSON.stringify(authComplete));
        });
      },
      handlers: {
        subscribe: ({ socket }) => {
          socket.send(JSON.stringify(subscriptionSuccess()));
          socket.send(
            JSON.stringify({
              type: "reauth_required",
              deadline: "2026-04-28T13:00:00.000Z",
              ...envelopeStub(),
            }),
          );
        },
      },
    };
    const server = await startServer([reauthScript, happyPathScript()]);
    const fetchWsToken = vi
      .fn()
      .mockResolvedValueOnce({ ws_token: "ws-tok-1", ws_token_exp: "2026-04-28T13:00:00Z" })
      .mockImplementationOnce(() => {
        freshTokenPromise = new Promise<{ ws_token: string; ws_token_exp: string }>((resolve) => {
          resolveFresh = resolve;
        });
        return freshTokenPromise;
      })
      .mockResolvedValueOnce({ ws_token: "ws-tok-3", ws_token_exp: "2026-04-28T15:00:00Z" });
    const sendSpy = vi.spyOn(WebSocket.prototype, "send");
    const client = createWsClient(
      makeOptions(server, {
        fetchWsToken,
        reconnectBackoffBaseMs: 1,
        reconnectBackoffMaxMs: 5,
      }),
    );
    const runPromise = client.run();
    try {
      await waitFor(() => fetchWsToken.mock.calls.length >= 2, {
        message: "reauth flow to request a fresh websocket token",
      });
      // The client's await reaction was registered first, so this observer
      // runs only after the closed-session check consumes the late token.
      void freshTokenPromise.then(() => {
        closedSessionHandledLateToken = true;
      });
      server.closeConnection(0, 1000, "closed during reauth");
      await server.awaitConnection(1, 3_000);
      freshResolved = true;
      resolveFresh({ ws_token: "late", ws_token_exp: "2026-04-28T14:00:00Z" });
      await waitFor(
        () =>
          closedSessionHandledLateToken &&
          !sendSpy.mock.calls.some(
            (c) => typeof c[0] === "string" && c[0].includes('"type":"reauth"'),
          ),
        { message: "closed session to handle the late token without sending reauth" },
      );
      expect(server.received.some((r) => r.parsed.type === "reauth")).toBe(false);
    } finally {
      try {
        if (!freshResolved) {
          resolveFresh({ ws_token: "late", ws_token_exp: "2026-04-28T14:00:00Z" });
        }
        if (server.connections[1] !== undefined) {
          server.closeConnection(1);
        }
        await client.close();
        await runPromise;
      } finally {
        sendSpy.mockRestore();
      }
    }
  });

  it("times out waiting for reauth_ok and closes the socket", async () => {
    const stuckReauthScript: ConnectionScript = {
      onConnect: (socket) => {
        const { authRequired, authOk, authComplete } = authPair();
        socket.send(JSON.stringify(authRequired));
        socket.once("message", () => {
          socket.send(JSON.stringify(authOk));
          socket.send(JSON.stringify(authComplete));
        });
      },
      handlers: {
        subscribe: ({ socket }) => {
          socket.send(JSON.stringify(subscriptionSuccess()));
          socket.send(
            JSON.stringify({
              type: "reauth_required",
              deadline: "2026-04-28T13:00:00.000Z",
              ...envelopeStub(),
            }),
          );
        },
      },
    };
    const server = await startServer([stuckReauthScript, happyPathScript()]);
    const client = createWsClient(
      makeOptions(server, {
        authHandshakeTimeoutMs: 30,
        reconnectBackoffBaseMs: 1,
        reconnectBackoffMaxMs: 5,
      }),
    );
    const runPromise = client.run();
    await server.awaitConnection(1, 3_000);
    expect(server.connections.length).toBeGreaterThanOrEqual(2);
    server.closeConnection(1);
    await client.close();
    await runPromise;
  });
});

describeWithTcp("ws_client — auth_expired triggers reconnect", () => {
  it("on auth_expired, closes the socket and re-authenticates the next session", async () => {
    const expiredScript: ConnectionScript = {
      onConnect: (socket) => {
        const { authRequired, authOk, authComplete } = authPair();
        socket.send(JSON.stringify(authRequired));
        socket.once("message", () => {
          socket.send(JSON.stringify(authOk));
          socket.send(JSON.stringify(authComplete));
        });
      },
      handlers: {
        subscribe: ({ socket }) => {
          socket.send(JSON.stringify(subscriptionSuccess()));
          socket.send(JSON.stringify({ type: "auth_expired", ...envelopeStub() }));
        },
      },
    };
    const server = await startServer([expiredScript, happyPathScript()]);
    const client = createWsClient(
      makeOptions(server, { reconnectBackoffBaseMs: 1, reconnectBackoffMaxMs: 5 }),
    );
    const runPromise = client.run();
    await server.awaitConnection(1, 3_000);
    expect(server.connections.length).toBeGreaterThanOrEqual(2);
    server.closeConnection(1);
    await client.close();
    await runPromise;
  });
});

describeWithTcp("ws_client — AI-review dedup + size guards", () => {
  function reviewFrame(version: number, deadlineIso: string): Record<string, unknown> {
    return {
      type: "ai_review.request",
      review_public_id: "0192f000-0000-7000-8000-dddddddddddd",
      user_public_id: "0192f000-0000-7000-8000-eeeeeeeeeeee",
      strategy_public_id: "0192f000-0000-7000-8000-ffffffffffff",
      wallet_public_id: "0192f000-0000-7000-8000-aaaaaaaaaaaa",
      instrument_public_id: "0192f000-0000-7000-8000-bbbbbbbbbbbb",
      selected_delegate_public_id: "0192f000-0000-7000-8000-cccccccccccc",
      deadline: deadlineIso,
      signal_envelope: { foo: "bar" },
      instrument_metadata: {},
      dispatch_version: version,
      ...envelopeStub({ topic: "ai_reviews.requests" }),
    };
  }

  it("drops a duplicate AI-review by dispatch_version", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const debug = vi.fn();
    const client = createWsClient(
      makeOptions(server, { onFrame, logger: { ...SILENT_LOGGER, debug } }),
    );
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    server.emit(0, reviewFrame(1, "2026-04-28T13:00:00.000Z"));
    server.emit(0, reviewFrame(1, "2026-04-28T13:00:00.000Z"));
    await waitFor(
      () =>
        onFrame.mock.calls.some(
          (c) => (c[0] as { type: string }).type === "ai_review.request",
        ),
      { message: "AI-review request to reach the websocket consumer" },
    );
    await waitFor(
      () =>
        debug.mock.calls.some(
          (c) => typeof c[0] === "string" && c[0].includes("drop AI-review replay"),
        ),
      { message: "duplicate AI-review frame to be dropped" },
    );
    const reviewDeliveries = onFrame.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "ai_review.request",
    );
    expect(reviewDeliveries).toHaveLength(1);
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });

  it("forwards a higher dispatch_version after a lower one was seen", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const client = createWsClient(makeOptions(server, { onFrame }));
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    server.emit(0, reviewFrame(1, "2026-04-28T13:00:00.000Z"));
    server.emit(0, reviewFrame(2, "2026-04-28T13:00:00.000Z"));
    await waitFor(
      () =>
        onFrame.mock.calls.filter((c) => (c[0] as { type: string }).type === "ai_review.request")
          .length === 2,
      { message: "both AI-review dispatch versions to reach the websocket consumer" },
    );
    expect(
      onFrame.mock.calls.filter((c) => (c[0] as { type: string }).type === "ai_review.request"),
    ).toHaveLength(2);
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });

  it("does NOT cache an AI-review when onFrame throws (next replay is forwarded again)", async () => {
    const server = await startServer([happyPathScript()]);
    const calls: ServerFrame[] = [];
    let throwCount = 0;
    const onFrame = (frame: ServerFrame): void => {
      calls.push(frame);
      if (frame.type === "ai_review.request" && throwCount === 0) {
        throwCount += 1;
        throw new Error("downstream closed");
      }
    };
    const client = createWsClient(makeOptions(server, { onFrame }));
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    server.emit(0, reviewFrame(1, "2026-04-28T13:00:00.000Z"));
    server.emit(0, reviewFrame(1, "2026-04-28T13:00:00.000Z"));
    await waitFor(
      () => calls.filter((c) => c.type === "ai_review.request").length >= 2,
      { message: "replayed AI-review request to reach the throwing consumer" },
    );
    expect(calls.filter((c) => c.type === "ai_review.request").length).toBeGreaterThanOrEqual(2);
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });

  it("drops an AI-review when signal_envelope exceeds the size budget", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const warn = vi.fn();
    const client = createWsClient(
      makeOptions(server, {
        onFrame,
        maxSignalEnvelopeBytes: 32,
        logger: { ...SILENT_LOGGER, warn },
      }),
    );
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    const big = { ...reviewFrame(1, "2026-04-28T13:00:00.000Z") };
    big.signal_envelope = { huge: "x".repeat(200) };
    server.emit(0, big);
    await waitFor(
      () =>
        warn.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            c[0].includes("dropping ai_review.request") &&
            c[0].includes("signal_envelope"),
        ),
      { message: "oversized AI-review signal envelope to be dropped" },
    );
    const aiCalls = onFrame.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "ai_review.request",
    );
    expect(aiCalls).toHaveLength(0);
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });

  it("drops oversized raw frames before parse", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const warn = vi.fn();
    const client = createWsClient(
      makeOptions(server, {
        onFrame,
        maxRawFrameBytes: 1024,
        logger: { ...SILENT_LOGGER, warn },
      }),
    );
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    server.emitText(
      0,
      JSON.stringify({ type: "signal", filler: "x".repeat(4096) }),
    );
    await waitFor(
      () =>
        warn.mock.calls.some(
          (c) => typeof c[0] === "string" && c[0].includes("dropping over-sized frame"),
        ),
      { message: "oversized raw websocket frame to be dropped" },
    );
    const sigs = onFrame.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "signal",
    );
    expect(sigs).toHaveLength(0);
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });

  it("drops unparseable JSON, frames without a string type, and unknown types", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const debug = vi.fn();
    const client = createWsClient(
      makeOptions(server, { onFrame, logger: { ...SILENT_LOGGER, debug } }),
    );
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    server.emitText(0, "{not valid json");
    server.emitText(0, JSON.stringify({ no_type: true }));
    server.emitText(0, JSON.stringify({ type: "totally_unknown_v999" }));
    await waitFor(
      () =>
        debug.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            c[0].includes('dropping unknown frame.type="totally_unknown_v999"'),
        ),
      { message: "unknown websocket frame to be dropped" },
    );
    expect(onFrame.mock.calls.map((c) => (c[0] as { type: string }).type)).not.toContain(
      "totally_unknown_v999",
    );
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });

  it("evicts oldest entry when dedup cache reaches its cap", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const client = createWsClient(makeOptions(server, { onFrame, dedupCacheCap: 2 }));
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    function emitWith(reviewId: string, version: number): void {
      const f = reviewFrame(version, "2026-04-28T13:00:00.000Z");
      f.review_public_id = reviewId;
      server.emit(0, f);
    }
    emitWith("review-a", 1);
    emitWith("review-b", 1);
    emitWith("review-c", 1);
    emitWith("review-a", 1);
    await waitFor(
      () =>
        onFrame.mock.calls.filter(
          (c) => (c[0] as { type: string }).type === "ai_review.request",
        ).length >= 4,
      { message: "four AI-review requests to reach the websocket consumer" },
    );
    expect(
      onFrame.mock.calls.filter((c) => (c[0] as { type: string }).type === "ai_review.request").length,
    ).toBeGreaterThanOrEqual(4);
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });

  it("falls back to a default TTL when ai_review.request deadline is unparseable", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const client = createWsClient(makeOptions(server, { onFrame }));
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    const bad = reviewFrame(1, "not-a-date");
    server.emit(0, bad);
    await waitFor(
      () => onFrame.mock.calls.some((c) => (c[0] as { type: string }).type === "ai_review.request"),
      { message: "AI-review request with an invalid deadline to reach the consumer" },
    );
    expect(
      onFrame.mock.calls.some((c) => (c[0] as { type: string }).type === "ai_review.request"),
    ).toBe(true);
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });

  it("treats a missing ai_review.request signal_envelope as an empty envelope", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const client = createWsClient(makeOptions(server, { onFrame, maxSignalEnvelopeBytes: 4 }));
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    const frame = reviewFrame(1, "2026-04-28T13:00:00.000Z");
    delete frame.signal_envelope;
    server.emit(0, frame);
    await waitFor(
      () => onFrame.mock.calls.some((c) => (c[0] as { type: string }).type === "ai_review.request"),
      { message: "AI-review request without a signal envelope to reach the consumer" },
    );
    expect(onFrame).toHaveBeenCalled();
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });

  it("dedups ai_review.decision_ack and ai_review.caps_violation by dispatch_version", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const debug = vi.fn();
    const client = createWsClient(
      makeOptions(server, { onFrame, logger: { ...SILENT_LOGGER, debug } }),
    );
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    const ack = {
      type: "ai_review.decision_ack",
      review_public_id: "0192f000-0000-7000-8000-dddddddddddd",
      user_public_id: "0192f000-0000-7000-8000-eeeeeeeeeeee",
      strategy_public_id: "0192f000-0000-7000-8000-ffffffffffff",
      wallet_public_id: "0192f000-0000-7000-8000-aaaaaaaaaaaa",
      instrument_public_id: "0192f000-0000-7000-8000-bbbbbbbbbbbb",
      responding_delegate_public_id: "0192f000-0000-7000-8000-cccccccccccc",
      decision: "approve",
      new_status: "approved",
      resolution_mode: "delegate",
      rationale: null,
      dispatch_version: 7,
      ...envelopeStub({ topic: "ai_reviews.decisions" }),
    };
    const cap = {
      type: "ai_review.caps_violation",
      review_public_id: "0192f000-0000-7000-8000-dddddddddddd",
      user_public_id: "0192f000-0000-7000-8000-eeeeeeeeeeee",
      strategy_public_id: "0192f000-0000-7000-8000-ffffffffffff",
      wallet_public_id: "0192f000-0000-7000-8000-aaaaaaaaaaaa",
      instrument_public_id: "0192f000-0000-7000-8000-bbbbbbbbbbbb",
      cap_type: "daily-orders",
      attempted: 11,
      limit: 10,
      dispatch_version: 3,
      ...envelopeStub({ topic: "ai_reviews.caps" }),
    };
    server.emit(0, ack);
    server.emit(0, ack);
    server.emit(0, cap);
    server.emit(0, cap);
    await waitFor(
      () =>
        onFrame.mock.calls.some(
          (c) => (c[0] as { type: string }).type === "ai_review.decision_ack",
        ) &&
        onFrame.mock.calls.some(
          (c) => (c[0] as { type: string }).type === "ai_review.caps_violation",
        ),
      { message: "both AI-review acknowledgement types to reach the consumer" },
    );
    await waitFor(
      () =>
        debug.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            c[0].includes("key=ai_review.decision_ack:"),
        ) &&
        debug.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            c[0].includes("key=ai_review.caps_violation:"),
        ),
      { message: "duplicate AI-review acknowledgements to be dropped" },
    );
    const ackCalls = onFrame.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "ai_review.decision_ack",
    );
    const capCalls = onFrame.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "ai_review.caps_violation",
    );
    expect(ackCalls).toHaveLength(1);
    expect(capCalls).toHaveLength(1);
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });
});

describeWithTcp("ws_client — periodic dedup pruning", () => {
  it("re-delivers an expired AI-review after the prune timer evicts it", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const client = createWsClient(
      makeOptions(server, {
        onFrame,
        dedupPruneIntervalMs: 30,
      }),
    );
    const runPromise = client.run();
    try {
      await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
        message: "client subscription request to reach the websocket server",
      });
      const past = new Date(Date.now() - 10_000).toISOString();
      const stale = {
        type: "ai_review.request",
        review_public_id: "0192f000-0000-7000-8000-dddddddddddd",
        user_public_id: "0192f000-0000-7000-8000-eeeeeeeeeeee",
        strategy_public_id: "0192f000-0000-7000-8000-ffffffffffff",
        wallet_public_id: "0192f000-0000-7000-8000-aaaaaaaaaaaa",
        instrument_public_id: "0192f000-0000-7000-8000-bbbbbbbbbbbb",
        selected_delegate_public_id: "0192f000-0000-7000-8000-cccccccccccc",
        deadline: past,
        signal_envelope: {},
        instrument_metadata: {},
        dispatch_version: 1,
        ...envelopeStub({ topic: "ai_reviews.requests" }),
      };
      server.emit(0, stale);
      await waitFor(
        () =>
          onFrame.mock.calls.filter(
            (c) => (c[0] as { type: string }).type === "ai_review.request",
          ).length === 1,
        { message: "expired AI-review request to reach the consumer initially" },
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 80);
        if (typeof timer.unref === "function") timer.unref();
      });
      server.emit(0, stale);
      await waitFor(
        () =>
          onFrame.mock.calls.filter(
            (c) => (c[0] as { type: string }).type === "ai_review.request",
          ).length === 2,
        {
          timeoutMs: 2_000,
          message: "expired AI-review request to be redelivered after pruning",
        },
      );
      expect(
        onFrame.mock.calls.filter((c) => (c[0] as { type: string }).type === "ai_review.request"),
      ).toHaveLength(2);
    } finally {
      server.closeConnection(0);
      await client.close();
      await runPromise;
    }
  });

  it("keeps a future-deadline AI-review through a prune pass", async () => {
    const server = await startServer([happyPathScript()]);
    const onFrame = vi.fn<(frame: ServerFrame) => void>();
    const debug = vi.fn();
    const client = createWsClient(
      makeOptions(server, {
        onFrame,
        dedupPruneIntervalMs: 30,
        logger: { ...SILENT_LOGGER, debug },
      }),
    );
    const runPromise = client.run();
    try {
      await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
        message: "client subscription request to reach the websocket server",
      });
      const future = new Date(Date.now() + 60_000).toISOString();
      const frame = {
        type: "ai_review.request",
        review_public_id: "0192f000-0000-7000-8000-dddddddddddd",
        user_public_id: "0192f000-0000-7000-8000-eeeeeeeeeeee",
        strategy_public_id: "0192f000-0000-7000-8000-ffffffffffff",
        wallet_public_id: "0192f000-0000-7000-8000-aaaaaaaaaaaa",
        instrument_public_id: "0192f000-0000-7000-8000-bbbbbbbbbbbb",
        selected_delegate_public_id: "0192f000-0000-7000-8000-cccccccccccc",
        deadline: future,
        signal_envelope: {},
        instrument_metadata: {},
        dispatch_version: 1,
        ...envelopeStub({ topic: "ai_reviews.requests" }),
      };
      server.emit(0, frame);
      await waitFor(
        () =>
          onFrame.mock.calls.filter(
            (c) => (c[0] as { type: string }).type === "ai_review.request",
          ).length === 1,
        { message: "future AI-review request to reach the consumer initially" },
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 80);
        if (typeof timer.unref === "function") timer.unref();
      });
      server.emit(0, frame);
      await waitFor(
        () =>
          debug.mock.calls.some(
            (c) =>
              typeof c[0] === "string" &&
              c[0].includes("key=ai_review.request:"),
          ),
        { message: "future-deadline AI-review replay to be dropped" },
      );
      expect(
        onFrame.mock.calls.filter((c) => (c[0] as { type: string }).type === "ai_review.request"),
      ).toHaveLength(1);
    } finally {
      server.closeConnection(0);
      await client.close();
      await runPromise;
    }
  });
});

describeWithTcp("ws_client — close()", () => {
  it("close() before run() resolves immediately and run() returns", async () => {
    const server = await startServer([]);
    const client = createWsClient(makeOptions(server));
    await client.close();
    await client.close();
    expect(server.connections).toHaveLength(0);
  });

  it("run() is idempotent while the client is active", async () => {
    const server = await startServer([happyPathScript()]);
    const client = createWsClient(makeOptions(server));
    const firstRun = client.run();
    const secondRun = client.run();
    expect(secondRun).toBe(firstRun);
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    await client.close();
    await firstRun;
  });

  it("close() during ws_token mint stops before opening a socket", async () => {
    const server = await startServer([]);
    let resolveToken!: (value: { ws_token: string; ws_token_exp: string }) => void;
    const fetchWsToken = vi.fn(
      () =>
        new Promise<{ ws_token: string; ws_token_exp: string }>((resolve) => {
          resolveToken = resolve;
        }),
    );
    const socketFactory = vi.fn();
    const client = createWsClient(
      makeOptions(server, {
        fetchWsToken,
        socketFactory: socketFactory as unknown as WsClientOptions["socketFactory"],
      }),
    );
    const runPromise = client.run();
    await waitFor(() => fetchWsToken.mock.calls.length === 1, {
      message: "initial websocket token request to start",
    });
    const closePromise = client.close();
    resolveToken({ ws_token: "late", ws_token_exp: "2026-04-28T13:00:00.000Z" });
    await closePromise;
    await runPromise;
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("a second concurrent close() awaits the same teardown rather than returning early", async () => {
    const server = await startServer([happyPathScript()]);
    const client = createWsClient(makeOptions(server));
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    const firstClose = client.close();
    const secondClose = client.close();
    let firstDoneAt: number | null = null;
    let secondDoneAt: number | null = null;
    void firstClose.then(() => {
      firstDoneAt = Date.now();
    });
    void secondClose.then(() => {
      secondDoneAt = Date.now();
    });
    await Promise.all([firstClose, secondClose]);
    await runPromise;
    expect(firstDoneAt).not.toBeNull();
    expect(secondDoneAt).not.toBeNull();
    expect(Math.abs((secondDoneAt as unknown as number) - (firstDoneAt as unknown as number))).toBeLessThan(50);
  });

  it("close() during reconnect backoff cancels the sleep instead of waiting it out", async () => {
    const failScript: ConnectionScript = {
      onConnect: (socket) => {
        socket.send(
          JSON.stringify({ type: "auth_required", timeout: 10, ...envelopeStub() }),
        );
      },
      handlers: {
        authenticate: ({ socket }) => {
          socket.send(
            JSON.stringify({ type: "auth_failed", reason: "force-reconnect", ...envelopeStub() }),
          );
        },
      },
    };
    const server = await startServer([failScript]);
    const info = vi.fn();
    const client = createWsClient(
      makeOptions(server, {
        reconnectBackoffBaseMs: 5_000,
        reconnectBackoffMaxMs: 5_000,
        reconnectJitterFraction: 0,
        logger: { ...SILENT_LOGGER, info },
      }),
    );
    const runPromise = client.run();
    await server.awaitConnection(0, 3_000);
    server.closeConnection(0);
    await waitFor(
      () =>
        info.mock.calls.some(
          (c) => c[0] === "watch: reconnecting in 5000ms (attempt 1)",
        ),
      { message: "client to enter the 5000ms reconnect backoff" },
    );
    const beforeClose = Date.now();
    await client.close();
    await runPromise;
    const elapsed = Date.now() - beforeClose;
    expect(elapsed).toBeLessThan(2_000);
  });

  it("close() during streaming drains the runner", async () => {
    const server = await startServer([happyPathScript()]);
    const client = createWsClient(makeOptions(server));
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    expect(server.connections).toHaveLength(1);
    await client.close();
    await client.close();
    await runPromise;
  });
});

describeWithTcp("ws_client — runs with all defaults applied", () => {
  it("connects successfully when no optional overrides are provided", async () => {
    const server = await startServer([happyPathScript()]);
    const client = createWsClient({
      wsUrl: server.url,
      tokenStore: new TokenStore({ access: "a", refresh: "r" }),
      fetchWsToken: vi.fn().mockResolvedValue({
        ws_token: "tok",
        ws_token_exp: "2026-04-28T13:00:00.000Z",
      }),
      topics: ["signals."],
      minter: new EnvelopeMinter(),
      onFrame: vi.fn(),
      logger: SILENT_LOGGER,
    });
    const runPromise = client.run();
    await waitFor(() => server.received.some((r) => r.parsed.type === "subscribe"), {
      message: "client subscription request to reach the websocket server",
    });
    expect(server.received.some((r) => r.parsed.type === "subscribe")).toBe(true);
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });
});

describeWithTcp("ws_client — runner failure propagation", () => {
  it("preserves Error instances from runner startup failures", async () => {
    const server = await startServer([]);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementationOnce(() => {
      throw new Error("timer object unavailable");
    });
    try {
      const client = createWsClient(makeOptions(server));
      await expect(client.run()).rejects.toThrow("timer object unavailable");
      await client.close();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("rejects run() when prune timer startup throws a non-Error value", async () => {
    const server = await startServer([]);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementationOnce(() => {
      throw ("timer unavailable" as unknown as Error);
    });
    try {
      const client = createWsClient(makeOptions(server));
      await expect(client.run()).rejects.toThrow("timer unavailable");
      await client.close();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});

describe("ws_client — toBuffer", () => {
  it("returns the buffer unchanged when input is already a Buffer", () => {
    const original = Buffer.from("hello");
    expect(toBuffer(original)).toBe(original);
  });

  it("concatenates an array of buffers", () => {
    const result = toBuffer([Buffer.from("hel"), Buffer.from("lo")]);
    expect(result.toString("utf8")).toBe("hello");
  });

  it("converts an ArrayBuffer to a Buffer", () => {
    const arr = new Uint8Array([0x68, 0x69]);
    const result = toBuffer(arr.buffer);
    expect(result.toString("utf8")).toBe("hi");
  });
});

describeWithTcp("ws_client — close-before-open via injected socket", () => {
  it("waitForOpen rejects when the socket emits close before open", async () => {
    const server = await startServer([]);
    const fakeFactory = (): WebSocket => {
      const emitter = new EventEmitter();
      const fake = emitter as unknown as WebSocket & {
        close: () => void;
        terminate: () => void;
        send: () => void;
      };
      fake.close = () => undefined;
      fake.terminate = () => undefined;
      fake.send = () => undefined;
      setImmediate(() => {
        emitter.emit("close", 1006, Buffer.from("preempt"));
      });
      return fake;
    };
    const factorySpy = vi.fn(fakeFactory);
    const warn = vi.fn();
    const client = createWsClient(
      makeOptions(server, {
        socketFactory: factorySpy as unknown as WsClientOptions["socketFactory"],
        logger: { ...SILENT_LOGGER, warn },
        reconnectBackoffBaseMs: 1,
        reconnectBackoffMaxMs: 5,
      }),
    );
    const runPromise = client.run();
    await waitFor(
      () =>
        warn.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            c[0].includes("websocket closed before open") &&
            c[0].includes("reason=preempt"),
        ),
      { message: "pre-open socket close to reject waitForOpen" },
    );
    expect(factorySpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    await client.close();
    await runPromise;
  });

  it("waitForOpen uses a no-reason fallback when close carries an empty reason", async () => {
    const server = await startServer([]);
    const fakeFactory = (): WebSocket => {
      const emitter = new EventEmitter();
      const fake = emitter as unknown as WebSocket & {
        close: () => void;
        terminate: () => void;
        send: () => void;
      };
      fake.close = () => undefined;
      fake.terminate = () => undefined;
      fake.send = () => undefined;
      setImmediate(() => {
        emitter.emit("close", 1006, Buffer.alloc(0));
      });
      return fake;
    };
    const factorySpy = vi.fn(fakeFactory);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const client = createWsClient(
      makeOptions(server, {
        socketFactory: factorySpy as unknown as WsClientOptions["socketFactory"],
        logger,
        reconnectBackoffBaseMs: 1,
        reconnectBackoffMaxMs: 5,
      }),
    );
    const runPromise = client.run();
    await waitFor(
      () =>
        logger.warn.mock.calls.some(
          (c) => typeof c[0] === "string" && c[0].includes("(no reason)"),
        ),
      {
        timeoutMs: 2_000,
        message: "pre-open socket close without a reason to be logged",
      },
    );
    await client.close();
    await runPromise;
    expect(
      logger.warn.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("(no reason)"),
      ),
    ).toBe(true);
  });
});

describeWithTcp("ws_client — formatError String fallback for non-Error reauth failure", () => {
  it("logs the stringified non-Error rejection from fetchWsToken during reauth", async () => {
    const reauthScript: ConnectionScript = {
      onConnect: (socket) => {
        const { authRequired, authOk, authComplete } = authPair();
        socket.send(JSON.stringify(authRequired));
        socket.once("message", () => {
          socket.send(JSON.stringify(authOk));
          socket.send(JSON.stringify(authComplete));
        });
      },
      handlers: {
        subscribe: ({ socket }) => {
          socket.send(JSON.stringify(subscriptionSuccess()));
          socket.send(
            JSON.stringify({
              type: "reauth_required",
              deadline: "2026-04-28T13:00:00.000Z",
              ...envelopeStub(),
            }),
          );
        },
      },
    };
    const server = await startServer([reauthScript, happyPathScript()]);
    const warnSpy = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    };
    const fetchWsToken = vi
      .fn()
      .mockResolvedValueOnce({ ws_token: "ws-tok-1", ws_token_exp: "2026-04-28T13:00:00Z" })
      .mockRejectedValueOnce("plain string rejection")
      .mockResolvedValueOnce({ ws_token: "ws-tok-2", ws_token_exp: "2026-04-28T15:00:00Z" });
    const client = createWsClient(
      makeOptions(server, {
        fetchWsToken,
        logger,
        reconnectBackoffBaseMs: 1,
        reconnectBackoffMaxMs: 5,
      }),
    );
    const runPromise = client.run();
    await server.awaitConnection(1, 3_000);
    expect(
      warnSpy.mock.calls.some((c) =>
        typeof c[0] === "string" && c[0].includes("plain string rejection"),
      ),
    ).toBe(true);
    server.closeConnection(1);
    await client.close();
    await runPromise;
  });
});

describeWithTcp("ws_client — counter envelope minting", () => {
  it("authenticate, subscribe, ping, and reauth carry monotonically increasing sequence_ids on the right counters", async () => {
    const reauthScript: ConnectionScript = {
      onConnect: (socket) => {
        const { authRequired, authOk, authComplete } = authPair();
        socket.send(JSON.stringify(authRequired));
        socket.once("message", () => {
          socket.send(JSON.stringify(authOk));
          socket.send(JSON.stringify(authComplete));
        });
      },
      handlers: {
        subscribe: ({ socket }) => {
          socket.send(JSON.stringify(subscriptionSuccess()));
          socket.send(
            JSON.stringify({
              type: "reauth_required",
              deadline: "2026-04-28T13:00:00.000Z",
              ...envelopeStub(),
            }),
          );
        },
        reauth: ({ socket }) => {
          socket.send(
            JSON.stringify({
              type: "reauth_ok",
              exp: "2026-04-28T14:00:00.000Z",
              ...envelopeStub(),
            }),
          );
        },
      },
    };
    const server = await startServer([reauthScript]);
    const fetchWsToken = vi
      .fn()
      .mockResolvedValue({ ws_token: "ws-tok-x", ws_token_exp: "2026-04-28T13:00:00Z" });
    const client = createWsClient(
      makeOptions(server, {
        fetchWsToken,
        heartbeatIntervalMs: 30,
      }),
    );
    const runPromise = client.run();
    await waitFor(
      () => {
        const types = server.received.map((r) => r.parsed.type);
        return (
          types.includes("authenticate") &&
          types.includes("subscribe") &&
          types.includes("reauth") &&
          types.filter((t) => t === "ping").length >= 1
        );
      },
      {
        timeoutMs: 3_000,
        message: "authenticate, subscribe, reauth, and ping frames to reach the server",
      },
    );
    const auth = server.received.find((r) => r.parsed.type === "authenticate");
    const sub = server.received.find((r) => r.parsed.type === "subscribe");
    const reauth = server.received.find((r) => r.parsed.type === "reauth");
    const ping = server.received.find((r) => r.parsed.type === "ping");
    expect(auth?.parsed.sequence_id).toBe(1);
    expect(sub?.parsed.sequence_id).toBe(2);
    expect(reauth?.parsed.sequence_id).toBe(3);
    expect(ping?.parsed.sequence_id).toBe(1);
    server.closeConnection(0);
    await client.close();
    await runPromise;
  });
});
