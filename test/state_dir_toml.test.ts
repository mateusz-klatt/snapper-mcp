import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireSessionLock,
  assertNotSymlinkOrSpecial,
  defaultConfigFilePath,
  defaultIsPidAlive,
  ensurePrivateDir,
  isWakeEnabled,
  loadManifest,
  mutateLockedJsonFile,
  readBytesIfPresent,
  readRuntimeJsonFile,
  readTextIfPresent,
  readWakePreference,
  removeWakePreference,
  resolveHomeDir,
  resolveStateDir,
  saveManifest,
  sha256Hex,
  UnsafeFileTargetError,
  unwireManagedClient,
  updateManagedFile,
  writeFileAtomic,
  writeWakePreference,
} from "../src/state_dir.js";
import {
  inspectCodexSnapperBlock,
  inspectGrokSnapperTable,
  inspectKimiHooksBlock,
  readMarkedBlock,
  removeCodexSnapperBlock,
  removeGrokSnapperTable,
  removeKimiHooksBlock,
  removeMarkedBlock,
  tomlBasicString,
  TomlEditError,
  tomlStringArray,
  upsertCodexSnapperBlock,
  upsertGrokSnapperTable,
  upsertKimiHooksBlock,
  upsertMarkedBlock,
  validateKimiHooksBlock,
} from "../src/toml_edit.js";

