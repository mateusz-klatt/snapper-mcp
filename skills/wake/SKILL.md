---
name: wake
description: Arm the Snapper review-request watch monitor for THIS session only
disable-model-invocation: true
---

Invoking this skill arms the bundled watch monitor for this session — the
plugin declares it with `when: "on-skill-invoke:snapper-mcp:wake"`, so the host
starts it in response to this very invocation. Arm only one session at a time;
every armed session receives the same requests.

Confirm it actually started, then stop:

1. Check that a watch process is now running:

   ```
   pgrep -af '[s]napper-mcp.*watch'
   ```

   Treat matches as candidates: another session or plugin may own them.
   Confirm the host monitor record belongs to this session and that the
   process uses this plugin's resolved configuration path. A process match
   alone does not establish that this session is armed.
2. If there is **no verified monitor for this session** after a few seconds, the host did not honour the
   trigger (older release, or a monitor left over from an earlier version is
   holding the name). Resolve this plugin's actual seeded `env.json` from the
   installed `snapper-mcp` data directory or its host configuration. Replace
   the placeholder in both commands below with that same absolute path.
   First verify the file exists, without printing its credential contents:

   ```
   test -f "/absolute/path/to/snapper-mcp/data/env.json"
   ```

   If this check fails, locate the correct seeded file before continuing.
   After the check succeeds, start the command below through
   the **Monitor tool**, persistent and without a timeout — NOT a backgrounded
   shell command, which only reports when the process exits, and `watch` is
   built never to exit:

   ```
   npx -y @mateusz-klatt/snapper-mcp@0.15.0 watch --config="/absolute/path/to/snapper-mcp/data/env.json"
   ```

   Do not use an ambient `CLAUDE_PLUGIN_DATA` value without
   verifying that it belongs to `snapper-mcp`; another plugin can own it.
   Never print the file — it holds a credential. Do not add `--topic`: it
   replaces the defaults and would silently drop `ai_reviews.`.
3. Either way, before reporting success make sure the monitor survived startup.
   On connect `watch` logs `subscribing to topics: ...`, and that list must
   include both `ai_reviews.` and `ai_research.`.

Once armed, pending review requests addressed to this delegate stream as JSONL
and wake you; answer each `ai_review.request` before its deadline using the
`submit_ai_review_decision` tool. `signal` and `decision_ack` frames are
informational — they need no reply.

A session that never invokes this skill never starts a monitor, so it does not
connect, consume tokens, or compete for the same request. The monitor is not
restored when a session resumes — invoke this skill again to re-arm it.
