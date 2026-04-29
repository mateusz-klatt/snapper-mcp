import { describe, expect, it } from "vitest";

import {
  EnvValidationError,
  computeRefreshUrl,
  computeWsUrl,
  parseEnv,
  parseWatchEnv,
} from "../src/env.js";

function baseEnv(overrides: Partial<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  return {
    SNAPPER_BASE_URL: "http://localhost:8000/api/mcp",
    SNAPPER_ACCESS_TOKEN: "access-jwt",
    SNAPPER_REFRESH_TOKEN: "refresh-jwt",
    SNAPPER_WATCH_ACCESS_TOKEN: "watch-jwt",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("parseEnv", () => {
  it("returns a validated BridgeEnv on the happy path with a trailing slash appended to the base URL path", async () => {
    const result = await parseEnv(baseEnv(), []);
    expect(result.baseUrl).toBeInstanceOf(URL);
    expect(result.baseUrl.toString()).toBe("http://localhost:8000/api/mcp/");
    expect(result.accessToken).toBe("access-jwt");
    expect(result.refreshToken).toBe("refresh-jwt");
    expect(result.watchAccessToken).toBe("watch-jwt");
  });

  it("leaves the URL unchanged when the user already provided a trailing slash", async () => {
    const result = await parseEnv(
      baseEnv({ SNAPPER_BASE_URL: "http://localhost:8000/api/mcp/" }),
      [],
    );
    expect(result.baseUrl.toString()).toBe("http://localhost:8000/api/mcp/");
  });

  it("trims surrounding whitespace on tokens but keeps the canonical URL", async () => {
    const result = await parseEnv(
      baseEnv({
        SNAPPER_ACCESS_TOKEN: "  access-jwt  ",
        SNAPPER_REFRESH_TOKEN: "\trefresh-jwt\n",
        SNAPPER_WATCH_ACCESS_TOKEN: " watch-jwt ",
      }),
      [],
    );
    expect(result.accessToken).toBe("access-jwt");
    expect(result.refreshToken).toBe("refresh-jwt");
    expect(result.watchAccessToken).toBe("watch-jwt");
  });

  it("throws EnvValidationError with the missing variable name when SNAPPER_BASE_URL is absent", async () => {
    await expect(parseEnv(baseEnv({ SNAPPER_BASE_URL: undefined }), [])).rejects.toThrow(
      EnvValidationError,
    );
    try {
      await parseEnv(baseEnv({ SNAPPER_BASE_URL: undefined }), []);
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_BASE_URL");
        expect(error.message).toContain("SNAPPER_BASE_URL");
        expect(error.message).toContain(".mcp.json");
      }
    }
  });

  it("throws with the exact variable name when SNAPPER_ACCESS_TOKEN is absent", async () => {
    try {
      await parseEnv(baseEnv({ SNAPPER_ACCESS_TOKEN: undefined }), []);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_ACCESS_TOKEN");
      }
    }
  });

  it("returns refreshToken=null when SNAPPER_REFRESH_TOKEN is absent", async () => {
    const result = await parseEnv(baseEnv({ SNAPPER_REFRESH_TOKEN: undefined }), []);
    expect(result.accessToken).toBe("access-jwt");
    expect(result.refreshToken).toBeNull();
  });

  it("returns refreshToken=null when SNAPPER_REFRESH_TOKEN is blank", async () => {
    const result = await parseEnv(baseEnv({ SNAPPER_REFRESH_TOKEN: "   " }), []);
    expect(result.refreshToken).toBeNull();
  });

  it("returns watchAccessToken=null when SNAPPER_WATCH_ACCESS_TOKEN is blank", async () => {
    const result = await parseEnv(baseEnv({ SNAPPER_WATCH_ACCESS_TOKEN: "" }), []);
    expect(result.watchAccessToken).toBeNull();
  });

  it("legacy rotating setup with the original three env vars still parses", async () => {
    const result = await parseEnv(baseEnv({ SNAPPER_WATCH_ACCESS_TOKEN: undefined }), []);
    expect(result.accessToken).toBe("access-jwt");
    expect(result.refreshToken).toBe("refresh-jwt");
    expect(result.watchAccessToken).toBeNull();
  });

  it("rejects blank access tokens", async () => {
    try {
      await parseEnv(baseEnv({ SNAPPER_ACCESS_TOKEN: "   " }), []);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_ACCESS_TOKEN");
        expect(error.message).toMatch(/Missing required SNAPPER_ACCESS_TOKEN/);
      }
    }
  });

  it("rejects an unparseable SNAPPER_BASE_URL", async () => {
    try {
      await parseEnv(baseEnv({ SNAPPER_BASE_URL: "not-a-url" }), []);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_BASE_URL");
        expect(error.message).toMatch(/not a valid URL/);
      }
    }
  });
});

describe("computeRefreshUrl", () => {
  it("derives the refresh endpoint from an /api/mcp base", () => {
    const refresh = computeRefreshUrl(new URL("http://localhost:8000/api/mcp"));
    expect(refresh.pathname).toBe("/api/auth/refresh");
    expect(refresh.origin).toBe("http://localhost:8000");
    expect(refresh.searchParams.get("return_tokens")).toBe("true");
    expect(refresh.toString()).toBe("http://localhost:8000/api/auth/refresh?return_tokens=true");
  });

  it("does not concatenate the refresh path onto the /api/mcp segment", () => {
    const refresh = computeRefreshUrl(new URL("https://snapper.example.com/api/mcp"));
    expect(refresh.pathname).toBe("/api/auth/refresh");
    expect(refresh.pathname.startsWith("/api/mcp")).toBe(false);
  });

  it("preserves https scheme, host, and port", () => {
    const refresh = computeRefreshUrl(new URL("https://snapper.example.com:8443/api/mcp"));
    expect(refresh.origin).toBe("https://snapper.example.com:8443");
    expect(refresh.toString()).toBe(
      "https://snapper.example.com:8443/api/auth/refresh?return_tokens=true",
    );
  });

  it("always sets return_tokens=true", () => {
    const refresh = computeRefreshUrl(new URL("http://localhost:8000/api/mcp"));
    expect(refresh.search).toContain("return_tokens=true");
  });
});