describe("state_dir", () => {
  const tempDirs: string[] = [];

  async function makeTemp(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "snapper-mcp-state-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves OS-aware home and state directories", () => {
    expect(resolveHomeDir({ HOME: "/tmp/h1" }, "linux")).toBe(path.resolve("/tmp/h1"));
    expect(resolveHomeDir({ USERPROFILE: "/tmp/w1" }, "win32")).toBe(path.resolve("/tmp/w1"));
    expect(resolveHomeDir({}, "linux").length).toBeGreaterThan(0);

    expect(resolveStateDir({ SNAPPER_MCP_HOME: "/tmp/custom" }, "linux")).toBe(
      path.resolve("/tmp/custom"),
    );
    expect(resolveStateDir({ HOME: "/tmp/u", XDG_CONFIG_HOME: "/tmp/xdg" }, "linux")).toBe(
      path.join(path.resolve("/tmp/xdg"), "snapper-mcp"),
    );
    expect(resolveStateDir({ HOME: "/tmp/u" }, "linux")).toBe(
      path.join(path.resolve("/tmp/u"), ".config", "snapper-mcp"),
    );
    expect(resolveStateDir({ HOME: "/tmp/u" }, "darwin")).toBe(
      path.join(path.resolve("/tmp/u"), "Library", "Application Support", "snapper-mcp"),
    );
    expect(resolveStateDir({ USERPROFILE: "/tmp/u", APPDATA: "/tmp/roam" }, "win32")).toBe(
      path.join(path.resolve("/tmp/roam"), "snapper-mcp"),
    );
    expect(resolveStateDir({ USERPROFILE: "/tmp/u" }, "win32")).toBe(
      path.join(path.resolve("/tmp/u"), "AppData", "Roaming", "snapper-mcp"),
    );
    expect(defaultConfigFilePath({ SNAPPER_MCP_HOME: "/tmp/s" }, "linux")).toBe(
      path.join(path.resolve("/tmp/s"), "config.json"),
    );
  });

  it("checks PID liveness and refuses symlinks and directories where regular files are expected", async () => {
    expect(defaultIsPidAlive(process.pid)).toBe(true);
    expect(defaultIsPidAlive(-1)).toBe(false);
    expect(defaultIsPidAlive(999_999_999)).toBe(false);

    const dir = await makeTemp();
    await ensurePrivateDir(path.join(dir, "sub"), "linux");
    await ensurePrivateDir(path.join(dir, "sub-win"), "win32");

    await expect(assertNotSymlinkOrSpecial(path.join(dir, "sub"), false)).rejects.toThrow(
      UnsafeFileTargetError,
    );
    await expect(assertNotSymlinkOrSpecial(path.join(dir, "sub"), true)).resolves.toBeUndefined();

    const realFile = path.join(dir, "real.txt");
    await writeFileAtomic(realFile, "hello\n", { mode: 0o600, platform: "win32" });
    expect(await readTextIfPresent(realFile)).toBe("hello\n");
    expect((await readBytesIfPresent(realFile))?.toString("utf8")).toBe("hello\n");
    expect(await readTextIfPresent(path.join(dir, "missing.txt"))).toBeNull();
    expect(await readBytesIfPresent(path.join(dir, "missing.txt"))).toBeNull();

    const linkPath = path.join(dir, "link.txt");
    await symlink(realFile, linkPath);
    await expect(writeFileAtomic(linkPath, "bad")).rejects.toThrow(UnsafeFileTargetError);
  });

  it("acquires session locks exclusively and requires quiescent stale recovery", async () => {
    const stateDir = await makeTemp();
    const aliveSet = new Set<number>([101]);
    const sessionKey = "101:abc";

    const first = await acquireSessionLock({
      stateDir,
      client: "grok",
      sessionKey,
      pid: 101,
      isPidAlive: (p) => aliveSet.has(p),
    });
    expect(first.acquired).toBe(true);

    const duplicate = await acquireSessionLock({
      stateDir,
      client: "grok",
      sessionKey,
      pid: 102,
      isPidAlive: (p) => aliveSet.has(p),
    });
    expect(duplicate.acquired).toBe(false);
    await duplicate.release();

    aliveSet.delete(101);
    aliveSet.add(103);
    await expect(
      acquireSessionLock({
        stateDir,
        client: "grok",
        sessionKey,
        pid: 103,
        isPidAlive: (p) => aliveSet.has(p),
      }),
    ).rejects.toThrow("QUIESCENT");

    const lockPath = path.join(
      stateDir,
      "locks",
      `grok-${sha256Hex(sessionKey).slice(0, 24)}.lock`,
    );
    await first.release();
    await rm(lockPath, { force: true });
    const recovered = await acquireSessionLock({
      stateDir,
      client: "grok",
      sessionKey,
      pid: 103,
      isPidAlive: (p) => aliveSet.has(p),
    });
    expect(recovered.acquired).toBe(true);
    await recovered.release();
  });

  it("requires quiescent mutex and data recovery before mutating runtime JSON", async () => {
    const stateDir = await makeTemp();
    const runtimeDir = path.join(stateDir, "runtime");
    await ensurePrivateDir(runtimeDir);
    const mutexPath = path.join(runtimeDir, "sample.mutex");
    const dataPath = path.join(runtimeDir, "sample.json");
    await writeFile(mutexPath, "{not-json", "utf8");
    await writeFile(dataPath, "{corrupt", "utf8");

    const mutate = (): Promise<number> =>
      mutateLockedJsonFile({
        stateDir,
        name: "sample",
        initial: () => ({ count: 0 }),
        mutate: (cur) => ({ next: { count: cur.count + 5 }, result: cur.count + 5 }),
      });
    await expect(mutate()).rejects.toThrow("QUIESCENT");
    expect(await readTextIfPresent(mutexPath)).toBe("{not-json");

    await rm(mutexPath, { force: true });
    await expect(mutate()).rejects.toMatchObject({
      name: "StateDataRecoveryRequiredError",
      dataPath,
    });
    await rm(dataPath, { force: true });
    await expect(mutate()).resolves.toBe(5);
    expect(await readRuntimeJsonFile(stateDir, "sample", () => ({ count: 0 }))).toEqual({
      count: 5,
    });
    expect(await readRuntimeJsonFile(stateDir, "absent", () => ({ count: 9 }))).toEqual({
      count: 9,
    });
  });

  it("manages wake preference markers and rejects malformed markers", async () => {
    const stateDir = await makeTemp();
    expect(await readWakePreference(stateDir, "kimi")).toBeNull();
    expect(isWakeEnabled(null)).toBe(false);
    expect(isWakeEnabled("default")).toBe(true);
    expect(isWakeEnabled("on")).toBe(true);
    expect(isWakeEnabled("off")).toBe(false);

    await writeWakePreference(stateDir, "kimi", "on");
    expect(await readWakePreference(stateDir, "kimi")).toBe("on");
    await removeWakePreference(stateDir, "kimi");
    expect(await readWakePreference(stateDir, "kimi")).toBeNull();

    await writeFileAtomic(path.join(stateDir, "wake", "kimi.pref"), "bogus\n");
    await expect(readWakePreference(stateDir, "kimi")).rejects.toThrow(
      /invalid wake preference/,
    );
  });

  it("restores untouched files byte-for-byte and surgically strips user-modified files", async () => {
    const stateDir = await makeTemp();
    const workDir = await makeTemp();

    const preExistingPath = path.join(workDir, "user-config.json");
    const exactOriginalBytes = '{\n  "customComment": "preserve   exact   spacing" \n}';
    await writeFile(preExistingPath, exactOriginalBytes, "utf8");

    const createdPath = path.join(workDir, "nested", "created.json");

    await updateManagedFile({
      stateDir,
      client: "cursor",
      targetPath: preExistingPath,
      render: () => '{\n  "customComment": "preserve   exact   spacing",\n  "snapper": true\n}\n',
    });
    // Idempotent second call when rendered text matches current text:
    await updateManagedFile({
      stateDir,
      client: "cursor",
      targetPath: preExistingPath,
      render: (cur) => cur!,
    });
    await updateManagedFile({
      stateDir,
      client: "cursor",
      targetPath: createdPath,
      render: () => '{"created":true}\n',
    });

    const manifest = await loadManifest(stateDir);
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0]?.writtenSha256).toHaveLength(64);

    await unwireManagedClient({
      stateDir,
      client: "cursor",
      strip: () => null,
    });

    expect(await readFile(preExistingPath, "utf8")).toBe(exactOriginalBytes);
    expect(await readTextIfPresent(createdPath)).toBeNull();
    expect(await readTextIfPresent(path.join(workDir, "nested"))).toBeNull();

    // Now test user editing the file AFTER integrate ran:
    await updateManagedFile({
      stateDir,
      client: "copilot",
      targetPath: preExistingPath,
      render: () => '{"user":"v1","snapper":true}\n',
    });
    await writeFile(preExistingPath, '{"user":"v2-edited-by-human","snapper":true}\n', "utf8");

    await unwireManagedClient({
      stateDir,
      client: "copilot",
      strip: (_filePath, current) => {
        const doc = JSON.parse(current) as Record<string, unknown>;
        delete doc["snapper"];
        return `${JSON.stringify(doc)}\n`;
      },
    });
    expect(await readFile(preExistingPath, "utf8")).toBe('{"user":"v2-edited-by-human"}\n');

    // Invalid manifest rejection:
    await saveManifest(stateDir, { version: 1, entries: [] });
    await writeFile(path.join(stateDir, "manifest.json"), "{bad", "utf8");
    await expect(loadManifest(stateDir)).rejects.toThrow(/not valid JSON/);
    await writeFile(path.join(stateDir, "manifest.json"), '{"version":99}', "utf8");
    await expect(loadManifest(stateDir)).rejects.toThrow(/unsupported format/);
    expect(sha256Hex("abc")).toHaveLength(64);
  });
});

