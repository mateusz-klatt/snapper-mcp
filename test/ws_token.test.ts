import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NoRefreshTokenError, RefreshFailedError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { TokenStore } from "../src/token_store.js";
import { fetchWsToken } from "../src/ws_token.js";

type FetchArgs = Parameters<typeof fetch>;

function makeSilentLogger() {
  return createLogger({ prefix: "test", level: "error", timestamps: false });
}

function makeStore(access = "a1", refresh: string | null = "r1"): TokenStore {
  return new TokenStore({ access, refresh });
}

function makeResponse(status: number, body: unknown = null): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fullPayload(overrides: Record<string, unknown> = {}): {
  payload: Record<string, unknown>;
} {
  return {
    payload: {
      access_token: "new-access",
      refresh_token: "new-refresh",
      ws_token: "ws-token-abc",
      ws_token_exp: "2026-04-27T12:00:00Z",
      ...overrides,
    },
  };
}

describe("fetchWsToken — happy path + URL/header contract", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to /api/auth/refresh?return_tokens=true with Bearer refresh and Content-Type", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, fullPayload()));
    const store = makeStore("a-old", "r-old");
    await fetchWsToken(
      new URL("http://localhost:8000/api/mcp"),
      store,
      makeSilentLogger(),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(url instanceof URL ? url.toString() : String(url)).toBe(
      "http://localhost:8000/api/auth/refresh?return_tokens=true",
    );
    expect(init?.method).toBe("POST");
    const sent = new Headers(init?.headers);
    expect(sent.get("authorization")).toBe("Bearer r-old");
    expect(sent.get("content-type")).toBe("application/json");
  });

  it("returns the captured ws_token + ws_token_exp from the refresh payload", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        200,
        fullPayload({ ws_token: "captured-ws", ws_token_exp: "2026-12-31T23:59:00Z" }),
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

  it("publishes the rotated TokenPair on the store regardless of ws_token validity", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        200,
        fullPayload({ access_token: "rotated-a", refresh_token: "rotated-r" }),
      ),
    );
    const store = makeStore("a-old", "r-old");
    await fetchWsToken(
      new URL("http://localhost:8000/api/mcp"),
      store,
      makeSilentLogger(),
    );
    expect(store.accessToken()).toBe("rotated-a");
    expect(store.current()).toEqual({ access: "rotated-a", refresh: "rotated-r" });
  });

  it("ignores extra payload fields (csrf_token, user, message) and other envelope fields", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        session_id: "irrelevant",
        sequence_id: 7,
        public_id: "irrelevant",
        timestamp: "irrelevant",
        payload: {
          access_token: "a",
          refresh_token: "r",
          ws_token: "ws",
          ws_token_exp: "2026-04-27T12:00:00Z",
          csrf_token: "csrf",
          user: { username: "alice" },
          message: "session refreshed",
          unknown_future_field: 42,
        },
      }),
    );
    const result = await fetchWsToken(
      new URL("http://localhost:8000/api/mcp"),
      makeStore(),
      makeSilentLogger(),
    );
    expect(result).toEqual({ ws_token: "ws", ws_token_exp: "2026-04-27T12:00:00Z" });
  });
});

describe("fetchWsToken — PAT-mode rejection", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws NoRefreshTokenError without an HTTP round-trip when refresh is null", async () => {
    const store = makeStore("a", null);
    await expect(
      fetchWsToken(new URL("http://localhost:8000/api/mcp"), store, makeSilentLogger()),
    ).rejects.toBeInstanceOf(NoRefreshTokenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws NoRefreshTokenError without an HTTP round-trip when refresh is empty string", async () => {
    const store = new TokenStore({ access: "a", refresh: "" });
    await expect(
      fetchWsToken(new URL("http://localhost:8000/api/mcp"), store, makeSilentLogger()),
    ).rejects.toBeInstanceOf(NoRefreshTokenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchWsToken — burned-refresh safety", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes the new TokenPair THEN rejects when ws_token field is missing", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        payload: {
          access_token: "rot-a",
          refresh_token: "rot-r",
          ws_token_exp: "2026-04-27T12:00:00Z",
        },
      }),
    );
    const store = makeStore("a-old", "r-old");
    await expect(
      fetchWsToken(new URL("http://localhost:8000/api/mcp"), store, makeSilentLogger()),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 200,
      message: expect.stringMatching(/ws_token missing or empty/i),
    });
    expect(store.accessToken()).toBe("rot-a");
    expect(store.current()).toEqual({ access: "rot-a", refresh: "rot-r" });
  });

  it("publishes the new TokenPair THEN rejects when ws_token_exp is not parseable", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        payload: {
          access_token: "rot-a",
          refresh_token: "rot-r",
          ws_token: "ws",
          ws_token_exp: "not-a-date",
        },
      }),
    );
    const store = makeStore("a-old", "r-old");
    await expect(
      fetchWsToken(new URL("http://localhost:8000/api/mcp"), store, makeSilentLogger()),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 200,
      message: expect.stringMatching(/not a parseable ISO 8601 datetime/i),
    });
    expect(store.accessToken()).toBe("rot-a");
  });

  it("publishes the new TokenPair THEN rejects when ws_token_exp is a numeric epoch (server contract is ISO string)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        payload: {
          access_token: "rot-a",
          refresh_token: "rot-r",
          ws_token: "ws",
          ws_token_exp: 1735689600,
        },
      }),
    );
    const store = makeStore("a-old", "r-old");
    await expect(
      fetchWsToken(new URL("http://localhost:8000/api/mcp"), store, makeSilentLogger()),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 200,
      message: expect.stringMatching(/ws_token_exp missing or empty/i),
    });
    expect(store.accessToken()).toBe("rot-a");
  });

  it("publishes the new TokenPair THEN rejects a plain calendar date that Date.parse alone would accept (regex tightens drift detection)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        payload: {
          access_token: "rot-a",
          refresh_token: "rot-r",
          ws_token: "ws",
          ws_token_exp: "2026-04-27",
        },
      }),
    );
    const store = makeStore("a-old", "r-old");
    await expect(
      fetchWsToken(new URL("http://localhost:8000/api/mcp"), store, makeSilentLogger()),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 200,
      message: expect.stringMatching(/not a parseable ISO 8601 datetime/i),
    });
    expect(store.accessToken()).toBe("rot-a");
  });

  it("accepts ISO datetime with timezone offset (+00:00 form)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        200,
        fullPayload({ ws_token_exp: "2026-04-27T12:00:00.123456+00:00" }),
      ),
    );
    const result = await fetchWsToken(
      new URL("http://localhost:8000/api/mcp"),
      makeStore(),
      makeSilentLogger(),
    );
    expect(result.ws_token_exp).toBe("2026-04-27T12:00:00.123456+00:00");
  });

  it("publishes the new TokenPair THEN rejects when ws_token_exp is empty string", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        payload: {
          access_token: "rot-a",
          refresh_token: "rot-r",
          ws_token: "ws",
          ws_token_exp: "",
        },
      }),
    );
    const store = makeStore("a-old", "r-old");
    await expect(
      fetchWsToken(new URL("http://localhost:8000/api/mcp"), store, makeSilentLogger()),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 200,
      message: expect.stringMatching(/ws_token_exp missing or empty/i),
    });
    expect(store.accessToken()).toBe("rot-a");
  });

  it("does NOT publish the TokenPair when access_token is missing (full refresh failure surfaces via RefreshFailedError)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        payload: {
          refresh_token: "rot-r",
          ws_token: "ws",
          ws_token_exp: "2026-04-27T12:00:00Z",
        },
      }),
    );
    const store = makeStore("a-old", "r-old");
    await expect(
      fetchWsToken(new URL("http://localhost:8000/api/mcp"), store, makeSilentLogger()),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 200,
      message: expect.stringMatching(/access_token missing or empty/i),
    });
    expect(store.accessToken()).toBe("a-old");
    expect(store.current()).toEqual({ access: "a-old", refresh: "r-old" });
  });
});

