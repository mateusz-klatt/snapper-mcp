# @mateusz-klatt/snapper-mcp

[![npm version](https://img.shields.io/npm/v/@mateusz-klatt%2Fsnapper-mcp.svg)](https://www.npmjs.com/package/@mateusz-klatt/snapper-mcp)
[![node](https://img.shields.io/node/v/@mateusz-klatt%2Fsnapper-mcp.svg)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/@mateusz-klatt%2Fsnapper-mcp.svg)](./LICENSE)
[![CI](https://github.com/mateusz-klatt/snapper-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mateusz-klatt/snapper-mcp/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=mateusz-klatt_snapper-mcp&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=mateusz-klatt_snapper-mcp)

Lightweight stdio-to-HTTP **Model Context Protocol** bridge. Spawns as a
subprocess, speaks MCP over stdio to Claude Desktop / Claude Code, and
proxies every request to a Snapper backend's `/api/mcp` endpoint with
Bearer-token auth + on-401 refresh-token rotation.

## What is this

Snapper is a multi-tenant trading platform. Its backend exposes MCP at
`/api/mcp`, guarded by Bearer-JWT auth, feature flag, and per-principal
rate limiting. MCP hosts (Claude Desktop, Claude Code) speak MCP over
**stdio** — they spawn a subprocess and exchange JSON-RPC frames over
stdin/stdout. `@mateusz-klatt/snapper-mcp` is the stdio ⇄ HTTP bridge that
makes that conversation work.

It is a **thin** bridge: ~1200 lines of TypeScript, using Node's
built-in `fetch`, plus `@modelcontextprotocol/sdk` for MCP framing. No OAuth, no telemetry, no cached credentials on disk —
tokens come from env vars, get rotated in-memory, and die with the
process.

## Install & run

```bash
# One-shot via npx (recommended — matches what Claude Desktop + Claude Code do):
npx -y @mateusz-klatt/snapper-mcp

# Or install globally:
npm install -g @mateusz-klatt/snapper-mcp
snapper-mcp
```

Requires **Node 22+** (uses Node's built-in `fetch`, `AbortController`,
and ESM top-level `await`). CI validates the declared minimum
(Node 22) across Ubuntu / macOS / Windows; higher Node versions
work because the bridge only relies on APIs stable since Node 18.

Three required env vars must be set by the MCP host before spawning:

| Variable | Purpose |
| --- | --- |
| `SNAPPER_BASE_URL` | URL of Snapper's `/api/mcp` endpoint. |
| `SNAPPER_ACCESS_TOKEN` | JWT access token for Bearer auth (generated in Snapper UI). |
| `SNAPPER_REFRESH_TOKEN` | JWT refresh token for on-401 rotation (generated in Snapper UI). |

See [`.env.example`](./.env.example) for placeholder values.

## Claude Desktop integration

Add to your Claude Desktop config (e.g. `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "snapper": {
      "command": "npx",
      "args": ["-y", "@mateusz-klatt/snapper-mcp"],
      "env": {
        "SNAPPER_BASE_URL": "https://your-snapper-instance.example.com/api/mcp",
        "SNAPPER_ACCESS_TOKEN": "<generated via Snapper UI: Settings → AI Delegates>",
        "SNAPPER_REFRESH_TOKEN": "<generated via Snapper UI: Settings → AI Delegates>"
      }
    }
  }
}
```

Restart Claude Desktop; your Snapper instance appears in the MCP server
list. Confirm tools load via the MCP Servers settings panel.

## Claude Code integration

Claude Code uses the same `.mcp-config.json` format. Drop the snippet
above into your project's `.mcp-config.json` (or the global config) and
restart the Claude Code CLI.

## Generating tokens

Snapper ships a **Settings → AI Delegates** UI that generates the two
JWTs for you. Each delegate has configurable caps (per-order max USD
value, per-day / per-month ceilings, allowed order types). Tokens are
bound to the delegate's permissions + wallet scope; revoke the delegate
in-place to kill the bridge live.

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

On 401 with `error_code: "invalid_bearer_token"`, the bridge triggers
a single-flight refresh via Snapper's `/api/auth/refresh?return_tokens=true`
(POST with Bearer refresh header), updates the in-memory token pair,
and retries the original request **once**. If the retry is also 401,
the error surfaces verbatim to the MCP host — no refresh storm.

N concurrent 401s under load share ONE refresh call. Token rotation is
race-tight: the new access token is published BEFORE the in-flight
refresh promise clears, so no caller can observe the old token after
rotation completes.

## Error handling

Three surfaces, each handled at the right layer:

**Backend transport errors** (503 `feature_disabled`, 401
`user_deactivated`, 401 `invalid_bearer_token`, 401
`missing_bearer_token`, 503 `mcp_unavailable`, 429
`rate_limit_exceeded`) come back as HTTP responses the MCP SDK
surfaces as `McpError` / JSON-RPC error envelopes. The bridge passes
these through to the MCP host verbatim; Claude's agent sees the
original `error_code` + message. The one exception is
`invalid_bearer_token`: the bridge intercepts it, rotates the refresh
token via `/api/auth/refresh`, and retries the original request once
before giving up.

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

## Privacy & telemetry

**Zero telemetry.** The bridge talks exclusively between the MCP host
on your machine and the Snapper backend at `SNAPPER_BASE_URL`. No
analytics, no error reporting to third parties, no opt-in/opt-out —
there is simply nothing to opt into. Read [`src/`](./src/) — it's small.

## Windows notes

Use plain ASCII URLs + JWT values in `SNAPPER_BASE_URL` /
`SNAPPER_ACCESS_TOKEN` / `SNAPPER_REFRESH_TOKEN`. JWTs are URL-safe by
design. If you're using a `.mcp-config.json`, the `env` object is
portable across macOS / Linux / Windows.

## Troubleshooting

Common stderr messages the bridge emits and how to respond. All errors
land on stderr — stdout is reserved for MCP JSON-RPC frames.

### Startup (exit 1 before the stdio server accepts traffic)

| Stderr excerpt | Meaning | Fix |
| --- | --- | --- |
| `Missing required environment variable SNAPPER_BASE_URL` | `SNAPPER_BASE_URL` is not set or is whitespace-only. | Set it in your MCP host's `.mcp-config.json` env block. |
| `Missing required environment variable SNAPPER_ACCESS_TOKEN` | Same, for the access token. | Generate one in the Snapper UI and set it. |
| `Missing required environment variable SNAPPER_REFRESH_TOKEN` | Same, for the refresh token. | Same. |
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
| `invalid_bearer_token` (401) | Access JWT expired / revoked. | Bridge attempts refresh + retry once; if both fail, regenerate tokens. |
| `mcp_unavailable` (503) | Server-side MCP init incomplete (transient infrastructure bug). | Bridge retries once with 1 s backoff; if it persists, check backend logs. |
| `rate_limit_exceeded` (429) | Per-principal throttle hit. | Retry later or ask an admin to raise the cap. |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, test runs, and
public-repo hygiene rules.

## License

[MIT](./LICENSE).
