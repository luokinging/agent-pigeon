---
description: Show pigeon job status. Bare shows the 10 most recent jobs (one page); a page number shows the next page; a job-id shows that one job. Liveness is verified (pid probe + heartbeat + timeout), not just the stored status field.
argument-hint: "[job-id | page-number]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pigeon.mjs" status "$ARGUMENTS"`

Present the command output to the user as-is.

- If no argument was passed: the output is the first page — the 10 most recent jobs, newest first. If there are more, the footer says `Next page: /pigeon:status 2`. Render it compactly (a table is fine). Preserve the actionable fields: job id, model, client, effort, status, the pagination footer, and any follow-up hints (e.g. `/pigeon:result <id>`, `/pigeon:cancel <id>`). Do not fetch further pages on your own — only when the user asks.
- If a page number was passed (e.g. `2`): show that page of 10, with the same footer.
- If a job-id was passed: show the full output for that job, including any liveness note (e.g. crashed / suspected-stuck / timeout). Do not summarize or condense it.
