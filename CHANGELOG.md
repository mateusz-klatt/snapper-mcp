# Changelog

All notable changes to `@mateusz-klatt/snapper-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- (next release TBD)

## [0.6.0]

Restores the plugin monitor entry to functional state and corrects
the long-standing `.mcp-config.json` filename typo. The plugin monitor
shipped in `0.5.0` was empirically broken in Claude Code 2.1.x — the
documented `CLAUDE_PLUGIN_OPTION_<KEY>` user_config auto-export does
not exist for monitor processes (verified by inspecting
`/proc/<pid>/environ` of running plugin subprocesses). `0.6.0`
replaces the env-var auto-export reliance with a `--config=PATH`
flag plus a proxy-side self-seed step: the proxy MCP server, which
DOES receive `${user_config.X}` substitution via `mcpServers.env`,
writes a JSON file to `${CLAUDE_PLUGIN_DATA}/env.json` (mode 0600,
atomic) at startup; the monitor reads that file via `--config=`. The
plugin manifest's `monitors[]` entry uses the same substitution
syntax as `mcpServers[]` for the file path, which IS supported in
both spots, even though the `env` block is silently rejected for
`monitors[]`.

### Added

- `--config=PATH` flag accepted by both the proxy entrypoint and the
  `watch` subcommand. Loads a JSON file with the same key set as the
  existing env-var contract: `SNAPPER_BASE_URL`,
  `SNAPPER_ACCESS_TOKEN`, `SNAPPER_REFRESH_TOKEN` (optional),
  `SNAPPER_WATCH_ACCESS_TOKEN` (optional). Missing keys fall through
  to lower rungs of the resolution chain.
- Per-key flag overrides: `--access-token=VALUE`, `--base-url=VALUE`,
  `--refresh-token=VALUE`, `--watch-access-token=VALUE`. Both
  `--flag=value` and `--flag value` forms accepted. Last duplicate
  wins. Operator-facing escape hatches for testing or one-off runs.
- Per-key resolution chain (highest wins): CLI flag → `--config=`
  file → environment variable. Watch mode disallows file/env
  fallback from `SNAPPER_WATCH_ACCESS_TOKEN` to
  `SNAPPER_ACCESS_TOKEN` (only the explicit `--access-token=` CLI
  flag may stand in for the watch token, as a deliberate escape
  hatch).
- Proxy startup self-seeds `${CLAUDE_PLUGIN_DATA}/env.json` when
  that variable is set in the environment. Atomic write
  (`tmp + rename`), mode 0600, always overwrites — no staleness
  check. The seeded file carries all four key values (empty string
  for unset optionals). On write failure (`EACCES` / `EROFS` /
  `ENOSPC`), the proxy logs a warning and continues — the proxy
  itself does not need the file, only downstream monitor processes
  do.
- Token-shape redaction in error messages (`<jwt-NN-chars-...>`
  format) so accidentally-typed flag values like `--bogus=eyJ...`
  do not leak into stderr.
- File hardening: `--config=` rejects world-writable files,
  non-regular files (symlink to `/dev/null`, named pipes,
  directories), and files larger than 1 MiB. Group/world-readable
  files emit a warning but continue (operator's choice).

### Fixed

- `.mcp-config.json` typo across stderr error messages and README.
  That filename does not exist in any documented MCP host. The
  canonical names are `.mcp.json` for Claude Code (project-level or
  user-level) and `claude_desktop_config.json` for Claude Desktop
  (OS-specific paths). All five sites updated.
- Plugin monitor entry now actually functional in Claude Code
  2.1.x — see header note above.

### Breaking

- `EnvValidationError.message` strings updated for the
  `.mcp-config.json` → `.mcp.json` rename. Operator-facing only;
  no automation should be parsing these strings.
- Internal exports `isClaudeCodePluginContext` and
  `watchAccessToken` removed from `src/env.ts`. These were never
  re-exported from the package entrypoint; only the package's own
  test files referenced them. Public surface unchanged.
- Plugin monitor graceful-skip-when-blank-watch-token REMOVED. In
  `0.5.0`, when a Claude Code plugin operator left
  `SNAPPER_WATCH_ACCESS_TOKEN` blank, the monitor exited 0 with a
  stderr info message ("plugin monitor staying idle"). In `0.6.0`,
  the monitor either succeeds or hard-errors with an actionable
  message. **Two operator migration paths:**

  - **Primary path (operators who want the monitor):** populate
    `SNAPPER_WATCH_ACCESS_TOKEN` in the plugin user_config.
    Long-lived single-delegate operators paste the same token as
    `SNAPPER_ACCESS_TOKEN` (no rotation, no race). Rotating
    delegate operators mint a SECOND long-lived delegate
    explicitly for the monitor in the Snapper AI Integration UI.
  - **Fallback path (operators who don't want the monitor):**
    disable the monitor at the Claude Code plugin level. Either
    flip `enabledPlugins.snapper-mcp@... = false` in
    `~/.claude/settings.json` for the whole plugin, or remove the
    `monitors[]` array from the local plugin manifest cache for
    proxy-only.

### Migration

`v0.5.x` operators with env-var-only setups (Claude Desktop,
systemd, plain CLI) keep working unchanged after
`npm i -g @mateusz-klatt/snapper-mcp@0.6.0` — the env-var rung of
the new resolution chain still resolves credentials. Claude Code
plugin operators who left `SNAPPER_WATCH_ACCESS_TOKEN` blank in
`0.5.0` need to take one of the two actions in `### Breaking`
above before restarting Claude Code.

