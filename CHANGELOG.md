# Changelog

All notable changes to `@mateusz-klatt/snapper-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.15.0] — 2026-08-03

### Fixed: the monitor is back, and it arms — the trigger needs a QUALIFIED skill name

0.14.0 removed the bundled monitor after concluding that
`when: "on-skill-invoke:<skill>"` never starts one. **That conclusion was
wrong, and this release corrects it.** The trigger works; it just does not
accept the bare skill name the reference docs imply ("the named skill in this
plugin").

The host compares `when` against `` `on-skill-invoke:${key}` `` where `key` is
the skill-usage key, and for a plugin skill that key is
`<plugin name>:<skill>`. So `on-skill-invoke:wake` can never match, while
`on-skill-invoke:snapper-mcp:wake` arms the monitor within seconds.
Reproduced both ways on Claude Code 2.1.220, from a clean session with no
watch process running.

The monitor is therefore declared again, keyed on the qualified name. Running
`/wake` arms it; a session that never runs `/wake` still starts nothing.

### Changed

- Arming is handled by the host again, so the monitor command's
  `${CLAUDE_PLUGIN_DATA}` is expanded per plugin by the host rather than
  resolved in the agent's shell — where, on a machine with several plugins
  installed, it could point at a different plugin's directory.
- The `wake` skill now verifies the monitor started and falls back to arming it
  itself only if the host did not, so the plugin still works on hosts that do
  not honour the trigger.

## [0.14.0] — 2026-08-03

### Fixed: the monitor is armed by `/wake`, per session

Released 0.13.0 declared its monitor **ungated**, so installing the plugin
started a watch process that ran in every session — several open sessions all
connected and competed for the same request. The fix attempted after that tag
gated the declaration with `when: "on-skill-invoke:wake"`, but that trigger
does not start a monitor in the current Claude Code release: verified against
2.1.220 with the skill both invoked as a slash command and dispatched by the
model, only the suppression half fires. Gated, it never armed; ungated, it
always armed. Neither is what the plugin wants.

0.14.0 declares no monitor at all. The `wake` skill arms one for the current
session instead: it checks whether the machine is already watching, resolves
the seeded credentials, starts `snapper-mcp watch` through the host's monitor
primitive, and confirms the subscription list contains `ai_reviews.` before
reporting success. A session that never runs `/wake` never connects, consumes
tokens, or competes for a request.

### Upgrading from 0.13.0

Installing 0.14.0 removes the monitor declaration but does **not** stop a
watch process 0.13.0 already started. Stop the leftover monitor — or restart
your Claude Code host — before running `/wake`, otherwise two monitors handle
every request. `pgrep -af "snapper-mcp.*watch"` shows whether one is running.

### Changed

- Installing the plugin no longer spawns a background process. Run `/wake` in
  the session that should answer review requests, once per session — it is not
  restored when a session resumes.
- The `wake` skill carries the command it arms, pinned to the matching runtime
  tag. It reads credentials from the `env.json` the proxy MCP server seeds, and
  falls back to `--base-url` / `--access-token` flags or the
  `SNAPPER_BASE_URL` + `SNAPPER_ACCESS_TOKEN` environment variables.

## [0.13.0] — 2026-08-02

### New: foreign review requests are held, not woken (#172)

The `watch` monitor now fetches its own `delegate_public_id` from
`GET /api/auth/me` at startup and classifies incoming `ai_review.request`
frames. Requests addressed to another delegate are **held** instead of waking
the agent immediately: the frame is released to the JSONL consumer only when
the fanout window opens (`frame.timestamp + 30 s`), and a `decision_ack`
arriving earlier cancels the held frame entirely. The selected delegate keeps
waking instantly. Identity resolution fails open — if `/api/auth/me` is
unavailable, every request wakes the agent as before.

### Added

- The `watch` monitor subscribes to `ai_research.` by default and forwards
  `ai_research.request` frames to its JSONL consumer (#146).

### Changed

- Wire contract regenerated for the auth `ai_reviewer` role (#148) and the
  researcher role (#145).
- Dependencies refreshed to latest across the board.

### Fixed

- Test suite waits on conditions instead of fixed sleeps, eliminating timing
  flakes on slow runners (#166, #167); platform-specific config skips are
  declared explicitly (#153).

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