describe("toml_edit (smol-toml AST verified)", () => {
  it("escapes control characters and validates marker invariants", () => {
    const escaped = tomlBasicString('a\\b"c\bd\te\nf\fg\r\u0001\u007f');
    expect(escaped).toContain("\\u0001");
    expect(escaped).toContain("\\u007f");
    expect(tomlStringArray(["x", "y"])).toBe('["x", "y"]');

    const doc = upsertMarkedBlock('title = "demo"\n', '[extra]\nflag = true');
    expect(readMarkedBlock(doc)).toBe("[extra]\nflag = true");
    expect(removeMarkedBlock(doc)).toBe('title = "demo"\n');
    expect(removeMarkedBlock('title = "demo"\n')).toBe('title = "demo"\n');

    expect(() => upsertMarkedBlock("invalid = [", "x = 1")).toThrow(TomlEditError);
    expect(() => readMarkedBlock("# BEGIN snapper-mcp\nx = 1\n")).toThrow(TomlEditError);
    expect(() =>
      readMarkedBlock("# END snapper-mcp\nx = 1\n# BEGIN snapper-mcp\n"),
    ).toThrow(TomlEditError);
  });

  it("upserts, inspects, and removes Codex [mcp_servers.snapper] while refusing unmanaged tables", () => {
    const base = [
      'model = "gpt-5.4"',
      "",
      "[mcp_servers.other]",
      'command = "iris"',
      'args = ["mcp"]',
      "",
    ].join("\n");

    const withWake = upsertCodexSnapperBlock(base, {
      command: "/usr/local/bin/snapper-mcp",
      configPath: "/etc/snapper/config.json",
      wake: true,
    });
    expect(inspectCodexSnapperBlock(withWake)).toEqual({
      configured: true,
      wakeEnabled: true,
    });

    const withoutWake = upsertCodexSnapperBlock(withWake, {
      command: "/usr/local/bin/snapper-mcp",
      configPath: "/etc/snapper/config.json",
      wake: false,
    });
    expect(inspectCodexSnapperBlock(withoutWake)).toEqual({
      configured: true,
      wakeEnabled: false,
    });

    const stripped = removeCodexSnapperBlock(withoutWake);
    expect(inspectCodexSnapperBlock(stripped)).toEqual({
      configured: false,
      wakeEnabled: false,
    });
    expect(stripped).toContain('[mcp_servers.other]');
    expect(inspectCodexSnapperBlock("not valid [")).toEqual({
      configured: false,
      wakeEnabled: false,
    });

    // Unmanaged [mcp_servers.snapper] outside markers must fail closed:
    const unmanaged = '[mcp_servers.snapper]\ncommand = "custom"\nargs = []\n';
    expect(() =>
      upsertCodexSnapperBlock(unmanaged, {
        command: "snapper-mcp",
        configPath: "/tmp/c.json",
        wake: true,
      }),
    ).toThrow(/unmanaged \[mcp_servers\.snapper\]/);
  });

  it("adopts unmarked Grok [mcp_servers.snapper] tables and preserves unrelated keys", () => {
    // Simulates Grok UI stripping comments when saving config.toml:
    const grokSaved = [
      'theme = "dark"',
      "",
      "[mcp_servers.snapper]",
      'command = "old-snapper-mcp"',
      'args = ["--config", "/old.json"]',
      "enabled = true",
      "",
      "[mcp_servers.iris]",
      'command = "iris"',
      'args = ["mcp", "--client", "grok"]',
      "",
    ].join("\n");

    const adopted = upsertGrokSnapperTable(grokSaved, {
      command: "snapper-mcp",
      configPath: "/new/config.json",
    });
    expect(adopted).toContain("# BEGIN snapper-mcp");
    expect(adopted).toContain('"/new/config.json"');
    expect(adopted).not.toContain("old-snapper-mcp");
    expect(inspectGrokSnapperTable(adopted)).toBe(true);

    const removed = removeGrokSnapperTable(adopted);
    expect(inspectGrokSnapperTable(removed)).toBe(false);
    expect(removed).toContain('[mcp_servers.iris]');
    expect(removed).toContain('theme = "dark"');

    // Inline dotted table fallback:
    const inlineGrok = 'theme = "light"\nmcp_servers.snapper = { command = "x", args = [] }\n';
    const cleanedInline = removeGrokSnapperTable(inlineGrok);
    expect(inspectGrokSnapperTable(cleanedInline)).toBe(false);
    expect(cleanedInline).toContain('theme = "light"');
    expect(inspectGrokSnapperTable("bad = [")).toBe(false);
  });

  it("validates Kimi [[hooks]] keys strictly and preserves unrelated Kimi settings", () => {
    expect(() =>
      validateKimiHooksBlock('[[hooks]]\nevent = "Stop"\ncommand = "x"\nunknown_key = true\n'),
    ).toThrow(/unsupported key/);
    expect(() => validateKimiHooksBlock('other = 1\n')).toThrow(/only \[\[hooks\]\]/);

    const existing = [
      'default_model = "kimi-k2"',
      "",
      "[[hooks]]",
      'event = "SessionStart"',
      'command = "iris hook --client kimi --event SessionStart"',
      "timeout = 5",
      "",
    ].join("\n");

    const updated = upsertKimiHooksBlock(existing, [
      {
        event: "UserPromptSubmit",
        command: "snapper-mcp hook --client kimi --event UserPromptSubmit --config /c.json",
        timeout: 5,
      },
    ]);
    expect(inspectKimiHooksBlock(updated)).toBe(true);

    const stripped = removeKimiHooksBlock(updated);
    expect(inspectKimiHooksBlock(stripped)).toBe(false);
    expect(stripped).toContain("iris hook --client kimi");
    expect(inspectKimiHooksBlock("invalid = [")).toBe(false);
  });
});