## [0.5.0]

Plugin-surface release that restores the deferred plugin monitor
entry. A new `SNAPPER_WATCH_ACCESS_TOKEN` user_config field carries a
long-lived watch-only PAT delegate, delivered to the monitor process
through Claude Code's documented per-plugin env-export mechanism
(every user_config value is auto-exported to plugin subprocesses as
`CLAUDE_PLUGIN_OPTION_<KEY>`). The bridge gains a new
`parseWatchEnv` resolver in watch mode that reads from a precedence
chain over those env vars; the proxy MCP server's `parseEnv` contract
is unchanged, and standalone hosts (Claude Desktop manual config,
direct CLI) keep working through the existing `SNAPPER_*` env-var
fallback rungs without any operator-side adjustment.

### Added

- `SNAPPER_WATCH_ACCESS_TOKEN` user_config field in `plugin.json`.
  Optional, sensitive. Operators mint a SECOND long-lived PAT delegate
  in Snapper's AI Integration UI and paste its access token here;
  leaving it blank keeps the plugin monitor process idle (graceful
  exit 0 with one informational stderr line) and does not affect the
  proxy MCP server.
- `monitors` entry in `plugin.json` declaring a single `snapper-watch`
  monitor. The monitor command is the trivial
  `npx -y @mateusz-klatt/snapper-mcp@0.5.0 watch` — no shell wrapping,
  no `cross-env` wrapper, no `${user_config.X}` substitution into
  argv. Claude Code auto-exports every user_config value to the
  monitor subprocess as `CLAUDE_PLUGIN_OPTION_<KEY>` env vars, and
  the bridge's new `parseWatchEnv` reads them directly. The watch
  token never enters any process's argv at any layer.
- `parseWatchEnv`, `watchAccessToken`, and `isClaudeCodePluginContext`
  helpers in `src/env.ts`. The watch resolver chain is, in order:
  `CLAUDE_PLUGIN_OPTION_SNAPPER_WATCH_ACCESS_TOKEN` (plugin context,
  dedicated watch token) → `SNAPPER_WATCH_ACCESS_TOKEN` (standalone
  host, dedicated watch token) → `SNAPPER_ACCESS_TOKEN` (standalone
  fallback). In Claude Code plugin context the third rung is
  intentionally DECLINED — falling back to the rotating proxy
  delegate's access token would die at access-expiry inside a
  long-running monitor and re-introduce the original v0.4.0
  deferral failure mode. Base URL chain is parallel:
  `CLAUDE_PLUGIN_OPTION_SNAPPER_BASE_URL` → `SNAPPER_BASE_URL`. The
  refresh token is forced to `null` regardless of source — watch
  must run in PAT mode to avoid colliding with the proxy MCP server
  on the shared refresh-JTI.
- Plugin-monitor graceful skip in `watchMain`: if the bridge detects
  it is running inside a Claude Code plugin context (either
  `CLAUDE_PLUGIN_OPTION_SNAPPER_BASE_URL` — the documented userConfig
  auto-export — or the defensive `CLAUDE_PLUGIN_ROOT` fallback signal
  is set; see `isClaudeCodePluginContext`) AND no access-token rung
  resolves, it writes one informational stderr line and exits 0
  instead of throwing. Standalone hosts (neither signal present)
  still hard-fail with the existing `EnvValidationError` exit-1 path
  so a misconfigured systemd / launchd unit surfaces the cause
  clearly.
- New manifest-shape vitest cases in `test/plugin_manifest.test.ts`
  asserting the monitor command is the simple form: pins exact
  `@0.5.0`, invokes `snapper-mcp watch`, embeds NO `${user_config.X}`
  substitutions, and uses no shell-wrapping primitives (`cross-env`,
  `sh -c`, `cmd /C`, `=` env-prefix syntax).
- 22 new bridge tests covering the precedence chain (incl. the
  proxy-fallback decline regression for plugin context), the
  dual-signal plugin-context detection, the graceful-skip branch
  (both via `CLAUDE_PLUGIN_OPTION_*` and via `CLAUDE_PLUGIN_ROOT`-
  alone), and the standalone-context hard-fail invariant.

### Changed

- Watch subcommand entry now calls `parseWatchEnv` instead of the
  general `parseEnv`. Standalone hosts that set `SNAPPER_BASE_URL` +
  `SNAPPER_ACCESS_TOKEN` see ZERO behaviour change; the new code
  path resolves identically through the chain's lower rungs.
