---
description: Delegate a chunk of work to a model running on a chosen CLI client, in the background. Returns a job-id immediately and never blocks.
argument-hint: "--model <m> [--client <c>] [--effort <e>] -- <task text>"
allowed-tools: Agent
---

Delegate work to pigeon as a managed background job:

`/pigeon:work --model <m> [--client <c>] [--effort <e>] -- <task text>`

Everything after `--` is the literal task text, passed through untouched even if it contains `--something`.

Raw user request:
$ARGUMENTS

If there's no `--model` or no task text (e.g. a bare `/pigeon:work`), ask which model this goes to and what it should do, then stop. The user can run `/pigeon:list` to see configured models.

Otherwise forward the request to the `pigeon:pigeon-runner` subagent (`subagent_type: "pigeon:pigeon-runner"`) with the model, any `--client` / `--effort`, and the task text, all verbatim. The runner makes the actual call; pigeon validates, spawns a background job, and prints a `job-id` without waiting for the work to finish. Return the runner's output (the job-id and hint) to the user verbatim; they can then use `/pigeon:status`, `/pigeon:result`, `/pigeon:cancel`, or `/pigeon:continue`.

For "delegate one thing and tell me when it's done", prefer `/pigeon:run` — it's non-blocking and notifies you on completion. Use `/pigeon:work` when you need a managed job: to cancel or continue it, or have it survive across sessions.
