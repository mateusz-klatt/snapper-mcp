# Changelog

All notable changes to `@snapper/mcp-client` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- (next release TBD)

## [1.0.0]

First stable release of the bridge. The prior `0.1.0-alpha.0`
publish was a scope-reservation placeholder with no functional code.

### Highlights

- Production-grade stdio↔HTTP MCP bridge for Claude Desktop /
  Claude Code ↔ Snapper `/api/mcp`. Bearer-JWT auth with on-401
  single-flight refresh-rotation + SDK-delegated cancellation +
  SIGTERM-driven graceful drain + stdout byte-purity guarantees.
- Five refresh-path stderr mappings (rejected / malformed / 5xx /
  network / timeout). Backend transport errors (feature_disabled,
  user_deactivated, invalid_bearer_token, missing_bearer_token,
  mcp_unavailable, rate_limit_exceeded) surface through the MCP
  SDK's own `McpError` / JSON-RPC error envelopes to the host;
  documented in README troubleshooting table.
- Zero telemetry / cached credentials / runtime dependencies
  beyond `@modelcontextprotocol/sdk`.
- CI matrix Node 18/20/22 × ubuntu/macos/windows, SonarCloud static
  analysis, gitleaks secret-scan, provenance-attested
  workflow_dispatch publish pipeline.

Full set of deliverables (carried over from [0.2.0] below — same
codebase, only the version metadata changed for the 1.0.0 release).

## [0.2.0]

### Added

- Functional stdio↔HTTP MCP bridge — `node dist/index.js` with
  `SNAPPER_BASE_URL` + `SNAPPER_ACCESS_TOKEN` + `SNAPPER_REFRESH_TOKEN`
  env vars boots a live bridge against Snapper's `/api/mcp` endpoint.
- `TokenStore` with race-tight single-flight refresh rotation.
- `createBridgeFetch` custom `fetch` wrapper (SDK v1.29 `FetchLike`
  option) — preserves SDK-set headers via `new Headers(init.headers)`
  then `.set("Authorization", ...)`; `peekErrorCode` reads
  `response.clone()`; `invalid_bearer_token`-gated refresh with
  retry-bound of 1.
- `makePerformRefresh` with 10s `AbortController` timeout, POST to
  `/api/auth/refresh?return_tokens=true` with `Authorization: Bearer
  <refresh_jwt>`, PayloadResponse envelope parsing (rejects flat body
  shapes).
- Bidirectional MCP proxy with capability-mirror subset filtering
  (exactly matches what the bridge can proxy), `fallbackNotificationHandler`
  for reverse-path forwarding, SDK-delegated cancellation propagation
  via `extra.signal` → `httpClient.request({ signal })`, and sub-
  capability gating for `resources/subscribe` / `unsubscribe`.
- App-owned SIGTERM/SIGINT drain — `pendingForward` + `pendingReverse`
  Sets tracked in user space, `Promise.allSettled` drain under a 10s
  timeout, `isShuttingDown` flag guards new request handlers, exit
  code reflects either-set timeout.
- End-to-end subprocess tests against a local mock MCP backend
  (initialize, tools/list, resources/list refused when capability
  absent, SIGTERM drain, env-failure paths per required var).
- Runtime stdout byte-purity test via
  `readline.createInterface({ crlfDelay: Infinity })` — portable on
  windows-latest CI.
- SonarCloud analysis wired via `workflow_dispatch` +
  `push/pull_request` with lcov coverage from vitest's v8 provider.
- Provenance-attested `npm publish --access public` workflow
  (`workflow_dispatch` only, with `permissions: id-token: write` for
  OIDC).

### Changed

- Build-time version injection via `tsup.config.ts` `define` →
  single source of truth is `package.json`; the runtime banner
  cannot drift from the published metadata.
- Full `README.md` covering install + Claude Desktop + Claude Code
  integration + token generation + auth/refresh semantics + error
  handling + shutdown drain + privacy statement + troubleshooting
  tables (startup / refresh-path / backend-transport).
- `src/errors.ts` defines `REFRESH_ERROR_MAPPINGS` +
  `resolveRefreshError` consumed by `createBridgeFetch` in
  `bridge_fetch.ts` to emit actionable stderr on refresh failures.
  Backend transport errors are NOT re-mapped at runtime; they
  surface through the SDK's `McpError` / JSON-RPC envelope (README
  troubleshooting documents the user-facing meaning of each
  backend `error_code`).

## [0.1.0-alpha.0]

### Added

- Initial package skeleton: toolchain (`tsup`, `vitest`, `eslint`), CI workflows (lint + typecheck + build + test across Node 18/20/22 × ubuntu/macos/windows matrix), `gitleaks` secret-scan workflow, and a `workflow_dispatch` publish workflow.
- `LICENSE` (MIT), `.gitignore`, `.gitattributes` (LF), `.gitleaks.toml` allowlist for placeholders + test fixtures.
- Placeholder `src/main.ts` — logs a stub banner to stderr and exits 0. Real bridge wiring lands in v0.2.0.
- Documentation placeholders: `README.md`, `CONTRIBUTING.md`, `CODEOWNERS`, `.github/pull_request_template.md`.

### Reserved

- npm scope `@snapper/mcp-client` — published as `0.1.0-alpha.0` to claim the package name.
