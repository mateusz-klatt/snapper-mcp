/**
 * Minimal WebSocket server harness for ws_client lifecycle tests.
 *
 * Wraps the `ws` package's WebSocketServer with a small protocol
 * scripting layer: tests hand the server a sequence of "scripts"
 * (one per expected client connection) describing the sequence of
 * frames to emit on connect and how to react to specific client
 * frame types. Each script handler receives the live socket so it
 * can emit follow-up frames at any point.
 *
 * Counter-stamped envelope fields (session_id / sequence_id /
 * public_id / timestamp) are server-provided defaults; scripts can
 * override any field per-emit.
 */

import type { AddressInfo } from "node:net";
import type { Buffer } from "node:buffer";
import { WebSocket, WebSocketServer } from "ws";

type FrameTypeFor<T extends { readonly type: string }> = T["type"];

type ClientHandlerArgs = {
  readonly socket: WebSocket;
  readonly raw: string;
  readonly parsed: Record<string, unknown>;
  readonly server: MockWsServer;
};

export type ClientHandler = (args: ClientHandlerArgs) => Promise<void> | void;

export interface ConnectionScript {
  readonly headers?: Record<string, string>;
  readonly onConnect?: (socket: WebSocket, server: MockWsServer) => Promise<void> | void;
  readonly handlers?: Partial<Record<string, ClientHandler>>;
}

export interface MockWsServer {
  readonly url: URL;
  readonly received: Array<{ connection: number; raw: string; parsed: Record<string, unknown> }>;
  readonly connections: WebSocket[];
  readonly upgradeHeaders: Array<Record<string, string | string[] | undefined>>;
  readonly close: () => Promise<void>;
  emit(connectionIndex: number, frame: object): void;
  emitText(connectionIndex: number, text: string): void;
  closeConnection(connectionIndex: number, code?: number, reason?: string): void;
  awaitConnection(index: number, timeoutMs?: number): Promise<WebSocket>;
}

export async function makeMockWsServer(
  scripts: readonly ConnectionScript[],
): Promise<MockWsServer> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });
  const address = wss.address() as AddressInfo;
  const url = new URL(`ws://127.0.0.1:${address.port}/api/ws`);

  const received: MockWsServer["received"] = [];
  const connections: WebSocket[] = [];
  const upgradeHeaders: MockWsServer["upgradeHeaders"] = [];
  const connectionResolvers = new Map<number, (socket: WebSocket) => void>();

  const server: MockWsServer = {
    url,
    received,
    connections,
    upgradeHeaders,
    close: async () => {
      for (const socket of connections) {
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
    emit: (connectionIndex, frame) => {
      const socket = connections[connectionIndex];
      if (socket === undefined) throw new Error(`no connection at index ${connectionIndex}`);
      socket.send(JSON.stringify(frame));
    },
    emitText: (connectionIndex, text) => {
      const socket = connections[connectionIndex];
      if (socket === undefined) throw new Error(`no connection at index ${connectionIndex}`);
      socket.send(text);
    },
    closeConnection: (connectionIndex, code = 1000, reason = "") => {
      const socket = connections[connectionIndex];
      if (socket === undefined) throw new Error(`no connection at index ${connectionIndex}`);
      socket.close(code, reason);
    },
    awaitConnection: (index, timeoutMs = 2000) =>
      new Promise<WebSocket>((resolve, reject) => {
        const existing = connections[index];
        if (existing !== undefined) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for connection #${index} after ${timeoutMs}ms`)),
          timeoutMs,
        );
        connectionResolvers.set(index, (socket) => {
          clearTimeout(timer);
          resolve(socket);
        });
      }),
  };

  wss.on("connection", (socket, request) => {
    const index = connections.length;
    connections.push(socket);
    upgradeHeaders.push({ ...request.headers });
    const script = scripts[index] ?? {};
    const resolver = connectionResolvers.get(index);
    if (resolver !== undefined) {
      resolver(socket);
      connectionResolvers.delete(index);
    }
    socket.on("message", (raw: Buffer) => {
      const text = raw.toString("utf8");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { __unparsable: text };
      }
      received.push({ connection: index, raw: text, parsed });
      const frameType =
        typeof parsed.type === "string" ? (parsed.type as FrameTypeFor<{ type: string }>) : "";
      const handler = script.handlers?.[frameType];
      if (handler !== undefined) {
        void Promise.resolve(handler({ socket, raw: text, parsed, server }));
      }
    });
    if (script.onConnect !== undefined) {
      void Promise.resolve(script.onConnect(socket, server));
    }
  });

  return server;
}
