import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBridgeFetch } from "../src/bridge_fetch.js";
import type { Logger } from "../src/logger.js";
import { TokenStore } from "../src/token_store.js";

type FetchArgs = Parameters<typeof fetch>;

function testLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeStore(access = "access-token"): TokenStore {
  return new TokenStore({ access });
}

function makeResponse(status: number, body: unknown = null): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createBridgeFetch — bearer injection", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("injects Authorization: Bearer <token> on every request", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200));
    const store = makeStore("the-token");
    const logger = testLogger();
    const bridgeFetch = createBridgeFetch(store, logger);

    await bridgeFetch("https://snapper.example.com/api/mcp", { method: "POST" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as FetchArgs;
    const sent = new Headers(init?.headers);
    expect(sent.get("authorization")).toBe("Bearer the-token");
    expect(init?.method).toBe("POST");
  });

  it("preserves caller-supplied headers (Accept, Content-Type) — adds Authorization without clobbering", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200));
    const store = makeStore();
    const bridgeFetch = createBridgeFetch(store, testLogger());

    await bridgeFetch("https://snapper.example.com/api/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    const [, init] = fetchMock.mock.calls[0] as FetchArgs;
    const sent = new Headers(init?.headers);
    expect(sent.get("accept")).toBe("application/json");
    expect(sent.get("content-type")).toBe("application/json");
    expect(sent.get("authorization")).toBe("Bearer access-token");
  });

  it("returns a 200 response untouched without writing stderr", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true }));
    const logger = testLogger();
    const bridgeFetch = createBridgeFetch(makeStore(), logger);

    const response = await bridgeFetch("https://snapper.example.com/api/mcp");
    expect(response.status).toBe(200);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("createBridgeFetch — 401 contract (log-once + propagate)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("propagates the 401 response to the caller (does not consume, does not throw)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(401, { error_code: "invalid_bearer_token", detail: "rejected" }),
    );
    const bridgeFetch = createBridgeFetch(makeStore(), testLogger());

    const response = await bridgeFetch("https://snapper.example.com/api/mcp");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { detail?: string };
    expect(body.detail).toBe("rejected");
  });

  it("writes the auth-failed stderr line on the first 401", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(401));
    const logger = testLogger();
    const bridgeFetch = createBridgeFetch(makeStore("token-A"), logger);

    await bridgeFetch("https://snapper.example.com/api/mcp");
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message] = vi.mocked(logger.error).mock.calls[0] as [string];
    expect(message).toContain("Authentication failed for SNAPPER_ACCESS_TOKEN");
    expect(message).toContain("Recreate the AI delegate in Snapper");
  });

  it("does NOT re-emit the stderr line on the second 401 in the same session (log-once)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(401)).mockResolvedValueOnce(makeResponse(401));
    const logger = testLogger();
    const bridgeFetch = createBridgeFetch(makeStore("token-A"), logger);

    await bridgeFetch("https://snapper.example.com/api/mcp");
    await bridgeFetch("https://snapper.example.com/api/mcp");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("does NOT exit the process on 401 (the caller decides termination)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(401));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)}) called unexpectedly`);
    }) as never);
    try {
      const bridgeFetch = createBridgeFetch(makeStore(), testLogger());
      await bridgeFetch("https://snapper.example.com/api/mcp");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("createBridgeFetch — non-401 status codes", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([200, 201, 400, 403, 404, 422, 500, 503])(
    "passes through status %i without writing stderr",
    async (status) => {
      fetchMock.mockResolvedValueOnce(makeResponse(status));
      const logger = testLogger();
      const bridgeFetch = createBridgeFetch(makeStore(), logger);

      const response = await bridgeFetch("https://snapper.example.com/api/mcp");
      expect(response.status).toBe(status);
      expect(logger.error).not.toHaveBeenCalled();
    },
  );
});
