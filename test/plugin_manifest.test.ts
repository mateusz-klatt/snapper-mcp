import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, it, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const PLUGIN_MANIFEST_PATH = resolve(REPO_ROOT, ".claude-plugin/plugin.json");
const MARKETPLACE_MANIFEST_PATH = resolve(REPO_ROOT, ".claude-plugin/marketplace.json");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");
const WAKE_SKILL_PATH = resolve(REPO_ROOT, "skills/wake/SKILL.md");
const LOCKFILE_PATH = resolve(REPO_ROOT, "package-lock.json");

interface PluginUserConfigField {
  type: string;
  title: string;
  description: string;
  required: boolean;
  sensitive?: boolean;
}

interface PluginManifest {
  name: string;
  version: string;
  description: string;
  userConfig: Record<string, PluginUserConfigField>;
  mcpServers: Record<string, { args: string[]; env: Record<string, string> }>;
  monitors?: unknown;
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("plugin manifest", () => {
  const manifest = loadJson<PluginManifest>(PLUGIN_MANIFEST_PATH);
  const pkg = loadJson<{ version: string }>(PACKAGE_JSON_PATH);
  const marketplace = loadJson<{
    metadata: { version: string };
    plugins: { version: string }[];
  }>(MARKETPLACE_MANIFEST_PATH);

  it("reports a version that matches the runtime npm package version", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it(`re-pins mcpServers.args to the matching @${"${pkg.version}"} runtime tag`, () => {
    const args = manifest.mcpServers["snapper"].args;
    expect(args).toContain(`@mateusz-klatt/snapper-mcp@${pkg.version}`);
  });

  it("declares exactly two userConfig fields", () => {
    expect(Object.keys(manifest.userConfig).sort((a, b) => a.localeCompare(b))).toEqual([
      "SNAPPER_ACCESS_TOKEN",
      "SNAPPER_BASE_URL",
    ]);
  });

  it("declares SNAPPER_BASE_URL + SNAPPER_ACCESS_TOKEN as required userConfig fields", () => {
    expect(manifest.userConfig["SNAPPER_BASE_URL"].required).toBe(true);
    expect(manifest.userConfig["SNAPPER_ACCESS_TOKEN"].required).toBe(true);
    expect(manifest.userConfig["SNAPPER_ACCESS_TOKEN"].sensitive).toBe(true);
  });

  it("passes both credential fields to the proxy MCP server (and only those)", () => {
    const env = manifest.mcpServers["snapper"].env;
    expect(env["SNAPPER_BASE_URL"]).toBe("${user_config.SNAPPER_BASE_URL}");
    expect(env["SNAPPER_ACCESS_TOKEN"]).toBe("${user_config.SNAPPER_ACCESS_TOKEN}");
    expect(Object.keys(env).sort((a, b) => a.localeCompare(b))).toEqual([
      "SNAPPER_ACCESS_TOKEN",
      "SNAPPER_BASE_URL",
    ]);
  });

  it("ships exactly one monitor, pinned to the runtime tag and invoking watch", () => {
    const monitors = manifest.monitors as { name: string; command: string; when: string }[];
    expect(Array.isArray(monitors)).toBe(true);
    expect(monitors).toHaveLength(1);
    expect(monitors[0].command).toContain(`@mateusz-klatt/snapper-mcp@${pkg.version}`);
    expect(monitors[0].command).toMatch(/^npx\s+-y\s+/);
    expect(monitors[0].command).toContain('--config="${CLAUDE_PLUGIN_DATA}/env.json"');
    expect(monitors[0].command).not.toContain("${user_config.");
  });

  it("arms the monitor on the PLUGIN-QUALIFIED skill key, not the bare skill name", () => {
    // The runtime compares `when === \`on-skill-invoke:${key}\`` where key is the
    // skill-usage key — for plugin skills that is `<plugin name>:<skill>`. A bare
    // skill name never matches and the monitor silently never arms, which is what
    // the reference docs' "the named skill in this plugin" wording invites.
    const monitors = manifest.monitors as { when: string }[];
    expect(monitors[0].when).toBe(`on-skill-invoke:${manifest.name}:wake`);
  });

  it("keeps marketplace metadata + nested plugin entry in lockstep with the runtime version", () => {
    expect(marketplace.metadata.version).toBe(pkg.version);
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].version).toBe(pkg.version);
  });

  it("keeps the lockfile in lockstep with the runtime version", () => {
    const lock = loadJson<{ version: string; packages: Record<string, { version?: string }> }>(
      LOCKFILE_PATH,
    );
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });
});

describe("wake skill", () => {
  const skill = readFileSync(WAKE_SKILL_PATH, "utf8");
  const manifestSource = readFileSync(PLUGIN_MANIFEST_PATH, "utf8");
  const pkg = loadJson<{ version: string }>(PACKAGE_JSON_PATH);
  const RUNTIME_TAG = /@mateusz-klatt\/snapper-mcp@(\d+\.\d+\.\d+)/g;

  it("is named `wake` and cannot be invoked by the model", () => {
    expect(skill).toMatch(/^---\r?\n/);
    expect(skill).toMatch(/^name:\s*wake\s*$/m);
    expect(skill).toMatch(/^disable-model-invocation:\s*true\s*$/m);
  });

  it("carries the exact arm command: pinned tag, watch subcommand, seeded config path", () => {
    expect(skill).toContain(
      `npx -y @mateusz-klatt/snapper-mcp@${pkg.version} watch --config="$CLAUDE_PLUGIN_DATA/env.json"`,
    );
  });

  it("leaves no stale runtime pin anywhere in the skill or the manifest", () => {
    for (const source of [skill, manifestSource]) {
      const pins = [...source.matchAll(RUNTIME_TAG)].map((match) => match[1]);
      expect(pins.length).toBeGreaterThan(0);
      for (const pin of pins) expect(pin).toBe(pkg.version);
    }
  });

  it("carries no credential values or manifest substitutions", () => {
    expect(skill).not.toContain("${user_config.");
    expect(skill).not.toMatch(/SNAPPER_ACCESS_TOKEN\s*=/);
    expect(skill).not.toMatch(/--access-token[= ]\s*[A-Za-z0-9._-]{20,}/);
  });

  it("orders the duplicate guard ahead of the fallback arm command", () => {
    const guard = skill.indexOf("pgrep");
    const arm = skill.indexOf("npx -y");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(arm).toBeGreaterThan(guard);
  });

  it("keeps the config preflight on the fallback path", () => {
    expect(skill).toContain("test -f");
  });

  it("names the same qualified trigger the manifest arms on", () => {
    const manifest = loadJson<{ name: string }>(PLUGIN_MANIFEST_PATH);
    expect(skill).toContain(`on-skill-invoke:${manifest.name}:wake`);
  });

  it("verifies the subscription covers review requests after arming", () => {
    const arm = skill.indexOf("npx -y");
    const verify = skill.indexOf("subscribing to topics");
    expect(verify).toBeGreaterThan(arm);
    expect(skill).toContain("ai_reviews.");
  });

  it("demands the event-per-line monitor primitive, not a backgrounded shell", () => {
    expect(skill).toContain("Monitor tool");
    expect(skill).toMatch(/never to exit|no wakeups/);
  });

  it("warns that --topic would drop the review-request subscription", () => {
    expect(skill).toContain("--topic");
  });
});
