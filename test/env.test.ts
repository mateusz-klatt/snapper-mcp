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

describe("parseEnv multi-profile", () => {
  it("resolves profile-specific env vars when --profile is given", async () => {
    const env = baseEnv({
      SNAPPER_BASE_URL: "http://wrong.example.com/api/mcp",
      SNAPPER_ACCESS_TOKEN: "wrong",
      SNAPPER_PROFILE_PROD_BASE_URL: "https://prod.example.com/api/mcp",
      SNAPPER_PROFILE_PROD_ACCESS_TOKEN: "prod-jwt",
    });
    const result = await parseEnv(env, ["--profile=prod"]);
    expect(result.baseUrl.toString()).toBe("https://prod.example.com/api/mcp/");
    expect(result.accessToken).toBe("prod-jwt");
    expect(result.profile).toBe("prod");
  });

  it("resolves profile-specific env vars when SNAPPER_PROFILE env var is set", async () => {
    const env = baseEnv({
      SNAPPER_PROFILE: "staging",
      SNAPPER_PROFILE_STAGING_BASE_URL: "https://staging.example.com/api/mcp",
      SNAPPER_PROFILE_STAGING_ACCESS_TOKEN: "staging-jwt",
    });
    const result = await parseEnv(env, []);
    expect(result.baseUrl.toString()).toBe("https://staging.example.com/api/mcp/");
    expect(result.accessToken).toBe("staging-jwt");
    expect(result.profile).toBe("staging");
  });

  it("prefers --profile CLI flag over SNAPPER_PROFILE env var", async () => {
    const env = baseEnv({
      SNAPPER_PROFILE: "staging",
      SNAPPER_PROFILE_PROD_BASE_URL: "https://prod.example.com/api/mcp",
      SNAPPER_PROFILE_PROD_ACCESS_TOKEN: "prod-jwt",
      SNAPPER_PROFILE_STAGING_BASE_URL: "https://staging.example.com/api/mcp",
      SNAPPER_PROFILE_STAGING_ACCESS_TOKEN: "staging-jwt",
    });
    const result = await parseEnv(env, ["--profile=prod"]);
    expect(result.baseUrl.toString()).toBe("https://prod.example.com/api/mcp/");
    expect(result.profile).toBe("prod");
  });

  it("falls back to bare env vars when no profile is selected", async () => {
    const result = await parseEnv(baseEnv(), []);
    expect(result.profile).toBeNull();
  });

  it("does NOT fall back to bare env vars when profile is selected (hard isolation)", async () => {
    const env = baseEnv({ SNAPPER_PROFILE: "prod" });
    try {
      await parseEnv(env, []);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      if (err instanceof EnvValidationError) {
        expect(err.variable).toBe("SNAPPER_BASE_URL");
        expect(err.message).toContain("profile=prod");
        expect(err.message).toContain("SNAPPER_PROFILE_PROD_BASE_URL");
      }
    }
  });

  it("names the profile-specific access token env var when missing", async () => {
    const env = baseEnv({
      SNAPPER_PROFILE: "prod",
      SNAPPER_PROFILE_PROD_BASE_URL: "https://prod.example.com/api/mcp",
    });
    try {
      await parseEnv(env, []);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      if (err instanceof EnvValidationError) {
        expect(err.variable).toBe("SNAPPER_ACCESS_TOKEN");
        expect(err.message).toContain("SNAPPER_PROFILE_PROD_ACCESS_TOKEN");
      }
    }
  });

  it("rejects an uppercase profile name", async () => {
    try {
      await parseEnv(baseEnv({ SNAPPER_PROFILE: "PROD" }), []);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      if (err instanceof EnvValidationError) {
        expect(err.variable).toBe("SNAPPER_PROFILE");
        expect(err.message).toMatch(/Invalid profile name/);
      }
    }
  });

  it("rejects a profile name containing an underscore", async () => {
    try {
      await parseEnv(baseEnv(), ["--profile=my_app"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      if (err instanceof EnvValidationError) {
        expect(err.message).toMatch(/Invalid profile name/);
      }
    }
  });

  it("rejects an over-long profile name (>32 chars)", async () => {
    try {
      await parseEnv(baseEnv({ SNAPPER_PROFILE: "a".repeat(33) }), []);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
    }
  });

  it("rejects an empty profile name from --profile", async () => {
    const result = await parseEnv(baseEnv(), ["--profile="]);
    expect(result.profile).toBeNull();
  });

  it("loads profile values from a config file profiles section", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "snapper-mcp-env-"));
    try {
      const configPath = path.join(root, "env.json");
      await writeFile(
        configPath,
        JSON.stringify({
          profiles: {
            prod: {
              SNAPPER_BASE_URL: "https://prod.example.com/api/mcp",
              SNAPPER_ACCESS_TOKEN: "config-prod-jwt",
            },
            staging: {
              SNAPPER_BASE_URL: "https://staging.example.com/api/mcp",
              SNAPPER_ACCESS_TOKEN: "config-staging-jwt",
            },
          },
        }),
        { mode: 0o600 },
      );
      const result = await parseEnv(
        { SNAPPER_PROFILE: "prod" } as NodeJS.ProcessEnv,
        [`--config=${configPath}`],
      );
      expect(result.baseUrl.toString()).toBe("https://prod.example.com/api/mcp/");
      expect(result.accessToken).toBe("config-prod-jwt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls through from missing profile-block key to the profile env var", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "snapper-mcp-env-"));
    try {
      const configPath = path.join(root, "env.json");
      await writeFile(
        configPath,
        JSON.stringify({
          profiles: {
            prod: {
              SNAPPER_BASE_URL: "https://prod.example.com/api/mcp",
            },
          },
        }),
        { mode: 0o600 },
      );
      const env = {
        SNAPPER_PROFILE: "prod",
        SNAPPER_PROFILE_PROD_ACCESS_TOKEN: "env-fallback-jwt",
      } as NodeJS.ProcessEnv;
      const result = await parseEnv(env, [`--config=${configPath}`]);
      expect(result.baseUrl.toString()).toBe("https://prod.example.com/api/mcp/");
      expect(result.accessToken).toBe("env-fallback-jwt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a config file profiles field that is not an object", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "snapper-mcp-env-"));
    try {
      const configPath = path.join(root, "env.json");
      await writeFile(configPath, JSON.stringify({ profiles: ["not", "object"] }), { mode: 0o600 });
      try {
        await parseEnv(baseEnv(), [`--config=${configPath}`]);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(EnvValidationError);
        if (err instanceof EnvValidationError) {
          expect(err.message).toContain("profiles");
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a config file with an invalid profile name", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "snapper-mcp-env-"));
    try {
      const configPath = path.join(root, "env.json");
      await writeFile(
        configPath,
        JSON.stringify({ profiles: { "PROD-ENV": { SNAPPER_BASE_URL: "x" } } }),
        { mode: 0o600 },
      );
      try {
        await parseEnv(baseEnv(), [`--config=${configPath}`]);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(EnvValidationError);
        if (err instanceof EnvValidationError) {
          expect(err.variable).toBe("SNAPPER_PROFILE");
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-object profile block", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "snapper-mcp-env-"));
    try {
      const configPath = path.join(root, "env.json");
      await writeFile(configPath, JSON.stringify({ profiles: { prod: "string-not-object" } }), {
        mode: 0o600,
      });
      try {
        await parseEnv(baseEnv(), [`--config=${configPath}`]);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(EnvValidationError);
        if (err instanceof EnvValidationError) {
          expect(err.message).toContain("profiles.prod");
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-string value inside a profile block", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "snapper-mcp-env-"));
    try {
      const configPath = path.join(root, "env.json");
      await writeFile(
        configPath,
        JSON.stringify({ profiles: { prod: { SNAPPER_BASE_URL: 42 } } }),
        { mode: 0o600 },
      );
      try {
        await parseEnv(baseEnv(), [`--config=${configPath}`]);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(EnvValidationError);
        if (err instanceof EnvValidationError) {
          expect(err.variable).toBe("SNAPPER_BASE_URL");
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes profile name in the error when --config has no profiles section", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "snapper-mcp-env-"));
    try {
      const configPath = path.join(root, "env.json");
      await writeFile(
        configPath,
        JSON.stringify({ SNAPPER_BASE_URL: "https://example.com/api/mcp" }),
        { mode: 0o600 },
      );
      try {
        await parseEnv(
          { SNAPPER_PROFILE: "prod" } as NodeJS.ProcessEnv,
          [`--config=${configPath}`],
        );
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(EnvValidationError);
        if (err instanceof EnvValidationError) {
          expect(err.message).toContain("profiles.prod block");
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
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
