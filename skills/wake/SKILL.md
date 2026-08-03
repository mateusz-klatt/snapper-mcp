---
name: wake
description: Arm the Snapper consult wake monitor for THIS session only
disable-model-invocation: true
---

Arm the Snapper watch monitor for THIS session. Arm only one session at a
time — every armed session receives the same requests. Do it now:

1. List your background tasks first. If one is already streaming
   `snapper-mcp watch`, this session is already armed — report that and STOP.
   A second monitor would double-handle every review request.
2. Resolve the config path BEFORE arming. The proxy MCP server seeds an
   `env.json` into this plugin's data directory:

   ```
   test -f "$CLAUDE_PLUGIN_DATA/env.json" && echo "$CLAUDE_PLUGIN_DATA"
   ```

   `CLAUDE_PLUGIN_DATA` is set per plugin, so on a machine with several plugins
   installed it can point at a different plugin's directory. If the file is
   missing, or the path does not name this plugin, find the seeded `env.json`
   under the Claude plugin data directory and use that path in step 3 instead.
3. Start the command below as a **persistent background monitor**, so each
   stdout line arrives as an event that wakes you:

   ```
   npx -y @mateusz-klatt/snapper-mcp@0.14.0 watch --config="$CLAUDE_PLUGIN_DATA/env.json"
   ```

4. Confirm it survived startup before reporting success. When credentials
   cannot be resolved, `watch` exits within a couple of seconds and names every
   source it tried on stderr. Read the task output; on failure re-run with
   `--base-url` and `--access-token`, or with `SNAPPER_BASE_URL` +
   `SNAPPER_ACCESS_TOKEN` set in the environment.

Once armed, pending review requests addressed to this delegate stream as JSONL
and wake you; answer each `ai_review.request` before its deadline using the
`submit_ai_review_decision` tool. `signal` and `decision_ack` frames are
informational — they need no reply.

A session that never invokes this skill never starts a monitor, so it does not
connect, consume tokens, or compete for the same request. The monitor is not
restored when a session resumes — invoke this skill again to re-arm it, and
stop it by ending the session.
