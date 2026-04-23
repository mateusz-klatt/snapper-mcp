/**
 * Minimal MCP Streamable HTTP server for subprocess integration tests.
 *
 * The bridge spawned by `test/stdout_purity.test.ts` +
 * `test/main.test.ts` completes MCP `initialize` against this stub,
 * so we need a server that:
 *
 *   - Accepts POST to /api/mcp with MCP JSON-RPC envelope.
 *   - Handles `initialize` → returns serverInfo + capabilities.
 *   - Handles `tools/list` / `tools/call` → returns stubbed data.
 *   - Handles `ping` → returns empty result.
 *
 * This intentionally does NOT implement SSE streaming — our bridge
 * tests only exercise the non-streaming request/response path
 * through StreamableHTTPClientTransport's HTTP POST mode.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export interface MockSnapperServer {
  readonly baseUrl: URL;
  readonly stop: () => Promise<void>;
  calls: Array<{ method: string; params: unknown }>;
}

export interface MockSnapperOptions {
  readonly capabilities?: Record<string, unknown>;
  readonly serverInfo?: { name: string; version: string };
  readonly tools?: Array<{ name: string; description?: string; inputSchema: unknown }>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export async function makeMockSnapperServer(
  options: MockSnapperOptions = {},
): Promise<MockSnapperServer> {
  const capabilities = options.capabilities ?? { tools: {} };
  const serverInfo = options.serverInfo ?? { name: "snapper", version: "1.0.0-test" };
  const tools = options.tools ?? [
    {
      name: "list_instruments",
      description: "Returns tradable instruments for an exchange.",
      inputSchema: {
        type: "object",
        properties: { exchange: { type: "string" } },
        required: ["exchange"],
      },
    },
  ];

  const calls: MockSnapperServer["calls"] = [];

  const httpServer: HttpServer = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || !(req.url ?? "").startsWith("/api/mcp")) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const raw = await readBody(req);
    let envelope: { jsonrpc?: string; id?: number; method?: string; params?: unknown };
    try {
      envelope = JSON.parse(raw) as typeof envelope;
    } catch {
      sendJson(res, { jsonrpc: "2.0", error: { code: -32700, message: "parse error" } }, 400);
      return;
    }

    const method = envelope.method ?? "";
    calls.push({ method, params: envelope.params ?? null });

    if (method === "initialize") {
      sendJson(res, {
        jsonrpc: "2.0",
        id: envelope.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities,
          serverInfo,
        },
      });
      return;
    }
    if (method === "notifications/initialized") {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (method === "tools/list") {
      sendJson(res, { jsonrpc: "2.0", id: envelope.id, result: { tools } });
      return;
    }
    if (method === "tools/call") {
      sendJson(res, {
        jsonrpc: "2.0",
        id: envelope.id,
        result: {
          content: [{ type: "text", text: "ok" }],
          isError: false,
        },
      });
      return;
    }
    if (method === "ping") {
      sendJson(res, { jsonrpc: "2.0", id: envelope.id, result: {} });
      return;
    }
    sendJson(res, {
      jsonrpc: "2.0",
      id: envelope.id,
      error: { code: -32601, message: `method not found: ${method}` },
    });
  }

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address() as AddressInfo;
  const baseUrl = new URL(`http://127.0.0.1:${addr.port}/api/mcp`);

  return {
    baseUrl,
    calls,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
