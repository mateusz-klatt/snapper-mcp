/**
 * Local state directory, hardened atomic file I/O, wake preference
 * markers, session locks, and reversible integration manifest storage.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
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
  const parent = path.dirname(targetPath);
  await mkdir(parent, { recursive: true, mode: mode === 0o600 ? 0o700 : 0o755 });
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

async function tryCreateExclusiveLock(
  lockPath: string,
  payload: LockFilePayload,
): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if (isExistsError(err)) return false;
    throw err;
  }
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  const raw = await readTextIfPresent(lockPath);
  if (raw === null) return;
  try {
    const parsed = JSON.parse(raw) as { readonly token?: unknown };
    if (parsed.token === token) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // Do not unlink an unparseable file we cannot prove ownership of.
  }
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
      return {
        acquired: true,
        release: () => releaseOwnedLock(lockPath, token),
      };
    }
    const existingRaw = await readTextIfPresent(lockPath);
    if (existingRaw === null) {
      continue;
    }
    let holderAlive = false;
    try {
      const existing = JSON.parse(existingRaw) as { readonly pid?: unknown };
      if (typeof existing.pid === "number" && isPidAlive(existing.pid)) {
        holderAlive = true;
      }
    } catch {
      holderAlive = false;
    }
    if (holderAlive) {
      return { acquired: false, release: () => Promise.resolve() };
    }
    await rm(lockPath, { force: true });
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
}): Promise<R> {
  const platform = params.platform ?? process.platform;
  const isPidAlive = params.isPidAlive ?? defaultIsPidAlive;
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

  const deadline = Date.now() + 1_500;
  let acquired = false;
  while (Date.now() < deadline) {
    acquired = await tryCreateExclusiveLock(lockPath, payload);
    if (acquired) break;
    const raw = await readTextIfPresent(lockPath);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as {
          readonly pid?: unknown;
          readonly createdAtMs?: unknown;
        };
        const stalePid =
          typeof parsed.pid !== "number" || !isPidAlive(parsed.pid);
        const expired =
          typeof parsed.createdAtMs === "number" &&
          Date.now() - parsed.createdAtMs > 5_000;
        if (stalePid || expired) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        await rm(lockPath, { force: true });
        continue;
      }
    }
    await sleep(15);
  }
  if (!acquired) {
    throw new Error(`timed out acquiring state lock for ${params.name}`);
  }

  try {
    const raw = await readTextIfPresent(dataPath);
    let current: T;
    if (raw === null || raw.trim().length === 0) {
      current = params.initial();
    } else {
      try {
        current = JSON.parse(raw) as T;
      } catch {
        current = params.initial();
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
  const existingBytes = await readBytesIfPresent(resolvedTarget);
  const existingText = existingBytes === null ? null : existingBytes.toString("utf8");
  const nextText = params.render(existingText);
  if (existingText !== null && existingText === nextText) {
    return;
  }

  const manifest = await loadManifest(params.stateDir);
  const prior = manifest.entries.find(
    (entry) => entry.client === params.client && entry.path === resolvedTarget,
  );
  const record: ManifestFileRecord = {
    path: resolvedTarget,
    client: params.client,
    existedBefore: prior ? prior.existedBefore : existingBytes !== null,
    backupBase64: prior
      ? prior.backupBase64
      : existingBytes === null
        ? null
        : existingBytes.toString("base64"),
    writtenSha256: sha256Hex(nextText),
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
    mode: params.mode ?? 0o644,
    platform,
  });
}

async function pruneEmptyParentDirs(filePath: string, levels = 3): Promise<void> {
  let dir = path.dirname(filePath);
  for (let i = 0; i < levels; i += 1) {
    try {
      const st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) break;
      await rmdir(dir);
      dir = path.dirname(dir);
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
    const current = await readTextIfPresent(entry.path);
    if (current === null) {
      continue;
    }
    const unchangedSinceInstall = sha256Hex(current) === entry.writtenSha256;
    if (!entry.existedBefore && unchangedSinceInstall) {
      await rm(entry.path, { force: true });
      await pruneEmptyParentDirs(entry.path);
      continue;
    }
    if (unchangedSinceInstall && entry.backupBase64 !== null) {
      await writeFileAtomic(entry.path, Buffer.from(entry.backupBase64, "base64"), {
        mode: 0o644,
        platform,
      });
      continue;
    }
    const stripped = params.strip(entry.path, current);
    if (stripped === null) {
      await rm(entry.path, { force: true });
      await pruneEmptyParentDirs(entry.path);
    } else if (stripped !== current) {
      await writeFileAtomic(entry.path, stripped, { mode: 0o644, platform });
    }
  }

  await saveManifest(params.stateDir, { version: 1, entries: remaining }, platform);
}
