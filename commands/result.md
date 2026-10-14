---
description: Fetch the final output of a finished pigeon job. If the job is not done yet, reports its current status instead.
argument-hint: "<job-id>"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pigeon.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. If the job is done, the output is the delegated model's complete result text — show all of it verbatim, including file paths and code exactly as reported. If the job is not finished, the output states the current status; relay that and remind the user they can `/pigeon:status <job-id>` or `/pigeon:cancel <job-id>`.
