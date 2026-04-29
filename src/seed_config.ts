import { mkdir, rename, unlink, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { BridgeEnv } from "./env.js";
import type { Logger } from "./logger.js";

export async function seedConfigFileIfPluginContext(
  env: BridgeEnv,
  source: NodeJS.ProcessEnv,
  logger: Logger,
): Promise<void> {
  const dataDir = source["CLAUDE_PLUGIN_DATA"];
  if (typeof dataDir !== "string" || dataDir.trim().length === 0) return;

  const target = path.join(dataDir, "env.json");
  const payload = `${JSON.stringify(
    {
      SNAPPER_BASE_URL: env.baseUrl.toString(),
      SNAPPER_ACCESS_TOKEN: env.accessToken,
      SNAPPER_REFRESH_TOKEN: env.refreshToken ?? "",
      SNAPPER_WATCH_ACCESS_TOKEN: env.watchAccessToken ?? "",
    },
    null,
    2,
  )}\n`;
  const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`;

  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, payload, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
    logger.info(`seeded env.json at ${target}`);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`failed to seed env.json at ${target}: ${message}`);
  }
}
