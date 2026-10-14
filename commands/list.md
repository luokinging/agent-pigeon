---
description: List configured pigeon models with their provider, protocol, drivable clients (default marked), and effort levels (default marked).
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pigeon.mjs" list`

Present the command output to the user as-is. It is a table of model / provider / protocol / clients (default marked with `*`) / effort (default marked with `*`). Do not summarize or condense it. If the output reports no models configured, tell the user to run `/pigeon:config`.
