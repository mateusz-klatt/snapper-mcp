import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireSessionLock,
  mutateLockedJsonFile,
  sha256Hex,
} from "../src/state_dir.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    open: vi.fn(actual.open),
    rm: vi.fn(actual.rm),
  };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
  "node:fs/promises",
);

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sessionLockPath(stateDir: string, sessionKey: string): string {
  return path.join(
    stateDir,
    "locks",
    `grok-${sha256Hex(sessionKey).slice(0, 24)}.lock`,
  );
}

async function writeLock(
  lockPath: string,
  pid: number,
  token: string,
  createdAtMs: number,
): Promise<string> {
  const raw = `${JSON.stringify({ pid, token, sessionKey: "sample", createdAtMs })}\n`;
  await actualFs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  await actualFs.writeFile(lockPath, raw, { encoding: "utf8", mode: 0o600 });
  return raw;
}

describe("state_dir lock race regressions", () => {
  const tempDirs: string[] = [];

  async function makeTemp(): Promise<string> {
    const dir = await actualFs.mkdtemp(path.join(os.tmpdir(), "snapper-mcp-lock-race-"));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.mocked(fs.link).mockImplementation(actualFs.link);
    vi.mocked(fs.open).mockImplementation(actualFs.open);
    vi.mocked(fs.rm).mockImplementation(actualFs.rm);
  });

  afterEach(async () => {
    vi.useRealTimers();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await actualFs.rm(dir, { recursive: true, force: true });
    }
  });

  it("allows only one owner during exclusive payload publication", async () => {
    const stateDir = await makeTemp();
    const sessionKey = "101:publication";
    const lockPath = sessionLockPath(stateDir, sessionKey);
    const publicationStarted = deferred();
    const resumePublication = deferred();
    let intercepted = false;

    vi.mocked(fs.open).mockImplementation(async (target, flags, mode) => {
      const handle = await actualFs.open(target, flags, mode);
      if (!intercepted && target === lockPath) {
        intercepted = true;
        const originalWrite = handle.writeFile.bind(handle) as (
          data: string | Uint8Array,
          options?: unknown,
        ) => Promise<void>;
        handle.writeFile = (async (
          data: string | Uint8Array,
          options?: unknown,
        ): Promise<void> => {
          publicationStarted.resolve();
          await resumePublication.promise;
          await originalWrite(data, options);
        }) as unknown as typeof handle.writeFile;
      }
      return handle;
    });
    vi.mocked(fs.link).mockImplementation(async (existingPath, newPath) => {
      if (!intercepted && newPath === lockPath) {
        intercepted = true;
        publicationStarted.resolve();
        await resumePublication.promise;
      }
      await actualFs.link(existingPath, newPath);
    });

    const firstPromise = acquireSessionLock({
      stateDir,
      client: "grok",
      sessionKey,
      pid: 101,
      isPidAlive: () => true,
    });
    await publicationStarted.promise;
    const second = await acquireSessionLock({
      stateDir,
      client: "grok",
      sessionKey,
      pid: 202,
      isPidAlive: () => true,
    });
    resumePublication.resolve();
    const first = await firstPromise;

    try {
      expect(first.acquired).not.toBe(second.acquired);
      const names = await actualFs.readdir(path.dirname(lockPath));
      expect(names.filter((name) => name.includes(".tmp."))).toEqual([]);
    } finally {
      resumePublication.resolve();
      await first.release();
      await second.release();
    }
  });

  it("does not evict a live runtime lock holder after five seconds", async () => {
    let nowMs = 10_000;
    const stateDir = await makeTemp();
    const lockPath = path.join(stateDir, "runtime", "sample.mutex");
    const original = await writeLock(lockPath, 101, "live-holder", 1_000);

    const operation = mutateLockedJsonFile({
      stateDir,
      name: "sample",
      initial: () => ({ count: 0 }),
      mutate: (current) => ({
        next: { count: current.count + 1 },
        result: current.count + 1,
      }),
      isPidAlive: () => true,
      nowMs: () => nowMs,
      sleepMs: (ms) => {
        nowMs += ms;
        return Promise.resolve();
      },
    });
    await expect(operation).rejects.toThrow("QUIESCENT");

    expect(await actualFs.readFile(lockPath, "utf8")).toBe(original);
  });

  it("does not unlink a replacement after deciding another lock was stale", async () => {
    const stateDir = await makeTemp();
    const lockPath = path.join(stateDir, "runtime", "sample.mutex");
    const stale = await writeLock(lockPath, 101, "stale-holder", Date.now());
    const removalStarted = deferred();
    const resumeRemoval = deferred();
    let intercepted = false;

    vi.mocked(fs.rm).mockImplementation(async (target, options) => {
      if (!intercepted && target === lockPath) {
        intercepted = true;
        removalStarted.resolve();
        await resumeRemoval.promise;
      }
      await actualFs.rm(target, options);
    });

    const operation = mutateLockedJsonFile({
      stateDir,
      name: "sample",
      initial: () => ({ count: 0 }),
      mutate: (current) => ({
        next: { count: current.count + 1 },
        result: current.count + 1,
      }),
      isPidAlive: (pid) => pid === 202,
    });
    const settled = operation.then(
      () => "settled",
      () => "settled",
    );
    const phase = await Promise.race([
      removalStarted.promise.then(() => "removal"),
      settled,
    ]);

    if (phase === "settled") {
      await expect(operation).rejects.toThrow("QUIESCENT");
      expect(await actualFs.readFile(lockPath, "utf8")).toBe(stale);
      return;
    }

    await actualFs.rm(lockPath, { force: true });
    const replacement = await writeLock(lockPath, 202, "live-replacement", Date.now());
    resumeRemoval.resolve();
    await operation;

    expect(await actualFs.readFile(lockPath, "utf8")).toBe(replacement);
  });

  it("requires explicit quiescent recovery for a malformed session lock", async () => {
    const stateDir = await makeTemp();
    const sessionKey = "101:malformed";
    const lockPath = sessionLockPath(stateDir, sessionKey);
    await actualFs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    await actualFs.writeFile(lockPath, "{not-json", "utf8");

    await expect(
      acquireSessionLock({
        stateDir,
        client: "grok",
        sessionKey,
        pid: 202,
        isPidAlive: () => true,
      }),
    ).rejects.toThrow("QUIESCENT");
    expect(await actualFs.readFile(lockPath, "utf8")).toBe("{not-json");
  });

  it("requires explicit quiescent recovery for a dead session lock", async () => {
    const stateDir = await makeTemp();
    const sessionKey = "101:dead";
    const lockPath = sessionLockPath(stateDir, sessionKey);
    const original = await writeLock(lockPath, 101, "dead-holder", Date.now());

    await expect(
      acquireSessionLock({
        stateDir,
        client: "grok",
        sessionKey,
        pid: 202,
        isPidAlive: () => false,
      }),
    ).rejects.toThrow("QUIESCENT");
    expect(await actualFs.readFile(lockPath, "utf8")).toBe(original);
  });

  it("serializes concurrent calls to release one owner handle", async () => {
    const stateDir = await makeTemp();
    const sessionKey = "101:release";
    const lockPath = sessionLockPath(stateDir, sessionKey);
    const first = await acquireSessionLock({
      stateDir,
      client: "grok",
      sessionKey,
      pid: 101,
      isPidAlive: () => true,
    });
    const removalStarted = deferred();
    const resumeRemoval = deferred();
    let intercepted = false;

    vi.mocked(fs.rm).mockImplementation(async (target, options) => {
      if (!intercepted && target === lockPath) {
        intercepted = true;
        removalStarted.resolve();
        await resumeRemoval.promise;
      }
      await actualFs.rm(target, options);
    });

    const firstRelease = first.release();
    await removalStarted.promise;
    const secondRelease = first.release();
    let replacement: Awaited<ReturnType<typeof acquireSessionLock>> | null = null;

    try {
      if (secondRelease !== firstRelease) {
        await secondRelease;
      } else {
        resumeRemoval.resolve();
        await firstRelease;
      }
      replacement = await acquireSessionLock({
        stateDir,
        client: "grok",
        sessionKey,
        pid: 202,
        isPidAlive: () => true,
      });
      expect(replacement.acquired).toBe(true);
      const replacementRaw = await actualFs.readFile(lockPath, "utf8");

      if (secondRelease !== firstRelease) {
        resumeRemoval.resolve();
        await firstRelease;
      }

      expect(await actualFs.readFile(lockPath, "utf8")).toBe(replacementRaw);
      const ownerRemovals = vi
        .mocked(fs.rm)
        .mock.calls.filter(([target]) => target === lockPath);
      expect(ownerRemovals).toHaveLength(1);
    } finally {
      resumeRemoval.resolve();
      await Promise.all([firstRelease, secondRelease]);
      await first.release();
      if (replacement !== null) {
        await replacement.release();
      }
    }
  });

  it("cleans temporary payloads when exclusive link publication fails", async () => {
    const stateDir = await makeTemp();
    const sessionKey = "101:link-error";
    const lockPath = sessionLockPath(stateDir, sessionKey);
    vi.mocked(fs.link).mockRejectedValue(new Error("injected link failure"));

    await expect(
      acquireSessionLock({
        stateDir,
        client: "grok",
        sessionKey,
        pid: 101,
        isPidAlive: () => true,
      }),
    ).rejects.toThrow("injected link failure");

    const names = await actualFs.readdir(path.dirname(lockPath));
    expect(names.filter((name) => name.includes(".tmp."))).toEqual([]);
  });
});
