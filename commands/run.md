---
description: Delegate a task to a model in FOREGROUND mode, launched as a Claude background shell task — the conversation is not blocked and you are notified with the model's result when it finishes.
argument-hint: "--model <m> [--client <c>] [--effort <e>] -- <task text>"
allowed-tools: Bash
---

`/pigeon:run` delegates a task and gets the result back without blocking the conversation, by riding Claude Code's own background-task mechanism:

`/pigeon:run --model <m> [--client <c>] [--effort <e>] -- <task text>`

Raw user request:
$ARGUMENTS

If there's no `--model` or task (e.g. a bare `/pigeon:run`), ask which model and what to do, then stop.

Otherwise make one Bash call with `run_in_background: true`, passing the task on stdin via a quoted heredoc so it survives shell quoting:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pigeon.mjs" run --model <m> [--client <c>] [--effort <e>] --stdin <<'PIGEON_TASK_EOF'
<the task text, verbatim>
PIGEON_TASK_EOF
```

`run_in_background: true` is what makes this non-blocking: Claude Code doesn't wait, and re-invokes you with a task-notification when the process finishes. `pigeon run` runs the client synchronously and prints the model's final result to stdout, so the background task completes exactly when the model is done and its stdout is the result. Relay that result to the user when the notification arrives — don't poll, just launch and continue.

Use `/pigeon:work` instead when you need a managed job: to cancel or continue it, or have it survive across sessions.
