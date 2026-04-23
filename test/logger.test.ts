import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, readLoggerConfig } from "../src/logger.js";

function captureStderr(): { lines: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    writes.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  return {
    lines: writes,
    restore: () => {
      spy.mockRestore();
    },
  };
}

describe("readLoggerConfig", () => {
  it("defaults to level=info and timestamps=false", () => {
    const config = readLoggerConfig("prefix", {} as NodeJS.ProcessEnv);
    expect(config.prefix).toBe("prefix");
    expect(config.level).toBe("info");
    expect(config.timestamps).toBe(false);
  });

  it("parses SNAPPER_MCP_LOG_LEVEL case-insensitively", () => {
    expect(
      readLoggerConfig("x", { SNAPPER_MCP_LOG_LEVEL: "DEBUG" } as NodeJS.ProcessEnv).level,
    ).toBe("debug");
    expect(
      readLoggerConfig("x", { SNAPPER_MCP_LOG_LEVEL: "  warn  " } as NodeJS.ProcessEnv).level,
    ).toBe("warn");
  });

  it("falls back to info on unknown level strings", () => {
    expect(
      readLoggerConfig("x", { SNAPPER_MCP_LOG_LEVEL: "loud" } as NodeJS.ProcessEnv).level,
    ).toBe("info");
  });

  it("treats 1/true/yes/on as timestamps enabled", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      expect(
        readLoggerConfig("x", { SNAPPER_MCP_LOG_TIMESTAMPS: value } as NodeJS.ProcessEnv)
          .timestamps,
      ).toBe(true);
    }
  });

  it("treats 0/false/other as timestamps disabled", () => {
    for (const value of ["0", "false", "no", ""]) {
      expect(
        readLoggerConfig("x", { SNAPPER_MCP_LOG_TIMESTAMPS: value } as NodeJS.ProcessEnv)
          .timestamps,
      ).toBe(false);
    }
  });
});

describe("createLogger", () => {
  let capture: ReturnType<typeof captureStderr>;

  beforeEach(() => {
    capture = captureStderr();
  });

  afterEach(() => {
    capture.restore();
  });

  it("writes every line to stderr (never stdout)", () => {
    const logger = createLogger({ prefix: "bridge", level: "debug", timestamps: false });
    logger.info("hello");
    expect(capture.lines).toHaveLength(1);
    expect(capture.lines[0]).toBe("[bridge] INFO hello\n");
  });

  it("filters below the configured min level", () => {
    const logger = createLogger({ prefix: "bridge", level: "warn", timestamps: false });
    logger.debug("dropped");
    logger.info("dropped");
    logger.warn("kept");
    logger.error("kept");
    expect(capture.lines).toHaveLength(2);
    expect(capture.lines[0]).toContain("WARN kept");
    expect(capture.lines[1]).toContain("ERROR kept");
  });

  it("serialises Error instances via .stack", () => {
    const logger = createLogger({ prefix: "bridge", level: "debug", timestamps: false });
    const err = new Error("boom");
    logger.error("refresh failed", err);
    expect(capture.lines[0]).toContain("refresh failed");
    expect(capture.lines[0]).toContain("boom");
  });

  it("JSON-stringifies plain-object context", () => {
    const logger = createLogger({ prefix: "bridge", level: "debug", timestamps: false });
    logger.info("event", { requestId: 42, method: "tools/list" });
    expect(capture.lines[0]).toContain('{"requestId":42,"method":"tools/list"}');
  });

  it("prefixes each line with an ISO timestamp when timestamps=true", () => {
    const logger = createLogger({ prefix: "bridge", level: "debug", timestamps: true });
    logger.info("msg");
    expect(capture.lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[bridge\]/);
  });

  it("accepts a prefix-only shorthand via createLogger(prefix, env)", () => {
    const logger = createLogger("short", {} as NodeJS.ProcessEnv);
    logger.info("x");
    expect(capture.lines[0]).toContain("[short]");
  });

  it("passes string tails through verbatim (no JSON-stringify)", () => {
    const logger = createLogger({ prefix: "bridge", level: "debug", timestamps: false });
    logger.info("event", "plain-string-tail");
    expect(capture.lines[0]).toContain("plain-string-tail");
    expect(capture.lines[0]).not.toContain('"plain-string-tail"');
  });

  it("serialises Error instances without a stack via name: message fallback", () => {
    const logger = createLogger({ prefix: "bridge", level: "debug", timestamps: false });
    const err = new Error("no-stack");
    delete (err as { stack?: string }).stack;
    logger.error("oops", err);
    expect(capture.lines[0]).toContain("Error: no-stack");
  });

  it("falls back to String(value) when JSON.stringify throws (circular reference)", () => {
    const logger = createLogger({ prefix: "bridge", level: "debug", timestamps: false });
    const circular: Record<string, unknown> = { name: "cycle" };
    circular["self"] = circular;
    logger.info("event", circular);
    expect(capture.lines[0]).toContain("event");
    // The exact fallback text is "[object Object]" — what matters is we
    // did NOT blow up on the circular reference.
    expect(capture.lines[0]).toContain("[object Object]");
  });
});
