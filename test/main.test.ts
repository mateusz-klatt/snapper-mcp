import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { makeMockSnapperServer, type MockSnapperServer } from "./helpers/mock_snapper_server.js";
import { CAN_LISTEN_ON_LOOPBACK } from "./helpers/listen_capability.js";

const DIST_ENTRY = resolve(__dirname, "..", "dist", "index.js");

interface BridgeSubprocess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdoutLines: string[];
  readonly stderrChunks: string[];
  sendFrame(frame: Record<string, unknown>): void;
  waitForLine(predicate: (line: string) => boolean, timeoutMs?: number): Promise<string>;
  stop(signal?: NodeJS.Signals): Promise<number | null>;
}

function spawnBridge(
  server: MockSnapperServer,
  overrides: Record<string, string | undefined> = {},
): BridgeSubprocess {
  const child = spawn(process.execPath, [DIST_ENTRY], {
    env: {
      ...process.env,
      SNAPPER_BASE_URL: server.baseUrl.toString(),
      SNAPPER_ACCESS_TOKEN: "test-access",
      SNAPPER_MCP_LOG_LEVEL: "error",
      ...overrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const stdoutLines: string[] = [];
  const stderrChunks: string[] = [];
  const lineListeners = new Set<(line: string) => void>();

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    stdoutLines.push(line);
    for (const listener of lineListeners) listener(line);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  return {
    child,
    stdoutLines,
    stderrChunks,
    sendFrame(frame) {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    waitForLine(predicate, timeoutMs = 5_000) {
      return new Promise<string>((resolveLine, rejectLine) => {
        for (const existing of stdoutLines) {
          if (predicate(existing)) {
            resolveLine(existing);
            return;
          }
        }
        const listener = (line: string): void => {
          if (predicate(line)) {
            lineListeners.delete(listener);
            clearTimeout(timer);
            resolveLine(line);
          }
        };
        lineListeners.add(listener);
        const timer = setTimeout(() => {
          lineListeners.delete(listener);
          rejectLine(
            new Error(
              `timeout waiting for matching stdout line. stderr tail: ${stderrChunks.join("").slice(-500)}`,
            ),
          );
        }, timeoutMs);
      });
    },
    async stop(signal: NodeJS.Signals = "SIGTERM") {
      if (child.exitCode !== null) return child.exitCode;
      child.kill(signal);
      const [code] = (await once(child, "close")) as [number | null];
      rl.close();
      return code;
    },
  };
}

describe("bridge subprocess — env failure paths", () => {
  it("exits 1 with actionable stderr when SNAPPER_BASE_URL is missing", async () => {
    const child = spawn(process.execPath, [DIST_ENTRY], {
      env: {
        ...process.env,
        SNAPPER_BASE_URL: undefined,
        SNAPPER_ACCESS_TOKEN: "a",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
    const [code] = (await once(child, "close")) as [number | null];
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toMatch(/SNAPPER_BASE_URL/);
  });

  it("exits 1 when SNAPPER_BASE_URL is unparseable", async () => {
    const child = spawn(process.execPath, [DIST_ENTRY], {
      env: {
        ...process.env,
        SNAPPER_BASE_URL: "not-a-url",
        SNAPPER_ACCESS_TOKEN: "a",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
    const [code] = (await once(child, "close")) as [number | null];
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toMatch(/not a valid URL/);
  });

  it("exits 1 with actionable stderr when SNAPPER_ACCESS_TOKEN is missing", async () => {
    const child = spawn(process.execPath, [DIST_ENTRY], {
      env: {
        ...process.env,
        SNAPPER_BASE_URL: "http://localhost:8000/api/mcp",
        SNAPPER_ACCESS_TOKEN: undefined,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
    const [code] = (await once(child, "close")) as [number | null];
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toMatch(/SNAPPER_ACCESS_TOKEN/);
  });

  it("starts with the 2 required env vars and fails at handshake when backend is unreachable", async () => {
    const child = spawn(process.execPath, [DIST_ENTRY], {
      env: {
        ...process.env,
        SNAPPER_BASE_URL: "http://127.0.0.1:1/api/mcp",
        SNAPPER_ACCESS_TOKEN: "access",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
    const [code] = (await once(child, "close")) as [number | null];
    expect(code).toBe(1);
    const stderr = stderrChunks.join("");
    expect(stderr).toMatch(/MCP handshake to Snapper failed at startup/);
  });
});

describe.skipIf(!CAN_LISTEN_ON_LOOPBACK)("bridge subprocess — MCP lifecycle end-to-end", () => {
  let server: MockSnapperServer;

  beforeAll(async () => {
    server = await makeMockSnapperServer({
      capabilities: { tools: {} },
      serverInfo: { name: "snapper", version: "1.0.0-test" },
      tools: [
        {
          name: "list_instruments",
          description: "stub",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "submit_manual_order",
          description: "stub",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  const activeSubprocesses: BridgeSubprocess[] = [];

  afterEach(async () => {
    while (activeSubprocesses.length > 0) {
      const sp = activeSubprocesses.pop();
      if (sp?.child.exitCode === null) {
        await sp.stop();
      }
    }
  });

  it("completes initialize and mirrors backend capabilities to the stdio side", async () => {
    const bridge = spawnBridge(server);
    activeSubprocesses.push(bridge);
    bridge.sendFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-host", version: "0.0.0" },
      },
    });
    const response = JSON.parse(
      await bridge.waitForLine((line) => line.includes('"id":1')),
    ) as { result: { serverInfo: { name: string; version: string }; capabilities: unknown } };
    expect(response.result.serverInfo.name).toBe("snapper");
    expect(response.result.serverInfo.version).toBe("1.0.0-test");
    expect(response.result.capabilities).toMatchObject({ tools: {} });
  });

  it("forwards tools/list end-to-end — stub returns 2 tools the host sees", async () => {
    const bridge = spawnBridge(server);
    activeSubprocesses.push(bridge);
    bridge.sendFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-host", version: "0.0.0" },
      },
    });
    await bridge.waitForLine((line) => line.includes('"id":1'));
    bridge.sendFrame({ jsonrpc: "2.0", method: "notifications/initialized" });

    bridge.sendFrame({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listResponse = JSON.parse(
      await bridge.waitForLine((line) => line.includes('"id":2')),
    ) as { result: { tools: Array<{ name: string }> } };
    const names = listResponse.result.tools.map((t) => t.name);
    expect(names).toContain("list_instruments");
    expect(names).toContain("submit_manual_order");
  });

  it("refuses resources/list when the backend advertises only tools capability", async () => {
    const bridge = spawnBridge(server);
    activeSubprocesses.push(bridge);
    bridge.sendFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-host", version: "0.0.0" },
      },
    });
    await bridge.waitForLine((line) => line.includes('"id":1'));
    bridge.sendFrame({ jsonrpc: "2.0", method: "notifications/initialized" });

    bridge.sendFrame({ jsonrpc: "2.0", id: 2, method: "resources/list" });
    const response = JSON.parse(
      await bridge.waitForLine((line) => line.includes('"id":2')),
    ) as { error?: { code: number } };
    expect(response.error).toBeDefined();
  });

  // POSIX signals do not exist on Windows. child.kill('SIGTERM') there is
  // equivalent to SIGKILL — the process is terminated abruptly with no
  // chance to run a handler, so the graceful-drain contract is inherently
  // Unix-only. The drain code itself is covered by the unit tests in
  // test/shutdown.test.ts on every platform; this subprocess-level test
  // only verifies signal delivery semantics, so skipping on Windows is
  // the honest outcome.
  const sigtermDrain = process.platform === "win32" ? it.skip : it;
  sigtermDrain("SIGTERM triggers graceful drain + subprocess exits 0", async () => {
    const bridge = spawnBridge(server);
    activeSubprocesses.push(bridge);
    bridge.sendFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-host", version: "0.0.0" },
      },
    });
    await bridge.waitForLine((line) => line.includes('"id":1'));
    const code = await bridge.stop("SIGTERM");
    expect(code).toBe(0);
  });
});
