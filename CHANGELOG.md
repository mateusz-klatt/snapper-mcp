# Changelog

All notable changes to `@mateusz-klatt/snapper-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- (next release TBD)

## [0.3.0]

Runtime release that adds a new `watch` subcommand for push-wakeup
streaming of live trading signals + order events. Operators wire it
manually at the host layer; plugin-manifest-level monitor wiring is
intentionally deferred to a future release — see the `### Deferred`
section below for the rotation-conflict reasoning.

### Added

- New `snapper-mcp watch [--topic PREFIX]...` subcommand. Opens an
  authenticated WebSocket to the Snapper backend's `/api/ws`
  endpoint (Bearer-on-upgrade), authenticates with a one-shot
  `ws_token` minted via the existing refresh-token flow,
  subscribes to the configured topic family roots (default:
  `signals.` + `orders.events.`), and writes one JSONL frame per
  line to stdout. Stderr is the logger channel; stdout is the
  JSONL stream.
- Reconnect with jittered exponential backoff (base 1s, max 30s,
  ±25%); shutdown cancels any in-flight reconnect sleep promptly
  rather than waiting it out.
- Server-side `reauth_required` triggers a fresh ws_token mint and
  a `reauth` frame in the same socket; `auth_expired` cycles the
  connection from scratch.
- Forward-compatible discriminated dispatch: unknown
  `frame.type` values are dropped silently with a single warn line
  so a backend that ships new frame variants ahead of an npm bridge
  update stays compatible.
- AI-review dedup keyed on `(type, review_public_id)` with LRU
  eviction (default cap 10000) and deadline-based pruning every
  60s. Cache update commits AFTER a successful frame delivery so
  at-least-once semantics survive a thrown downstream callback.
- Frame-size guards: 64 KiB raw frame budget pre-parse; 16 KiB
  UTF-8 byte budget on the embedded `signal_envelope` field of an
  AI-review request.
- The watch subcommand forwards only DATA frames (signals, order
  events, AI-review variants) to stdout as JSONL. Control frames
  (subscription_success, pong, error, the auth/reauth family) are
  handled internally and surface only through the stderr logger,
  keeping the JSONL stream free of protocol noise.
- New runtime dependency on `ws ^8.20.0` (and the matching
  `@types/ws` dev dep) for the WebSocket client implementation.

### Changed

- `mcpServers.args` re-pinned to `@mateusz-klatt/snapper-mcp@0.3.0`
  so a fresh `/plugin install` resolves to this runtime rather than
  `@0.2.2`. Existing installs receive it on `/plugin update
  snapper-mcp` or the next marketplace refresh.
- `index.ts` argv dispatch routes to the new watch entry when
  argv[0] === "watch"; otherwise it falls through to the existing
  default proxy mode unchanged.
- Stdout-gate now allows `process.stdout` in exactly two files
  (`index.ts` + `watch.ts`) — both legitimate output channels.
  `console.*` remains forbidden everywhere.

### Deferred

- Plugin-manifest-level monitor wiring for the watch subcommand is
  intentionally NOT shipped in this release. The bridge mints the
  one-shot `ws_token` over the existing refresh-token rotation
  flow, and rotating that flow from a monitor process would
  invalidate the proxy MCP server's refresh token (both processes
  read the same `SNAPPER_REFRESH_TOKEN` from user config). A
  future release will integrate plugin monitors once the backend
  exposes a non-rotating ws_token endpoint or the bridge gains a
  separate watch-only credential pair. Until then, integrate the
  watch subcommand at the host layer using a SEPARATE delegate's
  credentials.

### Tests

- 54 new bridge tests covering the WebSocket client lifecycle,
  argv parser, JSONL contract, signal handling, and exit codes.
  Total bridge suite: 269 (was 215). One existing test was
  updated to assert the new control-vs-data forwarding contract.

## [0.2.2]

Runtime release covering post-0.2.0 bridge UX fixes plus a plugin
manifest re-pin so Claude Code plugin v0.2.2 users land on this
runtime instead of v0.2.0.

### Added

- Plugin manifest tag `v0.2.2`. `mcpServers.args` now pins
  `@mateusz-klatt/snapper-mcp@0.2.2`, replacing the v0.2.1 tag's
  pin to `@0.2.0`. `/plugin install snapper-mcp@mateusz-klatt-snapper-mcp`
  in a fresh Claude Code session resolves to this runtime; existing
  plugin installs receive it on `/plugin update snapper-mcp` or next
  marketplace refresh.

