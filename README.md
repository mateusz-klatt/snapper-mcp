# @mateusz-klatt/snapper-mcp

[![npm version](https://img.shields.io/npm/v/@mateusz-klatt%2Fsnapper-mcp.svg?v=2)](https://www.npmjs.com/package/@mateusz-klatt/snapper-mcp)
[![node](https://img.shields.io/node/v/@mateusz-klatt%2Fsnapper-mcp.svg?v=2)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/@mateusz-klatt%2Fsnapper-mcp.svg?v=2)](./LICENSE)
[![CI](https://github.com/mateusz-klatt/snapper-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mateusz-klatt/snapper-mcp/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=mateusz-klatt_snapper-mcp&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=mateusz-klatt_snapper-mcp)
[![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-Plugin-ff6a00)](#install)

Lightweight stdio-to-HTTP **Model Context Protocol** bridge. Spawns as a
subprocess, speaks MCP over stdio to Claude Desktop / Claude Code, and
proxies every request to a Snapper backend's `/api/mcp` endpoint with
Bearer-token auth.

## What is this

Snapper is a multi-tenant trading platform. Its backend exposes MCP at
`/api/mcp`, guarded by Bearer-JWT auth, feature flag, and per-principal
rate limiting. MCP hosts (Claude Desktop, Claude Code) speak MCP over
**stdio** — they spawn a subprocess and exchange JSON-RPC frames over
stdin/stdout. `@mateusz-klatt/snapper-mcp` is the stdio ⇄ HTTP bridge that
makes that conversation work.

It is a **thin** TypeScript bridge using Node's built-in `fetch`, plus
`@modelcontextprotocol/sdk` for MCP framing. No OAuth, no telemetry.
Standalone hosts (Claude Desktop, systemd, plain CLI) can provide
credentials through CLI flags, a hardened `--config` JSON file, or
environment variables. Claude Code plugin installs write a
`0600`-mode `env.json` into the per-plugin `${CLAUDE_PLUGIN_DATA}`
directory at proxy startup so the auto-spawned monitor process can
read its credentials via `--config=PATH`; the file is owned by the
plugin's data dir and is overwritten atomically on every proxy
startup.

## Install

Three install paths, in recommended order. All three end at the same
runtime — pick whichever matches your MCP host.

### Option 1 — Claude Code plugin (recommended)

In any Claude Code session:

```text
/plugin marketplace add mateusz-klatt/snapper-mcp
/plugin install snapper-mcp@mateusz-klatt-snapper-mcp
```

Claude Code prompts for two values:

- **Snapper API URL** — your backend's `/api/mcp` endpoint.
- **Access token** — paste from Snapper's *Settings -> AI Delegates*
  page (the config-snippet generator). The same token authenticates
  both the proxy MCP server and the watch monitor.

Plugin changes installed mid-session need `/reload-plugins` (or a
Claude Code restart) before the MCP server starts. After reloading,
`/mcp list` should show the `snapper` server connected.

The plugin manifest threads both credentials (`SNAPPER_BASE_URL`,
`SNAPPER_ACCESS_TOKEN`) into the proxy MCP subprocess as env vars via
`${user_config.KEY}` interpolation. The proxy then writes a
`0600`-mode `env.json` snapshot into `${CLAUDE_PLUGIN_DATA}` at
startup so the auto-spawned watch monitor can read the same values
via `--config="${CLAUDE_PLUGIN_DATA}/env.json"`. Claude Code stores
`sensitive: true` user_config values in the OS keychain when
available, falling back to `~/.claude/.credentials.json` — they
never land in `settings.json` or the manifest.

### Option 2 — Claude Desktop manual config

Add to your Claude Desktop config
(`~/Library/Application Support/Claude/claude_desktop_config.json` on
macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "snapper": {
      "command": "npx",
      "args": ["-y", "@mateusz-klatt/snapper-mcp"],
      "env": {
        "SNAPPER_BASE_URL": "https://your-snapper-instance.example.com/api/mcp",
        "SNAPPER_ACCESS_TOKEN": "<generated via Snapper UI: Settings -> AI Delegates>"
      }
    }
  }
}
```

Restart Claude Desktop; the Snapper server shows up in the MCP Servers
settings panel.

### Option 3 — Direct CLI / custom hosts

```bash
SNAPPER_BASE_URL="..." SNAPPER_ACCESS_TOKEN="..." \
  npx -y @mateusz-klatt/snapper-mcp

npm install -g @mateusz-klatt/snapper-mcp
SNAPPER_BASE_URL="..." SNAPPER_ACCESS_TOKEN="..." snapper-mcp
```

Requires **Node 26+** (uses Node's built-in `fetch`, `AbortController`,
and ESM top-level `await`). CI validates the declared minimum
(Node 26) across Ubuntu / macOS / Windows.

## Configuration

Two environment variables are the common MCP-host configuration shape:

| Variable | Required? | Purpose |
| --- | --- | --- |
| `SNAPPER_BASE_URL` | yes | URL of Snapper's `/api/mcp` endpoint. |
| `SNAPPER_ACCESS_TOKEN` | yes | Long-lived AI delegate JWT for Bearer auth (generated in Snapper UI). The same token authenticates both the proxy MCP server and the watch monitor. |

See [`.env.example`](./.env.example) for placeholder values.

Direct CLI runs also accept `--base-url`, `--access-token`, and
`--config=PATH`. Resolution order is CLI flags, then a JSON config
file, then environment variables. Config files can contain the same
top-level `SNAPPER_BASE_URL` / `SNAPPER_ACCESS_TOKEN` keys shown
above; on POSIX systems the bridge refuses world-writable files and
warns when the file is group- or world-readable.

### Multi-profile support

Run multiple Snapper instances (prod + staging, prod + local dev) from
one bridge install. Select a profile at spawn time:

```bash
SNAPPER_PROFILE=prod snapper-mcp
# or
snapper-mcp --profile=prod
```

When a profile is selected, the bridge reads
`SNAPPER_PROFILE_<UPPER>_BASE_URL` and
`SNAPPER_PROFILE_<UPPER>_ACCESS_TOKEN` instead of the bare top-level
vars (hard isolation — no accidental cross-profile fallback). Profile
names match `^[a-z0-9]{1,32}$`. CLI flag wins over env var.
CLI `--base-url` / `--access-token` flags still override the selected
profile; otherwise config/env lookup is profile-scoped.

The `--config` JSON file may carry a `profiles` block:

```json
{
  "profiles": {
    "prod":    { "SNAPPER_BASE_URL": "https://snapper.example.com/api/mcp", "SNAPPER_ACCESS_TOKEN": "..." },
    "staging": { "SNAPPER_BASE_URL": "https://staging.example.com/api/mcp", "SNAPPER_ACCESS_TOKEN": "..." }
  }
}
```

Verify a profile offline before spawning the bridge:

```bash
snapper-mcp check --profile=prod
```

## Generating tokens

Snapper ships a **Settings → AI Delegates** UI that issues credentials.
Each delegate emits a single long-lived (~3-month / 90-day) access JWT. Paste
the value into `SNAPPER_ACCESS_TOKEN`; the same token powers both the
proxy MCP server and the optional push-wakeup monitor.

Each delegate has configurable caps: per-instrument quantity,
max open orders, rolling 24h USD notional, and 60-second cancel rate.
Tokens are bound to the delegate's permissions + wallet scope; revoke
the delegate in-place via `POST /api/ai-delegates/{id}/deactivate` to
revoke the backend token inventory and evict verify caches via
`admin.user_deactivated`.

## Logging

All bridge logs go to **stderr** exclusively. Stdout is reserved for
MCP JSON-RPC frames — any stray write there corrupts the protocol
stream and Claude Desktop disconnects.

Verbosity knob: set `SNAPPER_MCP_LOG_LEVEL=debug` for transport-level
diagnostics (URL, HTTP status, error_code). Valid levels:
`debug` / `info` (default) / `warn` / `error`. Timestamps in the log
prefix: `SNAPPER_MCP_LOG_TIMESTAMPS=1`.

For structured-log pipelines, set `SNAPPER_MCP_LOG_FORMAT=json` to
switch every stderr line to a single-line JSON object:

```text
{"t":"2026-05-02T16:00:00.000Z","lvl":"info","prefix":"bridge","msg":"connected","rest":[{"req":42}]}
```

The `t` field is always present in JSON mode regardless of
`SNAPPER_MCP_LOG_TIMESTAMPS`. Pipe through `jq` for filtering:

```bash
npx -y @mateusz-klatt/snapper-mcp 2>&1 | jq 'select(.lvl=="error")'
```

`Error` instances in the rest arguments serialise as `{name, message,
stack}`; circular objects fall back to `String(value)` rather than
throwing.

## Authentication

On every outbound HTTP request, the bridge injects
`Authorization: Bearer ${SNAPPER_ACCESS_TOKEN}` while preserving any
`Accept` / `Content-Type` / other headers the SDK set.

On 401 the bridge writes a single-line stderr message — once per
session — and propagates the 401 response to the MCP host. The host
surfaces the auth error as a protocol error; the operator recreates
the AI delegate in Snapper to recover.

## Watch subcommand

`snapper-mcp watch` opens a long-lived WebSocket session against
Snapper's `/api/ws` endpoint and writes one JSONL frame per line to
stdout. A Claude Code plugin monitor (or any host that can read a
subprocess's stdout) consumes the JSONL stream as push-style wakeup.

```bash
snapper-mcp watch --topic signals. --topic orders.events.
```

Default subscription: `signals.`, `orders.events.`, `ai_reviews.`, and
`ai_research.` if no `--topic` is given. Each prefix MUST end with `.` to
address a topic family root. The `ai_reviews.` family carries review-request
and decision-ack frames, while `ai_research.` carries committed research-round
wakes. A monitoring host can therefore wake its consumer when either kind of
work needs attention.

The watch session mints a one-shot WebSocket token via
`POST /api/auth/ws_token` using the same `SNAPPER_ACCESS_TOKEN`
configured for the proxy.

## Check subcommand

`snapper-mcp check` runs an offline diagnostic on the configured
access token + base URL — no network. Useful for validating the
contents of `SNAPPER_ACCESS_TOKEN` (sub, role, expiry, and any
`scope`/`scopes` claim present) without burning the token on a failed
bridge-up. This is an offline decode only; server-side signature,
inventory revocation, wallet scope, and permission checks still happen
on the Snapper backend.

```bash
snapper-mcp check
# base URL: https://snapper.example.com/api/mcp/
# access token:
#   alg: HS256
#   sub: ai-claudedesktop-a1b2c3
#   role: ai_delegate
#   exp: 2026-08-01T00:00:00.000Z (in 90.5d)
#   status: valid
```

Exit codes:

- `0` — token decoded, base URL parsed, expiry OK.
- `1` — env validation failed (missing or malformed inputs).
- `2` — token decoded but is already expired or has no `exp` claim.

The same `--config=PATH`, `--access-token`, and `--base-url` flags
the proxy + watch subcommands accept also work for `check`.

## Plugin monitor entry

The plugin manifest's `monitors[]` block auto-spawns
`snapper-mcp watch` on plugin install. The monitor command reads
credentials from the same `--config=PATH` JSON file the proxy MCP
server seeded into `${CLAUDE_PLUGIN_DATA}/env.json` at startup. Both
processes share the same `SNAPPER_ACCESS_TOKEN`.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev workflow
(`npm install`, `npm test`, `npm run build`).

## License

MIT — see [LICENSE](./LICENSE).
