import { describe, expect, it } from "vitest";

import {
  BridgeStartupError,
  REFRESH_ERROR_MAPPINGS,
  RefreshFailedError,
  resolveRefreshError,
} from "../src/errors.js";

describe("refresh-path error mapping", () => {
  it("contains the 5 refresh scenarios (rejected / malformed / server-error / network / timeout)", () => {
    expect(REFRESH_ERROR_MAPPINGS).toHaveLength(5);
  });

  it("is frozen at module load (single source of truth)", () => {
    expect(Object.isFrozen(REFRESH_ERROR_MAPPINGS)).toBe(true);
  });

  it("resolves `refresh rejected (401)` to the regenerate-tokens hint", () => {
    const message = resolveRefreshError(new RefreshFailedError("refresh rejected (401)", 401));
    expect(message).toMatch(/refresh token may be expired/i);
    expect(message).toMatch(/regenerate tokens in the Snapper UI/i);
  });

  it("resolves `refresh response malformed ...` to the contract-mismatch hint", () => {
    const message = resolveRefreshError(
      new RefreshFailedError("refresh response malformed: payload.access_token missing", 200),
    );
    expect(message).toMatch(/malformed/i);
    expect(message).toMatch(/payload.*access_token.*refresh_token/i);
  });

  it("resolves `refresh server error (503)` to the transient-backend hint", () => {
    const message = resolveRefreshError(new RefreshFailedError("refresh server error (503)", 503));
    expect(message).toMatch(/server error/i);
    expect(message).toMatch(/transiently unhealthy|retry/i);
  });

  it("resolves `refresh network error` to the connectivity hint", () => {
    const message = resolveRefreshError(new RefreshFailedError("refresh network error", 0));
    expect(message).toMatch(/cannot reach/i);
    expect(message).toMatch(/SNAPPER_BASE_URL/i);
  });

  it("resolves `refresh timeout after 10s` to the timeout hint", () => {
    const message = resolveRefreshError(new RefreshFailedError("refresh timeout after 10s", 0));
    expect(message).toMatch(/timed out.*10s/i);
  });

  it("falls back to the error's own message on unknown patterns", () => {
    const message = resolveRefreshError(new Error("refresh unknown doom scenario"));
    expect(message).toMatch(/refresh failed/i);
    expect(message).toMatch(/unknown doom scenario/);
  });

  it("handles non-Error values via String() — rare but allowed by the Promise contract", () => {
    const message = resolveRefreshError("bare string rejection" as unknown);
    expect(message).toMatch(/refresh failed/i);
    expect(message).toContain("bare string rejection");
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

describe("RefreshFailedError", () => {
  it("carries message + status + optional cause", () => {
    const cause = new Error("underlying");
    const err = new RefreshFailedError("refresh timeout after 10s", 0, cause);
    expect(err.name).toBe("RefreshFailedError");
    expect(err.message).toBe("refresh timeout after 10s");
    expect(err.status).toBe(0);
    expect(err.cause).toBe(cause);
  });
});
