---
name: dispatch
description: Delegate, resume, steer, inspect, and cancel independent Pigeon sessions through the local pigeon CLI. Use when the user explicitly asks to use Pigeon; do not infer delegation from unrelated requests.
---

# Pigeon sessions

Pigeon is an independent CLI. The host invokes it; the selected runner (claude, codex, hermes) executes the task. Host and runner are independent choices. This skill does not install tools, credentials, hooks, or a background notification service.

## Choose a route

Run `pigeon capabilities --json` and `pigeon config validate --json` when necessary. Capability declarations are not live connectivity/model-access tests. `binary_available` checks only PATH, not authentication or Gateway readiness; inspect `authentication`, control booleans, `steerMode`, and `limitations`. Explicit provider `auth.type: none` is currently supported only by Codex; Claude and Hermes reject it. Native runner-managed authentication is a separate mode. Do not assume a provider or model exists. `--preset NAME` selects configured options. `--model ID` means the actual backend model ID, not a legacy model alias. Explicit flags override preset fields and the resulting combination must validate. Without a provider/preset, `--runner RUNNER` uses that runner's own authentication/configuration. Effort is optional; only select a level supported by the actual model and endpoint.

## Submit and keep both IDs

```sh
pigeon run --preset coding --background --json -- "Self-contained task"
pigeon run --provider service --runner codex --model REAL_MODEL_ID --background --json -- "Self-contained task"
pigeon resume SESSION_ID --background --json -- "Follow-up task"
```

Run from the intended working directory. Include enough context, files, scope, and success criteria in the task; the delegated agent does not see this conversation. Native agents may modify files and run tools: pass the user's scope accurately.

`run/resume --background --json` waits for runner control readiness, then returns `session_id`, `execution_id`, and `status`, normally `running`; a fast task may already return terminal `completed`. Ready means the runner control channel is ready, not merely that the manager started. Startup waits up to 120 seconds by default (`PIGEON_STARTUP_TIMEOUT_MS` in milliseconds), without waiting for task completion. Give the submitting host call a timeout longer than startup plus CLI overhead (150 seconds for the default). Startup failures exit nonzero with error JSON containing top-level `session_id`, `execution_id`, and `status` when an execution was created; retain these for inspection even on failure. Errors before execution creation may have no IDs. Session identifies a conversation; execution identifies one turn. Resume creates a new execution on the same bound session and inherits its working directory and route. Do not silently switch runners/providers. If a response is lost, inspect `pigeon executions --json` before retrying.

## Control and inspect

```sh
pigeon status EXECUTION_ID --json
pigeon steer EXECUTION_ID --json -- "Additional instruction for this turn"
pigeon cancel EXECUTION_ID --json
pigeon messages SESSION_ID -n 10
pigeon events EXECUTION_ID --json
pigeon result EXECUTION_ID --json
```

After a submission returns `running`, steer can be sent immediately without status polling to establish readiness; the turn may still finish before the control arrives. Steer targets an active execution and does not create a new turn. Use the concise `messages SESSION_ID -n N` view by default; add `--raw` only when structured history is needed. Accepted/buffered does not mean consumed; report the backend's actual acknowledgment. Do not emulate unsupported steer by canceling or resuming. Cancel acknowledgments may precede termination. `unknown` means outcome uncertain; do not automatically resend the task. Messages are the collected Pigeon view, not guaranteed complete native runner history; respect truncation markers. Direct CLI `result --json` preserves the complete stored final result, while status/messages provide bounded previews. A host tool may apply its own marked response limit; use the direct CLI for the full result. Events are structured execution records, not a promise of private model reasoning.

## Completion notifications

By default, immediately after a successful background run/resume returns, start `pigeon wait EXECUTION_ID --json` through the host's background shell/task and retain the returned IDs. Do this before ending the host turn; do not wait for a user request or poll status first. In Claude Code, use a second Bash call with `run_in_background: true`. The waiter blocks until terminal state, and its completion lets the host notify; it also returns promptly for a fast task already at a terminal state. Do not launch a blocking waiter as a synchronous agent tool. If the host has no completion callback, clearly state that no automatic notification is installed and use later status/result queries. The Hermes plugin installs no watcher and excludes blocking wait/follow actions; use a separate host-supported background shell if available. Similarly, `events EXECUTION_ID --json --follow` is a long-lived observer.

Read the returned status: `running` is ready, while `completed` is already terminal. Submission exit alone does not establish task completion. Never cancel shared tasks merely because a host conversation or observer ends. Only cancel the requested execution.

## CLI location and legacy

Use pigeon on PATH. Source checkout fallback: `node /absolute/path/to/agent-pigeon/packages/cli/src/index.mjs`. A copied skill contains no runtime and needs a separately installed CLI. Integrations may support PIGEON_CLI as one executable or JS-file path; it is not a shell command string.

PIGEON_HOME selects Pigeon config/state storage (default ~/.pigeon). Use `pigeon legacy ...` or the original scripts/pigeon.mjs only for explicitly requested legacy jobs/aliases; those have different identities, storage, and command semantics. Do not route standalone IDs through legacy hooks or commands.
