import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ALL_CLIENTS } from "../src/clients.js";
import { doctorMain, parseDoctorArgs } from "../src/doctor.js";
import { integrateMain, parseIntegrateArgs } from "../src/integrate.js";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll(/=+$/g, "");
}

function makeValidJwt(expOffsetSec = 3600): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encodeBase64Url(
    JSON.stringify({
      sub: "delegate-1",
      role: "AI_DELEGATE",
      scopes: ["read.orders"],
      exp: Math.floor(Date.now() / 1000) + expOffsetSec,
    }),
  );
  return `${header}.${payload}.test-secret-signature`;
}

class TextCapture {
  private readonly chunks: string[] = [];

  write = (chunk: string | Uint8Array): boolean => {
    this.chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  };

  text(): string {
    return this.chunks.join("");
  }
}

describe("parseIntegrateArgs & parseDoctorArgs", () => {
  it("parses integrate and doctor CLI flags and rejects invalid arguments", () => {
    const intParsed = parseIntegrateArgs([
      "codex",
      "cursor",
      "--no-wake",
      "--bin=/usr/local/bin/snapper-mcp",
      "--config=/tmp/c.json",
    ]);
    expect(intParsed.clients).toEqual(["codex", "cursor"]);
    expect(intParsed.wake).toBe(false);
    expect(intParsed.remove).toBe(false);
    expect(intParsed.invocation).toEqual({ command: "/usr/local/bin/snapper-mcp" });

    const intSpace = parseIntegrateArgs(["all", "--remove", "--wake", "--bin", "snapper-mcp"]);
    expect(intSpace.clients).toEqual(ALL_CLIENTS);
    expect(intSpace.remove).toBe(true);
    expect(intSpace.wake).toBe(true);

    expect(() => parseIntegrateArgs(["codex", "--bin"])).toThrow(/--bin requires/);
    expect(() => parseIntegrateArgs(["codex", "--bin="])).toThrow(/--bin requires/);
    expect(() => parseIntegrateArgs(["codex", "--unknown"])).toThrow(/unknown argument/);

    const docDefault = parseDoctorArgs([]);
    expect(docDefault.clients).toEqual(ALL_CLIENTS);

    const docSubset = parseDoctorArgs(["--client", "codex", "--client=grok", "kimi"]);
    expect(docSubset.clients).toEqual(["codex", "grok", "kimi"]);

    expect(() => parseDoctorArgs(["--client"])).toThrow(/--client requires/);
    expect(() => parseDoctorArgs(["--client="])).toThrow(/--client requires/);
    expect(() => parseDoctorArgs(["--bad"])).toThrow(/unknown argument/);
  });
});

