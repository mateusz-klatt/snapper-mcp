import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EnvValidationError, loadConfigFile, type ConfigFile } from "../src/env.js";
import type { Logger } from "../src/logger.js";

function testLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "snapper-mcp-config-"));
}

async function writeJson(filePath: string, value: unknown, mode = 0o600): Promise<void> {
  await writeFile(filePath, JSON.stringify(value), { mode });
}

describe("loadConfigFile", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("loads a JSON config file with all known keys", async () => {
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "env.json");
    const expected: ConfigFile = {
      SNAPPER_BASE_URL: "https://snapper.example.com/api/mcp",
      SNAPPER_ACCESS_TOKEN: "access",
      SNAPPER_REFRESH_TOKEN: "refresh",
      SNAPPER_WATCH_ACCESS_TOKEN: "watch",
    };
    await writeJson(filePath, expected);
    await expect(loadConfigFile(filePath, testLogger())).resolves.toEqual(expected);
  });

  it("loads a JSON config file with a subset of known keys", async () => {
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "env.json");
    await writeJson(filePath, { SNAPPER_BASE_URL: "https://snapper.example.com/api/mcp" });
    await expect(loadConfigFile(filePath, testLogger())).resolves.toEqual({
      SNAPPER_BASE_URL: "https://snapper.example.com/api/mcp",
    });
  });

  it("returns an empty config object for an empty JSON object", async () => {
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "env.json");
    await writeJson(filePath, {});
    await expect(loadConfigFile(filePath, testLogger())).resolves.toEqual({});
  });

  it("throws when the file is empty", async () => {
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "env.json");
    await writeFile(filePath, "", { mode: 0o600 });
    await expect(loadConfigFile(filePath, testLogger())).rejects.toBeInstanceOf(EnvValidationError);
  });

  it.each([null, [], "string", 42])("throws when the JSON root is not an object", async (value) => {
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "env.json");
    await writeJson(filePath, value);
    await expect(loadConfigFile(filePath, testLogger())).rejects.toBeInstanceOf(EnvValidationError);
  });

  it("throws when the file contains malformed JSON", async () => {
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "env.json");
    await writeFile(filePath, "{", { mode: 0o600 });
    await expect(loadConfigFile(filePath, testLogger())).rejects.toBeInstanceOf(EnvValidationError);
  });

  it("returns null when a missing file stays missing through the retry budget", async () => {
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "missing-env.json");
    await expect(loadConfigFile(filePath, testLogger())).resolves.toBeNull();
  });

  it("loads a missing file that appears before the retry budget is exhausted", async () => {
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "delayed-env.json");
    const timer = setTimeout(() => {
      void writeJson(filePath, { SNAPPER_ACCESS_TOKEN: "access" });
    }, 100);
    try {
      await expect(loadConfigFile(filePath, testLogger())).resolves.toEqual({
        SNAPPER_ACCESS_TOKEN: "access",
      });
    } finally {
      clearTimeout(timer);
    }
  });

  it("ignores unknown keys for forward compatibility", async () => {
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "env.json");
    await writeJson(filePath, { SNAPPER_ACCESS_TOKEN: "access", EXTRA_KEY: "future" });
    await expect(loadConfigFile(filePath, testLogger())).resolves.toEqual({
      SNAPPER_ACCESS_TOKEN: "access",
    });
  });

  it("throws when a known key has a non-string value", async () => {
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "env.json");
    await writeJson(filePath, { SNAPPER_ACCESS_TOKEN: 123 });
    await expect(loadConfigFile(filePath, testLogger())).rejects.toBeInstanceOf(EnvValidationError);
  });

  it("throws when the file is world-writable on POSIX", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "env.json");
    await writeJson(filePath, { SNAPPER_ACCESS_TOKEN: "access" }, 0o606);
    await chmod(filePath, 0o606);
    await expect(loadConfigFile(filePath, testLogger())).rejects.toBeInstanceOf(EnvValidationError);
  });

  it("loads a Windows-style file without applying POSIX mode-bit hardening", async () => {
    if (process.platform !== "win32") return;
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "env.json");
    await writeJson(filePath, { SNAPPER_ACCESS_TOKEN: "access" });
    await expect(loadConfigFile(filePath, testLogger())).resolves.toEqual({
      SNAPPER_ACCESS_TOKEN: "access",
    });
  });

  it("throws when the file exceeds the size limit", async () => {
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "env.json");
    await writeFile(filePath, `"${"x".repeat(2 * 1024 * 1024)}"`, { mode: 0o600 });
    await expect(loadConfigFile(filePath, testLogger())).rejects.toBeInstanceOf(EnvValidationError);
  });

  it.runIf(process.platform !== "win32")(
    "throws when a POSIX symlink target resolves to a non-regular file",
    async () => {
      const root = await tempRoot();
      roots.push(root);
      const filePath = path.join(root, "device-link");
      await symlink("/dev/null", filePath);
      await expect(loadConfigFile(filePath, testLogger())).rejects.toBeInstanceOf(
        EnvValidationError,
      );
    },
  );

  it("warns but loads when a config file is group-readable on POSIX", async () => {
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "env.json");
    await writeJson(filePath, { SNAPPER_ACCESS_TOKEN: "access" }, 0o640);
    await chmod(filePath, 0o640);
    const logger = testLogger();
    await expect(loadConfigFile(filePath, logger)).resolves.toEqual({
      SNAPPER_ACCESS_TOKEN: "access",
    });
    if (process.platform !== "win32") {
      expect(logger.warn).toHaveBeenCalledTimes(1);
    }
  });

  it("throws immediately when the path is a directory", async () => {
    const root = await tempRoot();
    roots.push(root);
    await expect(loadConfigFile(root, testLogger())).rejects.toBeInstanceOf(EnvValidationError);
  });

  it("wraps non-ENOENT stat failures in EnvValidationError", async () => {
    await expect(loadConfigFile("\0bad-path", testLogger())).rejects.toBeInstanceOf(
      EnvValidationError,
    );
  });

  it("wraps read failures after a successful stat in EnvValidationError", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = await tempRoot();
    roots.push(root);
    const filePath = path.join(root, "unreadable.json");
    await writeJson(filePath, { SNAPPER_ACCESS_TOKEN: "access" }, 0o200);
    await chmod(filePath, 0o200);
    await expect(loadConfigFile(filePath, testLogger())).rejects.toBeInstanceOf(
      EnvValidationError,
    );
    await chmod(filePath, 0o600);
  });
});
