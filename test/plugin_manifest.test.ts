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

  it("declares no monitors, so installing the plugin starts no background process", () => {
    expect(manifest.monitors).toBeUndefined();
  });

  it("keeps marketplace metadata + nested plugin entry in lockstep with the runtime version", () => {
    expect(marketplace.metadata.version).toBe(pkg.version);
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].version).toBe(pkg.version);
  });
});

describe("wake skill", () => {
  const skill = readFileSync(WAKE_SKILL_PATH, "utf8");
  const pkg = loadJson<{ version: string }>(PACKAGE_JSON_PATH);

  it("is named `wake` and cannot be invoked by the model", () => {
    expect(skill).toMatch(/^---\r?\n/);
    expect(skill).toMatch(/^name:\s*wake\s*$/m);
    expect(skill).toMatch(/^disable-model-invocation:\s*true\s*$/m);
  });

  it(`pins the arm command to the @${"${pkg.version}"} runtime tag`, () => {
    expect(skill).toContain(`@mateusz-klatt/snapper-mcp@${pkg.version}`);
  });

  it("arms the watch subcommand via `npx -y`", () => {
    expect(skill).toMatch(/npx\s+-y\s+@mateusz-klatt\/snapper-mcp@[^\s]+\s+watch\b/);
  });

  it("carries no credential values or manifest substitutions", () => {
    expect(skill).not.toContain("${user_config.");
    expect(skill).not.toMatch(/SNAPPER_ACCESS_TOKEN\s*=/);
  });

  it("tells the reader to check for an existing monitor before starting one", () => {
    expect(skill.toLowerCase()).toContain("already");
  });
});
