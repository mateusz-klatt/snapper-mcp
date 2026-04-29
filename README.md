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
Bearer-token auth + optional on-401 refresh-token rotation (rotating
delegates) or single-shot long-lived PAT delegates.

## What is this

Snapper is a multi-tenant trading platform. Its backend exposes MCP at
`/api/mcp`, guarded by Bearer-JWT auth, feature flag, and per-principal
rate limiting. MCP hosts (Claude Desktop, Claude Code) speak MCP over
**stdio** — they spawn a subprocess and exchange JSON-RPC frames over
stdin/stdout. `@mateusz-klatt/snapper-mcp` is the stdio ⇄ HTTP bridge that
makes that conversation work.

It is a **thin** bridge: ~1500 lines of TypeScript, using Node's
built-in `fetch`, plus `@modelcontextprotocol/sdk` for MCP framing. No
OAuth, no telemetry. Standalone hosts (Claude Desktop, systemd, plain
CLI) read credentials from env vars only — nothing on disk. Claude
Code plugin installs (`since v0.6.0`) write a `0600`-mode `env.json`
into the per-plugin `${CLAUDE_PLUGIN_DATA}` directory at proxy
startup so the auto-spawned monitor process can read its credentials
via `--config=PATH`; the file is owned by the plugin's data dir and
is overwritten atomically on every proxy startup. Rotating delegates
rotate in-memory on 401; long-lived PAT delegates never rotate.

## Install

Three install paths, in recommended order. All three end at the same
runtime — pick whichever matches your MCP host.

### Option 1 — Claude Code plugin (recommended, since v0.2.1)

In any Claude Code session:

```text
/plugin marketplace add mateusz-klatt/snapper-mcp
/plugin install snapper-mcp@mateusz-klatt-snapper-mcp
```

Claude Code prompts for two required values plus two optional values:

- **Snapper API URL** — your backend's `/api/mcp` endpoint.
- **Access token** — paste from Snapper's *Settings -> AI Delegates*
  page (the config-snippet generator). Powers the proxy MCP server.
- **Refresh token** *(optional)* — paste for rotating-token delegates;
  **leave blank** for long-lived PAT delegates.
- **Watch monitor access token** — required if you want the
  push-wakeup monitor to start. Long-lived single-delegate operators
  paste the SAME token as **Access token** above (no rotation, no
  race). Rotating-delegate operators mint a SECOND long-lived PAT
  delegate explicitly for the monitor and paste its access token
  here. Leaving the field blank causes the monitor to hard-error at
  session start; if you don't want the monitor at all, disable the
  plugin or remove the `monitors[]` array from the local manifest
  cache. See [Plugin monitor entry](#plugin-monitor-entry-since-v060)
  below for the `--config=PATH` delivery mechanism.

Plugin changes installed mid-session need `/reload-plugins` (or a
Claude Code restart) before the MCP server starts. After reloading,
`/mcp list` should show the `snapper` server connected.

The plugin manifest threads all four credentials
(`SNAPPER_BASE_URL`, `SNAPPER_ACCESS_TOKEN`, `SNAPPER_REFRESH_TOKEN`,
`SNAPPER_WATCH_ACCESS_TOKEN`) into the proxy MCP subprocess as env
vars via `${user_config.KEY}` interpolation. The proxy then writes a
`0600`-mode `env.json` snapshot into `${CLAUDE_PLUGIN_DATA}` at
startup so the auto-spawned watch monitor can read the same values
via `--config="${CLAUDE_PLUGIN_DATA}/env.json"` — see
[Plugin monitor entry](#plugin-monitor-entry-since-v060) below for
the wire mechanics. Claude Code stores `sensitive: true` user_config
values in the OS keychain when available, falling back to
`~/.claude/.credentials.json` — they never land in `settings.json`
or the manifest.

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
        "SNAPPER_ACCESS_TOKEN": "<generated via Snapper UI: Settings -> AI Delegates>",
        "SNAPPER_REFRESH_TOKEN": "<generated via Snapper UI: Settings -> AI Delegates>"
      }
    }
  }
}
```

For long-lived PAT delegates, omit `SNAPPER_REFRESH_TOKEN` or set it
to `""`. Restart Claude Desktop; the Snapper server shows up in the
MCP Servers settings panel.

### Option 3 — Direct CLI / custom hosts

```bash
# One-shot via npx (matches Option 2 under the hood):
SNAPPER_BASE_URL="..." SNAPPER_ACCESS_TOKEN="..." \
  npx -y @mateusz-klatt/snapper-mcp