describe("fetchWsToken — HTTP error paths", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws RefreshFailedError(401) when the refresh route rejects", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(401, { detail: "rejected" }));
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 401,
    });
  });

  it("throws RefreshFailedError with matching status on 5xx", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(503, { detail: "server error" }));
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 503,
    });
  });

  it("throws RefreshFailedError(0) on network error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("ECONNREFUSED"));
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 0,
      message: expect.stringMatching(/network error/i),
    });
  });

  it("throws RefreshFailedError with timeout message on AbortError", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchMock.mockRejectedValueOnce(abortError);
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 0,
      message: expect.stringMatching(/timeout/i),
    });
  });

  it("throws RefreshFailedError with unexpected-status message on 4xx non-401", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(404, { detail: "missing" }));
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 404,
      message: expect.stringMatching(/unexpected status/i),
    });
  });

  it("throws RefreshFailedError on non-JSON 2xx body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      message: expect.stringMatching(/not JSON/i),
    });
  });

  it("throws RefreshFailedError on 204 (no body, parsed as empty stream)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toBeInstanceOf(RefreshFailedError);
  });

  it("throws RefreshFailedError on 422 with descriptive message", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(422, { detail: [{ msg: "validation failed" }] }),
    );
    await expect(
      fetchWsToken(
        new URL("http://localhost:8000/api/mcp"),
        makeStore(),
        makeSilentLogger(),
      ),
    ).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 422,
    });
  });
});

describe("fetchWsToken — single-flight rotate semantics", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("two concurrent fetchWsToken calls coalesce under TokenStore.rotate; one captures, the other surfaces an explicit retry error", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        200,
        fullPayload({ ws_token: "ws-coalesced", ws_token_exp: "2026-04-27T12:00:00Z" }),
      ),
    );
    const store = makeStore();
    const logger = makeSilentLogger();

    const settled = await Promise.allSettled([
      fetchWsToken(new URL("http://localhost:8000/api/mcp"), store, logger),
      fetchWsToken(new URL("http://localhost:8000/api/mcp"), store, logger),
    ]);

    const fulfilled = settled.filter(
      (s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchWsToken>>> =>
        s.status === "fulfilled",
    );
    const rejected = settled.filter(
      (s): s is PromiseRejectedResult => s.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0].value).toEqual({
      ws_token: "ws-coalesced",
      ws_token_exp: "2026-04-27T12:00:00Z",
    });
    expect(rejected[0].reason).toMatchObject({
      name: "RefreshFailedError",
      message: expect.stringMatching(/joined an existing refresh/i),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("after a coalesce-loser failure, a subsequent fetchWsToken call succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(200, fullPayload({ ws_token: "ws-1" })))
      .mockResolvedValueOnce(makeResponse(200, fullPayload({ ws_token: "ws-2" })));
    const store = makeStore();
    const logger = makeSilentLogger();

    const [a, b] = await Promise.allSettled([
      fetchWsToken(new URL("http://localhost:8000/api/mcp"), store, logger),
      fetchWsToken(new URL("http://localhost:8000/api/mcp"), store, logger),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x.localeCompare(y));
    expect(statuses).toEqual(["fulfilled", "rejected"]);

    const second = await fetchWsToken(
      new URL("http://localhost:8000/api/mcp"),
      store,
      logger,
    );
    expect(second.ws_token).toBe("ws-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