- `mcpServers.args` re-pinned to `@mateusz-klatt/snapper-mcp@0.5.0`
  so a fresh `/plugin install` resolves to this runtime — the
  monitor command also pins `@0.5.0`.
- README "Push wakeup" section reorganised: the plugin monitor entry
  is now described as the first-class production path. The prior
  `### Why isn't there a plugin monitor entry?` subsection is REPLACED
  by `### Plugin monitor entry (since v0.5.0)` describing the
  `SNAPPER_WATCH_ACCESS_TOKEN` field, the auto-export mechanism, and
  the watch-only-PAT requirement.

### Notes

- **No argv exposure.** The watch token travels from operator-supplied
  user_config → OS keychain → Claude Code parent process →
  `CLAUDE_PLUGIN_OPTION_SNAPPER_WATCH_ACCESS_TOKEN` env var on the
  monitor subprocess. It is never substituted into a command string,
  never visible in `ps aux`, never written to disk by the bridge.
- **Cross-platform.** The auto-export mechanism is Claude Code-native
  and works identically on Linux, macOS, and Windows. No
  shell-specific syntax in the manifest, no platform-conditional
  command strings, no external npm packages beyond the bridge tarball
  itself.
- **Backend dependency.** Same as v0.4.0: requires a Snapper backend
  exposing `POST /api/auth/ws_token`. No new backend requirement.

## [0.4.0]

Runtime release that switches the `watch` subcommand to a dedicated
non-rotating ws_token-issuance endpoint. PAT-style delegates are now
first-class for push-wakeup streaming. Plugin-manifest-level monitor
wiring remains deferred — see the `### Deferred` section below for
the access-expiry reasoning.

### Changed

- `fetchWsToken` now POSTs to the dedicated
  `POST /api/auth/ws_token` endpoint with the caller's access bearer
  rather than piggybacking on `POST /api/auth/refresh`. The new
  endpoint mints a one-shot `ws_token` without rotating the
  refresh-token pair, which is what lets a long-lived watch process
  reuse the same delegate's credentials as the proxy MCP server
  without colliding on the refresh JTI. Long-lived PAT-style
  delegates (configured without a `SNAPPER_REFRESH_TOKEN`) are now
  first-class for the watch subcommand — they mint ws_tokens via
  their long-lived access bearer indefinitely.
- `mcpServers.args` re-pinned to `@mateusz-klatt/snapper-mcp@0.4.0`
  so a fresh `/plugin install` resolves to this runtime.

### Added

- Defensive `typeof` check in the `hasTopic` runtime guard:
  malformed frames carrying a non-string non-null `topic` (e.g. a
  numeric value smuggled past type-checking) are now reported as
  unstamped instead of being narrowed to `PublishedDataFrame`.
- `SessionRunner.sendClientFrame` now pre-checks
  `socket.readyState` and skips the send when the socket is in
  CLOSING or CLOSED — typically a heartbeat tick racing a
  server-initiated close. The skip logs at debug level instead of
  pushing into a torn-down socket. CONNECTING-state sends still
  propagate to `socket.send()` and the underlying `ws@8`
  synchronous throw — that path is a programming error and the
  failure must surface to the runner's session loop.

### Removed

- The watch subcommand no longer pre-checks for a configured
  refresh token before starting. PAT-mode now works identically;
  the legacy `NoRefreshTokenError` PAT-rejection branch in
  `runForever` is gone, as is its unit test.

### Deferred

- Plugin-manifest-level monitor wiring (the `monitors` field in
  `plugin.json` and a matching `monitors/monitors.json`) was
  considered for this release but intentionally NOT shipped. The
  dedicated ws_token endpoint resolves the refresh-JTI race
  between watch and proxy, but a rotating delegate's access token
  still expires after ~15 minutes by default. A monitor process
  driven by a rotating delegate would die at access expiry and
  could not refresh without rotating the shared refresh JTI —
  re-introducing the original race. A future release will land
  the monitor wiring once the bridge gains a separate watch-only
  PAT credential UX (a long-lived access token dedicated to the
  monitor, distinct from the proxy's rotating credential pair).
  Operators who want push-wakeup streaming today should mint a
  long-lived PAT delegate in the Snapper UI and wire
  `snapper-mcp watch` at the host layer using that delegate's
  `SNAPPER_ACCESS_TOKEN`.

### Tests

- 277 bridge tests (was 269 in 0.3.0). `test/ws_token.test.ts`
  fully rewritten (24 cases) covering the new endpoint contract:
  URL + Bearer access header, token-store immutability, PAT-mode
  happy path, 401 / 429 / 5xx / 4xx mapping, network + AbortError
  mapping, payload validation (non-JSON / null body / missing
  fields / non-ISO `ws_token_exp`).

### Backend dependency

- Requires Snapper backend that exposes
  `POST /api/auth/ws_token`. Older Snapper deployments without
  that route should pin to `@mateusz-klatt/snapper-mcp@0.3.0`.

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
  `frame.type` values are dropped silently (recorded at debug
  level only) so a backend that ships new frame variants ahead of
  an npm bridge update stays compatible without spamming stderr.
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
