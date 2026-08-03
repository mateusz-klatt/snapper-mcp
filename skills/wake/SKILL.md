---
name: wake
description: Arm the Snapper consult wake monitor for THIS session only
disable-model-invocation: true
---

Arm the Snapper watch monitor for THIS session. Do it now:

1. List your background tasks first. If one is already streaming
   `snapper-mcp watch`, this session is already armed — report that and STOP.
   A second monitor would double-handle every review request.
2. Otherwise start the command below as a **persistent background monitor**,
   so each stdout line arrives as an event that wakes you:

   ```
   npx -y @mateusz-klatt/snapper-mcp@0.14.0 watch --config="$CLAUDE_PLUGIN_DATA/env.json"
   ```

   The proxy MCP server seeds that `env.json` when it starts. If
   `CLAUDE_PLUGIN_DATA` is not set in your shell or the file is missing, locate
   the seeded config instead (look for `env.json` under the Claude plugin data
   directory) and pass its path. `watch` also accepts `--base-url` and
   `--access-token`, and falls back to `SNAPPER_BASE_URL` +
   `SNAPPER_ACCESS_TOKEN` from the environment.

Once armed, pending review requests addressed to this delegate stream as JSONL
and wake you; answer each `ai_review.request` before its deadline using the
`submit_ai_review_decision` tool. `signal` and `decision_ack` frames are
informational — they need no reply.

A session that never invokes this skill never starts a monitor, so it does not
connect, consume tokens, or compete for the same request. The monitor is not
restored when a session resumes — invoke this skill again to re-arm it, and
stop it by ending the session.
