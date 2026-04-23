import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RefreshFailedError,
  createBridgeFetch,
  makePerformRefresh,
  peekErrorCode,
} from "../src/bridge_fetch.js";
import { createLogger } from "../src/logger.js";
import { TokenStore, type RefreshFn } from "../src/token_store.js";

type FetchArgs = Parameters<typeof fetch>;

function makeSilentLogger() {
  return createLogger({ prefix: "test", level: "error", timestamps: false });
}

function makeStore(access = "a1", refresh = "r1"): TokenStore {
  return new TokenStore({ access, refresh });
}

function makeResponse(status: number, body: unknown = null): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("peekErrorCode", () => {
  it("extracts error_code from a JSON body", async () => {
    const response = makeResponse(401, { error_code: "invalid_bearer_token" });
    expect(await peekErrorCode(response)).toBe("invalid_bearer_token");
  });

  it("returns null for non-object bodies", async () => {
    expect(await peekErrorCode(makeResponse(401, "plain string"))).toBe(null);
  });

  it("returns null for bodies without error_code", async () => {
    expect(await peekErrorCode(makeResponse(401, { detail: "nope" }))).toBe(null);
  });

  it("returns null when error_code is not a string", async () => {
    expect(await peekErrorCode(makeResponse(401, { error_code: 42 }))).toBe(null);
  });

  it("returns null on invalid JSON without throwing", async () => {
    const response = new Response("not json", { status: 401 });
    expect(await peekErrorCode(response)).toBe(null);
  });
});

describe("createBridgeFetch — header preservation + happy path", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges Authorization into existing Headers INSTANCE without dropping SDK-set headers", async () => {
    fetchMock.mockResolvedValue(makeResponse(200, { ok: true }));
    const store = makeStore("access-A");
    const via: RefreshFn = async () => ({ access: "unused", refresh: "unused" });
    const bridge = createBridgeFetch(store, via, makeSilentLogger());

    const sdkHeaders = new Headers();
    sdkHeaders.set("Accept", "application/json, text/event-stream");
    sdkHeaders.set("Content-Type", "application/json");
    await bridge("https://example.com/api/mcp", { method: "POST", headers: sdkHeaders });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as FetchArgs;
    const sent = new Headers(init?.headers);
    expect(sent.get("accept")).toBe("application/json, text/event-stream");
    expect(sent.get("content-type")).toBe("application/json");
    expect(sent.get("authorization")).toBe("Bearer access-A");
  });

  it("merges Authorization into plain-object headers too", async () => {
    fetchMock.mockResolvedValue(makeResponse(200, { ok: true }));
    const store = makeStore("access-B");
    const via: RefreshFn = async () => ({ access: "unused", refresh: "unused" });
    const bridge = createBridgeFetch(store, via, makeSilentLogger());

    await bridge("https://example.com/api/mcp", {
      method: "POST",
      headers: { "X-Trace": "abc" },
    });
    const [, init] = fetchMock.mock.calls[0] as FetchArgs;
    const sent = new Headers(init?.headers);
    expect(sent.get("x-trace")).toBe("abc");
    expect(sent.get("authorization")).toBe("Bearer access-B");
  });

  it("returns non-401 responses verbatim without consulting the store.rotate", async () => {
    fetchMock.mockResolvedValue(makeResponse(200, { ok: true }));
    const store = makeStore();
    let rotated = false;
    const via: RefreshFn = async () => {
      rotated = true;
      return { access: "nope", refresh: "nope" };
    };
    const bridge = createBridgeFetch(store, via, makeSilentLogger());

    const result = await bridge("https://example.com/api/mcp");
    expect(result.status).toBe(200);
    expect(rotated).toBe(false);
  });
});

