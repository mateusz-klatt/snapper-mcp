/**
 * Stderr-only structured logger for the MCP bridge.
 *
 * MCP stdio uses stdin/stdout for protocol traffic; any byte on stdout
 * that isn't valid JSON-RPC corrupts the stream. Every log line MUST
 * write to stderr, so this module is the single place where any kind
 * of logging output is generated — everywhere else in src/ uses a
 * logger returned from `createLogger`.
 *
 * Verbosity follows SNAPPER_MCP_LOG_LEVEL (one of debug/info/warn/error,
 * default info). SNAPPER_MCP_LOG_TIMESTAMPS=1 prefixes each line with an
 * ISO-8601 UTC timestamp; default off to keep stderr compact for the
 * common Claude Desktop use case.
 *
 * The stdout-writing console methods (debug, info, log, dir, trace,
 * group) are NOT used anywhere — Node routes all of them to stdout.
 * The eslint no-console rule + the stdout-gate npm script enforce
 * this at source level; the runtime stdout-purity test enforces it
 * at build-output level.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

export interface LoggerConfig {
  readonly prefix: string;
  readonly level: LogLevel;
  readonly timestamps: boolean;
}

function resolveLevel(raw: string | undefined): LogLevel {
  if (raw === undefined) return "info";
  const lower = raw.trim().toLowerCase();
  if (lower === "debug" || lower === "info" || lower === "warn" || lower === "error") {
    return lower;
  }
  return "info";
}

function resolveTimestamps(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const lower = raw.trim().toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}

export function readLoggerConfig(
  prefix: string,
  source: NodeJS.ProcessEnv = process.env,
): LoggerConfig {
  return {
    prefix,
    level: resolveLevel(source["SNAPPER_MCP_LOG_LEVEL"]),
    timestamps: resolveTimestamps(source["SNAPPER_MCP_LOG_TIMESTAMPS"]),
  };
}

function formatRest(rest: readonly unknown[]): string {
  if (rest.length === 0) return "";
  const parts: string[] = [];
  for (const value of rest) {
    if (typeof value === "string") {
      parts.push(value);
    } else if (value instanceof Error) {
      parts.push(value.stack ?? `${value.name}: ${value.message}`);
    } else {
      try {
        parts.push(JSON.stringify(value));
      } catch {
        parts.push(String(value));
      }
    }
  }
  return ` ${parts.join(" ")}`;
}

export function createLogger(config: LoggerConfig): Logger;
export function createLogger(prefix: string, source?: NodeJS.ProcessEnv): Logger;
export function createLogger(
  configOrPrefix: LoggerConfig | string,
  source: NodeJS.ProcessEnv = process.env,
): Logger {
  const config: LoggerConfig =
    typeof configOrPrefix === "string"
      ? readLoggerConfig(configOrPrefix, source)
      : configOrPrefix;
  const minLevel = LEVEL_ORDER[config.level];

  function emit(level: LogLevel, message: string, rest: readonly unknown[]): void {
    if (LEVEL_ORDER[level] < minLevel) return;
    const ts = config.timestamps ? `${new Date().toISOString()} ` : "";
    const line = `${ts}[${config.prefix}] ${level.toUpperCase()} ${message}${formatRest(rest)}\n`;
    process.stderr.write(line);
  }

  return {
    debug: (message, ...rest) => emit("debug", message, rest),
    info: (message, ...rest) => emit("info", message, rest),
    warn: (message, ...rest) => emit("warn", message, rest),
    error: (message, ...rest) => emit("error", message, rest),
  };
}
