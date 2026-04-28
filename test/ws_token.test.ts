import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RefreshFailedError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { TokenStore } from "../src/token_store.js";
import { fetchWsToken } from "../src/ws_token.js";

type FetchArgs = Parameters<typeof fetch>;

function makeSilentLogger() {
  return createLogger({ prefix: "test", level: "error", timestamps: false });
}

function makeStore(access = "access-token", refresh: string | null = null): TokenStore {
  return new TokenStore({ access, refresh });
}

function makeResponse(status: number, body: unknown = null): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function wsTokenEnvelope(
  overrides: Record<string, unknown> = {},
): { payload: Record<string, unknown> } {
  return {
    payload: {
      ws_token: "ws-token-abc",
      ws_token_exp: "2026-04-27T12:00:00Z",
      expires_in: 900,
      ...overrides,
    },
  };
}

describe("fetchWsToken — URL + header contract", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to /api/auth/ws_token on the same origin with Bearer access + Content-Type", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, wsTokenEnvelope()));
    const store = makeStore("watch-access");
    await fetchWsToken(
      new URL("http://localhost:8000/api/mcp"),
      store,
      makeSilentLogger(),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(url instanceof URL ? url.toString() : String(url)).toBe(
      "http://localhost:8000/api/auth/ws_token",
    );
    expect(init?.method).toBe("POST");
    const sent = new Headers(init?.headers);
    expect(sent.get("authorization")).toBe("Bearer watch-access");
    expect(sent.get("content-type")).toBeNull();
  });

  it("derives the ws_token URL from the configured base origin (https case)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, wsTokenEnvelope()));
    await fetchWsToken(
      new URL("https://api.snapper.example.com/api/mcp"),
      makeStore(),
      makeSilentLogger(),
    );
    const [url] = fetchMock.mock.calls[0] as FetchArgs;
    expect(url instanceof URL ? url.toString() : String(url)).toBe(
      "https://api.snapper.example.com/api/auth/ws_token",
    );
  });

  it("does NOT modify the TokenStore on success (no rotation)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, wsTokenEnvelope()));
    const store = makeStore("untouched-access", "untouched-refresh");
    await fetchWsToken(
      new URL("http://localhost:8000/api/mcp"),
      store,
      makeSilentLogger(),
    );
    expect(store.accessToken()).toBe("untouched-access");
    expect(store.current().refresh).toBe("untouched-refresh");
  });

  it("supports access-only (PAT-mode) delegates without a refresh credential", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, wsTokenEnvelope()));
    const store = makeStore("pat-access", null);
    const result = await fetchWsToken(
      new URL("http://localhost:8000/api/mcp"),
      store,
      makeSilentLogger(),
    );
    expect(result.ws_token).toBe("ws-token-abc");
    expect(store.hasRefreshToken()).toBe(false);
  });
});

describe("fetchWsToken — happy path payload extraction", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the ws_token + ws_token_exp tuple from the response payload", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        200,
        wsTokenEnvelope({ ws_token: "captured-ws", ws_token_exp: "2026-12-31T23:59:00Z" }),
      ),
    );
    const result = await fetchWsToken(
      new URL("http://localhost:8000/api/mcp"),
      makeStore(),
      makeSilentLogger(),
    );
    expect(result).toEqual({
      ws_token: "captured-ws",
      ws_token_exp: "2026-12-31T23:59:00Z",
    });
  });

  it("accepts ISO 8601 with explicit +00:00 offset and microsecond fraction", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, wsTokenEnvelope({ ws_token_exp: "2026-04-27T12:00:00.123456+00:00" })),
    );
    const result = await fetchWsToken(
      new URL("http://localhost:8000/api/mcp"),
      makeStore(),
      makeSilentLogger(),
    );
    expect(result.ws_token_exp).toBe("2026-04-27T12:00:00.123456+00:00");
  });
});

describe("fetchWsToken — HTTP failure mapping", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps 401 to RefreshFailedError(ws_token rejected (401))", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(401, { detail: "Authentication required" }));
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 401,
      message: expect.stringContaining("rejected (401)"),
    });
  });

  it("maps 429 to RefreshFailedError(ws_token rate-limited)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(429, { detail: "rate-limit exceeded" }));
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 429,
      message: expect.stringContaining("rate-limited"),
    });
  });

  it("maps 5xx to RefreshFailedError(ws_token server error)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(503));
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 503,
      message: expect.stringContaining("server error"),
    });
  });

  it("maps non-2xx non-401/429/5xx (e.g. 404) to RefreshFailedError(ws_token unexpected status)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(404));
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 404,
      message: expect.stringContaining("unexpected status"),
    });
  });
});

describe("fetchWsToken — transport failure mapping", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a generic network error to RefreshFailedError(ws_token network error)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 0,
      message: expect.stringContaining("network error"),
    });
  });

  it("maps an AbortError to RefreshFailedError(ws_token timeout after 10s)", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortErr);
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 0,
      message: expect.stringContaining("timeout after 10s"),
    });
  });
});

describe("fetchWsToken — payload validation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a non-JSON 200 body with RefreshFailedError(ws_token response malformed: not JSON)", async () => {
    const response = new Response("<html>not-json</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
    fetchMock.mockResolvedValueOnce(response);
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      message: expect.stringContaining("not JSON"),
    });
  });

  it("rejects a top-level JSON null body", async () => {
    const response = new Response("null", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    fetchMock.mockResolvedValueOnce(response);
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("body is not a JSON object"),
    });
  });

  it("rejects a top-level non-object body (e.g. a JSON string)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, "unexpected"));
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("body is not a JSON object"),
    });
  });

  it("rejects a missing payload.ws_token", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { payload: { ws_token_exp: "2026-04-27T12:00:00Z" } }),
    );
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("payload.ws_token"),
    });
  });

  it("rejects an empty-string payload.ws_token", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, wsTokenEnvelope({ ws_token: "" })),
    );
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("payload.ws_token"),
    });
  });

  it("rejects a missing payload.ws_token_exp", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { payload: { ws_token: "ws-abc" } }),
    );
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("payload.ws_token_exp"),
    });
  });

  it("rejects a non-ISO 8601 payload.ws_token_exp (e.g. bare date)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, wsTokenEnvelope({ ws_token_exp: "2026-04-27" })),
    );
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("ISO 8601"),
    });
  });

  it("rejects a payload.ws_token_exp that the regex accepts but Date.parse rejects", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, wsTokenEnvelope({ ws_token_exp: "2026-13-99T99:99:99Z" })),
    );
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toBeInstanceOf(RefreshFailedError);
  });
});
