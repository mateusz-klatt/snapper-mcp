/**
 * Subcommand entry for `snapper-mcp doctor`.
 *
 * Performs offline diagnostics of the credential configuration (`check`)
 * and inspects per-CLI MCP + session-wake wiring across all supported
 * coding CLIs.
 */

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import { PassThrough, type Writable } from "node:stream";

import { checkMain } from "./check.js";
import {
  ALL_CLIENTS,
  ClientArgError,
  parseClientSelection,
  type ClientName,
} from "./clients.js";
import { verifyCopilotOwnedFile } from "./copilot_extension.js";
import { parseCliFlags, redactCliArg, type CliFlags } from "./env.js";
import { findExecutableOnPath } from "./hook.js";
import {
  CLAUDE_MARKETPLACE_NAME,
  CLAUDE_PLUGIN_KEY,
  GROK_SKILL_BODY,
  isSnapperOwnedHookTree,
  KIMI_SKILL_BODY,
  resolveClientHomeDir,
} from "./integrate.js";
import { writeStderr } from "./logger.js";
import {
  defaultConfigFilePath,
  isWakeEnabled,
  readTextIfPresent,
  readWakePreference,
  resolveHomeDir,
  resolveStateDir,
} from "./state_dir.js";
import {
  extractTomlSnapperInvocation,
  inspectCodexSnapperBlock,
  inspectGrokSnapperTable,
  inspectKimiHooksBlock,
} from "./toml_edit.js";

export interface ClientDoctorReport {
  readonly client: ClientName;
  readonly mcpConfigured: boolean;
  readonly wakeEnabled: boolean;
  readonly brokenReason: string | null;
}

export interface DoctorOptions {
  readonly argv?: readonly string[];
  readonly source?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly stdout?: Pick<Writable, "write">;
  readonly stderr?: Pick<Writable, "write">;
  readonly now?: Date;
}

export function parseDoctorArgs(argv: readonly string[]): {
  readonly clients: readonly ClientName[];
  readonly flags: CliFlags;
} {
  const { flags, remaining } = parseCliFlags(argv);
  const targets: string[] = [];

  let i = 0;
  while (i < remaining.length) {
    const arg = remaining[i]!;
    if (arg === "--client") {
      const next = remaining[i + 1];
      if (typeof next !== "string" || next.trim().length === 0) {
        throw new ClientArgError("--client requires a CLI name or 'all'");
      }
      targets.push(next.trim());
      i += 2;
      continue;
    }
    if (arg.startsWith("--client=")) {
      const val = arg.slice("--client=".length).trim();
      if (val.length === 0) {
        throw new ClientArgError("--client requires a CLI name or 'all'");
      }
      targets.push(val);
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new ClientArgError(
        `unknown argument ${JSON.stringify(redactCliArg(arg))} — usage: snapper-mcp doctor [--client <${ALL_CLIENTS.join("|")}|all>] [--config PATH]`,
      );
    }
    targets.push(arg);
    i += 1;
  }

  const clients =
    targets.length === 0 ? [...ALL_CLIENTS] : parseClientSelection(targets);
  return { clients, flags };
}

function hasJsonMcpSnapper(raw: string | null): {
  readonly ok: boolean;
  readonly broken: string | null;
  readonly command: string | null;
  readonly args: readonly string[];
} {
  if (raw === null) {
    return { ok: false, broken: null, command: null, args: [] };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, broken: "MCP file is not a JSON object", command: null, args: [] };
    }
    const servers = (parsed as Record<string, unknown>)["mcpServers"];
    if (servers === undefined || servers === null) {
      return { ok: false, broken: null, command: null, args: [] };
    }
    if (typeof servers !== "object" || Array.isArray(servers)) {
      return { ok: false, broken: "mcpServers is not a JSON object", command: null, args: [] };
    }
    const snapper = (servers as Record<string, unknown>)["snapper"];
    if (snapper === undefined) {
      return { ok: false, broken: null, command: null, args: [] };
    }
    if (snapper === null || typeof snapper !== "object" || Array.isArray(snapper)) {
      return { ok: false, broken: "mcpServers.snapper is invalid", command: null, args: [] };
    }
    const cmd = (snapper as Record<string, unknown>)["command"];
    const rawArgs = (snapper as Record<string, unknown>)["args"];
    const args = Array.isArray(rawArgs)
      ? rawArgs.filter((x): x is string => typeof x === "string")
      : [];
    if (typeof cmd !== "string" || cmd.length === 0) {
      return {
        ok: false,
        broken: "mcpServers.snapper.command is missing",
        command: null,
        args: [],
      };
    }
    return { ok: true, broken: null, command: cmd, args };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, broken: `invalid JSON (${detail})`, command: null, args: [] };
  }
}

