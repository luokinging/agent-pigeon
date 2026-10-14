---
description: Delegate or resume a model session via a Claude background shell task; each turn notifies you with the result and stable pigeon session ID.
argument-hint: "--model <m> [--client <c>] [--effort <e>] -- <task> | --session <id> -- <message>"
allowed-tools: Bash
---

`/pigeon:run` starts a resumable session or follows up on its same underlying client thread:

- First turn: `/pigeon:run --model <m> [--client <c>] [--effort <e>] -- <task>`
- Follow-up: `/pigeon:run --session <id> -- <message>`

Raw user request:
$ARGUMENTS

If neither `--model` nor `--session` is supplied, or the task/message is missing, ask for the missing information and stop. A session continuation inherits its original model, client, effort, working directory and backend identity; do not add model/client/effort flags or re-resolve the model alias from current config.

For **every turn**, make one Bash call with `run_in_background: true`. Pass the task on stdin via a quoted heredoc with a delimiter absent from the task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pigeon.mjs" run --model <m> [--client <c>] [--effort <e>] --stdin <<'PIGEON_TASK_EOF'
<the task text, verbatim>
PIGEON_TASK_EOF
```

For follow-ups, use the same background Bash mechanism:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pigeon.mjs" run --session <id> --stdin <<'PIGEON_TASK_EOF'
<the follow-up message, verbatim>
PIGEON_TASK_EOF
```

Claude Code sends a task notification when the process finishes. Relay the result and the `Pigeon session: run-...` line to the user; preserve that ID for later follow-ups. This is a pigeon ID, distinct from the client's internal session ID and from a work job ID. Do not poll or switch to work/continue to resume a run session. Report nonzero exits as failures; no successful session is advertised if the client fails or cannot establish a resumable ID. Concurrent turns on the same session are rejected; wait for the active turn's notification and retry.

Successful session metadata lives in `~/.pigeon/run-sessions/` (or `$PIGEON_HOME/run-sessions/`), with no saved API key. Configured-provider credentials and endpoint are read from the original provider's current configuration, as with managed-job continue. Native sessions reuse the client's own authentication. Failed turns leave the last successful metadata intact; the client may already have written partial history to its own thread.

Use `/pigeon:work` for managed jobs with status/result/cancel and `/pigeon:continue <job-id>` for those jobs. Run session continuation needs only `/pigeon:run --session`.
