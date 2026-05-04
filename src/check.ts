/**
 * `snapper-mcp check` — offline health probe for the access token + base URL.
 *
 * Decodes the access JWT (header + payload, no signature verify) and
 * prints the operator-relevant claims plus expiry deltas so a user
 * can distinguish "wrong token pasted" from "right token, expired"
 * from "right token, wrong scope" without burning the token on a
 * failed bridge-up. Pure offline by default — no DNS, no HTTP.
 *
 * Output format is human-readable plain text on stdout. Non-zero
 * exit codes signal actionable diagnostics so the subcommand can be
 * piped into a startup script:
 *   - 0: token decoded, base URL parsed, no expiry red flag.
 *   - 1: env validation failed (missing or malformed inputs).
 *   - 2: token decoded but is already expired or has no `exp` claim.
 */

import { parseCliFlags, loadConfigFile, resolveBridgeEnv, EnvValidationError } from "./env.js";

interface JwtParts {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
}

const EXIT_OK = 0;
const EXIT_ENV = 1;
const EXIT_EXPIRED = 2;

function decodeBase64UrlJson(segment: string): Record<string, unknown> {
  const padded = segment.replaceAll("-", "+").replaceAll("_", "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const json = Buffer.from(padded + padding, "base64").toString("utf8");
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JWT segment is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function splitJwt(token: string): JwtParts {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new Error(`expected 3 dot-separated segments, got ${segments.length}`);
  }
  const [headerB64, payloadB64] = segments;
  if (headerB64 === undefined || headerB64.length === 0 || payloadB64 === undefined || payloadB64.length === 0) {
    throw new Error("JWT header or payload segment is empty");
  }
  return {
    header: decodeBase64UrlJson(headerB64),
    payload: decodeBase64UrlJson(payloadB64),
  };
}

function pickString(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];
  return typeof value === "string" ? value : null;
}

function pickNumber(claims: Record<string, unknown>, key: string): number | null {
  const value = claims[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickStringArray(claims: Record<string, unknown>, key: string): readonly string[] | null {
  const value = claims[key];
  if (!Array.isArray(value)) return null;
  return value.every((item): item is string => typeof item === "string") ? value : null;
}

function formatRelativeSeconds(deltaSeconds: number): string {
  if (deltaSeconds === 0) return "now";
  const sign = deltaSeconds > 0 ? "in " : "";
  const suffix = deltaSeconds < 0 ? " ago" : "";
  const abs = Math.abs(deltaSeconds);
  if (abs < 60) return `${sign}${abs.toFixed(0)}s${suffix}`;
  if (abs < 3600) return `${sign}${(abs / 60).toFixed(1)}min${suffix}`;
  if (abs < 86400) return `${sign}${(abs / 3600).toFixed(1)}h${suffix}`;
  return `${sign}${(abs / 86400).toFixed(1)}d${suffix}`;
}

function formatEpoch(epochSeconds: number, now: Date): string {
  const iso = new Date(epochSeconds * 1000).toISOString();
  const deltaSeconds = epochSeconds - Math.floor(now.getTime() / 1000);
  return `${iso} (${formatRelativeSeconds(deltaSeconds)})`;
}

function reportToken(
  payload: Record<string, unknown>,
  header: Record<string, unknown>,
  now: Date,
  stdout: NodeJS.WritableStream,
): boolean {
  const lines: string[] = [];
  lines.push("access token:");
  const alg = pickString(header, "alg");
  const typ = pickString(header, "typ");
  if (alg !== null) lines.push(`  alg: ${alg}`);
  if (typ !== null) lines.push(`  typ: ${typ}`);
  const sub = pickString(payload, "sub");
  if (sub !== null) lines.push(`  sub: ${sub}`);
  const iss = pickString(payload, "iss");
  if (iss !== null) lines.push(`  iss: ${iss}`);
  const aud = pickString(payload, "aud") ?? pickStringArray(payload, "aud")?.join(", ") ?? null;
  if (aud !== null) lines.push(`  aud: ${aud}`);
  const role = pickString(payload, "role");
  if (role !== null) lines.push(`  role: ${role}`);
  const scopes = pickStringArray(payload, "scopes") ?? pickStringArray(payload, "scope");
  if (scopes !== null) lines.push(`  scopes: ${scopes.join(", ")}`);
  const iat = pickNumber(payload, "iat");
  if (iat !== null) lines.push(`  iat: ${formatEpoch(iat, now)}`);
  const exp = pickNumber(payload, "exp");
  let expired = false;
  if (exp === null) {
    lines.push("  exp: <missing>  (treated as expired)");
    expired = true;
  } else {
    lines.push(`  exp: ${formatEpoch(exp, now)}`);
    if (exp <= Math.floor(now.getTime() / 1000)) {
      expired = true;
      lines.push("  status: EXPIRED — regenerate via Snapper UI");
    } else {
      lines.push("  status: valid");
    }
  }
  stdout.write(`${lines.join("\n")}\n`);
  return expired;
}

export interface CheckMainArgs {
  readonly argv: readonly string[];
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
}

export async function checkMain(args: CheckMainArgs): Promise<number> {
  const stdout = args.stdout ?? process.stdout;
  const stderr = args.stderr ?? process.stderr;
  const env = args.env ?? process.env;
  const now = args.now ?? new Date();
  const { flags } = parseCliFlags(args.argv);
  let configFile = null;
  try {
    if (flags.configPath !== null) {
      configFile = await loadConfigFile(flags.configPath);
    }
    const bridgeEnv = resolveBridgeEnv(env, flags, configFile);
    stdout.write(`base URL: ${bridgeEnv.baseUrl.toString()}\n`);
    let parts: JwtParts;
    try {
      parts = splitJwt(bridgeEnv.accessToken);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      stderr.write(`access token is not a parseable JWT: ${reason}\n`);
      return EXIT_ENV;
    }
    const expired = reportToken(parts.payload, parts.header, now, stdout);
    return expired ? EXIT_EXPIRED : EXIT_OK;
  } catch (err) {
    let message: string;
    if (err instanceof EnvValidationError || err instanceof Error) {
      message = err.message;
    } else {
      message = String(err);
    }
    stderr.write(`snapper-mcp check: ${message}\n`);
    return EXIT_ENV;
  }
}