describe("createBridgeFetch — 401 handling", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes on 401 invalid_bearer_token, retries once, surfaces retry response", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, { error_code: "invalid_bearer_token" }))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));
    const store = makeStore("old-access", "old-refresh");
    const via: RefreshFn = async () => ({ access: "new-access", refresh: "new-refresh" });
    const bridge = createBridgeFetch(store, via, makeSilentLogger());

    const result = await bridge("https://example.com/api/mcp");
    expect(result.status).toBe(200);
    expect(store.accessToken()).toBe("new-access");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchMock.mock.calls[1] as FetchArgs;
    expect(new Headers(retryInit?.headers).get("authorization")).toBe("Bearer new-access");
  });

  it("returns the ORIGINAL 401 when refresh throws, without a second refresh attempt", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(401, { error_code: "invalid_bearer_token" }));
    const store = makeStore("stale", "stale-refresh");
    const via: RefreshFn = async () => {
      throw new Error("refresh network error");
    };
    const bridge = createBridgeFetch(store, via, makeSilentLogger());

    const result = await bridge("https://example.com/api/mcp");
    expect(result.status).toBe(401);
    const body = (await result.json()) as { error_code: string };
    expect(body.error_code).toBe("invalid_bearer_token");
    expect(fetchMock).toHaveBeenCalledOnce();
  });


  it("does NOT refresh on 401 user_deactivated — returns it verbatim", async () => {
    fetchMock.mockResolvedValue(makeResponse(401, { error_code: "user_deactivated" }));
    const store = makeStore();
    let rotated = false;
    const via: RefreshFn = async () => {
      rotated = true;
      return { access: "x", refresh: "y" };
    };
    const bridge = createBridgeFetch(store, via, makeSilentLogger());

    const result = await bridge("https://example.com/api/mcp");
    expect(result.status).toBe(401);
    expect(rotated).toBe(false);
  });

  it("does NOT refresh on 401 with no error_code envelope", async () => {
    fetchMock.mockResolvedValue(makeResponse(401, { detail: "nope" }));
    const store = makeStore();
    let rotated = false;
    const via: RefreshFn = async () => {
      rotated = true;
      return { access: "x", refresh: "y" };
    };
    const bridge = createBridgeFetch(store, via, makeSilentLogger());

    const result = await bridge("https://example.com/api/mcp");
    expect(result.status).toBe(401);
    expect(rotated).toBe(false);
  });

  it("surfaces retry-also-401 verbatim without a second refresh (retry-bound=1)", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, { error_code: "invalid_bearer_token" }))
      .mockResolvedValueOnce(makeResponse(401, { error_code: "invalid_bearer_token" }));
    const store = makeStore();
    let invocations = 0;
    const via: RefreshFn = async () => {
      invocations += 1;
      return { access: `rotated-${invocations}`, refresh: `rotated-r-${invocations}` };
    };
    const bridge = createBridgeFetch(store, via, makeSilentLogger());

    const result = await bridge("https://example.com/api/mcp");
    expect(result.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(invocations).toBe(1);
  });

  it("N concurrent 401s share a single refresh (single-flight through TokenStore)", async () => {
    fetchMock.mockImplementation(async (_input, init) => {
      const sent = new Headers(init?.headers);
      const bearer = sent.get("authorization") ?? "";
      if (bearer === "Bearer old-access") {
        return makeResponse(401, { error_code: "invalid_bearer_token" });
      }
      return makeResponse(200, { ok: true });
    });
    const store = makeStore("old-access", "old-refresh");
    let refreshes = 0;
    const via: RefreshFn = async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { access: "new-access", refresh: "new-refresh" };
    };
    const bridge = createBridgeFetch(store, via, makeSilentLogger());

    const results = await Promise.all([
      bridge("https://example.com/api/mcp"),
      bridge("https://example.com/api/mcp"),
      bridge("https://example.com/api/mcp"),
      bridge("https://example.com/api/mcp"),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
    }
    expect(refreshes).toBe(1);
    expect(store.accessToken()).toBe("new-access");
  });

  it("peekErrorCode operates on a CLONE — original response body remains readable downstream", async () => {
    const originalBody = { error_code: "invalid_bearer_token", extra: "downstream" };
    const original = makeResponse(401, originalBody);
    fetchMock.mockResolvedValueOnce(original);
    const store = makeStore();
    const via: RefreshFn = async () => {
      throw new Error("refresh fail");
    };
    const bridge = createBridgeFetch(store, via, makeSilentLogger());

    const returned = await bridge("https://example.com/api/mcp");
    const roundtripped = (await returned.json()) as typeof originalBody;
    expect(roundtripped.error_code).toBe("invalid_bearer_token");
    expect(roundtripped.extra).toBe("downstream");
  });
});

