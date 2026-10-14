---
description: Cancel a running pigeon job — kills its whole process tree and marks it killed.
argument-hint: "<job-id>"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pigeon.mjs" cancel "$ARGUMENTS"`

Present the command output to the user as-is. It confirms the job's process tree was killed and its status set to `killed`, or reports why it could not be cancelled (e.g. unknown job-id, or already finished). Do not summarize or condense it.