describe("integrateMain & doctorMain across all 7 CLIs", () => {
  let rootDir: string;
  let homeDir: string;
  let stateDir: string;
  let jwtToken: string;
  let baseEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "snapper-integrate-"));
    homeDir = path.join(rootDir, "home");
    stateDir = path.join(rootDir, "state");
    await mkdir(homeDir, { recursive: true });
    jwtToken = makeValidJwt(7200);
    baseEnv = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      SNAPPER_MCP_HOME: stateDir,
      SNAPPER_BASE_URL: "https://snapper.example.com/api/mcp",
      SNAPPER_ACCESS_TOKEN: jwtToken,
    };
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("wires all 7 CLIs cleanly, passes doctor, transitions to --no-wake, and removes cleanly", async () => {
    const out1 = new TextCapture();
    const err1 = new TextCapture();
    const code1 = await integrateMain({
      argv: ["all"],
      source: baseEnv,
      platform: "linux",
      invocation: { command: "/opt/bin/snapper-mcp" },
      stdout: out1,
      stderr: err1,
    });
    expect(code1).toBe(0);
    expect(err1.text()).toBe("");
    for (const cli of ALL_CLIENTS) {
      expect(out1.text()).toContain(`${cli}: wired`);
    }

    const configPath = path.join(stateDir, "config.json");
    const configStat = await stat(configPath);
    expect(configStat.mode & 0o777).toBe(0o600);

    const clientFiles = [
      path.join(stateDir, "plugins", "claude-marketplace", "plugins", "snapper", ".mcp.json"),
      path.join(stateDir, "plugins", "claude-marketplace", "plugins", "snapper", "monitors", "monitors.json"),
      path.join(homeDir, ".codex", "config.toml"),
      path.join(homeDir, ".codex", "hooks.json"),
      path.join(homeDir, ".copilot", "mcp-config.json"),
      path.join(homeDir, ".copilot", "extensions", "snapper", "extension.mjs"),
      path.join(homeDir, ".gemini", "config", "mcp_config.json"),
      path.join(homeDir, ".gemini", "config", "hooks.json"),
      path.join(homeDir, ".kimi-code", "mcp.json"),
      path.join(homeDir, ".kimi-code", "config.toml"),
      path.join(homeDir, ".grok", "config.toml"),
      path.join(homeDir, ".grok", "hooks", "snapper.json"),
      path.join(homeDir, ".cursor", "mcp.json"),
      path.join(homeDir, ".cursor", "hooks.json"),
    ];
    for (const f of clientFiles) {
      const content = await readFile(f, "utf8");
      expect(content).not.toContain(jwtToken);
    }

    const docOut = new TextCapture();
    const docErr = new TextCapture();
    const docCode = await doctorMain({
      argv: [],
      source: { HOME: homeDir, SNAPPER_MCP_HOME: stateDir },
      platform: "linux",
      stdout: docOut,
      stderr: docErr,
    });
    expect(docCode).toBe(0);
    for (const cli of ALL_CLIENTS) {
      expect(docOut.text()).toContain(`  ${cli}: mcp=configured, wake=on`);
    }

    const codeIdem = await integrateMain({
      argv: [
        "all",
        "--base-url",
        "https://snapper.example.com/api/mcp",
        "--access-token",
        jwtToken,
      ],
      source: { HOME: homeDir, SNAPPER_MCP_HOME: stateDir },
      platform: "linux",
      invocation: { command: "/opt/bin/snapper-mcp" },
      stdout: new TextCapture(),
      stderr: new TextCapture(),
    });
    expect(codeIdem).toBe(0);

    const noWakeOut = new TextCapture();
    expect(
      await integrateMain({
        argv: ["all", "--no-wake"],
        source: { HOME: homeDir, SNAPPER_MCP_HOME: stateDir },
        platform: "linux",
        invocation: { command: "/opt/bin/snapper-mcp" },
        stdout: noWakeOut,
        stderr: new TextCapture(),
      }),
    ).toBe(0);

    const docOffOut = new TextCapture();
    expect(
      await doctorMain({
        argv: ["--client", "all"],
        source: { HOME: homeDir, SNAPPER_MCP_HOME: stateDir },
        platform: "linux",
        stdout: docOffOut,
        stderr: new TextCapture(),
      }),
    ).toBe(0);
    for (const cli of ALL_CLIENTS) {
      expect(docOffOut.text()).toContain(`  ${cli}: mcp=configured, wake=off`);
    }

    const rmOut = new TextCapture();
    expect(
      await integrateMain({
        argv: ["all", "--remove"],
        source: { HOME: homeDir, SNAPPER_MCP_HOME: stateDir },
        platform: "linux",
        stdout: rmOut,
        stderr: new TextCapture(),
      }),
    ).toBe(0);

    const docEmptyOut = new TextCapture();
    expect(
      await doctorMain({
        argv: [],
        source: { HOME: homeDir, SNAPPER_MCP_HOME: stateDir },
        platform: "linux",
        stdout: docEmptyOut,
        stderr: new TextCapture(),
      }),
    ).toBe(0);
    for (const cli of ALL_CLIENTS) {
      expect(docEmptyOut.text()).toContain(`  ${cli}: not configured`);
    }
  });

  it("preserves untouched pre-existing files byte-for-byte on --remove and surgically strips post-install user edits", async () => {
    const codexDir = path.join(homeDir, ".codex");
    const cursorDir = path.join(homeDir, ".cursor");
    const kimiSkillDir = path.join(homeDir, ".kimi-code", "skills", "snapper");
    await mkdir(codexDir, { recursive: true });
    await mkdir(cursorDir, { recursive: true });
    await mkdir(kimiSkillDir, { recursive: true });

    const originalCodexToml = '# Personal comment\nmodel = "gpt-5"\n';
    const originalCursorMcp = '{\n  "mcpServers": {\n    "other": {\n      "command": "other-mcp"\n    }\n  }\n}\n';
    await writeFile(path.join(codexDir, "config.toml"), originalCodexToml, "utf8");
    await writeFile(path.join(cursorDir, "mcp.json"), originalCursorMcp, "utf8");
    await writeFile(path.join(kimiSkillDir, "SKILL.md"), "# User custom header\n", "utf8");

    expect(
      await integrateMain({
        argv: ["codex", "cursor", "kimi", "grok"],
        source: baseEnv,
        platform: "win32",
        invocation: { command: "C:\\Tools\\snapper-mcp.exe" },
        stdout: new TextCapture(),
        stderr: new TextCapture(),
      }),
    ).toBe(0);

    const winCursorHooks = JSON.parse(
      await readFile(path.join(cursorDir, "hooks.json"), "utf8"),
    ) as { hooks: { stop: Array<{ command: string }> } };
    expect(winCursorHooks.hooks.stop[0]?.command).toContain(
      "& 'C:\\Tools\\snapper-mcp.exe'",
    );
    const winCodexHooks = await readFile(path.join(codexDir, "hooks.json"), "utf8");
    expect(winCodexHooks).toContain("commandWindows");

    const editedCursorMcp = JSON.parse(await readFile(path.join(cursorDir, "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    editedCursorMcp.mcpServers["added_later"] = { command: "later-mcp" };
    await writeFile(
      path.join(cursorDir, "mcp.json"),
      `${JSON.stringify(editedCursorMcp, null, 2)}\n`,
      "utf8",
    );

    expect(
      await integrateMain({
        argv: ["codex", "cursor", "kimi", "grok", "--remove"],
        source: baseEnv,
        platform: "win32",
        stdout: new TextCapture(),
        stderr: new TextCapture(),
      }),
    ).toBe(0);

    expect(await readFile(path.join(codexDir, "config.toml"), "utf8")).toBe(originalCodexToml);

    const strippedCursorMcp = JSON.parse(
      await readFile(path.join(cursorDir, "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(strippedCursorMcp.mcpServers["snapper"]).toBeUndefined();
    expect(strippedCursorMcp.mcpServers["other"]).toBeDefined();
    expect(strippedCursorMcp.mcpServers["added_later"]).toBeDefined();
    expect(await readFile(path.join(kimiSkillDir, "SKILL.md"), "utf8")).toBe(
      "# User custom header\n",
    );
  });

  it("detects tampered Copilot extensions and broken JSON configs in integrate and doctor", async () => {
    expect(
      await integrateMain({
        argv: ["copilot"],
        source: baseEnv,
        platform: "linux",
        invocation: { command: "snapper-mcp" },
        stdout: new TextCapture(),
        stderr: new TextCapture(),
      }),
    ).toBe(0);

    const watcherPath = path.join(
      homeDir,
      ".copilot",
      "extensions",
      "snapper",
      "watcher.mjs",
    );
    await writeFile(watcherPath, "// tampered\nexport default 1;\n", "utf8");

    const docOut = new TextCapture();
    expect(
      await doctorMain({
        argv: ["copilot"],
        source: baseEnv,
        platform: "linux",
        stdout: docOut,
        stderr: new TextCapture(),
      }),
    ).toBe(1);
    expect(docOut.text()).toContain("copilot: BROKEN (watcher.mjs failed SHA-256 ownership check)");

    const reErr = new TextCapture();
    expect(
      await integrateMain({
        argv: ["copilot"],
        source: baseEnv,
        platform: "linux",
        stdout: new TextCapture(),
        stderr: reErr,
      }),
    ).toBe(1);
    expect(reErr.text()).toContain("not an unmodified snapper-mcp extension file");

    const rmErr = new TextCapture();
    expect(
      await integrateMain({
        argv: ["copilot", "--remove"],
        source: baseEnv,
        platform: "linux",
        stdout: new TextCapture(),
        stderr: rmErr,
      }),
    ).toBe(1);
    expect(rmErr.text()).toContain("was modified after snapper-mcp wrote it");

    const geminiConfig = path.join(homeDir, ".gemini", "config");
    await mkdir(geminiConfig, { recursive: true });
    await writeFile(path.join(geminiConfig, "mcp_config.json"), "{broken-json", "utf8");

    const brokenDocOut = new TextCapture();
    expect(
      await doctorMain({
        argv: ["antigravity"],
        source: baseEnv,
        platform: "linux",
        stdout: brokenDocOut,
        stderr: new TextCapture(),
      }),
    ).toBe(1);
    expect(brokenDocOut.text()).toContain("antigravity: BROKEN");
  });
});
