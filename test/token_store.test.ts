import { describe, expect, it } from "vitest";

import { TokenStore, type RefreshFn, type TokenPair } from "../src/token_store.js";

const initial: TokenPair = { access: "access-1", refresh: "refresh-1" };
const rotated: TokenPair = { access: "access-2", refresh: "refresh-2" };

describe("TokenStore", () => {
  it("returns the initial access token until rotate runs", () => {
    const store = new TokenStore(initial);
    expect(store.accessToken()).toBe("access-1");
    expect(store.current()).toEqual(initial);
  });

  it("rotates the pair on successful refresh and publishes the new access token", async () => {
    const store = new TokenStore(initial);
    const via: RefreshFn = async () => rotated;
    const next = await store.rotate(via);
    expect(next).toEqual(rotated);
    expect(store.accessToken()).toBe("access-2");
    expect(store.current()).toEqual(rotated);
  });

  it("passes the current pair to the refresh callable", async () => {
    const store = new TokenStore(initial);
    let seen: TokenPair | undefined;
    const via: RefreshFn = async (current) => {
      seen = current;
      return rotated;
    };
    await store.rotate(via);
    expect(seen).toEqual(initial);
  });

  it("single-flights concurrent rotate calls — via is invoked EXACTLY once", async () => {
    const store = new TokenStore(initial);
    let invocations = 0;
    let resolveRefresh!: (pair: TokenPair) => void;
    const via: RefreshFn = async () => {
      invocations += 1;
      return new Promise<TokenPair>((resolve) => {
        resolveRefresh = resolve;
      });
    };

    const callers = [store.rotate(via), store.rotate(via), store.rotate(via), store.rotate(via)];
    expect(invocations).toBe(1);

    resolveRefresh(rotated);
    const results = await Promise.all(callers);
    for (const result of results) {
      expect(result).toEqual(rotated);
    }
    expect(invocations).toBe(1);
    expect(store.accessToken()).toBe("access-2");
  });

  it("race-tight: accessToken() returns the OLD pair while rotation is pending", async () => {
    const store = new TokenStore(initial);
    let resolveRefresh!: (pair: TokenPair) => void;
    const via: RefreshFn = async () =>
      new Promise<TokenPair>((resolve) => {
        resolveRefresh = resolve;
      });

    const pending = store.rotate(via);
    expect(store.accessToken()).toBe("access-1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.accessToken()).toBe("access-1");

    resolveRefresh(rotated);
    await pending;
    expect(store.accessToken()).toBe("access-2");
  });

  it("clears inFlight on refresh failure so the next rotate starts fresh", async () => {
    const store = new TokenStore(initial);
    const failing: RefreshFn = async () => {
      throw new Error("refresh rejected");
    };
    await expect(store.rotate(failing)).rejects.toThrow("refresh rejected");
    expect(store.accessToken()).toBe("access-1");

    let reattempted = false;
    const ok: RefreshFn = async () => {
      reattempted = true;
      return rotated;
    };
    await store.rotate(ok);
    expect(reattempted).toBe(true);
    expect(store.accessToken()).toBe("access-2");
  });

  it("late arrivals AFTER rotate settled trigger a NEW refresh cycle", async () => {
    const store = new TokenStore(initial);
    let invocations = 0;
    const via: RefreshFn = async () => {
      invocations += 1;
      return invocations === 1
        ? rotated
        : { access: "access-3", refresh: "refresh-3" };
    };

    await store.rotate(via);
    expect(invocations).toBe(1);
    expect(store.accessToken()).toBe("access-2");

    const next = await store.rotate(via);
    expect(invocations).toBe(2);
    expect(next.access).toBe("access-3");
    expect(store.accessToken()).toBe("access-3");
  });
});