describe("makePerformRefresh", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to /api/auth/refresh?return_tokens=true with Bearer refresh header", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { payload: { access_token: "a2", refresh_token: "r2" } }),
    );
    const refresh = makePerformRefresh(
      new URL("http://localhost:8000/api/mcp"),
      makeSilentLogger(),
    );
    await refresh({ access: "a1", refresh: "r1" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(url instanceof URL ? url.toString() : String(url)).toBe(
      "http://localhost:8000/api/auth/refresh?return_tokens=true",
    );
    expect(init?.method).toBe("POST");
    const sent = new Headers(init?.headers);
    expect(sent.get("authorization")).toBe("Bearer r1");
    expect(sent.get("content-type")).toBe("application/json");
  });

  it("parses PayloadResponse envelope and returns the new pair", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { payload: { access_token: "new-a", refresh_token: "new-r" } }),
    );
    const refresh = makePerformRefresh(
      new URL("http://localhost:8000/api/mcp"),
      makeSilentLogger(),
    );
    const pair = await refresh({ access: "old", refresh: "old-r" });
    expect(pair).toEqual({ access: "new-a", refresh: "new-r" });
  });

  it("throws RefreshFailedError(status=200) on FLAT {access_token, refresh_token} body (must use the envelope)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { access_token: "a", refresh_token: "r" }));
    const refresh = makePerformRefresh(
      new URL("http://localhost:8000/api/mcp"),
      makeSilentLogger(),
    );
    await expect(refresh({ access: "a1", refresh: "r1" })).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 200,
    });
  });

  it("throws RefreshFailedError(401) on 401", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(401, { detail: "rejected" }));
    const refresh = makePerformRefresh(
      new URL("http://localhost:8000/api/mcp"),
      makeSilentLogger(),
    );
    await expect(refresh({ access: "a1", refresh: "r1" })).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 401,
    });
  });

  it("throws RefreshFailedError with matching status on 5xx", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(503, { detail: "server error" }));
    const refresh = makePerformRefresh(
      new URL("http://localhost:8000/api/mcp"),
      makeSilentLogger(),
    );
    await expect(refresh({ access: "a1", refresh: "r1" })).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 503,
    });
  });

  it("throws RefreshFailedError(0) on network error (fetch throws)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("ECONNREFUSED"));
    const refresh = makePerformRefresh(
      new URL("http://localhost:8000/api/mcp"),
      makeSilentLogger(),
    );
    await expect(refresh({ access: "a1", refresh: "r1" })).rejects.toBeInstanceOf(
      RefreshFailedError,
    );
  });

  it("throws RefreshFailedError with 'timeout' message on AbortError (10s budget)", async () => {
    // fetch rejecting with an AbortError-named Error mimics the DOMException
    // the runtime surfaces when AbortController.abort() fires.
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchMock.mockRejectedValueOnce(abortError);
    const refresh = makePerformRefresh(
      new URL("http://localhost:8000/api/mcp"),
      makeSilentLogger(),
    );
    await expect(refresh({ access: "a1", refresh: "r1" })).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 0,
      message: expect.stringMatching(/timeout/i),
    });
  });

  it("throws RefreshFailedError on malformed (non-JSON) 2xx body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    const refresh = makePerformRefresh(
      new URL("http://localhost:8000/api/mcp"),
      makeSilentLogger(),
    );
    await expect(refresh({ access: "a1", refresh: "r1" })).rejects.toMatchObject({
      name: "RefreshFailedError",
    });
  });

  it("rejects empty-string payload.access_token", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { payload: { access_token: "", refresh_token: "r2" } }),
    );
    const refresh = makePerformRefresh(
      new URL("http://localhost:8000/api/mcp"),
      makeSilentLogger(),
    );
    await expect(refresh({ access: "a1", refresh: "r1" })).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 200,
    });
  });

  it("rejects missing payload.refresh_token with RefreshFailedError(status=200)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { payload: { access_token: "a2" } }),
    );
    const refresh = makePerformRefresh(
      new URL("http://localhost:8000/api/mcp"),
      makeSilentLogger(),
    );
    await expect(refresh({ access: "a1", refresh: "r1" })).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 200,
      message: expect.stringMatching(/refresh_token/i),
    });
  });

  it("rejects non-object 2xx body (array, primitive) with RefreshFailedError(status=200)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, 42));
    const refresh = makePerformRefresh(
      new URL("http://localhost:8000/api/mcp"),
      makeSilentLogger(),
    );
    await expect(refresh({ access: "a1", refresh: "r1" })).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 200,
      message: expect.stringMatching(/not a JSON object/i),
    });
  });

  it("throws RefreshFailedError with unexpected-status message on 4xx non-401", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(418, { detail: "teapot" }));
    const refresh = makePerformRefresh(
      new URL("http://localhost:8000/api/mcp"),
      makeSilentLogger(),
    );
    await expect(refresh({ access: "a1", refresh: "r1" })).rejects.toMatchObject({
      name: "RefreshFailedError",
      status: 418,
      message: expect.stringMatching(/unexpected status/i),
    });
  });
});
