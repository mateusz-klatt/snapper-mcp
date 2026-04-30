import { describe, expect, it } from "vitest";

import { AuthFailedError, BridgeStartupError } from "../src/errors.js";

describe("AuthFailedError", () => {
  it("carries message + status + optional cause", () => {
    const cause = new Error("underlying");
    const err = new AuthFailedError("ws_token rejected (401)", 401, cause);
    expect(err.name).toBe("AuthFailedError");
    expect(err.message).toBe("ws_token rejected (401)");
    expect(err.status).toBe(401);
    expect(err.cause).toBe(cause);
  });

  it("cause is optional", () => {
    const err = new AuthFailedError("ws_token timeout after 10s", 0);
    expect(err.cause).toBeUndefined();
  });
});

describe("BridgeStartupError", () => {
  it("exposes .name = BridgeStartupError and .cause", () => {
    const cause = new Error("root cause");
    const err = new BridgeStartupError("wrapper", cause);
    expect(err.name).toBe("BridgeStartupError");
    expect(err.message).toBe("wrapper");
    expect(err.cause).toBe(cause);
  });

  it("cause is optional", () => {
    const err = new BridgeStartupError("standalone");
    expect(err.cause).toBeUndefined();
  });
});
