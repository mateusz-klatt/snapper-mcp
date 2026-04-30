import { describe, expect, it } from "vitest";

import { parseCliFlags, type CliFlags } from "../src/env.js";

const EMPTY_FLAGS: CliFlags = {
  configPath: null,
  accessToken: null,
  baseUrl: null,
};

describe("parseCliFlags", () => {
  it("extracts a config path from equals-form argv", () => {
    const result = parseCliFlags(["--config=/tmp/snapper/env.json"]);
    expect(result.flags).toEqual({ ...EMPTY_FLAGS, configPath: "/tmp/snapper/env.json" });
    expect(result.remaining).toEqual([]);
  });

  it("extracts a config path from space-form argv", () => {
    const result = parseCliFlags(["--config", "/tmp/snapper/env.json"]);
    expect(result.flags).toEqual({ ...EMPTY_FLAGS, configPath: "/tmp/snapper/env.json" });
    expect(result.remaining).toEqual([]);
  });

  it("extracts all supported flags from equals-form argv", () => {
    const result = parseCliFlags([
      "--config=/tmp/env.json",
      "--access-token=access",
      "--base-url=https://snapper.example.com/api/mcp",
    ]);
    expect(result.flags).toEqual({
      configPath: "/tmp/env.json",
      accessToken: "access",
      baseUrl: "https://snapper.example.com/api/mcp",
    });
    expect(result.remaining).toEqual([]);
  });

  it("extracts all supported flags from space-form argv", () => {
    const result = parseCliFlags([
      "--config",
      "/tmp/env.json",
      "--access-token",
      "access",
      "--base-url",
      "https://snapper.example.com/api/mcp",
    ]);
    expect(result.flags).toEqual({
      configPath: "/tmp/env.json",
      accessToken: "access",
      baseUrl: "https://snapper.example.com/api/mcp",
    });
    expect(result.remaining).toEqual([]);
  });

  it("uses the last value when a supported flag is repeated", () => {
    const result = parseCliFlags(["--access-token=A", "--access-token", "B"]);
    expect(result.flags.accessToken).toBe("B");
    expect(result.remaining).toEqual([]);
  });

  it("passes unknown argv through unchanged", () => {
    const result = parseCliFlags(["--bogus", "value", "--topic", "signals."]);
    expect(result.flags).toEqual(EMPTY_FLAGS);
    expect(result.remaining).toEqual(["--bogus", "value", "--topic", "signals."]);
  });

  it("extracts supported flags while preserving watch-specific argv for the caller", () => {
    const result = parseCliFlags([
      "--config=/tmp/env.json",
      "--topic",
      "signals.",
      "--access-token=X",
      "--random",
    ]);
    expect(result.flags).toEqual({
      ...EMPTY_FLAGS,
      configPath: "/tmp/env.json",
      accessToken: "X",
    });
    expect(result.remaining).toEqual(["--topic", "signals.", "--random"]);
  });

  it("returns empty flags and empty remaining argv for an empty command line", () => {
    const result = parseCliFlags([]);
    expect(result.flags).toEqual(EMPTY_FLAGS);
    expect(result.remaining).toEqual([]);
  });

  it("uses an empty string when a supported space-form flag has no following value", () => {
    const result = parseCliFlags(["--config"]);
    expect(result.flags).toEqual({ ...EMPTY_FLAGS, configPath: "" });
    expect(result.remaining).toEqual([]);
  });

  it("skips sparse argv entries defensively", () => {
    const argv = ["--access-token=A"] as Array<string | undefined>;
    argv.unshift(undefined);
    const result = parseCliFlags(argv as readonly string[]);
    expect(result.flags).toEqual({ ...EMPTY_FLAGS, accessToken: "A" });
    expect(result.remaining).toEqual([]);
  });

  it("does not treat watch topics as config flags", () => {
    const result = parseCliFlags(["--config=/tmp/env.json", "--topic", "orders.events."]);
    expect(result.flags.configPath).toBe("/tmp/env.json");
    expect(result.remaining).toEqual(["--topic", "orders.events."]);
  });
});
