import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, it, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const PLUGIN_MANIFEST_PATH = resolve(REPO_ROOT, ".claude-plugin/plugin.json");
const MARKETPLACE_MANIFEST_PATH = resolve(REPO_ROOT, ".claude-plugin/marketplace.json");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");

interface PluginUserConfigField {
  type: string;
  title: string;
  description: string;
  required: boolean;
  sensitive?: boolean;
}

interface PluginMonitorEntry {
  name: string;
  command: string;
  description: string;
  when?: string;
}

interface PluginManifest {
  name: string;
  version: string;
  description: string;
  userConfig: Record<string, PluginUserConfigField>;
  mcpServers: Record<string, { args: string[]; env: Record<string, string> }>;
  monitors: PluginMonitorEntry[];
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

  it("declares SNAPPER_WATCH_ACCESS_TOKEN as an optional, sensitive userConfig field", () => {
    const field = manifest.userConfig["SNAPPER_WATCH_ACCESS_TOKEN"];
    expect(field).toBeDefined();
    expect(field.required).toBe(false);
    expect(field.sensitive).toBe(true);
  });

  it("keeps SNAPPER_BASE_URL + SNAPPER_ACCESS_TOKEN as required userConfig fields", () => {
    expect(manifest.userConfig["SNAPPER_BASE_URL"].required).toBe(true);
    expect(manifest.userConfig["SNAPPER_ACCESS_TOKEN"].required).toBe(true);
  });

  it("ships a single monitor entry with all required fields", () => {
    expect(Array.isArray(manifest.monitors)).toBe(true);
    expect(manifest.monitors).toHaveLength(1);
    const monitor = manifest.monitors[0];
    expect(monitor.name).toBe("snapper-watch");
    expect(monitor.description.length).toBeGreaterThan(0);
    expect(typeof monitor.command).toBe("string");
    expect(monitor.command.length).toBeGreaterThan(0);
  });

  it(`pins the monitor command to the @${"${pkg.version}"} runtime tag`, () => {
    const monitor = manifest.monitors[0];
    expect(monitor.command).toContain(`@mateusz-klatt/snapper-mcp@${pkg.version}`);
  });

  it("invokes the watch subcommand", () => {
    const monitor = manifest.monitors[0];
    expect(monitor.command).toMatch(/snapper-mcp@[^\s]+\s+watch\s*$/);
  });

  it("does NOT embed any substitution form into the monitor command (credentials must travel via the auto-exported CLAUDE_PLUGIN_OPTION_<KEY> env var, not via argv — this catches ${user_config.X}, ${ENV_VAR}, ${CLAUDE_PLUGIN_ROOT}, and any other ${...} form)", () => {
    const monitor = manifest.monitors[0];
    expect(monitor.command).not.toContain("${");
    expect(monitor.command).not.toContain("SNAPPER_ACCESS_TOKEN");
    expect(monitor.command).not.toContain("SNAPPER_WATCH_ACCESS_TOKEN");
  });

  it("does NOT shell-wrap or env-prefix the monitor command (no cross-env, no sh -c, no set, no =)", () => {
    const monitor = manifest.monitors[0];
    expect(monitor.command).not.toContain("cross-env");
    expect(monitor.command).not.toMatch(/\bsh\s+-c\b/);
    expect(monitor.command).not.toMatch(/\bcmd\s+\/[Cc]\b/);
    expect(monitor.command).not.toContain("=");
  });

  it("starts with `npx -y` so the runtime tarball resolves regardless of the operator's npm cache state", () => {
    const monitor = manifest.monitors[0];
    expect(monitor.command).toMatch(/^npx\s+-y\s+/);
  });

  it("keeps marketplace metadata + nested plugin entry in lockstep with the runtime version", () => {
    expect(marketplace.metadata.version).toBe(pkg.version);
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].version).toBe(pkg.version);
  });
});