# Or install globally:
npm install -g @mateusz-klatt/snapper-mcp
SNAPPER_BASE_URL="..." SNAPPER_ACCESS_TOKEN="..." snapper-mcp
```

Requires **Node 22+** (uses Node's built-in `fetch`, `AbortController`,
and ESM top-level `await`). CI validates the declared minimum
(Node 22) across Ubuntu / macOS / Windows; higher Node versions work
because the bridge only relies on APIs stable since Node 18.

Two env vars are required; a third is optional. The MCP host must set
them before spawning:

| Variable | Required? | Purpose |
| --- | --- | --- |
| `SNAPPER_BASE_URL` | yes | URL of Snapper's `/api/mcp` endpoint. |
| `SNAPPER_ACCESS_TOKEN` | yes | JWT access token for Bearer auth (generated in Snapper UI). |
| `SNAPPER_REFRESH_TOKEN` | optional (since v0.2.0) | JWT refresh token for on-401 rotation. Required for rotating-token delegates; **omit or leave blank for long-lived PAT delegates** - the bridge then surfaces any 401 verbatim instead of trying to rotate. |

See [`.env.example`](./.env.example) for placeholder values.

### Token types

Snapper delegates are minted in one of two modes:

- **Rotating** (default) — short-lived access token (15 min) + refresh
  token (7 days). Paste both env vars; the bridge auto-rotates on 401.
- **Long-lived PAT** (opt-in) — single access token with a ~10-year
  expiry, no refresh. Paste only `SNAPPER_ACCESS_TOKEN`; leave
  `SNAPPER_REFRESH_TOKEN` unset (or blank). Revoke by deactivating the
  delegate in the Snapper UI.

In Option 1 (plugin), Claude Code surfaces the refresh token field as
optional — leaving it blank routes the bridge into PAT mode at the
host-config layer, no further action needed.

## Generating tokens

Snapper ships a **Settings → AI Delegates** UI that issues credentials.
Two modes are supported:

- **Rotating delegate**: emits an access + refresh JWT pair. Paste both
  (`SNAPPER_ACCESS_TOKEN` + `SNAPPER_REFRESH_TOKEN`); the bridge
  auto-rotates on 401.
- **Long-lived PAT delegate**: emits a single access JWT with a
  ~10-year expiry and no refresh token. Paste only
  `SNAPPER_ACCESS_TOKEN`. Regenerate (by deactivating + recreating the
  delegate) to rotate.

Each delegate has configurable caps (per-order max USD value, per-day /
per-month ceilings, allowed order types). Tokens are bound to the
delegate's permissions + wallet scope; revoke the delegate in-place to
kill the bridge live.

## Logging

All bridge logs go to **stderr** exclusively. Stdout is reserved for
MCP JSON-RPC frames — any stray write there corrupts the protocol
stream and Claude Desktop disconnects.

Verbosity knob: set `SNAPPER_MCP_LOG_LEVEL=debug` for transport-level
diagnostics (URL, HTTP status, error_code). Valid levels:
`debug` / `info` (default) / `warn` / `error`. Timestamps in the log
prefix: `SNAPPER_MCP_LOG_TIMESTAMPS=1`.

At `info` and above, you see the startup banner, refresh events, and
any mapped backend errors. At `debug`, you also see successful refresh
events and notification-forwarding trace.

## Authentication + refresh

On every outbound HTTP request, the bridge injects
`Authorization: Bearer ${SNAPPER_ACCESS_TOKEN}` while preserving any
`Accept` / `Content-Type` / other headers the SDK set.

On 401 with `error_code: "invalid_bearer_token"`, the bridge behaviour
depends on whether `SNAPPER_REFRESH_TOKEN` is set:

- **Rotating mode** (refresh token set): single-flight refresh via
  Snapper's `/api/auth/refresh?return_tokens=true` (POST with Bearer
  refresh header), update the in-memory token pair, retry the
  original request **once**. If the retry is also 401, the error
  surfaces verbatim to the MCP host — no refresh storm.
- **Long-lived PAT mode** (refresh token absent/blank): the bridge
  skips the refresh round-trip entirely and surfaces the 401
  verbatim. A PAT-specific stderr line hints that the access token
  was rejected and must be regenerated via the Snapper UI.

In rotating mode, N concurrent 401s under load share ONE refresh
call. Token rotation is race-tight: the new access token is published
BEFORE the in-flight refresh promise clears, so no caller can observe
the old token after rotation completes.

## Error handling

Three surfaces, each handled at the right layer:

**Backend transport errors** (503 `feature_disabled`, 401
`user_deactivated`, 401 `invalid_bearer_token`, 401
`missing_bearer_token`, 503 `mcp_unavailable`, 429
`rate_limit_exceeded`) come back as HTTP responses the MCP SDK
surfaces as `McpError` / JSON-RPC error envelopes. The bridge passes
these through to the MCP host verbatim; Claude's agent sees the
original `error_code` + message. The one exception is
`invalid_bearer_token`: in rotating mode the bridge intercepts it,
rotates the refresh token via `/api/auth/refresh`, and retries the
original request once before giving up. In long-lived PAT mode (no
`SNAPPER_REFRESH_TOKEN`) the 401 is surfaced verbatim without a
refresh attempt.

**Refresh-path errors** (5 mapped scenarios: rejected, malformed
body, 5xx, network error, timeout) log a specific stderr message via
`resolveRefreshError` in `src/errors.ts` and return the original 401
to the SDK. The troubleshooting table below lists the exact stderr
text you'll see for each.

**Tool-layer errors** (e.g. caps violation on `submit_manual_order`)
are `CallToolResult.isError=true` responses that the bridge forwards
unchanged. The host's agent sees the error verbatim and can decide
whether to surface or retry.

**Startup errors** (missing/invalid env var, MCP handshake failure,
stdio attach failure) log the concrete cause to stderr and exit 1
BEFORE the stdio server accepts any traffic, so the MCP host surfaces
"MCP server failed to start" with the actionable reason in the
subprocess stderr tail.

## Shutdown

`SIGTERM` / `SIGINT` trigger a drain sequence that:

1. Flags the bridge as shutting-down (new host requests get
   `-32000 server shutting down`).
2. Awaits all in-flight forward-path requests and outbound reverse-path
   notifications (10 s total budget, split across the two sets).
3. Closes the HTTP transport, then the stdio server.
4. Exits 0 on clean drain, 1 if any phase hit the timeout.

In the `watch` subcommand the same signals trigger a `WebSocket.close`
on the active session; any in-flight reconnect-backoff sleep is
cancelled immediately rather than blocking shutdown for its full
duration.

## Push wakeup (`watch` subcommand)

In addition to the proxy mode used by Claude Desktop / Claude Code as
an MCP server, the bridge ships a second mode that streams live
backend events to stdout as JSONL frames:

```sh
snapper-mcp watch [--topic PREFIX]...
```

Each `--topic` argument is repeatable. Every PREFIX must end with `.`
(it addresses a topic family root). The default subscription is the
union of `signals.` and `orders.events.` — the two production roots
that matter most for an AI delegate's situational awareness:

```sh
# Default: subscribe to live signals + order lifecycle events.
snapper-mcp watch

