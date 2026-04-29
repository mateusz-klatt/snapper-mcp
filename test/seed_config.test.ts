import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeEnv } from "../src/env.js";
import type { Logger } from "../src/logger.js";
import { seedConfigFileIfPluginContext } from "../src/seed_config.js";

function bridgeEnv(overrides: Partial<BridgeEnv> = {}): BridgeEnv {
  return {
    baseUrl: new URL("https://snapper.example.com/api/mcp/"),
    accessToken: "access-token",
    refreshToken: "refresh-token",
    watchAccessToken: "watch-token",
    ...overrides,
  };
}

function testLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "snapper-mcp-seed-"));
}

async function readSeedFile(root: string): Promise<Record<string, string>> {
  const raw = await readFile(path.join(root, "env.json"), "utf8");
  return JSON.parse(raw) as Record<string, string>;
}

describe("seedConfigFileIfPluginContext", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => {
        await chmod(root, 0o700).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }),
    );
  });

  it("seeds env.json with private permissions when plugin data is set", async () => {
    const root = await tempRoot();
    roots.push(root);
    await seedConfigFileIfPluginContext(
      bridgeEnv(),
      { CLAUDE_PLUGIN_DATA: root } as NodeJS.ProcessEnv,
      testLogger(),
    );
    await expect(readSeedFile(root)).resolves.toEqual({
      SNAPPER_BASE_URL: "https://snapper.example.com/api/mcp/",
      SNAPPER_ACCESS_TOKEN: "access-token",
      SNAPPER_REFRESH_TOKEN: "refresh-token",
      SNAPPER_WATCH_ACCESS_TOKEN: "watch-token",
    });
    if (process.platform !== "win32") {
      expect((await stat(path.join(root, "env.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("always overwrites an existing config file with current values", async () => {
    const root = await tempRoot();
    roots.push(root);
    await writeFile(path.join(root, "env.json"), "{\"SNAPPER_ACCESS_TOKEN\":\"stale\"}", {
      mode: 0o600,
    });
    await seedConfigFileIfPluginContext(
      bridgeEnv({ accessToken: "fresh-access" }),
      { CLAUDE_PLUGIN_DATA: root } as NodeJS.ProcessEnv,
      testLogger(),
    );
    await expect(readSeedFile(root)).resolves.toMatchObject({
      SNAPPER_ACCESS_TOKEN: "fresh-access",
    });
  });

  it("can reseed the same content byte-identically", async () => {
    const root = await tempRoot();
    roots.push(root);
    const source = { CLAUDE_PLUGIN_DATA: root } as NodeJS.ProcessEnv;
    await seedConfigFileIfPluginContext(bridgeEnv(), source, testLogger());
    const first = await readFile(path.join(root, "env.json"), "utf8");
    await seedConfigFileIfPluginContext(bridgeEnv(), source, testLogger());
    const second = await readFile(path.join(root, "env.json"), "utf8");
    expect(second).toBe(first);
  });

  it.each([undefined, "", "   "])("does nothing when plugin data is not usable", async (value) => {
    const root = await tempRoot();
    roots.push(root);
    await seedConfigFileIfPluginContext(
      bridgeEnv(),
      { CLAUDE_PLUGIN_DATA: value } as NodeJS.ProcessEnv,
      testLogger(),
    );
    await expect(readFile(path.join(root, "env.json"), "utf8")).rejects.toThrow();
  });

  it("leaves a complete JSON file after concurrent seed attempts", async () => {
    const root = await tempRoot();
    roots.push(root);
    const source = { CLAUDE_PLUGIN_DATA: root } as NodeJS.ProcessEnv;
    await Promise.all([
      seedConfigFileIfPluginContext(bridgeEnv({ accessToken: "first" }), source, testLogger()),
      seedConfigFileIfPluginContext(bridgeEnv({ accessToken: "second" }), source, testLogger()),
    ]);
    const payload = await readSeedFile(root);
    expect(payload.SNAPPER_ACCESS_TOKEN === "first" || payload.SNAPPER_ACCESS_TOKEN === "second").toBe(
      true,
    );
    expect(payload.SNAPPER_BASE_URL).toBe("https://snapper.example.com/api/mcp/");
  });

  it("warns and continues when the seed target cannot be written", async () => {
    const root = await tempRoot();
    roots.push(root);
    const blocker = path.join(root, "not-a-directory");
    await writeFile(blocker, "x", { mode: 0o600 });
    const logger = testLogger();
    await expect(
      seedConfigFileIfPluginContext(
        bridgeEnv(),
        { CLAUDE_PLUGIN_DATA: blocker } as NodeJS.ProcessEnv,
        logger,
      ),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("does not write token values to logs", async () => {
    const root = await tempRoot();
    roots.push(root);
    const logger = testLogger();
    await seedConfigFileIfPluginContext(
      bridgeEnv({ accessToken: "sensitive-access", watchAccessToken: "sensitive-watch" }),
      { CLAUDE_PLUGIN_DATA: root } as NodeJS.ProcessEnv,
      logger,
    );
    const messages = [...vi.mocked(logger.info).mock.calls, ...vi.mocked(logger.warn).mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(messages).not.toContain("sensitive-access");
    expect(messages).not.toContain("sensitive-watch");
  });

  it("writes blank optional fields when optional tokens are absent", async () => {
    const root = await tempRoot();
    roots.push(root);
    await seedConfigFileIfPluginContext(
      bridgeEnv({ refreshToken: null, watchAccessToken: null }),
      { CLAUDE_PLUGIN_DATA: root } as NodeJS.ProcessEnv,
      testLogger(),
    );
    await expect(readSeedFile(root)).resolves.toMatchObject({
      SNAPPER_REFRESH_TOKEN: "",
      SNAPPER_WATCH_ACCESS_TOKEN: "",
    });
  });
});
