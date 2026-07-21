# Changelog

All notable changes to `@mateusz-klatt/snapper-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The `watch` monitor subscribes to `ai_research.` by default and forwards
  `ai_research.request` frames to its JSONL consumer.

## [0.12.0] — 2026-07-07

### New: watch monitor subscribes to AI-review requests by default

The `watch` monitor now subscribes to the `ai_reviews.` topic family out of
the box, so pending AI-review (consult) requests stream to the delegate as
JSONL alongside signal and order events — no extra flags required.

### Changed

- Node 26 compatibility; dependencies bumped to latest (including majors).
- Wire-contract regenerated for `paired_group_*` fields, `SignalData.paired_group_key`,
  and `OrderEventEnum.UNKNOWN`; the retired `zonda` exchange was dropped from the
  Exchange enum.
- Proxy caches mirrored capability families for fewer redundant lookups.

### Fixed

- Assorted static-analysis (Sonar) findings in the proxy and watch bridge,
  including simplified error-message resolution.

## [0.11.0] — 2026-05-02

### New: multi-profile support

Run two or more Snapper instances from a single bridge install (prod +
staging, prod + local dev, etc.) by selecting a profile at spawn time:

```bash
SNAPPER_PROFILE=prod snapper-mcp
# or
snapper-mcp --profile=prod
```

When a profile is selected, the bridge resolves credentials in this
order (CLI flag wins, then config file, then env var) — top-level bare
vars are NOT consulted (hard isolation prevents accidental cross-profile
leaks):

1. `--base-url` / `--access-token` CLI flags
2. `--config` file `profiles.<name>.SNAPPER_BASE_URL` /
   `.SNAPPER_ACCESS_TOKEN`
3. `SNAPPER_PROFILE_<UPPER>_BASE_URL` /
   `SNAPPER_PROFILE_<UPPER>_ACCESS_TOKEN` env vars

Without a profile selector, behaviour is unchanged: the bridge reads
top-level `SNAPPER_BASE_URL` + `SNAPPER_ACCESS_TOKEN` from CLI / config
/ env as before.

Profile names must match `^[a-z0-9]{1,32}$` (lowercase ASCII + digits,
1–32 chars). Underscores and uppercase are rejected to keep the env-var
mapping unambiguous. `--profile` CLI flag overrides `SNAPPER_PROFILE`
env var when both are set.

Config file shape extension (additive — old single-creds files keep
working):

```json
{
  "profiles": {
    "prod":    { "SNAPPER_BASE_URL": "https://snapper.example.com/api/mcp", "SNAPPER_ACCESS_TOKEN": "..." },
    "staging": { "SNAPPER_BASE_URL": "https://staging.example.com/api/mcp", "SNAPPER_ACCESS_TOKEN": "..." }
  }
}
```

`snapper-mcp check --profile=prod` threads the selector through so an
operator can verify each profile's token offline before spawning the
bridge.

## [0.10.0] — 2026-05-02

### New env var

`SNAPPER_MCP_LOG_FORMAT=json` switches every stderr log line to a
single-line JSON object so an operator can pipe stderr through `jq`
or other structured-log consumers:

```text
{"t":"2026-05-02T16:00:00.000Z","lvl":"info","prefix":"bridge","msg":"connected","rest":[{"req":42}]}
```

The `t` field is always present in JSON mode regardless of
`SNAPPER_MCP_LOG_TIMESTAMPS` — the timestamp env var only governs
the prefix on text-mode lines. `Error` instances in the rest
arguments serialise as `{name, message, stack}`; circular objects
fall back to `String(value)` rather than throwing.

Default `text` keeps the human-readable one-line-per-event format
unchanged for the common Claude Desktop use case.

## [0.9.0] — 2026-05-02

### New subcommand

`snapper-mcp check` — offline diagnostic for the configured access
token + base URL. Decodes the access JWT (no signature verify, no
network) and prints the operator-relevant claims (`sub`, `role`,
`scopes`, `iat`, `exp`) plus expiry deltas in human-readable form.

```bash
snapper-mcp check
# base URL: https://snapper.example.com/api/mcp/
# access token:
#   alg: HS256
#   sub: 01891e92-...
#   role: AI_DELEGATE
#   scopes: read.orders, write.orders
#   exp: 2026-08-01T00:00:00.000Z (in 90.5d)
#   status: valid
```

Exit codes: `0` valid, `1` env-validation failure, `2` token expired
or missing `exp`. Reuses the same `--config=PATH` /
`--access-token` / `--base-url` flag plumbing as the proxy + watch
subcommands.

## [0.8.0] — 2026-05-02

### Wire schema

Two new optional fields on the generated `SignalData` envelope:

- `ai_review_public_id: string | null = null`
- `ai_review_dispatch_version: number | null = null`

Both default to `null` at the source so signals emitted without an
AI-review citation behave byte-identical for downstream consumers.
When set, they propagate the citation across the trader-coordinator
hand-off so the runtime can fan out a caps-violation event to the
citing delegate's UI on rejection.

The dedup helper continues to return `null` for generic `signal`
frames — the AI-review dedup triple still belongs only to
`ai_review.{request, decision_ack, caps_violation}` frames.

## [0.7.0] — 2026-04-30

### Configuration

Two environment variables — `SNAPPER_BASE_URL` and `SNAPPER_ACCESS_TOKEN`.
The same long-lived AI delegate token authenticates both the proxy MCP
server and the watch monitor.
