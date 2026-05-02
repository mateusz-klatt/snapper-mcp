# Changelog

All notable changes to `@mateusz-klatt/snapper-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
