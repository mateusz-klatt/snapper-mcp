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
  refreshToken: null,
  watchAccessToken: null,
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
    SNAPPER_REFRESH_TOKEN: "env-refresh",
    SNAPPER_WATCH_ACCESS_TOKEN: "env-watch",
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
      SNAPPER_REFRESH_TOKEN: "file-refresh",
      SNAPPER_WATCH_ACCESS_TOKEN: "file-watch",
    };
    const result = resolveBridgeEnv(
      env(),
      flags({
        baseUrl: "https://cli.example.com/api/mcp",
        accessToken: "cli-access",
        refreshToken: "cli-refresh",
        watchAccessToken: "cli-watch",
      }),
      config,
      "proxy",
      testLogger(),
    );
    expect(result.baseUrl.toString()).toBe("https://cli.example.com/api/mcp/");
    expect(result.accessToken).toBe("cli-access");
    expect(result.refreshToken).toBe("cli-refresh");
    expect(result.watchAccessToken).toBe("cli-watch");
  });

  it("uses file values before environment values when CLI flags are absent", () => {
    const result = resolveBridgeEnv(
      env(),
      flags(),
      {
        SNAPPER_BASE_URL: "https://file.example.com/api/mcp",
        SNAPPER_ACCESS_TOKEN: "file-access",
        SNAPPER_REFRESH_TOKEN: "file-refresh",
        SNAPPER_WATCH_ACCESS_TOKEN: "file-watch",
      },
      "proxy",
      testLogger(),
    );
    expect(result.baseUrl.toString()).toBe("https://file.example.com/api/mcp/");
    expect(result.accessToken).toBe("file-access");
    expect(result.refreshToken).toBe("file-refresh");
    expect(result.watchAccessToken).toBe("file-watch");
  });

  it("uses environment values when no higher-priority rung resolves", () => {
    const result = resolveBridgeEnv(env(), flags(), null, "proxy", testLogger());
    expect(result.baseUrl.toString()).toBe("https://env.example.com/api/mcp/");
    expect(result.accessToken).toBe("env-access");
    expect(result.refreshToken).toBe("env-refresh");
    expect(result.watchAccessToken).toBe("env-watch");
  });

  it("resolves each key independently from the highest available rung", () => {
    const result = resolveBridgeEnv(
      env({ SNAPPER_REFRESH_TOKEN: "env-refresh" }),
      flags({ accessToken: "cli-access" }),
      {
        SNAPPER_BASE_URL: "https://file.example.com/api/mcp",
        SNAPPER_WATCH_ACCESS_TOKEN: "file-watch",
      },
      "proxy",
      testLogger(),
    );
    expect(result.baseUrl.toString()).toBe("https://file.example.com/api/mcp/");
    expect(result.accessToken).toBe("cli-access");
    expect(result.refreshToken).toBe("env-refresh");
    expect(result.watchAccessToken).toBe("file-watch");
  });

  it("throws with the missing key and source names when a required proxy key cannot resolve", () => {
    expect(() =>
      resolveBridgeEnv(
        env({ SNAPPER_ACCESS_TOKEN: undefined }),
        flags({ configPath: "/tmp/env.json" }),
        {},
        "proxy",
        testLogger(),
      ),
    ).toThrow(EnvValidationError);
    try {
      resolveBridgeEnv(
        env({ SNAPPER_ACCESS_TOKEN: undefined }),
        flags({ configPath: "/tmp/env.json" }),
        {},
        "proxy",
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

  it("uses the watch-token CLI flag before the access-token CLI escape hatch in watch mode", () => {
    const result = resolveBridgeEnv(
      env({ SNAPPER_WATCH_ACCESS_TOKEN: undefined }),
      flags({ accessToken: "cli-access", watchAccessToken: "cli-watch" }),
      null,
      "watch",
      testLogger(),
    );
    expect(result.accessToken).toBe("cli-watch");
    expect(result.watchAccessToken).toBe("cli-watch");
  });

  it("uses the access-token CLI flag as an explicit watch-mode escape hatch", () => {
    const result = resolveBridgeEnv(
      env({ SNAPPER_WATCH_ACCESS_TOKEN: undefined }),
      flags({ accessToken: "cli-access" }),
      null,
      "watch",
      testLogger(),
    );
    expect(result.accessToken).toBe("cli-access");
    expect(result.watchAccessToken).toBe("cli-access");
  });

  it("uses the watch token from the config file without falling back to the file access token", () => {
    const result = resolveBridgeEnv(
      env({ SNAPPER_WATCH_ACCESS_TOKEN: undefined }),
      flags(),
      {
        SNAPPER_ACCESS_TOKEN: "file-access",
        SNAPPER_WATCH_ACCESS_TOKEN: "file-watch",
      },
      "watch",
      testLogger(),
    );
    expect(result.accessToken).toBe("file-watch");
    expect(result.watchAccessToken).toBe("file-watch");
  });

  it("does not use the file access token as a watch token fallback", () => {
    expect(() =>
      resolveBridgeEnv(
        env({ SNAPPER_WATCH_ACCESS_TOKEN: undefined }),
        flags(),
        { SNAPPER_ACCESS_TOKEN: "file-access" },
        "watch",
        testLogger(),
      ),
    ).toThrow(EnvValidationError);
  });

  it("does not use the environment access token as a watch token fallback", () => {
    expect(() =>
      resolveBridgeEnv(
        env({ SNAPPER_WATCH_ACCESS_TOKEN: undefined }),
        flags(),
        null,
        "watch",
        testLogger(),
      ),
    ).toThrow(EnvValidationError);
  });

  it("resolves the proxy access token from each supported rung", () => {
    expect(
      resolveBridgeEnv(
        env({ SNAPPER_ACCESS_TOKEN: undefined }),
        flags({ accessToken: "cli-access" }),
        null,
        "proxy",
        testLogger(),
      ).accessToken,
    ).toBe("cli-access");
    expect(
      resolveBridgeEnv(
        env({ SNAPPER_ACCESS_TOKEN: undefined }),
        flags(),
        { SNAPPER_ACCESS_TOKEN: "file-access" },
        "proxy",
        testLogger(),
      ).accessToken,
    ).toBe("file-access");
    expect(resolveBridgeEnv(env(), flags(), null, "proxy", testLogger()).accessToken).toBe(
      "env-access",
    );
  });
});
