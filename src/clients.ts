/**
 * Supported coding CLI targets for `snapper-mcp` integration, hooks,
 * and session wake orchestration.
 */

export const SUPPORTED_CLIENTS = [
  "claude",
  "codex",
  "copilot",
  "antigravity",
  "kimi",
  "grok",
  "cursor",
] as const;

export type ClientName = (typeof SUPPORTED_CLIENTS)[number];

const CLIENT_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_CLIENTS);

export class ClientArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientArgError";
  }
}

export function isClientName(value: string): value is ClientName {
  return CLIENT_SET.has(value);
}

export function parseClientName(value: string, flagName = "--client"): ClientName {
  const normalized = value.trim().toLowerCase();
  if (isClientName(normalized)) {
    return normalized;
  }
  throw new ClientArgError(
    `unsupported ${flagName} value ${JSON.stringify(value)} — expected one of: ${SUPPORTED_CLIENTS.join(", ")}`,
  );
}

export const ALL_CLIENTS = SUPPORTED_CLIENTS;

export function parseClientSelection(
  value: string | readonly string[],
): readonly ClientName[] {
  const items = typeof value === "string" ? [value] : value;
  if (items.length === 0) {
    throw new ClientArgError(
      `client target is required — expected one of: ${SUPPORTED_CLIENTS.join(", ")}, all`,
    );
  }
  let sawAll = false;
  const seen = new Set<ClientName>();
  const out: ClientName[] = [];
  for (const raw of items) {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "all") {
      sawAll = true;
      continue;
    }
    const parsed = parseClientName(normalized, "client");
    if (!seen.has(parsed)) {
      seen.add(parsed);
      out.push(parsed);
    }
  }
  if (sawAll) {
    if (out.length > 0) {
      throw new ClientArgError(
        "'all' cannot be combined with other client targets",
      );
    }
    return SUPPORTED_CLIENTS;
  }
  return out;
}