function verifyInvocationExists(
  command: string,
  args: readonly string[],
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const isPathQualified =
    command.includes("/") ||
    command.includes("\\") ||
    (platform === "win32" && /^[A-Za-z]:/.test(command));
  if (isPathQualified) {
    try {
      const st = statSync(command);
      if (!st.isFile()) {
        return `command not found: ${command}`;
      }
      if (platform !== "win32" && process.platform !== "win32") {
        accessSync(command, fsConstants.X_OK);
      }
    } catch {
      return `command not found: ${command}`;
    }
  } else if (findExecutableOnPath(command, source, platform) === null) {
    return `command not found: ${command}`;
  }

  const baseExe = path.basename(command).replace(/\.exe$/i, "").toLowerCase();
  const firstArg = args[0];
  if (baseExe === "node" && typeof firstArg === "string" && firstArg.length > 0 && !firstArg.startsWith("-")) {
    try {
      if (!statSync(firstArg).isFile()) {
        return `entrypoint script not found: ${firstArg}`;
      }
    } catch {
      return `entrypoint script not found: ${firstArg}`;
    }
  }
  return null;
}

function inspectHookJsonFile(
  raw: string | null,
  client: ClientName,
  events: readonly string[],
): { readonly hasHooks: boolean; readonly broken: string | null } {
  if (raw === null) {
    return { hasHooks: false, broken: null };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { hasHooks: false, broken: "hooks file is not a JSON object" };
    }
    const allPresent = events.every((event) => isSnapperOwnedHookTree(parsed, client, event));
    return { hasHooks: allPresent, broken: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { hasHooks: false, broken: `invalid hooks JSON (${detail})` };
  }
}

function parseOptionalJsonObject(
  raw: string | null,
  label: string,
): { readonly doc: Record<string, unknown> | null; readonly broken: string | null } {
  if (raw === null) {
    return { doc: null, broken: null };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { doc: null, broken: `${label} is not a JSON object` };
    }
    return { doc: parsed as Record<string, unknown>, broken: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { doc: null, broken: `invalid ${label} (${detail})` };
  }
}

