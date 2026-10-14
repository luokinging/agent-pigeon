---
name: dispatch
description: >-
  Route a pigeon request to the right pigeon command (delegate / query / configure / manage jobs).
  Use this whenever the user invokes pigeon by name. Trigger on pigeon-anchored phrases ONLY — never on a
  generic "run a script / make a background task" without the pigeon anchor, and never assume a specific
  provider is configured.
  Delegate: "pigeon 调度", "pigeon 一下", "用 pigeon 跑", "让 pigeon 做", "pigeon 委派给…", "让 pigeon 后台跑",
  "pigeon 并行", "pigeon 扇出给几个模型", "use pigeon to delegate", "let pigeon run this", "pigeon this".
  Query capabilities: "pigeon 支持哪些模型", "pigeon 有哪些模型", "pigeon 配了什么", "pigeon 能调度谁",
  "what models does pigeon have", "pigeon list".
  Configure: "配置 pigeon", "给 pigeon 加个模型", "给 pigeon 加 provider", "pigeon 配 key", "configure pigeon".
  Manage jobs: "pigeon 任务到哪了", "pigeon 进度", "看下 pigeon 的任务", "pigeon 那个结果", "取回 pigeon 结果",
  "取消 pigeon 任务", "pigeon 接着跑", "pigeon 继续", "check my pigeon jobs", "pigeon status", "pigeon result".
---

You are the natural-language entry point for the pigeon plugin (delegate work to any vendor's model on any compatible CLI client). The user invoked pigeon without a slash command; work out the intent and carry it out via `node "${CLAUDE_PLUGIN_ROOT}/scripts/pigeon.mjs" <subcommand>`. Config lives in `~/.pigeon/config.json`.

When a specific model is named, first confirm it's configured by running `pigeon.mjs list`. If it isn't there (or nothing is configured), tell the user what is configured and offer the Configure flow below — pigeon only drives models the user has set up.

## Route by intent

### 1) Delegate work

Launch one independent background shell per task. Delegate with `run`, making one Bash call per task with `run_in_background: true`, so each task runs on its own and notifies you with its result when it finishes — non-blocking, no polling.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pigeon.mjs" run --model <m> [--client <c>] [--effort <e>] --stdin <<'PIGEON_TASK_EOF'
<the task text, verbatim>
PIGEON_TASK_EOF
```

For several tasks (e.g. "多开几个并行", comparing models), fire one such call per task, so the user gets N independent shells. If they want the outputs compared or written up, aggregate the N results once each has notified — that's a report, not a reason to run them as one command. Combine into a single command only if the user explicitly asks to. Omit `--client` / `--effort` to use the model's defaults.

Relay each completed run's result and `Pigeon session: run-...` ID. To follow up on that same client thread, use `run --session <id> --stdin` with the follow-up body in a quoted heredoc, again in a Bash call with `run_in_background: true` for **every turn**. Do not add model/client/effort overrides, query current model aliases, poll, or switch to work/continue for a run session. The saved session inherits its original model/client/effort/cwd/backend identity; credentials and endpoint come from the original provider's current config. Concurrent turns on one session are rejected; wait for its completion notification before retrying. Treat nonzero exits as failures and preserve the stable pigeon ID across successful turns.

Use `work` (a pigeon-managed detached job) when the user needs managed status/result/cancel, managed-job continue, or a batch too large for that many live shells — forward to the `pigeon:pigeon-runner` subagent. Even then, wait via `run_in_background`, not a foreground poll loop.

### 2) Query capabilities

Run `pigeon.mjs list` and present the configured models, their clients (default `*`) and effort.

### 3) Configure

Ask what to set (provider / model / api-key / base-url / effort), turn the user's answer into the config JSON shape, confirm it back, then persist with `pigeon.mjs config-set --json '<structured JSON>'`. Confirm before overwriting an existing value. This only edits config; it never calls a model.

### 4) Manage jobs

- progress → `pigeon.mjs status [job-id]`
- fetch output → `pigeon.mjs result <job-id>`
- stop one → `pigeon.mjs cancel <job-id>`
- follow up on a finished job → `pigeon.mjs continue <job-id> --stdin <<heredoc`

## Rules

Stay a thin router: pick the intent, run the right subcommand, relay the result; don't do the delegated work yourself. Pass task text via a quoted heredoc on `--stdin` so apostrophes, quotes, and newlines survive. If the intent is ambiguous (e.g. a bare "pigeon"), ask one short clarifying question.