# Or restrict to a single family:
snapper-mcp watch --topic signals.
```

Stdout is the JSONL channel — each frame is one line of valid JSON
ending in `\n`, in receive order. Stderr is the bridge's logger
channel (same `SNAPPER_MCP_LOG_LEVEL` knob applies). The watch
session resolves an access token through a per-key precedence chain
(`since v0.6.0`): `--watch-access-token=` CLI flag →
`--access-token=` CLI flag (escape hatch only) →
`--config=PATH` file's `SNAPPER_WATCH_ACCESS_TOKEN` key →
`SNAPPER_WATCH_ACCESS_TOKEN` env var. There is **no** file-level or
env-level fallback to `SNAPPER_ACCESS_TOKEN` — only the explicit
CLI flag may stand in. The refresh-token pair is intentionally
ignored in watch mode (PAT-only contract — see
[Plugin monitor entry](#plugin-monitor-entry-since-v060) below for
the rotation-race rationale). The bridge mints a one-shot `ws_token`
via `POST /api/auth/ws_token` (this route must exist on the
configured Snapper backend — older deployments without it should
pin the bridge to `@mateusz-klatt/snapper-mcp@0.3.0`). The route
does NOT rotate the refresh-token pair, so the watch process and the
proxy MCP server can share a single Snapper delegate's credentials
without colliding on the refresh JTI.

Reconnection is automatic: any unintended close schedules a reconnect
with jittered exponential backoff (base 1 s, max 30 s, ±25 %). The
backoff resets on the first successful subscription of the next
session. Server-side `reauth_required` warnings trigger an in-place
ws_token refresh; `auth_expired` cycles the connection from scratch.

**Long-running watch sessions should use a long-lived PAT-style
delegate** (mint via the Snapper UI with `long_lived=true`). The
watch subcommand mints ws_tokens via the access bearer and does
NOT rotate the refresh-token pair, so a rotating-token delegate's
access token will expire after the configured `auth_access_token_expire_minutes`
window (15 minutes by default) and the watch session will start
failing on its next ws_token mint. PAT delegates issue a
~10-year access token with no refresh credential, which keeps
the watch session running indefinitely.

Watch sessions configured against a rotating delegate still work
for short interactive runs and tests, but production push-wakeup
flows should be configured against a PAT delegate to avoid the
access-expiry death.

Only DATA frames (signals, order events, AI-review variants) are
written to stdout. Control frames (subscription confirmations, pong,
server `error` notices, auth + reauth events) are logged to stderr
only — the JSONL stream consumed by a Claude Code monitor primitive
stays free of protocol noise.

### Plugin monitor entry (since v0.6.0)

The plugin manifest auto-wires the watch subcommand as a Claude Code
plugin monitor. When configured, the monitor process runs for the
lifetime of each Claude Code session and streams JSONL frames to
Claude as notifications — the AI delegate sees signal + order events
the moment they happen, no polling required.

**Wire mechanics.** The proxy MCP subprocess receives all four
credentials via the manifest's `mcpServers.snapper.env` block (with
`${user_config.KEY}` substitution — supported by Claude Code for
`mcpServers[]` entries). At startup, before opening the MCP transport,
the proxy writes a `0600`-mode `env.json` snapshot into
`${CLAUDE_PLUGIN_DATA}` (Claude Code's documented per-plugin data dir).
The monitor command in the manifest is
`npx -y @mateusz-klatt/snapper-mcp@VERSION watch --config="${CLAUDE_PLUGIN_DATA}/env.json"`
— substitution happens at spawn time and resolves per-plugin even
though monitor processes do not receive `${user_config.X}` env-block
substitution (which Claude Code currently rejects for `monitors[]`
entries with no error log). Tokens never appear in any process's
argv at any layer; the file path does, and `ps -ef` only sees the
path. The seed file is overwritten atomically on every proxy startup
(no staleness check); the monitor reads it on its own startup with a
short ENOENT-only retry budget to absorb any spawn-order race with
the proxy.

**Watch-token requirement.** Populate `SNAPPER_WATCH_ACCESS_TOKEN` in
the plugin user_config or the monitor will hard-error at session
start. Two operator profiles:

- **Long-lived single-delegate operators** (one PAT, no refresh):
  paste the SAME token into `SNAPPER_ACCESS_TOKEN` and
  `SNAPPER_WATCH_ACCESS_TOKEN`. There is no rotation, hence no race;
  reusing one token is safe.
- **Rotating-delegate operators** (proxy gets rotating access +
  refresh): mint a SECOND long-lived PAT delegate in Snapper's
  *AI Integration* page explicitly for the monitor. Sharing the
  rotating proxy's access token would race the proxy's refresh-JTI
  rotation; that is why this is a separate user_config field.

If you don't want the monitor at all, disable it at the plugin level
— flip `enabledPlugins.snapper-mcp@... = false` in
`~/.claude/settings.json` to disable the entire plugin, or remove the
`monitors[]` array from the local plugin manifest cache for
proxy-only operation.

#### Standalone host wiring (Option 2 / 3)

Outside the plugin (Claude Desktop manual config, systemd, launchd,
direct CLI) the watch subcommand uses the same per-key resolution
chain as Claude Code, just without the proxy-self-seeded
`env.json` step. Three credential sources, highest wins per key:

1. **CLI flag** — `--watch-access-token=VALUE` (or
   `--access-token=VALUE` as an explicit operator escape hatch),
   `--base-url=VALUE`. Visible in `ps -ef`; use only for ad-hoc
   testing and one-off runs.
2. **Config file** via `--config=PATH` — JSON with the keys
   `SNAPPER_BASE_URL` and `SNAPPER_WATCH_ACCESS_TOKEN`. Recommended
   for systemd / launchd long-running deployments because the token
   never appears in argv.
3. **Environment variables** — `SNAPPER_WATCH_ACCESS_TOKEN`,
   `SNAPPER_BASE_URL`. Same env-var delivery channel that has always
   worked for standalone hosts; populate from your shell init or
   service unit.

Watch mode does NOT fall back from `SNAPPER_WATCH_ACCESS_TOKEN` to
`SNAPPER_ACCESS_TOKEN` at the file or env level — only the explicit
`--access-token=` CLI flag may stand in. The refresh-token pair is
hard-pinned to `null` for watch regardless of source — watch must
run in PAT mode, full stop.

Long-lived single-delegate operators paste the SAME token into
`SNAPPER_ACCESS_TOKEN` (for the proxy, if running) and
`SNAPPER_WATCH_ACCESS_TOKEN` (for watch); rotating-delegate operators
mint a SECOND long-lived PAT delegate explicitly for watch.

## Privacy & telemetry

**Zero telemetry.** The bridge talks exclusively between the MCP host
on your machine and the Snapper backend at `SNAPPER_BASE_URL`. No
analytics, no error reporting to third parties, no opt-in/opt-out —
there is simply nothing to opt into. Read [`src/`](./src/) — it's small.

## Windows notes

Use plain ASCII URLs + JWT values in `SNAPPER_BASE_URL` /
`SNAPPER_ACCESS_TOKEN` / `SNAPPER_REFRESH_TOKEN`. JWTs are URL-safe by
design. If you're using a `.mcp.json` (Claude Code) or
`claude_desktop_config.json` (Claude Desktop), the `env` object is
portable across macOS / Linux / Windows.

## Troubleshooting

Common stderr messages the bridge emits and how to respond. All errors
land on stderr — stdout is reserved for MCP JSON-RPC frames.

### Startup (exit 1 before the stdio server accepts traffic)

| Stderr excerpt | Meaning | Fix |
| --- | --- | --- |
| `Missing required environment variable SNAPPER_BASE_URL` | `SNAPPER_BASE_URL` is not set or is whitespace-only. | Set it in your MCP host's `.mcp.json` (Claude Code) or `claude_desktop_config.json` (Claude Desktop) env block, or pass `--base-url=URL` on the command line. |
| `Missing required environment variable SNAPPER_ACCESS_TOKEN` | Same, for the access token. | Generate one in the Snapper UI and set it. |
| `Access token was rejected and no SNAPPER_REFRESH_TOKEN is configured` | 401 `invalid_bearer_token` in long-lived PAT mode — the access token has been revoked or the delegate deactivated. | Regenerate the delegate in the Snapper UI and replace `SNAPPER_ACCESS_TOKEN`. |
| `Environment variable SNAPPER_BASE_URL is not a valid URL` | URL is set but unparseable (e.g. missing scheme). | Use a form like `http://localhost:8000/api/mcp` or `https://snapper.example.com/api/mcp`. |
| `MCP handshake to Snapper failed at startup` | The bridge could not complete the initial MCP `initialize` call. | Check that `SNAPPER_BASE_URL` points at `/api/mcp` (not a different endpoint) and that the backend is healthy. |