### Changed

- `bridge_fetch.ts` PAT-mode 401 stderr is now rate-limited per
  access token. The bridge tracks which access tokens have been
  warned about and emits "Access token was rejected and no
  SNAPPER_REFRESH_TOKEN is configured" exactly once per access
  token, preventing stderr flooding when the MCP host retries many
  times against an invalid long-lived token. Rotating-mode path is
  unaffected.
- `TokenStore.rotate()` now guards on both `null` and empty-string
  refresh values, matching `hasRefreshToken()`'s semantics.
  Defensive: `parseEnv` never yields an empty refresh token, but
  manual `TokenStore` construction could, and the two methods now
  agree.
- `NoRefreshTokenError` docstring narrowed to the actual invariant
  it enforces (rotate attempted without a refresh token) rather
  than the 401 caller context. Call-site context kept as a
  cross-reference.

### Tests

- `bridge_fetch.test.ts` — 3 repeated 401s against the same PAT
  emit exactly one stderr line.
- `token_store.test.ts` — `hasRefreshToken()` returns false for
  empty-string refresh, and `rotate()` throws `NoRefreshTokenError`
  in that case.

### Notes

- The npm `0.2.1` slot is intentionally skipped: `v0.2.1` is the
  plugin-surface git tag introducing the marketplace integration
  (manifests + README + CHANGELOG), with no runtime change. This
  release advances the runtime by a single semver patch.
- npm provenance attestations remain enabled (`--provenance`).

## [0.2.1]

Plugin-surface release: introduces the Claude Code plugin marketplace
integration. The MCP runtime executed by `/plugin install` is the
published npm package `@mateusz-klatt/snapper-mcp@0.2.0` — Claude Code
launches it via `npx -y @mateusz-klatt/snapper-mcp@0.2.0`, pinned in
`mcpServers.args` so future runtime publishes do not silently upgrade
plugin `v0.2.1` users.

### Added

- Claude Code plugin marketplace integration. `/plugin marketplace add
  mateusz-klatt/snapper-mcp` followed by `/plugin install
  snapper-mcp@mateusz-klatt-snapper-mcp` followed by `/reload-plugins`
  (or a Claude Code restart) produces a working MCP server. Two
  required values plus one optional refresh token are prompted at
  install time via `userConfig`; the values thread to the bridge
  subprocess via `${user_config.KEY}` interpolation. Long-lived PAT
  delegates leave the refresh field blank — no further client-side
  action.
- `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json`
  manifests in the public repo root, sourced from `./` so the same
  commit serves both the npm package and the plugin marketplace.
- Claude Code Plugin badge in README pointing at the new Install
  section.

### Changed

- README "Install & run" reorganised into three options (plugin /
  Claude Desktop manual / direct CLI), surfacing the plugin install
  path first as the recommended flow. Token-types subsection clarifies
  PAT-mode UX inside the plugin install (leave refresh blank).
- Plugin-install storage note updated: `sensitive: true` `userConfig`
  values land in the OS keychain (with `~/.claude/.credentials.json`
  fallback) per Claude Code plugin behaviour — never in
  `settings.json` or the manifest. The bridge subprocess itself
  caches nothing on disk.

### Notes

- The dist tarball delivered by the plugin is unchanged from v0.2.0;
  same provenance on npm. The `v0.2.1` git tag bumps plugin metadata
  only.
- The git working tree at this tag also contains commit `0a3454b`
  (post-0.2.0 bridge UX fixes: PAT stderr rate-limit, `TokenStore.rotate`
  empty-string parity, `NoRefreshTokenError` docstring narrowing).
  Those are NOT part of the plugin runtime — `/plugin install` runs
  the published npm `0.2.0` artifact, which predates `0a3454b`. The
  fixes ship to plugin users when npm **`0.2.2`** publishes and a
  follow-up plugin tag re-pins `mcpServers.args` to `@0.2.2`. The
  `0.2.1` runtime slot is intentionally skipped (reserved for this
  plugin-surface tag).

## [0.2.0]

### Added

- Long-lived PAT support. `SNAPPER_REFRESH_TOKEN` is now optional —
  omit or leave blank when the Snapper delegate was minted with
  `long_lived=True` (a single access token with ~10-year expiry, no
  refresh). In PAT mode, a 401 `invalid_bearer_token` is surfaced
  verbatim with a PAT-specific stderr hint and the bridge does NOT
  attempt to call `/api/auth/refresh`.
