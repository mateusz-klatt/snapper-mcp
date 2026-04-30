import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EnvValidationError, computeWsUrl, parseEnv, parseWatchEnv } from "../src/env.js";

function baseEnv(overrides: Partial<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  return {
    SNAPPER_BASE_URL: "http://localhost:8000/api/mcp",
    SNAPPER_ACCESS_TOKEN: "access-jwt",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("parseEnv", () => {
  it("returns a validated BridgeEnv on the happy path with a trailing slash appended to the base URL path", async () => {
    const result = await parseEnv(baseEnv(), []);
    expect(result.baseUrl).toBeInstanceOf(URL);
    expect(result.baseUrl.toString()).toBe("http://localhost:8000/api/mcp/");
    expect(result.accessToken).toBe("access-jwt");
  });

  it("leaves the URL unchanged when the user already provided a trailing slash", async () => {
    const result = await parseEnv(
      baseEnv({ SNAPPER_BASE_URL: "http://localhost:8000/api/mcp/" }),
      [],
    );
    expect(result.baseUrl.toString()).toBe("http://localhost:8000/api/mcp/");
  });

  it("trims surrounding whitespace on tokens but keeps the canonical URL", async () => {
    const result = await parseEnv(baseEnv({ SNAPPER_ACCESS_TOKEN: "  access-jwt  " }), []);
    expect(result.accessToken).toBe("access-jwt");
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

  it("ignores unknown env vars (silent-ignore contract)", async () => {
    const result = await parseEnv(
      baseEnv({ SOME_UNRELATED_VAR: "ignored", ANOTHER: "also-ignored" } as Record<
        string,
        string
      >),
      [],
    );
    expect(result.accessToken).toBe("access-jwt");
  });

  it("loads values from --config before falling back to environment variables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "snapper-mcp-env-"));
    try {
      const configPath = path.join(root, "env.json");
      await writeFile(
        configPath,
        JSON.stringify({
          SNAPPER_BASE_URL: "https://config.example.com/api/mcp",
          SNAPPER_ACCESS_TOKEN: "config-access",
        }),
        { mode: 0o600 },
      );
      const result = await parseEnv(baseEnv(), [`--config=${configPath}`]);
      expect(result.baseUrl.toString()).toBe("https://config.example.com/api/mcp/");
      expect(result.accessToken).toBe("config-access");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
  it("resolves the same access token as parseEnv", async () => {
    const result = await parseWatchEnv(baseEnv(), []);
    expect(result.baseUrl.toString()).toBe("http://localhost:8000/api/mcp/");
    expect(result.accessToken).toBe("access-jwt");
  });

  it("uses --access-token CLI flag when given", async () => {
    const result = await parseWatchEnv(baseEnv(), ["--access-token", "explicit"]);
    expect(result.accessToken).toBe("explicit");
  });

  it("normalises the base URL to a trailing-slash pathname", async () => {
    const result = await parseWatchEnv(baseEnv(), []);
    expect(result.baseUrl.pathname).toBe("/api/mcp/");
  });

  it("throws EnvValidationError naming SNAPPER_ACCESS_TOKEN when no access token resolves", async () => {
    try {
      await parseWatchEnv(baseEnv({ SNAPPER_ACCESS_TOKEN: undefined }), []);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_ACCESS_TOKEN");
      }
    }
  });

  it("throws EnvValidationError naming SNAPPER_BASE_URL when base URL is missing", async () => {
    try {
      await parseWatchEnv(baseEnv({ SNAPPER_BASE_URL: undefined }), []);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_BASE_URL");
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