### Refresh-path (the bridge writes the stderr then returns the 401 to the host)

| Stderr excerpt | Meaning | Fix |
| --- | --- | --- |
| `Refresh rejected — your refresh token may be expired or revoked` | `/api/auth/refresh` returned 401. | Regenerate tokens via the Snapper UI; replace `SNAPPER_REFRESH_TOKEN`. |
| `Refresh response malformed` | Backend returned 2xx without the expected `{payload: {access_token, refresh_token}}` envelope. | Snapper backend version may not match this client's contract; check release notes. |
| `Refresh failed with a server error` | `/api/auth/refresh` returned 5xx. | Backend transiently unhealthy; retry when it recovers. |
| `Cannot reach the refresh endpoint` | Network error between the bridge and Snapper. | Verify `SNAPPER_BASE_URL` is reachable; check firewalls / DNS. |
| `Refresh timed out after 10s` | The `/api/auth/refresh` POST took longer than 10 s. | Backend slow / unreachable; retry when responsive. |

### Backend transport errors (surfaced to the MCP host as `McpError` / JSON-RPC errors)

These come back in the protocol stream rather than bridge stderr.
Claude's agent sees the backend's `error_code` verbatim.

| Backend `error_code` (HTTP) | Meaning | Fix |
| --- | --- | --- |
| `feature_disabled` (503) | Snapper's `ai_integration_enabled` feature flag is off. | Ask an admin to enable it. |
| `user_deactivated` (401) | Your Snapper user account was deactivated. | Contact an admin to reactivate. |
| `missing_bearer_token` (401) | Bridge did not send a bearer header. | Check SNAPPER_ACCESS_TOKEN is set; should not reach you in normal operation. |
| `invalid_bearer_token` (401) | Access JWT expired / revoked. | In rotating mode the bridge attempts refresh + retry once; if both fail, regenerate tokens. In long-lived PAT mode (no `SNAPPER_REFRESH_TOKEN`) the 401 is surfaced verbatim — regenerate the delegate via the Snapper UI. |
| `mcp_unavailable` (503) | Server-side MCP init incomplete (transient infrastructure bug). | Bridge retries once with 1 s backoff; if it persists, check backend logs. |
| `rate_limit_exceeded` (429) | Per-principal throttle hit. | Retry later or ask an admin to raise the cap. |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, test runs, and
public-repo hygiene rules.

## License

[MIT](./LICENSE).
