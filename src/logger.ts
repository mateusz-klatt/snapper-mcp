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
 * SNAPPER_MCP_LOG_FORMAT=json switches every line to a single-line
 * JSON object (``{"t":"...","lvl":"info","prefix":"...","msg":"...",
 * "rest":[...]}``) so an operator can pipe stderr through ``jq`` for
 * structured filtering. Default ``text`` keeps the human-readable
 * one-line-per-event format. The ``t`` field is always present in
 * JSON mode regardless of SNAPPER_MCP_LOG_TIMESTAMPS — the timestamp
 * env var only governs the prefix on text-mode lines.
 *
 * The stdout-writing console methods (debug, info, log, dir, trace,
 * group) are NOT used anywhere — Node routes all of them to stdout.
 * The eslint no-console rule + the stdout-gate npm script enforce
 * this at source level; the runtime stdout-purity test enforces it
 * at build-output level.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "text" | "json";

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
  readonly format: LogFormat;
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

function resolveFormat(raw: string | undefined): LogFormat {
  if (raw === undefined) return "text";
  const lower = raw.trim().toLowerCase();
  return lower === "json" ? "json" : "text";
}

export function readLoggerConfig(
  prefix: string,
  source: NodeJS.ProcessEnv = process.env,
): LoggerConfig {
  return {
    prefix,
    level: resolveLevel(source["SNAPPER_MCP_LOG_LEVEL"]),
    timestamps: resolveTimestamps(source["SNAPPER_MCP_LOG_TIMESTAMPS"]),
    format: resolveFormat(source["SNAPPER_MCP_LOG_FORMAT"]),
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

function jsonSafeRest(rest: readonly unknown[]): unknown[] {
  return rest.map(value => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack ?? null };
    }
    try {
      JSON.stringify(value);

      return value;
    } catch {
      return String(value);
    }
  });
}

function formatJsonLine(
  level: LogLevel,
  prefix: string,
  message: string,
  rest: readonly unknown[],
): string {
  const record: Record<string, unknown> = {
    t: new Date().toISOString(),
    lvl: level,
    prefix,
    msg: message,
  };

  if (rest.length > 0) {
    record["rest"] = jsonSafeRest(rest);
  }

  return `${JSON.stringify(record)}\n`;
}

function formatTextLine(
  level: LogLevel,
  prefix: string,
  message: string,
  rest: readonly unknown[],
  timestamps: boolean,
): string {
  const ts = timestamps ? `${new Date().toISOString()} ` : "";

  return `${ts}[${prefix}] ${level.toUpperCase()} ${message}${formatRest(rest)}\n`;
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
    const line =
      config.format === "json"
        ? formatJsonLine(level, config.prefix, message, rest)
        : formatTextLine(level, config.prefix, message, rest, config.timestamps);

    process.stderr.write(line);
  }

  return {
    debug: (message, ...rest) => emit("debug", message, rest),
    info: (message, ...rest) => emit("info", message, rest),
    warn: (message, ...rest) => emit("warn", message, rest),
    error: (message, ...rest) => emit("error", message, rest),
  };
}
