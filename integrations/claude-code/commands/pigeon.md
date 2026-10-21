---
description: Delegate, resume, steer, or inspect an independent Pigeon session
argument-hint: <run|resume|steer|status|result|messages|events|cancel|capabilities|config> ...
---

Handle this Pigeon request: $ARGUMENTS

Use the standalone Pigeon CLI through `sh "${CLAUDE_PLUGIN_ROOT}/scripts/pigeon.sh"` in Bash. This wrapper prefers PIGEON_CLI (one executable or JS file), then pigeon on PATH, then packages/cli/src/index.mjs only when the plugin is still inside a complete source checkout. A cached/copied plugin requires the CLI installed separately. Do not call legacy scripts or root-plugin commands.

Read the bundled dispatch skill for operation semantics. Preserve user text as quoted arguments, not shell source. Do not execute $ARGUMENTS as an unreviewed shell command. Use the requested working directory; make delegation context self-contained.

- Discover supported combinations with `capabilities --json`; validate config with `config validate --json`. Do not print keys or assume any provider/model is configured.
- Start with `run --preset NAME --background --json -- TASK`, or explicit `run --provider NAME --runner RUNNER --model MODEL [--effort LEVEL] --background --json -- TASK`. Runner-only mode uses runner-managed authentication. `--model` is an actual model ID.
- Resume with `resume SESSION --background --json -- TASK`. Run/resume waits for runner control readiness, not merely manager startup, then returns session_id, execution_id, and status, normally `running`; a fast task may already be `completed`. Startup defaults to 120 seconds (`PIGEON_STARTUP_TIMEOUT_MS` in milliseconds), without waiting for task completion. Set the submitting Bash timeout to at least 150000 ms by default, or the configured startup timeout plus 30000 ms. Retain IDs even on failure: startup error JSON includes top-level session_id/execution_id/status when an execution was created.
- By default, immediately after successful background run/resume returns, invoke a second Bash call with `run_in_background: true`, running `wait EXECUTION --json`. Start this waiter before ending the host turn, without asking for a notification request or polling status first. The host's notification delivers the completed waiter; inspect its JSON and use `result EXECUTION --json` as needed. A fast completed task also gets its result through the waiter. Read the returned status instead of treating submission exit alone as completion. If background notifications are unavailable, say so and offer status/result.
- Use `steer EXECUTION --json -- TEXT` only for the active turn, without replacing it with resume. Once submission returns `running`, steer needs no readiness status polling; the turn may still end before delivery. A delivery acknowledgment does not establish consumption.
- Use `status|result|cancel EXECUTION --json`, the concise `messages SESSION -n N`, or `events EXECUTION --json`. Add `--raw` to messages only when structured history is needed. Only use `events ... --follow` in a host background task when requested.
- If a submission response is lost, inspect `executions --json` before retrying to avoid duplicate work.

This integration has no SessionEnd cleanup hook. Closing Claude or ending a waiter must not cancel shared Pigeon executions. Cancellation requires the user's requested execution ID.