function inspectClaudeRegistration(params: {
  readonly settingsRaw: string | null;
  readonly knownRaw: string | null;
  readonly installedRaw: string | null;
  readonly pluginRoot: string;
}): {
  readonly anyPresent: boolean;
  readonly ok: boolean;
  readonly broken: string | null;
} {
  const settings = parseOptionalJsonObject(params.settingsRaw, "Claude settings.json");
  if (settings.broken !== null) {
    return { anyPresent: true, ok: false, broken: settings.broken };
  }
  const known = parseOptionalJsonObject(params.knownRaw, "Claude known_marketplaces.json");
  if (known.broken !== null) {
    return { anyPresent: true, ok: false, broken: known.broken };
  }
  const installed = parseOptionalJsonObject(
    params.installedRaw,
    "Claude installed_plugins.json",
  );
  if (installed.broken !== null) {
    return { anyPresent: true, ok: false, broken: installed.broken };
  }

  const extra = settings.doc?.["extraKnownMarketplaces"];
  const hasSettingsMarket =
    extra !== null &&
    typeof extra === "object" &&
    !Array.isArray(extra) &&
    CLAUDE_MARKETPLACE_NAME in (extra as Record<string, unknown>);
  const enabled = settings.doc?.["enabledPlugins"];
  const hasEnabled =
    enabled !== null &&
    typeof enabled === "object" &&
    !Array.isArray(enabled) &&
    (enabled as Record<string, unknown>)[CLAUDE_PLUGIN_KEY] === true;
  const hasKnown =
    known.doc !== null && CLAUDE_MARKETPLACE_NAME in known.doc;

  const pluginsMap = installed.doc?.["plugins"];
  const pluginEntries =
    pluginsMap !== null && typeof pluginsMap === "object" && !Array.isArray(pluginsMap)
      ? (pluginsMap as Record<string, unknown>)[CLAUDE_PLUGIN_KEY]
      : undefined;
  const hasInstalledAny = pluginEntries !== undefined;
  const hasInstalledMatching =
    Array.isArray(pluginEntries) &&
    pluginEntries.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>)["installPath"] === params.pluginRoot,
    );

  const anyPresent =
    hasSettingsMarket || hasEnabled || hasKnown || hasInstalledAny;
  const ok =
    hasSettingsMarket && hasEnabled && hasKnown && hasInstalledMatching;
  return { anyPresent, ok, broken: null };
}

async function inspectClaudeClient(params: {
  readonly stateDir: string;
  readonly source: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly pref: Awaited<ReturnType<typeof readWakePreference>>;
}): Promise<ClientDoctorReport> {
  const claudeHome = resolveClientHomeDir(
    "CLAUDE_CONFIG_DIR",
    ".claude",
    params.source,
    params.platform,
  );
  const pluginRoot = path.join(
    params.stateDir,
    "plugins",
    "claude-marketplace",
    "plugins",
    "snapper",
  );
  const mcp = hasJsonMcpSnapper(
    await readTextIfPresent(path.join(pluginRoot, ".mcp.json")),
  );
  if (mcp.broken !== null) {
    return { client: "claude", mcpConfigured: false, wakeEnabled: false, brokenReason: mcp.broken };
  }
  const reg = inspectClaudeRegistration({
    settingsRaw: await readTextIfPresent(path.join(claudeHome, "settings.json")),
    knownRaw: await readTextIfPresent(
      path.join(claudeHome, "plugins", "known_marketplaces.json"),
    ),
    installedRaw: await readTextIfPresent(
      path.join(claudeHome, "plugins", "installed_plugins.json"),
    ),
    pluginRoot,
  });
  if (reg.broken !== null) {
    return { client: "claude", mcpConfigured: false, wakeEnabled: false, brokenReason: reg.broken };
  }
  if (!mcp.ok && !reg.anyPresent) {
    return { client: "claude", mcpConfigured: false, wakeEnabled: false, brokenReason: null };
  }
  if (mcp.ok && !reg.ok) {
    return {
      client: "claude",
      mcpConfigured: false,
      wakeEnabled: false,
      brokenReason: "Claude plugin bundle is not registered/enabled in Claude settings",
    };
  }
  if (!mcp.ok || mcp.command === null) {
    return {
      client: "claude",
      mcpConfigured: false,
      wakeEnabled: false,
      brokenReason: "Claude settings reference snapper@snapper-local but plugin bundle is missing",
    };
  }
  const cmdBroken = verifyInvocationExists(mcp.command, mcp.args, params.source, params.platform);
  if (cmdBroken !== null) {
    return { client: "claude", mcpConfigured: false, wakeEnabled: false, brokenReason: cmdBroken };
  }
  const monitorsRaw = await readTextIfPresent(
    path.join(pluginRoot, "monitors", "monitors.json"),
  );
  const skillRaw = await readTextIfPresent(
    path.join(pluginRoot, "skills", "wake", "SKILL.md"),
  );
  const hasMonitor =
    monitorsRaw !== null && monitorsRaw.includes("snapper-watch") && skillRaw !== null;
  return {
    client: "claude",
    mcpConfigured: true,
    wakeEnabled: hasMonitor && isWakeEnabled(params.pref ?? "default"),
    brokenReason: null,
  };
}

