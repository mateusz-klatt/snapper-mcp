import { describe, expect, it } from "vitest";

import { TokenStore, type TokenPair } from "../src/token_store.js";

const initial: TokenPair = { access: "access-1" };

describe("TokenStore", () => {
  it("returns the access token supplied at construction", () => {
    const store = new TokenStore(initial);
    expect(store.accessToken()).toBe("access-1");
  });

  it("current() returns the underlying pair", () => {
    const store = new TokenStore(initial);
    expect(store.current()).toEqual(initial);
  });

  it("accessToken() is stable across calls", () => {
    const store = new TokenStore({ access: "stable-token" });
    expect(store.accessToken()).toBe("stable-token");
    expect(store.accessToken()).toBe("stable-token");
  });
});
