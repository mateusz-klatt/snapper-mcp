import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeMockSnapperServer, type MockSnapperServer } from "./helpers/mock_snapper_server.js";

const DIST_ENTRY = resolve(__dirname, "..", "dist", "index.js");

interface SubprocessOutcome {
  readonly stdoutLines: readonly string[];
  readonly stderrText: string;
  readonly exitCode: number | null;
}

async function runBridgeInitialize(
  baseUrl: URL,
  timeoutMs = 7_000,
  envOverrides: Record<string, string> = {},
): Promise<SubprocessOutcome> {
  const child = spawn(process.execPath, [DIST_ENTRY], {
    env: {
      ...process.env,
      SNAPPER_BASE_URL: baseUrl.toString(),
      SNAPPER_ACCESS_TOKEN: "test-access-jwt",
      SNAPPER_REFRESH_TOKEN: "test-refresh-jwt",
      SNAPPER_MCP_LOG_LEVEL: "error",
      ...envOverrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutLines: string[] = [];
  const stderrChunks: string[] = [];

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    stdoutLines.push(line);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "stdout-purity-test", version: "0.0.0" },
    },
  };
  child.stdin.write(`${JSON.stringify(initialize)}\n`);

  // Capture the exit event promise BEFORE any race so we can await it safely
  // even if the child has already fired `exit` by the time we check
  // (child.exitCode !== null). Using `once(child, "exit")` after the event
  // has already fired would hang forever.
  const exitPromise = once(child, "exit").catch(() => undefined);

  let watchdogHandle: NodeJS.Timeout | undefined;
  const exitWatchdog = new Promise<void>((resolve) => {
    watchdogHandle = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, timeoutMs);
  });

  try {
    await Promise.race([
      (async () => {
        while (stdoutLines.length === 0 && child.exitCode === null) {
          await new Promise((r) => setTimeout(r, 50));
        }
        await new Promise((r) => setTimeout(r, 500));
      })(),
      exitWatchdog,
    ]);
  } finally {
    if (watchdogHandle !== undefined) clearTimeout(watchdogHandle);
  }

  if (child.exitCode === null) {
    child.kill("SIGTERM");
  }
  await exitPromise;
  rl.close();

  return {
    stdoutLines,
    stderrText: stderrChunks.join(""),
    exitCode: child.exitCode,
  };
}

describe("stdout byte-purity", () => {
  let server: MockSnapperServer;

  beforeAll(async () => {
    server = await makeMockSnapperServer({
      capabilities: { tools: {} },
      serverInfo: { name: "snapper", version: "1.0.0-test" },
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  it("every stdout line from the bridge subprocess parses as MCP JSON-RPC", async () => {
    const outcome = await runBridgeInitialize(server.baseUrl);
    expect(outcome.stdoutLines.length).toBeGreaterThan(0);
    for (const line of outcome.stdoutLines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(
          `stdout line is not JSON — stream is corrupted. Line: ${JSON.stringify(line)}. ` +
            `Stderr tail: ${JSON.stringify(outcome.stderrText.slice(-1000))}. ` +
            `Parse error: ${String(err)}`,
          { cause: err },
        );
      }
      expect(parsed).toMatchObject({ jsonrpc: "2.0" });
    }
  }, 30_000);

  it("bridge banner (when not suppressed) goes to stderr, never stdout", async () => {
    const outcome = await runBridgeInitialize(
      server.baseUrl,
      7_000,
      { SNAPPER_MCP_LOG_LEVEL: "info" },
    );
    for (const line of outcome.stdoutLines) {
      expect(line).not.toContain("snapper-mcp");
      expect(line).not.toContain("bridging stdio");
    }
    // Positive assertion: banner MUST land on stderr.
    expect(outcome.stderrText).toContain("bridging stdio");
    expect(outcome.stderrText).toContain("snapper");
  }, 30_000);
});
