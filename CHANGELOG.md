# Changelog

All notable changes to `@mateusz-klatt/snapper-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- (next release TBD)

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
