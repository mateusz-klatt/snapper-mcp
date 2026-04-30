import { describe, expect, it, vi } from "vitest";

import {
  EnvValidationError,
  resolveBridgeEnv,
  type CliFlags,
  type ConfigFile,
} from "../src/env.js";
import type { Logger } from "../src/logger.js";

const EMPTY_FLAGS: CliFlags = {
  configPath: null,
  accessToken: null,
  baseUrl: null,
};

function testLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    SNAPPER_BASE_URL: "https://env.example.com/api/mcp",
    SNAPPER_ACCESS_TOKEN: "env-access",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function flags(overrides: Partial<CliFlags> = {}): CliFlags {
  return { ...EMPTY_FLAGS, ...overrides };
}

describe("resolveBridgeEnv", () => {
  it("uses CLI flags before file and environment values", () => {
    const config: ConfigFile = {
      SNAPPER_BASE_URL: "https://file.example.com/api/mcp",
      SNAPPER_ACCESS_TOKEN: "file-access",
    };
    const result = resolveBridgeEnv(
      env(),
      flags({
        baseUrl: "https://cli.example.com/api/mcp",
        accessToken: "cli-access",
      }),
      config,
      testLogger(),
    );
    expect(result.baseUrl.toString()).toBe("https://cli.example.com/api/mcp/");
    expect(result.accessToken).toBe("cli-access");
  });

  it("uses file values before environment values when CLI flags are absent", () => {
    const result = resolveBridgeEnv(
      env(),
      flags(),
      {
        SNAPPER_BASE_URL: "https://file.example.com/api/mcp",
        SNAPPER_ACCESS_TOKEN: "file-access",
      },
      testLogger(),
    );
    expect(result.baseUrl.toString()).toBe("https://file.example.com/api/mcp/");
    expect(result.accessToken).toBe("file-access");
  });

  it("uses environment values when no higher-priority rung resolves", () => {
    const result = resolveBridgeEnv(env(), flags(), null, testLogger());
    expect(result.baseUrl.toString()).toBe("https://env.example.com/api/mcp/");
    expect(result.accessToken).toBe("env-access");
  });

  it("resolves each key independently from the highest available rung", () => {
    const result = resolveBridgeEnv(
      env(),
      flags({ accessToken: "cli-access" }),
      { SNAPPER_BASE_URL: "https://file.example.com/api/mcp" },
      testLogger(),
    );
    expect(result.baseUrl.toString()).toBe("https://file.example.com/api/mcp/");
    expect(result.accessToken).toBe("cli-access");
  });

  it("throws with the missing key and source names when a required key cannot resolve", () => {
    expect(() =>
      resolveBridgeEnv(
        env({ SNAPPER_ACCESS_TOKEN: undefined }),
        flags({ configPath: "/tmp/env.json" }),
        {},
        testLogger(),
      ),
    ).toThrow(EnvValidationError);
    try {
      resolveBridgeEnv(
        env({ SNAPPER_ACCESS_TOKEN: undefined }),
        flags({ configPath: "/tmp/env.json" }),
        {},
        testLogger(),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_ACCESS_TOKEN");
        expect(error.message).toContain("SNAPPER_ACCESS_TOKEN");
        expect(error.message).toContain("--access-token");
        expect(error.message).toContain("--config=/tmp/env.json");
      }
    }
  });

  it("resolves the access token from each supported rung", () => {
    expect(
      resolveBridgeEnv(
        env({ SNAPPER_ACCESS_TOKEN: undefined }),
        flags({ accessToken: "cli-access" }),
        null,
        testLogger(),
      ).accessToken,
    ).toBe("cli-access");
    expect(
      resolveBridgeEnv(
        env({ SNAPPER_ACCESS_TOKEN: undefined }),
        flags(),
        { SNAPPER_ACCESS_TOKEN: "file-access" },
        testLogger(),
      ).accessToken,
    ).toBe("file-access");
    expect(resolveBridgeEnv(env(), flags(), null, testLogger()).accessToken).toBe("env-access");
  });

  it("ignores unknown env vars (silent-ignore contract)", () => {
    const result = resolveBridgeEnv(
      env({ SOME_UNRELATED_VAR: "ignored", ANOTHER: "also-ignored" }),
      flags(),
      null,
      testLogger(),
    );
    expect(result.baseUrl.toString()).toBe("https://env.example.com/api/mcp/");
    expect(result.accessToken).toBe("env-access");
  });
});
