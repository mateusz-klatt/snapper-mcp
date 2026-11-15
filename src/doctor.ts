/**
 * Subcommand entry for `snapper-mcp doctor`.
 *
 * Performs offline diagnostics of the credential configuration (`check`)
 * and inspects per-CLI MCP + session-wake wiring across all supported
 * coding CLIs.
 */

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
import { resolveClientHomeDir } from "./integrate.js";
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

  for (let i = 0; i < remaining.length; i += 1) {
    const arg = remaining[i]!;
    if (arg === "--client") {
      const next = remaining[i + 1];
      if (typeof next !== "string" || next.trim().length === 0) {
        throw new ClientArgError("--client requires a CLI name or 'all'");
      }
      targets.push(next.trim());
      i += 1;
      continue;
    }
    if (arg.startsWith("--client=")) {
      const val = arg.slice("--client=".length).trim();
      if (val.length === 0) {
        throw new ClientArgError("--client requires a CLI name or 'all'");
      }
      targets.push(val);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new ClientArgError(
        `unknown argument ${JSON.stringify(redactCliArg(arg))} — usage: snapper-mcp doctor [--client <${ALL_CLIENTS.join("|")}|all>] [--config PATH]`,
      );
    }
    targets.push(arg);
  }

  const clients =
    targets.length === 0 ? [...ALL_CLIENTS] : parseClientSelection(targets);
  return { clients, flags };
}

function hasJsonMcpSnapper(raw: string | null): {
  readonly ok: boolean;
  readonly broken: string | null;
  readonly args: readonly string[];
} {
  if (raw === null) {
    return { ok: false, broken: null, args: [] };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, broken: "MCP file is not a JSON object", args: [] };
    }
    const servers = (parsed as Record<string, unknown>)["mcpServers"];
    if (servers === undefined || servers === null) {
      return { ok: false, broken: null, args: [] };
    }
    if (typeof servers !== "object" || Array.isArray(servers)) {
      return { ok: false, broken: "mcpServers is not a JSON object", args: [] };
    }
    const snapper = (servers as Record<string, unknown>)["snapper"];
    if (snapper === undefined) {
      return { ok: false, broken: null, args: [] };
    }
    if (snapper === null || typeof snapper !== "object" || Array.isArray(snapper)) {
      return { ok: false, broken: "mcpServers.snapper is invalid", args: [] };
    }
    const cmd = (snapper as Record<string, unknown>)["command"];
    const rawArgs = (snapper as Record<string, unknown>)["args"];
    const args = Array.isArray(rawArgs)
      ? rawArgs.filter((x): x is string => typeof x === "string")
      : [];
    if (typeof cmd !== "string" || cmd.length === 0) {
      return { ok: false, broken: "mcpServers.snapper.command is missing", args: [] };
    }
    return { ok: true, broken: null, args };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, broken: `invalid JSON (${detail})`, args: [] };
  }
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
    case "claude": {
      const pluginRoot = path.join(
        stateDir,
        "plugins",
        "claude-marketplace",
        "plugins",
        "snapper",
      );
      const mcpRaw = await readTextIfPresent(path.join(pluginRoot, ".mcp.json"));
      const mcp = hasJsonMcpSnapper(mcpRaw);
      const monitorsRaw = await readTextIfPresent(
        path.join(pluginRoot, "monitors", "monitors.json"),
      );
      const hasMonitor = monitorsRaw !== null && monitorsRaw.includes("snapper-watch");
      return {
        client,
        mcpConfigured: mcp.ok,
        wakeEnabled: mcp.ok && hasMonitor && isWakeEnabled(pref ?? "default"),
        brokenReason: mcp.broken,
      };
    }

    case "codex": {
      const codexHome = resolveClientHomeDir("CODEX_HOME", ".codex", source, platform);
      const tomlRaw = await readTextIfPresent(path.join(codexHome, "config.toml"));
      const hooksRaw = await readTextIfPresent(path.join(codexHome, "hooks.json"));
      if (tomlRaw === null) {
        return { client, mcpConfigured: false, wakeEnabled: false, brokenReason: null };
      }
      const inspected = inspectCodexSnapperBlock(tomlRaw);
      const hasHooks = hooksRaw !== null && hooksRaw.includes("--client codex");
      return {
        client,
        mcpConfigured: inspected.configured,
        wakeEnabled:
          inspected.configured &&
          inspected.wakeEnabled &&
          hasHooks &&
          isWakeEnabled(pref ?? "default"),
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
      const hasExt = watcherRaw !== null && entryRaw !== null;
      return {
        client,
        mcpConfigured: mcp.ok,
        wakeEnabled: mcp.ok && hasExt && isWakeEnabled(pref ?? "default"),
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
      const hooksRaw = await readTextIfPresent(path.join(geminiConfig, "hooks.json"));
      const hasHooks = hooksRaw !== null && hooksRaw.includes("--client antigravity");
      return {
        client,
        mcpConfigured: mcp.ok,
        wakeEnabled: mcp.ok && hasHooks && isWakeEnabled(pref),
        brokenReason: mcp.broken,
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
      const tomlRaw = await readTextIfPresent(path.join(kimiHome, "config.toml"));
      const hasHooks = tomlRaw !== null && inspectKimiHooksBlock(tomlRaw);
      return {
        client,
        mcpConfigured: mcp.ok,
        wakeEnabled: mcp.ok && hasHooks && isWakeEnabled(pref),
        brokenReason: mcp.broken,
      };
    }

    case "grok": {
      const grokHome = resolveClientHomeDir("GROK_HOME", ".grok", source, platform);
      const tomlRaw = await readTextIfPresent(path.join(grokHome, "config.toml"));
      const configured = tomlRaw !== null && inspectGrokSnapperTable(tomlRaw);
      const hooksRaw = await readTextIfPresent(
        path.join(grokHome, "hooks", "snapper.json"),
      );
      const hasHooks = hooksRaw !== null && hooksRaw.includes("grok");
      return {
        client,
        mcpConfigured: configured,
        wakeEnabled: configured && hasHooks && isWakeEnabled(pref ?? "default"),
        brokenReason: null,
      };
    }

    case "cursor": {
      const cursorHome = path.join(resolveHomeDir(source, platform), ".cursor");
      const mcp = hasJsonMcpSnapper(
        await readTextIfPresent(path.join(cursorHome, "mcp.json")),
      );
      const hooksRaw = await readTextIfPresent(path.join(cursorHome, "hooks.json"));
      const hasHooks = hooksRaw !== null && hooksRaw.includes("--client cursor");
      const argWakeOff = mcp.args.includes("--wake=false");
      return {
        client,
        mcpConfigured: mcp.ok,
        wakeEnabled:
          mcp.ok && !argWakeOff && hasHooks && isWakeEnabled(pref ?? "default"),
        brokenReason: mcp.broken,
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