async function inspectClient(params: {
  readonly client: ClientName;
  readonly stateDir: string;
  readonly source: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}): Promise<ClientDoctorReport> {
  const { client, stateDir, source, platform } = params;
  let pref: Awaited<ReturnType<typeof readWakePreference>>;
  try {
    pref = await readWakePreference(stateDir, client);
  } catch (err) {
    return {
      client,
      mcpConfigured: false,
      wakeEnabled: false,
      brokenReason: err instanceof Error ? err.message : String(err),
    };
  }

  switch (client) {
    case "claude":
      return inspectClaudeClient({ stateDir, source, platform, pref });

    case "codex": {
      const codexHome = resolveClientHomeDir("CODEX_HOME", ".codex", source, platform);
      const tomlRaw = await readTextIfPresent(path.join(codexHome, "config.toml"));
      if (tomlRaw === null) {
        return { client, mcpConfigured: false, wakeEnabled: false, brokenReason: null };
      }
      const inspected = inspectCodexSnapperBlock(tomlRaw);
      if (!inspected.configured) {
        return { client, mcpConfigured: false, wakeEnabled: false, brokenReason: null };
      }
      const inv = extractTomlSnapperInvocation(tomlRaw);
      const cmdBroken =
        inv === null ? null : verifyInvocationExists(inv.command, inv.args, source, platform);
      if (cmdBroken !== null) {
        return { client, mcpConfigured: false, wakeEnabled: false, brokenReason: cmdBroken };
      }
      const hookInfo = inspectHookJsonFile(
        await readTextIfPresent(path.join(codexHome, "hooks.json")),
        "codex",
        ["SessionStart", "UserPromptSubmit", "Stop"],
      );
      if (hookInfo.broken !== null) {
        return { client, mcpConfigured: true, wakeEnabled: false, brokenReason: hookInfo.broken };
      }
      return {
        client,
        mcpConfigured: true,
        wakeEnabled:
          inspected.wakeEnabled && hookInfo.hasHooks && isWakeEnabled(pref ?? "default"),
        brokenReason: null,
      };
    }

    case "copilot": {
      const copilotHome = resolveClientHomeDir(
        "COPILOT_HOME",
        ".copilot",
        source,
        platform,
      );
      const mcp = hasJsonMcpSnapper(
        await readTextIfPresent(path.join(copilotHome, "mcp-config.json")),
      );
      if (mcp.broken !== null) {
        return {
          client,
          mcpConfigured: false,
          wakeEnabled: false,
          brokenReason: mcp.broken,
        };
      }
      const extDir = path.join(copilotHome, "extensions", "snapper");
      const watcherRaw = await readTextIfPresent(path.join(extDir, "watcher.mjs"));
      const entryRaw = await readTextIfPresent(path.join(extDir, "extension.mjs"));
      if (watcherRaw !== null && !verifyCopilotOwnedFile(watcherRaw)) {
        return {
          client,
          mcpConfigured: mcp.ok,
          wakeEnabled: false,
          brokenReason: "watcher.mjs failed SHA-256 ownership check",
        };
      }
      if (entryRaw !== null && !verifyCopilotOwnedFile(entryRaw)) {
        return {
          client,
          mcpConfigured: mcp.ok,
          wakeEnabled: false,
          brokenReason: "extension.mjs failed SHA-256 ownership check",
        };
      }
      if (!mcp.ok || mcp.command === null) {
        return { client, mcpConfigured: false, wakeEnabled: false, brokenReason: null };
      }
      const cmdBroken = verifyInvocationExists(mcp.command, mcp.args, source, platform);
      if (cmdBroken !== null) {
        return { client, mcpConfigured: false, wakeEnabled: false, brokenReason: cmdBroken };
      }
      const hasExt = watcherRaw !== null && entryRaw !== null;
      return {
        client,
        mcpConfigured: true,
        wakeEnabled: hasExt && isWakeEnabled(pref ?? "default"),
        brokenReason: null,
      };
    }

    case "antigravity": {
      const geminiConfig = path.join(
        resolveHomeDir(source, platform),
        ".gemini",
        "config",
      );
      const mcp = hasJsonMcpSnapper(
        await readTextIfPresent(path.join(geminiConfig, "mcp_config.json")),
      );
      if (mcp.broken !== null || !mcp.ok || mcp.command === null) {
        return {
          client,
          mcpConfigured: false,
          wakeEnabled: false,
          brokenReason: mcp.broken,
        };
      }
      const cmdBroken = verifyInvocationExists(mcp.command, mcp.args, source, platform);
      if (cmdBroken !== null) {
        return { client, mcpConfigured: false, wakeEnabled: false, brokenReason: cmdBroken };
      }
      const hookInfo = inspectHookJsonFile(
        await readTextIfPresent(path.join(geminiConfig, "hooks.json")),
        "antigravity",
        ["SessionStart", "PreInvocation", "Stop"],
      );
      if (hookInfo.broken !== null) {
        return { client, mcpConfigured: true, wakeEnabled: false, brokenReason: hookInfo.broken };
      }
      return {
        client,
        mcpConfigured: true,
        wakeEnabled: hookInfo.hasHooks && isWakeEnabled(pref),
        brokenReason: null,
      };
    }

    case "kimi": {
      const kimiHome = resolveClientHomeDir(
        "KIMI_CODE_HOME",
        ".kimi-code",
        source,
        platform,
      );
      const mcp = hasJsonMcpSnapper(
        await readTextIfPresent(path.join(kimiHome, "mcp.json")),
      );
      if (mcp.broken !== null || !mcp.ok || mcp.command === null) {
        return {
          client,
          mcpConfigured: false,
          wakeEnabled: false,
          brokenReason: mcp.broken,
        };
      }
      const cmdBroken = verifyInvocationExists(mcp.command, mcp.args, source, platform);
      if (cmdBroken !== null) {
        return { client, mcpConfigured: false, wakeEnabled: false, brokenReason: cmdBroken };
      }
      const tomlRaw = await readTextIfPresent(path.join(kimiHome, "config.toml"));
      const skillRaw = await readTextIfPresent(
        path.join(kimiHome, "skills", "snapper", "SKILL.md"),
      );
      const hasHooks = tomlRaw !== null && inspectKimiHooksBlock(tomlRaw);
      const hasSkill = skillRaw !== null && skillRaw.includes(KIMI_SKILL_BODY.trim());
      return {
        client,
        mcpConfigured: true,
        wakeEnabled: hasHooks && hasSkill && isWakeEnabled(pref),
        brokenReason: null,
      };
    }

    case "grok": {
      const grokHome = resolveClientHomeDir("GROK_HOME", ".grok", source, platform);
      const tomlRaw = await readTextIfPresent(path.join(grokHome, "config.toml"));
      const configured = tomlRaw !== null && inspectGrokSnapperTable(tomlRaw);
      if (!configured || tomlRaw === null) {
        return { client, mcpConfigured: false, wakeEnabled: false, brokenReason: null };
      }
      const inv = extractTomlSnapperInvocation(tomlRaw);
      const cmdBroken =
        inv === null ? null : verifyInvocationExists(inv.command, inv.args, source, platform);
      if (cmdBroken !== null) {
        return { client, mcpConfigured: false, wakeEnabled: false, brokenReason: cmdBroken };
      }
      const hookInfo = inspectHookJsonFile(
        await readTextIfPresent(path.join(grokHome, "hooks", "snapper.json")),
        "grok",
        ["Stop"],
      );
      if (hookInfo.broken !== null) {
        return { client, mcpConfigured: true, wakeEnabled: false, brokenReason: hookInfo.broken };
      }
      const skillRaw = await readTextIfPresent(
        path.join(grokHome, "skills", "snapper", "SKILL.md"),
      );
      const hasSkill = skillRaw !== null && skillRaw.includes(GROK_SKILL_BODY.trim());
      return {
        client,
        mcpConfigured: true,
        wakeEnabled: hookInfo.hasHooks && hasSkill && isWakeEnabled(pref ?? "default"),
        brokenReason: null,
      };
    }

    case "cursor": {
      const cursorHome = path.join(resolveHomeDir(source, platform), ".cursor");
      const mcp = hasJsonMcpSnapper(
        await readTextIfPresent(path.join(cursorHome, "mcp.json")),
      );
      if (mcp.broken !== null || !mcp.ok || mcp.command === null) {
        return {
          client,
          mcpConfigured: false,
          wakeEnabled: false,
          brokenReason: mcp.broken,
        };
      }
      const cmdBroken = verifyInvocationExists(mcp.command, mcp.args, source, platform);
      if (cmdBroken !== null) {
        return { client, mcpConfigured: false, wakeEnabled: false, brokenReason: cmdBroken };
      }
      const hookInfo = inspectHookJsonFile(
        await readTextIfPresent(path.join(cursorHome, "hooks.json")),
        "cursor",
        ["stop"],
      );
      if (hookInfo.broken !== null) {
        return { client, mcpConfigured: true, wakeEnabled: false, brokenReason: hookInfo.broken };
      }
      const argWakeOff = mcp.args.includes("--wake=false");
      return {
        client,
        mcpConfigured: true,
        wakeEnabled:
          !argWakeOff && hookInfo.hasHooks && isWakeEnabled(pref ?? "default"),
        brokenReason: null,
      };
    }
  }
}