describe("computeWsUrl", () => {
  it("derives ws://{host}/api/ws from an http /api/mcp base URL", () => {
    const ws = computeWsUrl(new URL("http://localhost:8000/api/mcp"));
    expect(ws.protocol).toBe("ws:");
    expect(ws.host).toBe("localhost:8000");
    expect(ws.pathname).toBe("/api/ws");
    expect(ws.search).toBe("");
    expect(ws.toString()).toBe("ws://localhost:8000/api/ws");
  });

  it("derives wss://{host}/api/ws from an https base URL", () => {
    const ws = computeWsUrl(new URL("https://snapper.example.com/api/mcp"));
    expect(ws.protocol).toBe("wss:");
    expect(ws.host).toBe("snapper.example.com");
    expect(ws.toString()).toBe("wss://snapper.example.com/api/ws");
  });

  it("preserves a non-default port in the ws host", () => {
    const ws = computeWsUrl(new URL("https://snapper.example.com:8443/api/mcp"));
    expect(ws.host).toBe("snapper.example.com:8443");
    expect(ws.toString()).toBe("wss://snapper.example.com:8443/api/ws");
  });

  it("normalises a trailing slash on /api/mcp/ before deriving the WS path", () => {
    const ws = computeWsUrl(new URL("http://localhost:8000/api/mcp/"));
    expect(ws.toString()).toBe("ws://localhost:8000/api/ws");
  });

  it("strips any query string and hash before deriving the WS URL", () => {
    const base = new URL("https://snapper.example.com/api/mcp?foo=bar#frag");
    const ws = computeWsUrl(base);
    expect(ws.search).toBe("");
    expect(ws.hash).toBe("");
    expect(ws.toString()).toBe("wss://snapper.example.com/api/ws");
  });

  it("rejects a base URL whose pathname is not /api/mcp", () => {
    try {
      computeWsUrl(new URL("https://snapper.example.com/api/different"));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_BASE_URL");
        expect(error.message).toContain("/api/mcp");
        expect(error.message).toContain("/api/different");
      }
    }
  });

  it("rejects an empty pathname", () => {
    try {
      computeWsUrl(new URL("https://snapper.example.com/"));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_BASE_URL");
      }
    }
  });

  it("rejects a non-http(s) scheme such as ws:// or file://", () => {
    try {
      computeWsUrl(new URL("ws://localhost:8000/api/mcp"));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.message).toMatch(/http:\/\/ or https:\/\//);
      }
    }
  });
});

describe("parseWatchEnv", () => {
  it("returns a BridgeEnv with refreshToken hard-pinned to null", async () => {
    const result = await parseWatchEnv(baseEnv(), []);
    expect(result.baseUrl.toString()).toBe("http://localhost:8000/api/mcp/");
    expect(result.accessToken).toBe("watch-jwt");
    expect(result.refreshToken).toBeNull();
    expect(result.watchAccessToken).toBe("watch-jwt");
  });

  it("uses --access-token as an explicit watch-mode escape hatch", async () => {
    const result = await parseWatchEnv(
      baseEnv({ SNAPPER_WATCH_ACCESS_TOKEN: undefined }),
      ["--access-token", "manual-watch"],
    );
    expect(result.accessToken).toBe("manual-watch");
    expect(result.watchAccessToken).toBe("manual-watch");
  });

  it("normalises the base URL to a trailing-slash pathname", async () => {
    const result = await parseWatchEnv(baseEnv(), []);
    expect(result.baseUrl.pathname).toBe("/api/mcp/");
  });

  it("throws EnvValidationError naming SNAPPER_WATCH_ACCESS_TOKEN when no watch token resolves", async () => {
    try {
      await parseWatchEnv(baseEnv({ SNAPPER_WATCH_ACCESS_TOKEN: undefined }), []);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_WATCH_ACCESS_TOKEN");
      }
    }
  });

  it("throws EnvValidationError naming SNAPPER_BASE_URL when access resolves but base URL does not", async () => {
    try {
      await parseWatchEnv(
        baseEnv({ SNAPPER_BASE_URL: undefined, SNAPPER_WATCH_ACCESS_TOKEN: "pat" }),
        [],
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_BASE_URL");
      }
    }
  });

  it("does not use SNAPPER_ACCESS_TOKEN as a watch token fallback from env vars", async () => {
    try {
      await parseWatchEnv(
        baseEnv({
          SNAPPER_ACCESS_TOKEN: "proxy-only",
          SNAPPER_WATCH_ACCESS_TOKEN: undefined,
        }),
        [],
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_WATCH_ACCESS_TOKEN");
      }
    }
  });

  it("rejects a base URL whose value is unparseable", async () => {
    try {
      await parseWatchEnv(baseEnv({ SNAPPER_BASE_URL: "not a url" }), []);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_BASE_URL");
      }
    }
  });
});
