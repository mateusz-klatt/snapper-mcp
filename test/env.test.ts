import { describe, it, expect } from "vitest";

import {
  EnvValidationError,
  computeRefreshUrl,
  computeWsUrl,
  isClaudeCodePluginContext,
  parseEnv,
  parseWatchEnv,
  watchAccessToken,
} from "../src/env.js";

function baseEnv(overrides: Partial<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  return {
    SNAPPER_BASE_URL: "http://localhost:8000/api/mcp",
    SNAPPER_ACCESS_TOKEN: "access-jwt",
    SNAPPER_REFRESH_TOKEN: "refresh-jwt",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("parseEnv", () => {
  it("returns a validated BridgeEnv on the happy path with a trailing slash appended to the base URL path", () => {
    const result = parseEnv(baseEnv());
    expect(result.baseUrl).toBeInstanceOf(URL);
    expect(result.baseUrl.toString()).toBe("http://localhost:8000/api/mcp/");
    expect(result.accessToken).toBe("access-jwt");
    expect(result.refreshToken).toBe("refresh-jwt");
  });

  it("leaves the URL unchanged when the user already provided a trailing slash", () => {
    const result = parseEnv(baseEnv({ SNAPPER_BASE_URL: "http://localhost:8000/api/mcp/" }));
    expect(result.baseUrl.toString()).toBe("http://localhost:8000/api/mcp/");
  });

  it("trims surrounding whitespace on tokens but keeps the canonical URL", () => {
    const result = parseEnv(
      baseEnv({ SNAPPER_ACCESS_TOKEN: "  access-jwt  ", SNAPPER_REFRESH_TOKEN: "\trefresh-jwt\n" }),
    );
    expect(result.accessToken).toBe("access-jwt");
    expect(result.refreshToken).toBe("refresh-jwt");
  });

  it("throws EnvValidationError with the missing variable name when SNAPPER_BASE_URL is absent", () => {
    expect(() => parseEnv(baseEnv({ SNAPPER_BASE_URL: undefined }))).toThrow(EnvValidationError);
    try {
      parseEnv(baseEnv({ SNAPPER_BASE_URL: undefined }));
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_BASE_URL");
        expect(error.message).toContain("SNAPPER_BASE_URL");
      }
    }
  });

  it("throws with the exact variable name when SNAPPER_ACCESS_TOKEN is absent", () => {
    try {
      parseEnv(baseEnv({ SNAPPER_ACCESS_TOKEN: undefined }));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_ACCESS_TOKEN");
      }
    }
  });

  it("returns refreshToken=null when SNAPPER_REFRESH_TOKEN is absent (PAT mode since v0.2.0)", () => {
    const result = parseEnv(baseEnv({ SNAPPER_REFRESH_TOKEN: undefined }));
    expect(result.accessToken).toBe("access-jwt");
    expect(result.refreshToken).toBeNull();
  });

  it("returns refreshToken=null when SNAPPER_REFRESH_TOKEN is blank (whitespace-only)", () => {
    const result = parseEnv(baseEnv({ SNAPPER_REFRESH_TOKEN: "   " }));
    expect(result.refreshToken).toBeNull();
  });

  it("returns refreshToken=null when SNAPPER_REFRESH_TOKEN is the empty string", () => {
    const result = parseEnv(baseEnv({ SNAPPER_REFRESH_TOKEN: "" }));
    expect(result.refreshToken).toBeNull();
  });

  it("legacy rotating setup with all three env vars still parses identically", () => {
    const result = parseEnv(baseEnv());
    expect(result.accessToken).toBe("access-jwt");
    expect(result.refreshToken).toBe("refresh-jwt");
  });

  it("rejects blank (whitespace-only) tokens", () => {
    try {
      parseEnv(baseEnv({ SNAPPER_ACCESS_TOKEN: "   " }));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_ACCESS_TOKEN");
        expect(error.message).toMatch(/empty/i);
      }
    }
  });

  it("rejects an unparseable SNAPPER_BASE_URL", () => {
    try {
      parseEnv(baseEnv({ SNAPPER_BASE_URL: "not-a-url" }));
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
  it("derives ${origin}/api/auth/refresh?return_tokens=true from an /api/mcp base", () => {
    const refresh = computeRefreshUrl(new URL("http://localhost:8000/api/mcp"));
    expect(refresh.pathname).toBe("/api/auth/refresh");
    expect(refresh.origin).toBe("http://localhost:8000");
    expect(refresh.searchParams.get("return_tokens")).toBe("true");
    expect(refresh.toString()).toBe("http://localhost:8000/api/auth/refresh?return_tokens=true");
  });

  it("does NOT concatenate the refresh path onto the /api/mcp segment", () => {
    const refresh = computeRefreshUrl(new URL("https://snapper.example.com/api/mcp"));
    expect(refresh.pathname).toBe("/api/auth/refresh");
    expect(refresh.pathname.startsWith("/api/mcp")).toBe(false);
  });

  it("preserves https scheme + host + port", () => {
    const refresh = computeRefreshUrl(new URL("https://snapper.example.com:8443/api/mcp"));
    expect(refresh.origin).toBe("https://snapper.example.com:8443");
    expect(refresh.toString()).toBe(
      "https://snapper.example.com:8443/api/auth/refresh?return_tokens=true",
    );
  });

  it("always sets return_tokens=true — backend returns null tokens without it", () => {
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

  it("strips any query string + hash before deriving the WS URL", () => {
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

  it("rejects an empty pathname (operator pointed bridge at the bare origin)", () => {
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

describe("isClaudeCodePluginContext", () => {
  it("returns true when CLAUDE_PLUGIN_OPTION_SNAPPER_BASE_URL is set (the documented userConfig auto-export signal)", () => {
    expect(
      isClaudeCodePluginContext({
        CLAUDE_PLUGIN_OPTION_SNAPPER_BASE_URL: "https://snapper.example.com/api/mcp",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("returns true when CLAUDE_PLUGIN_ROOT is set (defensive fallback signal, since some Claude Code versions also export it)", () => {
    expect(isClaudeCodePluginContext({ CLAUDE_PLUGIN_ROOT: "/some/path" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("returns false when neither CLAUDE_PLUGIN_OPTION_* nor CLAUDE_PLUGIN_ROOT is set (standalone host or manual CLI run)", () => {
    expect(isClaudeCodePluginContext({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("returns true even when the signal env var is the empty string (presence of the var, not its value, signals plugin context)", () => {
    expect(isClaudeCodePluginContext({ CLAUDE_PLUGIN_ROOT: "" } as NodeJS.ProcessEnv)).toBe(true);
    expect(
      isClaudeCodePluginContext({ CLAUDE_PLUGIN_OPTION_SNAPPER_BASE_URL: "" } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("watchAccessToken", () => {
  it("prefers CLAUDE_PLUGIN_OPTION_SNAPPER_WATCH_ACCESS_TOKEN over every other rung", () => {
    const result = watchAccessToken({
      CLAUDE_PLUGIN_OPTION_SNAPPER_BASE_URL: "https://x.test/api/mcp",
      CLAUDE_PLUGIN_OPTION_SNAPPER_WATCH_ACCESS_TOKEN: "watch-pat",
      SNAPPER_WATCH_ACCESS_TOKEN: "standalone-watch",
      CLAUDE_PLUGIN_OPTION_SNAPPER_ACCESS_TOKEN: "plugin-proxy",
      SNAPPER_ACCESS_TOKEN: "standalone-proxy",
    } as NodeJS.ProcessEnv);
    expect(result).toBe("watch-pat");
  });

  it("falls back to SNAPPER_WATCH_ACCESS_TOKEN when only the standalone-context watch token is set", () => {
    const result = watchAccessToken({
      SNAPPER_WATCH_ACCESS_TOKEN: "standalone-watch",
      SNAPPER_ACCESS_TOKEN: "standalone-proxy",
    } as NodeJS.ProcessEnv);
    expect(result).toBe("standalone-watch");
  });

  it("falls back to SNAPPER_ACCESS_TOKEN in standalone context (no Claude Code plugin signals present)", () => {
    const result = watchAccessToken({
      SNAPPER_ACCESS_TOKEN: "standalone-proxy",
    } as NodeJS.ProcessEnv);
    expect(result).toBe("standalone-proxy");
  });

  it("DECLINES the SNAPPER_ACCESS_TOKEN fallback in plugin context — the proxy delegate's token is rotating and would die at access-expiry, re-introducing the v0.4.0 deferral failure mode", () => {
    const result = watchAccessToken({
      CLAUDE_PLUGIN_OPTION_SNAPPER_BASE_URL: "https://x.test/api/mcp",
      CLAUDE_PLUGIN_OPTION_SNAPPER_ACCESS_TOKEN: "rotating-proxy-token",
      SNAPPER_ACCESS_TOKEN: "rotating-proxy-token-mirror",
    } as NodeJS.ProcessEnv);
    expect(result).toBeNull();
  });

  it("declines fallback in plugin context detected via CLAUDE_PLUGIN_ROOT alone (defensive belt — same decline)", () => {
    const result = watchAccessToken({
      CLAUDE_PLUGIN_ROOT: "/path/to/plugin",
      SNAPPER_ACCESS_TOKEN: "rotating-proxy-token",
    } as NodeJS.ProcessEnv);
    expect(result).toBeNull();
  });

  it("returns null when every rung is unset", () => {
    expect(watchAccessToken({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("treats blank or whitespace-only values as unset and continues down the chain", () => {
    const result = watchAccessToken({
      CLAUDE_PLUGIN_OPTION_SNAPPER_WATCH_ACCESS_TOKEN: "  ",
      SNAPPER_WATCH_ACCESS_TOKEN: "  real-token  ",
    } as NodeJS.ProcessEnv);
    expect(result).toBe("real-token");
  });

  it("trims surrounding whitespace from the resolved value", () => {
    const result = watchAccessToken({
      CLAUDE_PLUGIN_OPTION_SNAPPER_BASE_URL: "https://x.test/api/mcp",
      CLAUDE_PLUGIN_OPTION_SNAPPER_WATCH_ACCESS_TOKEN: "  jwt-with-padding  ",
    } as NodeJS.ProcessEnv);
    expect(result).toBe("jwt-with-padding");
  });
});

describe("parseWatchEnv", () => {
  it("returns a BridgeEnv with refreshToken hard-pinned to null even when SNAPPER_REFRESH_TOKEN is set in the source", () => {
    const result = parseWatchEnv({
      SNAPPER_BASE_URL: "https://snapper.example.com/api/mcp",
      SNAPPER_ACCESS_TOKEN: "standalone-pat",
      SNAPPER_REFRESH_TOKEN: "should-be-ignored",
    } as NodeJS.ProcessEnv);
    expect(result.baseUrl.toString()).toBe("https://snapper.example.com/api/mcp/");
    expect(result.accessToken).toBe("standalone-pat");
    expect(result.refreshToken).toBeNull();
  });

  it("prefers the CLAUDE_PLUGIN_OPTION_* rung over SNAPPER_* in plugin context", () => {
    const result = parseWatchEnv({
      CLAUDE_PLUGIN_OPTION_SNAPPER_BASE_URL: "https://plugin.example.com/api/mcp",
      CLAUDE_PLUGIN_OPTION_SNAPPER_WATCH_ACCESS_TOKEN: "plugin-watch-pat",
      SNAPPER_BASE_URL: "https://standalone.example.com/api/mcp",
      SNAPPER_ACCESS_TOKEN: "standalone-token",
    } as NodeJS.ProcessEnv);
    expect(result.baseUrl.toString()).toBe("https://plugin.example.com/api/mcp/");
    expect(result.accessToken).toBe("plugin-watch-pat");
  });

  it("normalises the base URL to a trailing-slash pathname (parity with parseEnv)", () => {
    const result = parseWatchEnv({
      SNAPPER_BASE_URL: "http://localhost:8000/api/mcp",
      SNAPPER_ACCESS_TOKEN: "pat",
    } as NodeJS.ProcessEnv);
    expect(result.baseUrl.pathname).toBe("/api/mcp/");
  });

  it("throws EnvValidationError naming SNAPPER_ACCESS_TOKEN when no rung resolves", () => {
    try {
      parseWatchEnv({
        SNAPPER_BASE_URL: "https://snapper.example.com/api/mcp",
      } as NodeJS.ProcessEnv);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_ACCESS_TOKEN");
      }
    }
  });

  it("throws EnvValidationError naming SNAPPER_BASE_URL when access resolves but base URL does not", () => {
    try {
      parseWatchEnv({
        SNAPPER_ACCESS_TOKEN: "pat",
      } as NodeJS.ProcessEnv);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_BASE_URL");
      }
    }
  });

  it("throws EnvValidationError naming SNAPPER_ACCESS_TOKEN when in plugin context with proxy-token-only — declines the rotating-delegate fallback that would die at access-expiry", () => {
    try {
      parseWatchEnv({
        CLAUDE_PLUGIN_OPTION_SNAPPER_BASE_URL: "https://snapper.example.com/api/mcp",
        CLAUDE_PLUGIN_OPTION_SNAPPER_ACCESS_TOKEN: "rotating-proxy-token",
      } as NodeJS.ProcessEnv);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_ACCESS_TOKEN");
      }
    }
  });

  it("rejects a base URL whose value is unparseable", () => {
    try {
      parseWatchEnv({
        SNAPPER_BASE_URL: "not a url",
        SNAPPER_ACCESS_TOKEN: "pat",
      } as NodeJS.ProcessEnv);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_BASE_URL");
      }
    }
  });
});