export async function doctorMain(options: DoctorOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(3);
  const source = options.source ?? process.env;
  const platform = options.platform ?? process.platform;
  const writeOut = (line: string): void => {
    options.stdout?.write(line);
  };
  const writeErr = (line: string): void => {
    if (options.stderr !== undefined) {
      options.stderr.write(line);
    } else {
      writeStderr(line);
    }
  };

  let parsed: ReturnType<typeof parseDoctorArgs>;
  try {
    parsed = parseDoctorArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`[snapper-mcp doctor] ${message}\n`);
    return 1;
  }

  const stateDir = resolveStateDir(source, platform);
  const configPath =
    parsed.flags.configPath ?? defaultConfigFilePath(source, platform);
  const checkArgv: string[] = ["--config", configPath];
  if (parsed.flags.baseUrl !== null) {
    checkArgv.push("--base-url", parsed.flags.baseUrl);
  }
  if (parsed.flags.accessToken !== null) {
    checkArgv.push("--access-token", parsed.flags.accessToken);
  }
  if (parsed.flags.profile !== null) {
    checkArgv.push("--profile", parsed.flags.profile);
  }

  const checkStdout = new PassThrough();
  const checkStderr = new PassThrough();
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  checkStdout.on("data", (c: Buffer) => outChunks.push(c));
  checkStderr.on("data", (c: Buffer) => errChunks.push(c));

  const checkCode = await checkMain({
    argv: checkArgv,
    env: source,
    now: options.now,
    stdout: checkStdout,
    stderr: checkStderr,
  });
  const checkOutText = Buffer.concat(outChunks).toString("utf8");
  const checkErrText = Buffer.concat(errChunks).toString("utf8");

  if (checkOutText.length > 0) {
    writeOut(checkOutText);
  }
  if (checkErrText.length > 0) {
    writeErr(checkErrText);
  }

  let anyBroken = checkCode !== 0;
  writeOut("clients:\n");
  for (const client of parsed.clients) {
    const report = await inspectClient({ client, stateDir, source, platform });
    if (report.brokenReason !== null) {
      anyBroken = true;
      writeOut(`  ${client}: BROKEN (${report.brokenReason})\n`);
    } else if (!report.mcpConfigured) {
      writeOut(`  ${client}: not configured\n`);
    } else {
      writeOut(
        `  ${client}: mcp=configured, wake=${report.wakeEnabled ? "on" : "off"}\n`,
      );
    }
  }

  return anyBroken ? 1 : 0;
}
