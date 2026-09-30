import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnvValidationError, loadConfigFile } from "../src/env.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, stat: vi.fn() };
});

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn() }));

describe("config file retry scheduling", () => {
  beforeEach(() => {
    vi.mocked(stat).mockReset();
    vi.mocked(sleep).mockReset().mockResolvedValue(undefined);
  });

  it("makes one initial attempt and three delayed retries for a missing file", async () => {
    const calls: string[] = [];
    vi.mocked(stat).mockImplementation(() => {
      calls.push("stat");
      return Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
    });
    vi.mocked(sleep).mockImplementation(() => {
      calls.push("sleep");
      return Promise.resolve();
    });

    await expect(loadConfigFile("missing.json")).resolves.toBeNull();

    expect(calls).toEqual(["stat", "sleep", "stat", "sleep", "stat", "sleep", "stat"]);
    expect(vi.mocked(sleep).mock.calls).toEqual([[500], [500], [500]]);
  });

  it("waits for the retry delay before observing a new filesystem error", async () => {
    let releaseSleep!: () => void;
    const delay = new Promise<void>((resolve) => { releaseSleep = resolve; });
    vi.mocked(sleep).mockReturnValueOnce(delay);
    vi.mocked(stat)
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));

    const loading = loadConfigFile("protected.json");
    const outcome = expect(loading).rejects.toBeInstanceOf(EnvValidationError);
    await Promise.resolve();

    expect(stat).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(500);
    releaseSleep();
    await outcome;
    expect(stat).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not schedule retries for an initial error other than a missing file", async () => {
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));

    await expect(loadConfigFile("protected.json")).rejects.toBeInstanceOf(EnvValidationError);

    expect(stat).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
