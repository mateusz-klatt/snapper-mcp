---
name: wake
description: Arm the Snapper consult wake monitor for THIS session only
disable-model-invocation: true
---

The Snapper consult wake monitor is now armed for this session.

Pending AI-review (consult) frames addressed to this delegate will stream as
JSONL and wake the agent, which must answer them within the deadline. Sessions
and subagents that do not invoke this skill never start the monitor, so they do
not connect, do not consume tokens, and do not double-handle the same consult.

On a session resume the monitor is not restored; run this skill again to re-arm
it. Stop watching by ending the session.
