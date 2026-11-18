/**
 * Local state directory, hardened atomic file I/O, wake preference
 * markers, session locks, and reversible integration manifest storage.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rmdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { ClientName } from "./clients.js";

export type WakePreference = "default" | "on" | "off";

export interface ManifestFileRecord {
  readonly path: string;
  readonly client: ClientName;
  readonly existedBefore: boolean;
  readonly backupBase64: string | null;
  readonly writtenSha256: string;
  readonly originalMode?: number | null;
  readonly createdDirs?: readonly string[];
}

export interface IntegrationManifest {
  readonly version: 1;
  readonly entries: readonly ManifestFileRecord[];
}

export interface SessionLockHandle {
  readonly acquired: boolean;
  readonly release: () => Promise<void>;
}

export class UnsafeFileTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeFileTargetError";
  }
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

export function resolveHomeDir(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicitHome =
    platform === "win32"
      ? (source["USERPROFILE"] ?? source["HOME"])
      : (source["HOME"] ?? source["USERPROFILE"]);
  if (typeof explicitHome === "string" && explicitHome.trim().length > 0) {
    return path.resolve(explicitHome.trim());
  }
  const fallback = os.homedir();
  if (fallback.trim().length === 0) {
    throw new Error("unable to resolve user home directory");
  }
  return path.resolve(fallback);
}

export function resolveStateDir(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = source["SNAPPER_MCP_HOME"];
  if (typeof override === "string" && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  const home = resolveHomeDir(source, platform);
  if (platform === "win32") {
    const appData = source["APPDATA"];
    if (typeof appData === "string" && appData.trim().length > 0) {
      return path.resolve(appData.trim(), "snapper-mcp");
    }
    return path.join(home, "AppData", "Roaming", "snapper-mcp");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "snapper-mcp");
  }
  const xdg = source["XDG_CONFIG_HOME"];
  if (typeof xdg === "string" && xdg.trim().length > 0) {
    return path.resolve(xdg.trim(), "snapper-mcp");
  }
  return path.join(home, ".config", "snapper-mcp");
}

export function defaultConfigFilePath(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(resolveStateDir(source, platform), "config.json");
}

function isMissingError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isExistsError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}

export async function assertNotSymlinkOrSpecial(
  targetPath: string,
  allowDirectory = false,
): Promise<void> {
  try {
    const st = await lstat(targetPath);
    if (st.isSymbolicLink()) {
      throw new UnsafeFileTargetError(`refusing symlink path: ${targetPath}`);
    }
    if (allowDirectory && st.isDirectory()) {
      return;
    }
    if (!st.isFile()) {
      throw new UnsafeFileTargetError(`refusing non-regular file path: ${targetPath}`);
    }
  } catch (err) {
    if (isMissingError(err)) return;
    throw err;
  }
}

async function collectMissingAncestorDirs(filePath: string): Promise<string[]> {
  const missing: string[] = [];
  let dir = path.dirname(path.resolve(filePath));
  while (true) {
    try {
      const st = await lstat(dir);
      if (st.isSymbolicLink()) {
        throw new UnsafeFileTargetError(`refusing symlink directory path: ${dir}`);
      }
      if (!st.isDirectory()) {
        throw new UnsafeFileTargetError(`refusing non-directory ancestor path: ${dir}`);
      }
      break;
    } catch (err) {
      if (!isMissingError(err)) throw err;
      missing.push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return missing;
}

export async function ensureParentDirForFile(
  filePath: string,
  dirMode = 0o700,
  platform: NodeJS.Platform = process.platform,
): Promise<readonly string[]> {
  const missingDeepestFirst = await collectMissingAncestorDirs(filePath);
  for (let i = missingDeepestFirst.length - 1; i >= 0; i -= 1) {
    const dir = missingDeepestFirst[i]!;
    await mkdir(dir, { recursive: true, mode: dirMode });
    if (platform !== "win32") {
      await chmod(dir, dirMode);
    }
  }
  return missingDeepestFirst;
}

async function statFileModeIfPresent(targetPath: string): Promise<number | null> {
  await assertNotSymlinkOrSpecial(targetPath, false);
  try {
    const st = await lstat(targetPath);
    return st.mode & 0o777;
  } catch (err) {
    if (isMissingError(err)) return null;
    throw err;
  }
}

export async function ensurePrivateDir(
  dirPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await assertNotSymlinkOrSpecial(dirPath, true);
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    await chmod(dirPath, 0o700);
  }
}

export async function writeFileAtomic(
  targetPath: string,
  content: string | Uint8Array,
  options: { readonly mode?: number; readonly platform?: NodeJS.Platform } = {},
): Promise<void> {
  const mode = options.mode ?? 0o600;
  const platform = options.platform ?? process.platform;
  await assertNotSymlinkOrSpecial(targetPath, false);
  await ensureParentDirForFile(
    targetPath,
    (mode & 0o077) === 0 ? 0o700 : 0o755,
    platform,
  );
  const tmp = `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tmp, content, { mode });
    if (platform !== "win32") {
      await chmod(tmp, mode);
    }
    await rename(tmp, targetPath);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function readTextIfPresent(targetPath: string): Promise<string | null> {
  await assertNotSymlinkOrSpecial(targetPath, false);
  try {
    return await readFile(targetPath, "utf8");
  } catch (err) {
    if (isMissingError(err)) return null;
    throw err;
  }
}

export async function readBytesIfPresent(targetPath: string): Promise<Buffer | null> {
  await assertNotSymlinkOrSpecial(targetPath, false);
  try {
    return await readFile(targetPath);
  } catch (err) {
    if (isMissingError(err)) return null;
    throw err;
  }
}

interface LockFilePayload {
  readonly pid: number;
  readonly token: string;
  readonly sessionKey: string;
  readonly createdAtMs: number;
}

type LockFileInspection =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly payload: LockFilePayload };

export class StateRecoveryRequiredError extends Error {
  readonly recoveryPath: string;

  constructor(message: string, recoveryPath: string) {
    super(message);
    this.name = "StateRecoveryRequiredError";
    this.recoveryPath = recoveryPath;
  }
}

export class StateLockRecoveryRequiredError extends StateRecoveryRequiredError {
  readonly lockPath: string;

  constructor(lockPath: string, reason: string) {
    super(
      `state lock at ${lockPath} requires QUIESCENT recovery (${reason}); ` +
        "stop all snapper-mcp writers and hooks, verify that no writer is active, " +
        "then move the lock file aside before retrying",
      lockPath,
    );
    this.name = "StateLockRecoveryRequiredError";
    this.lockPath = lockPath;
  }
}

export class StateLockContentionError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, name: string) {
    super(
      `timed out after 1.5 s waiting for live state lock ${name} at ${lockPath}; ` +
        "another snapper-mcp process holds it",
    );
    this.name = "StateLockContentionError";
    this.lockPath = lockPath;
  }
}

export class StateDataRecoveryRequiredError extends StateRecoveryRequiredError {
  readonly dataPath: string;

  constructor(dataPath: string, reason: string) {
    super(
      `runtime state data at ${dataPath} requires QUIESCENT recovery (${reason}); ` +
        "stop all snapper-mcp writers and hooks, verify that no writer is active, " +
        "then move the data file aside before retrying",
      dataPath,
    );
    this.name = "StateDataRecoveryRequiredError";
    this.dataPath = dataPath;
  }
}

async function inspectLockFile(lockPath: string): Promise<LockFileInspection> {
  const raw = await readTextIfPresent(lockPath);
  if (raw === null) return { kind: "missing" };
  try {
    const parsed = JSON.parse(raw) as {
      readonly pid?: unknown;
      readonly token?: unknown;
      readonly sessionKey?: unknown;
      readonly createdAtMs?: unknown;
    };
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      typeof parsed.sessionKey !== "string" ||
      typeof parsed.createdAtMs !== "number" ||
      !Number.isFinite(parsed.createdAtMs)
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "valid",
      payload: {
        pid: parsed.pid,
        token: parsed.token,
        sessionKey: parsed.sessionKey,
        createdAtMs: parsed.createdAtMs,
      },
    };
  } catch {
    return { kind: "invalid" };
  }
}

async function tryCreateExclusiveLock(
  lockPath: string,
  payload: LockFilePayload,
): Promise<boolean> {
  const tmp = `${lockPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      await link(tmp, lockPath);
    } catch (err) {
      if (isExistsError(err)) return false;
      throw err;
    }
    return true;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  const inspected = await inspectLockFile(lockPath);
  if (inspected.kind === "valid" && inspected.payload.token === token) {
    await rm(lockPath, { force: true });
  }
}

function ownedSessionLockHandle(lockPath: string, token: string): SessionLockHandle {
  let releasePromise: Promise<void> | null = null;
  return {
    acquired: true,
    release: () => {
      releasePromise ??= releaseOwnedLock(lockPath, token);
      return releasePromise;
    },
  };
}

export async function acquireSessionLock(params: {
  readonly stateDir: string;
  readonly client: ClientName;
  readonly sessionKey: string;
  readonly pid?: number;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly platform?: NodeJS.Platform;
}): Promise<SessionLockHandle> {
  const pid = params.pid ?? process.pid;
  const isPidAlive = params.isPidAlive ?? defaultIsPidAlive;
  const platform = params.platform ?? process.platform;
  const locksDir = path.join(params.stateDir, "locks");
  await ensurePrivateDir(locksDir, platform);

  const keyDigest = sha256Hex(params.sessionKey).slice(0, 24);
  const lockPath = path.join(locksDir, `${params.client}-${keyDigest}.lock`);
  const token = randomUUID();
  const payload: LockFilePayload = {
    pid,
    token,
    sessionKey: params.sessionKey,
    createdAtMs: Date.now(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const created = await tryCreateExclusiveLock(lockPath, payload);
    if (created) {
      return ownedSessionLockHandle(lockPath, token);
    }
    const inspected = await inspectLockFile(lockPath);
    if (inspected.kind === "missing") {
      continue;
    }
    if (inspected.kind === "invalid") {
      throw new StateLockRecoveryRequiredError(lockPath, "malformed or incomplete payload");
    }
    if (isPidAlive(inspected.payload.pid)) {
      return { acquired: false, release: () => Promise.resolve() };
    }
    throw new StateLockRecoveryRequiredError(lockPath, "recorded holder is not alive");
  }
  return { acquired: false, release: () => Promise.resolve() };
}

export async function mutateLockedJsonFile<T, R>(params: {
  readonly stateDir: string;
  readonly name: string;
  readonly initial: () => T;
  readonly mutate: (current: T) => { readonly next: T; readonly result: R };
  readonly isPidAlive?: (pid: number) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly nowMs?: () => number;
  readonly sleepMs?: (ms: number) => Promise<void>;
}): Promise<R> {
  const platform = params.platform ?? process.platform;
  const isPidAlive = params.isPidAlive ?? defaultIsPidAlive;
  const nowMs = params.nowMs ?? Date.now;
  const sleepMs = params.sleepMs ?? sleep;
  const runtimeDir = path.join(params.stateDir, "runtime");
  await ensurePrivateDir(runtimeDir, platform);
  const lockPath = path.join(runtimeDir, `${params.name}.mutex`);
  const dataPath = path.join(runtimeDir, `${params.name}.json`);
  const token = randomUUID();
  const payload: LockFilePayload = {
    pid: process.pid,
    token,
    sessionKey: params.name,
    createdAtMs: Date.now(),
  };

  const deadline = nowMs() + 1_500;
  let acquired = false;
  while (nowMs() < deadline) {
    acquired = await tryCreateExclusiveLock(lockPath, payload);
    if (acquired) break;
    const inspected = await inspectLockFile(lockPath);
    if (inspected.kind === "invalid") {
      throw new StateLockRecoveryRequiredError(lockPath, "malformed or incomplete payload");
    }
    if (inspected.kind === "valid" && !isPidAlive(inspected.payload.pid)) {
      throw new StateLockRecoveryRequiredError(lockPath, "recorded holder is not alive");
    }
    await sleepMs(15);
  }
  if (!acquired) {
    throw new StateLockContentionError(lockPath, params.name);
  }

  try {
    const raw = await readTextIfPresent(dataPath);
    let current: T;
    if (raw === null) {
      current = params.initial();
    } else {
      if (raw.trim().length === 0) {
        throw new StateDataRecoveryRequiredError(dataPath, "empty payload");
      }
      try {
        current = JSON.parse(raw) as T;
      } catch {
        throw new StateDataRecoveryRequiredError(dataPath, "malformed payload");
      }
    }
    const { next, result } = params.mutate(current);
    await writeFileAtomic(dataPath, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
      platform,
    });
    return result;
  } finally {
    await releaseOwnedLock(lockPath, token);
  }
}

export async function readRuntimeJsonFile<T>(
  stateDir: string,
  name: string,
  fallback: () => T,
): Promise<T> {
  const dataPath = path.join(stateDir, "runtime", `${name}.json`);
  const raw = await readTextIfPresent(dataPath);
  if (raw === null || raw.trim().length === 0) {
    return fallback();
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback();
  }
}

function wakeMarkerPath(stateDir: string, client: ClientName): string {
  return path.join(stateDir, "wake", `${client}.pref`);
}

export function isWakeEnabled(preference: WakePreference | null): boolean {
  return preference === "on" || preference === "default";
}

export async function readWakePreference(
  stateDir: string,
  client: ClientName,
): Promise<WakePreference | null> {
  const raw = await readTextIfPresent(wakeMarkerPath(stateDir, client));
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "on" || trimmed === "off" || trimmed === "default") {
    return trimmed;
  }
  throw new Error(`invalid wake preference marker for ${client}`);
}

export async function writeWakePreference(
  stateDir: string,
  client: ClientName,
  preference: WakePreference,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const dir = path.join(stateDir, "wake");
  await ensurePrivateDir(dir, platform);
  await writeFileAtomic(wakeMarkerPath(stateDir, client), `${preference}\n`, {
    mode: 0o600,
    platform,
  });
}

export async function removeWakePreference(
  stateDir: string,
  client: ClientName,
): Promise<void> {
  const target = wakeMarkerPath(stateDir, client);
  await assertNotSymlinkOrSpecial(target, false);
  await rm(target, { force: true });
}

function manifestPath(stateDir: string): string {
  return path.join(stateDir, "manifest.json");
}

export async function loadManifest(stateDir: string): Promise<IntegrationManifest> {
  const raw = await readTextIfPresent(manifestPath(stateDir));
  if (raw === null || raw.trim().length === 0) {
    return { version: 1, entries: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("integration manifest is not valid JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as { readonly version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { readonly entries?: unknown }).entries)
  ) {
    throw new Error("integration manifest has an unsupported format");
  }
  return parsed as IntegrationManifest;
}

export async function saveManifest(
  stateDir: string,
  manifest: IntegrationManifest,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await ensurePrivateDir(stateDir, platform);
  await writeFileAtomic(
    manifestPath(stateDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600, platform },
  );
}

export async function updateManagedFile(params: {
  readonly stateDir: string;
  readonly client: ClientName;
  readonly targetPath: string;
  readonly render: (existing: string | null) => string;
  readonly mode?: number;
  readonly platform?: NodeJS.Platform;
}): Promise<void> {
  const platform = params.platform ?? process.platform;
  const resolvedTarget = path.resolve(params.targetPath);
  const currentMode = await statFileModeIfPresent(resolvedTarget);
  const existingBytes = await readBytesIfPresent(resolvedTarget);
  const existingText = existingBytes === null ? null : existingBytes.toString("utf8");
  const nextText = params.render(existingText);
  if (existingText !== null && existingText === nextText) {
    return;
  }

  const missingDirs = await collectMissingAncestorDirs(resolvedTarget);
  const manifest = await loadManifest(params.stateDir);
  const prior = manifest.entries.find(
    (entry) => entry.client === params.client && entry.path === resolvedTarget,
  );
  const priorUntouched =
    prior !== undefined &&
    existingBytes !== null &&
    sha256Hex(existingBytes) === prior.writtenSha256;

  let existedBefore: boolean;
  let backupBase64: string | null;
  if (prior !== undefined) {
    if (priorUntouched) {
      existedBefore = prior.existedBefore;
      backupBase64 = prior.backupBase64;
    } else {
      existedBefore = true;
      backupBase64 = null;
    }
  } else {
    existedBefore = existingBytes !== null;
    backupBase64 = existingBytes === null ? null : existingBytes.toString("base64");
  }

  const originalMode = prior !== undefined ? (prior.originalMode ?? currentMode) : currentMode;
  const priorCreatedDirs = prior?.createdDirs ?? [];
  const mergedCreatedDirs = [
    ...missingDirs,
    ...priorCreatedDirs.filter((d) => !missingDirs.includes(d)),
  ];
  const effectiveMode = params.mode ?? currentMode ?? 0o600;

  const record: ManifestFileRecord = {
    path: resolvedTarget,
    client: params.client,
    existedBefore,
    backupBase64,
    writtenSha256: sha256Hex(nextText),
    originalMode,
    createdDirs: mergedCreatedDirs,
  };
  const filtered = manifest.entries.filter(
    (entry) => !(entry.client === params.client && entry.path === resolvedTarget),
  );
  await saveManifest(
    params.stateDir,
    { version: 1, entries: [...filtered, record] },
    platform,
  );
  await writeFileAtomic(resolvedTarget, nextText, {
    mode: effectiveMode,
    platform,
  });
}

async function pruneCreatedDirs(createdDirs: readonly string[]): Promise<void> {
  for (const dir of createdDirs) {
    try {
      const st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) break;
      await rmdir(dir);
    } catch {
      break;
    }
  }
}

export async function unwireManagedClient(params: {
  readonly stateDir: string;
  readonly client: ClientName;
  readonly strip: (filePath: string, current: string) => string | null;
  readonly filter?: (filePath: string) => boolean;
  readonly platform?: NodeJS.Platform;
}): Promise<void> {
  const platform = params.platform ?? process.platform;
  const select = params.filter ?? (() => true);
  const manifest = await loadManifest(params.stateDir);
  const owned = manifest.entries.filter(
    (entry) => entry.client === params.client && select(entry.path),
  );
  const remaining = manifest.entries.filter(
    (entry) => !(entry.client === params.client && select(entry.path)),
  );

  for (const entry of owned) {
    const currentMode = await statFileModeIfPresent(entry.path);
    const current = await readTextIfPresent(entry.path);
    if (current === null) {
      await pruneCreatedDirs(entry.createdDirs ?? []);
      continue;
    }
    const targetMode = entry.originalMode ?? currentMode ?? 0o600;
    const unchangedSinceInstall = sha256Hex(current) === entry.writtenSha256;
    if (!entry.existedBefore && unchangedSinceInstall) {
      await rm(entry.path, { force: true });
      await pruneCreatedDirs(entry.createdDirs ?? []);
      continue;
    }
    if (unchangedSinceInstall && entry.backupBase64 !== null) {
      await writeFileAtomic(entry.path, Buffer.from(entry.backupBase64, "base64"), {
        mode: targetMode,
        platform,
      });
      continue;
    }
    const stripped = params.strip(entry.path, current);
    if (stripped === null) {
      await rm(entry.path, { force: true });
      await pruneCreatedDirs(entry.createdDirs ?? []);
    } else if (stripped !== current) {
      await writeFileAtomic(entry.path, stripped, { mode: targetMode, platform });
    }
  }

  if (remaining.length === 0) {
    await assertNotSymlinkOrSpecial(manifestPath(params.stateDir), false);
    await rm(manifestPath(params.stateDir), { force: true });
  } else {
    await saveManifest(params.stateDir, { version: 1, entries: remaining }, platform);
  }
}
