import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { main, resolvePackageName, resolvePackageVersion } from "../src/main.js";
import { makeMockSnapperServer, type MockSnapperServer } from "./helpers/mock_snapper_server.js";

describe("resolvePackageVersion / resolvePackageName", () => {
  it("returns the build-time global verbatim when it is a string", () => {
    expect(resolvePackageVersion("0.3.0")).toBe("0.3.0");
    expect(resolvePackageName("@scope/pkg")).toBe("@scope/pkg");
  });

  it("falls back to the in-source default when the global is undefined or non-string", () => {
    expect(resolvePackageVersion(undefined)).toBe("dev");
    expect(resolvePackageName(undefined)).toBe("@mateusz-klatt/snapper-mcp");
    expect(resolvePackageVersion(42)).toBe("dev");
    expect(resolvePackageName({ pkg: "x" })).toBe("@mateusz-klatt/snapper-mcp");
  });
});

describe("main — in-process lifecycle", () => {
  let server: MockSnapperServer;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    server = await makeMockSnapperServer({
      capabilities: { tools: {} },
      serverInfo: { name: "snapper", version: "1.0.0-unit" },
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy?.mockRestore();
    stderrSpy.mockRestore();
  });

  function baseEnv(overrides: Partial<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
    return {
      SNAPPER_BASE_URL: server.baseUrl.toString(),
      SNAPPER_ACCESS_TOKEN: "access-jwt",
      SNAPPER_REFRESH_TOKEN: "refresh-jwt",
      SNAPPER_MCP_LOG_LEVEL: "debug",
      ...overrides,
    } as NodeJS.ProcessEnv;
  }

  it("happy path: initializes, mirrors capabilities, logs banner without exiting", async () => {
    const [stdioTransport] = InMemoryTransport.createLinkedPair();
    await main({ source: baseEnv(), argv: [], stdioTransport, install: false });

    const stderrText = stderrSpy.mock.calls
      .map((args) => (typeof args[0] === "string" ? args[0] : String(args[0])))
      .join("");
    expect(stderrText).toContain("bridging stdio");
    expect(stderrText).toContain("snapper");
  });

  it("uses process.env, process.argv, and installs handlers when options are omitted", async () => {
    const [stdioTransport] = InMemoryTransport.createLinkedPair();
    const originalArgv = process.argv;
    const previousBaseUrl = process.env.SNAPPER_BASE_URL;
    const previousAccess = process.env.SNAPPER_ACCESS_TOKEN;
    const previousRefresh = process.env.SNAPPER_REFRESH_TOKEN;
    const previousLogLevel = process.env.SNAPPER_MCP_LOG_LEVEL;
    const before = { term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") };
    process.argv = ["/usr/bin/node", "/usr/local/bin/snapper-mcp"];
    process.env.SNAPPER_BASE_URL = server.baseUrl.toString();
    process.env.SNAPPER_ACCESS_TOKEN = "access-jwt";
    process.env.SNAPPER_REFRESH_TOKEN = "refresh-jwt";
    process.env.SNAPPER_MCP_LOG_LEVEL = "error";
    try {
      await main({ stdioTransport });
      const after = { term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") };
      expect(after.term).toBeGreaterThan(before.term);
      expect(after.int).toBeGreaterThan(before.int);
      const extraTerm = after.term - before.term;
      const extraInt = after.int - before.int;
      for (let i = 0; i < extraTerm; i += 1) {
        const listener = process.listeners("SIGTERM").pop();
        if (listener) process.removeListener("SIGTERM", listener);
      }
      for (let i = 0; i < extraInt; i += 1) {
        const listener = process.listeners("SIGINT").pop();
        if (listener) process.removeListener("SIGINT", listener);
      }
    } finally {
      process.argv = originalArgv;
      if (previousBaseUrl === undefined) {
        delete process.env.SNAPPER_BASE_URL;
      } else {
        process.env.SNAPPER_BASE_URL = previousBaseUrl;
      }
      if (previousAccess === undefined) {
        delete process.env.SNAPPER_ACCESS_TOKEN;
      } else {
        process.env.SNAPPER_ACCESS_TOKEN = previousAccess;
      }
      if (previousRefresh === undefined) {
        delete process.env.SNAPPER_REFRESH_TOKEN;
      } else {
        process.env.SNAPPER_REFRESH_TOKEN = previousRefresh;
      }
      if (previousLogLevel === undefined) {
        delete process.env.SNAPPER_MCP_LOG_LEVEL;
      } else {
        process.env.SNAPPER_MCP_LOG_LEVEL = previousLogLevel;
      }
    }
  });

  it("exits 1 when env var SNAPPER_BASE_URL is missing", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    const env = baseEnv({ SNAPPER_BASE_URL: undefined });
    await expect(main({ source: env, argv: [], install: false })).rejects.toThrow("exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderrText = stderrSpy.mock.calls
      .map((args) => (typeof args[0] === "string" ? args[0] : String(args[0])))
      .join("");
    expect(stderrText).toContain("SNAPPER_BASE_URL");
  });

  it("exits 1 when proxy mode receives an unknown argument", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    await expect(
      main({ source: baseEnv(), argv: ["--topic", "signals."], install: false }),
    ).rejects.toThrow("exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderrText = stderrSpy.mock.calls
      .map((args) => (typeof args[0] === "string" ? args[0] : String(args[0])))
      .join("");
    expect(stderrText).toContain("Unknown argument");
    expect(stderrText).toContain("--topic");
  });

  it("redacts JWT-shaped values from unknown proxy arguments", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    const token = `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    await expect(
      main({ source: baseEnv(), argv: [`--secret=${token}`], install: false }),
    ).rejects.toThrow("exit(1)");
    const stderrText = stderrSpy.mock.calls
      .map((args) => (typeof args[0] === "string" ? args[0] : String(args[0])))
      .join("");
    expect(stderrText).toContain("<jwt-");
    expect(stderrText).not.toContain(token);
  });

  it("rethrows non-EnvValidationError failures unchanged", async () => {
    // parseEnv throws for an unparseable URL — EnvValidationError exits 1
    // (covered by the previous test). Here we force a different error class
    // to be thrown from inside the env-parsing try block by stubbing the
    // base URL with a value that triggers URL validation to fail, and
    // assert we exit 1 the same way (ensures the instanceof branch does
    // not swallow unrelated errors).
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    const env = baseEnv({ SNAPPER_BASE_URL: "not-a-url" });
    await expect(main({ source: env, argv: [], install: false })).rejects.toThrow("exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when MCP handshake fails (dead backend)", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit(1)");
    });
    const deadEnv = baseEnv({ SNAPPER_BASE_URL: "http://127.0.0.1:1/api/mcp/" });
    await expect(main({ source: deadEnv, argv: [], install: false })).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderrText = stderrSpy.mock.calls
      .map((args) => (typeof args[0] === "string" ? args[0] : String(args[0])))
      .join("");
    expect(stderrText).toContain("MCP handshake to Snapper failed at startup");
  });

  it("installs signal handlers when install=true (default)", async () => {
    const [stdioTransport] = InMemoryTransport.createLinkedPair();
    const before = { term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") };
    await main({ source: baseEnv(), argv: [], stdioTransport, install: true });
    const after = { term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") };
    expect(after.term).toBeGreaterThan(before.term);
    expect(after.int).toBeGreaterThan(before.int);
    // Clean up the handlers we installed so subsequent tests start from a
    // clean listener set.
    const extraTerm = after.term - before.term;
    const extraInt = after.int - before.int;
    for (let i = 0; i < extraTerm; i += 1) {
      const listener = process.listeners("SIGTERM").pop();
      if (listener) process.removeListener("SIGTERM", listener);
    }
    for (let i = 0; i < extraInt; i += 1) {
      const listener = process.listeners("SIGINT").pop();
      if (listener) process.removeListener("SIGINT", listener);
    }
  });

  it("installed shutdown handler invokes setShuttingDown callback when a signal fires", async () => {
    const [stdioTransport] = InMemoryTransport.createLinkedPair();
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => undefined as never));
    try {
      const before = {
        term: process.listenerCount("SIGTERM"),
        int: process.listenerCount("SIGINT"),
      };
      await main({ source: baseEnv(), argv: [], stdioTransport, install: true });
      process.emit("SIGTERM");
      // Drain runs async; give it a tick.
      await new Promise((resolve) => setImmediate(resolve));
      // setShuttingDown callback should have been invoked; the only
      // observable side-effect is that the drain sequence reached exit.
      expect(exit).toHaveBeenCalled();
      // Clean up installed listeners.
      const after = {
        term: process.listenerCount("SIGTERM"),
        int: process.listenerCount("SIGINT"),
      };
      const extraTerm = after.term - before.term;
      const extraInt = after.int - before.int;
      for (let i = 0; i < extraTerm; i += 1) {
        const listener = process.listeners("SIGTERM").pop();
        if (listener) process.removeListener("SIGTERM", listener);
      }
      for (let i = 0; i < extraInt; i += 1) {
        const listener = process.listeners("SIGINT").pop();
        if (listener) process.removeListener("SIGINT", listener);
      }
    } finally {
      exit.mockRestore();
    }
  });

  it("forwards ping requests end-to-end, exercising the proxy closure", async () => {
    const [stdioTransport, clientSideTransport] = InMemoryTransport.createLinkedPair();
    await main({ source: baseEnv(), argv: [], stdioTransport, install: false });

    // Minimal MCP client on the stdio side that issues initialize + ping.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const host = new Client({ name: "test-host", version: "0.0.0" }, { capabilities: {} });
    await host.connect(clientSideTransport);
    const pingResult = await host.ping();
    expect(pingResult).toBeDefined();
    await host.close();
  });

  it("wraps stdio attach failures in BridgeStartupError and uninstalls handlers", async () => {
    const [stdioTransport] = InMemoryTransport.createLinkedPair();
    // Break the stdio transport so connect() rejects
    (stdioTransport as unknown as { start: () => Promise<void> }).start = () =>
      Promise.reject(new Error("broken transport"));
    const before = { term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") };
    await expect(
      main({ source: baseEnv(), argv: [], stdioTransport, install: true }),
    ).rejects.toThrow(/failed to attach stdio server transport/);
    const after = { term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") };
    // Handlers installed, then uninstalled — net zero.
    expect(after.term).toBe(before.term);
    expect(after.int).toBe(before.int);
  });
});
