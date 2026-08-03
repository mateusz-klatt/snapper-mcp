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
   pgrep -af "snapper-mcp.*watch"
   ```

   A task list does not show background monitors, so check the processes. One
   match means this session is armed — report that and STOP.
2. If there is **no** match after a few seconds, the host did not honour the
   trigger (older release, or a monitor left over from an earlier version is
   holding the name). Arm it yourself instead: start the command below through
   the **Monitor tool**, persistent and without a timeout — NOT a backgrounded
   shell command, which only reports when the process exits, and `watch` is
   built never to exit:

   ```
   npx -y @mateusz-klatt/snapper-mcp@0.15.0 watch --config="$CLAUDE_PLUGIN_DATA/env.json"
   ```

   `CLAUDE_PLUGIN_DATA` is set per plugin, so on a machine with several plugins
   it can point at a different plugin's directory. Verify
   `test -f "$CLAUDE_PLUGIN_DATA/env.json"` first, and if it is missing find
   this plugin's seeded `env.json` under the Claude plugin data directory.
   Never print the file — it holds a credential. Do not add `--topic`: it
   replaces the defaults and would silently drop `ai_reviews.`.
3. Either way, before reporting success make sure the monitor survived startup.
   On connect `watch` logs `subscribing to topics: ...`, and that list must
   include `ai_reviews.`.

Once armed, pending review requests addressed to this delegate stream as JSONL
and wake you; answer each `ai_review.request` before its deadline using the
`submit_ai_review_decision` tool. `signal` and `decision_ack` frames are
informational — they need no reply.

A session that never invokes this skill never starts a monitor, so it does not
connect, consume tokens, or compete for the same request. The monitor is not
restored when a session resumes — invoke this skill again to re-arm it.