- `NoRefreshTokenError` — raised by `TokenStore.rotate()` when a
  rotation is attempted in PAT mode. Callers (notably
  `createBridgeFetch`) check `store.hasRefreshToken()` before
  calling `rotate()` so the error stays internal to the store.

### Changed

- `BridgeEnv.refreshToken` now has the type `string | null` (was
  `string`). Existing rotating-token setups that keep
  `SNAPPER_REFRESH_TOKEN` set see ZERO behaviour change — the bridge
  continues to perform single-flight 401-rotation exactly as before.
- `TokenPair.refresh` now has the type `string | null`.
- `parseEnv` tolerates a missing or blank `SNAPPER_REFRESH_TOKEN`
  and returns `null`. Strict validation still applies to
  `SNAPPER_BASE_URL` and `SNAPPER_ACCESS_TOKEN`.

### Tests

- Added `env.test.ts` cases for optional refresh (absent / empty /
  legacy-set); `bridge_fetch.test.ts` cases for the PAT 401 path
  (no rotation, PAT-specific stderr, rotating regression intact);
  `token_store.test.ts` case for `NoRefreshTokenError`.

## [0.1.0]

First public release. Everything below ships in this version.

### Runtime

- Lightweight stdio-to-HTTP MCP bridge. Spawns as a subprocess, speaks
  MCP over stdio to Claude Desktop / Claude Code, and proxies every
  request to a Snapper backend's `/api/mcp` endpoint with Bearer-JWT
  auth and on-401 single-flight refresh-token rotation.
- Strict env-var config: `SNAPPER_BASE_URL`, `SNAPPER_ACCESS_TOKEN`,
  `SNAPPER_REFRESH_TOKEN`. Trailing slashes on the base URL are
  normalised so either `/api/mcp` or `/api/mcp/` is accepted.
- Stderr-only logger (`SNAPPER_MCP_LOG_LEVEL` debug/info/warn/error).
  Stdout is reserved for JSON-RPC frames; a runtime byte-purity test
  enforces this at build-output level.
- `TokenStore` with race-tight single-flight rotation — N concurrent
  401s trigger exactly one refresh call; every caller awaits the same
  promise and observes the rotated pair atomically.
- Custom `fetch` wrapper preserves SDK-set `Accept` / `Content-Type`
  headers while injecting `Authorization`; peeks `error_code` on a
  cloned response; retries once after refresh (`retry-bound = 1`,
  no refresh storms).
- Bidirectional MCP proxy with exact capability-mirror subset
  filtering — only forwards what the backend advertises and the
  bridge knows how to proxy. `fallbackNotificationHandler` for
  reverse path; three-kind capability gate (always / family / sub)
  drives which stdio handlers register.
- App-owned SIGTERM/SIGINT drain. Tracks `pendingForward` +
  `pendingReverse` Sets, `Promise.allSettled` under a 10 s budget
  split across forward and reverse, `isShuttingDown` flag gates
  new request handlers, exit code reflects either-set timeout.
- Zero telemetry, zero cached credentials, zero runtime dependencies
  beyond `@modelcontextprotocol/sdk`.

### Quality + release tooling

- 132 unit + integration tests (vitest). Subprocess tests against a
  mock Snapper HTTP server cover `initialize`, `tools/list`,
  capability-missing refusal, SIGTERM drain, and env-failure exit
  paths.
- 100% line coverage + 100% function coverage; statements ≥99%,
  branches ≥90% enforced by `vitest.config.ts` thresholds.
- CI matrix: Node 22 × ubuntu/macos/windows (minimum validated,
  higher versions work through stable Node APIs).
- Static gates: ESLint (no-console, no-any), TypeScript strict,
  stdout-gate scanner, gitleaks secret scan, SonarCloud quality scan.
- Release guardrails (`.github/workflows/publish.yml`): manual
  `workflow_dispatch` from `master` only, full gate re-run,
  `npm pack --dry-run` audit, version-already-published check
  (distinguishes npm 404 from network error), `npm publish
  --provenance`, post-publish verify, auto-create `v{version}` git
  tag + GitHub Release whose body is extracted from this CHANGELOG.
- Dependabot weekly updates for npm + github-actions with grouped
  `@types/*`, `vitest`, and `eslint` bumps.
