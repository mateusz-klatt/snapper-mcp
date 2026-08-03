---
name: wake
description: Arm the Snapper review-request watch monitor for THIS session only
disable-model-invocation: true
---

Arm the Snapper watch monitor for THIS session. Arm only one session at a
time — every armed session receives the same requests. Do it now, in order:

1. Check whether this machine is already watching. A task list does not show
   background monitors, so check the processes:

   ```
   pgrep -af "snapper-mcp.*watch"
   ```

   A match means a monitor is already running — possibly one auto-started by
   plugin version 0.13.0, which shipped an ungated monitor. If it is healthy
   and subscribed to `ai_reviews.`, report that and STOP: a second monitor
   double-handles every request. Stop a leftover 0.13.0 monitor (or restart
   the host) before arming a new one.

2. Resolve the config path BEFORE arming:

   ```
   test -f "$CLAUDE_PLUGIN_DATA/env.json" && echo "$CLAUDE_PLUGIN_DATA"
   ```

   `CLAUDE_PLUGIN_DATA` is set per plugin, so treat it as a candidate only: on
   a machine with several plugins installed it can point at a different
   plugin's directory. If the file is missing, or the path does not name this
   plugin, find this plugin's seeded `env.json` under the Claude plugin data
   directory and use that path in step 3. Never print the file — it holds a
   credential.

3. Arm it with the **Monitor tool**, persistent and without a timeout — NOT a
   backgrounded Bash command. The Monitor tool turns every stdout line into an
   event that wakes you; a backgrounded shell command only reports when the
   process exits, and `watch` is built never to exit, so it would deliver no
   wakeups at all:

   ```
   npx -y @mateusz-klatt/snapper-mcp@0.14.0 watch --config="$CLAUDE_PLUGIN_DATA/env.json"
   ```

   Do not add `--topic`: it replaces the defaults, and dropping `ai_reviews.`
   silently stops every review request.

4. Confirm it survived startup before reporting success. On connect `watch`
   logs `subscribing to topics: ...`, and that list must include
   `ai_reviews.`. When credentials cannot be resolved it exits within a couple
   of seconds naming every source it tried. Read the monitor's output; on
   failure re-run with `--base-url` and `--access-token`, or with
   `SNAPPER_BASE_URL` + `SNAPPER_ACCESS_TOKEN` set in the environment.

Once armed, pending review requests addressed to this delegate stream as JSONL
and wake you; answer each `ai_review.request` before its deadline using the
`submit_ai_review_decision` tool. `signal` and `decision_ack` frames are
informational — they need no reply.

A session that never invokes this skill never starts a monitor, so it does not
connect, consume tokens, or compete for the same request. The monitor is not
restored when a session resumes — invoke this skill again to re-arm it, and
stop it by ending the session.
