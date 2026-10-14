// Plain-text rendering: list (model table) / status (job status) / result (final output).
// Pure functions, no IO.

function pad(str, width) {
  const s = String(str ?? "");
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length))
  );
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();
  const out = [line(headers), line(widths.map((w) => "-".repeat(w)))];
  for (const r of rows) {
    out.push(line(r));
  }
  return out.join("\n");
}

// One model table (rows + header). models: registry-resolved [{ model, provider, protocols, clients, defaultClient, effort, defaultEffort }]
function renderModelTable(models) {
  const rows = models.map((m) => {
    const clients = (m.clients ?? [])
      .map((c) => (c === m.defaultClient ? `${c}*` : c))
      .join(",");
    const effort = (m.effort ?? [])
      .map((e) => (e === m.defaultEffort ? `${e}*` : e))
      .join(",");
    const protocols = Array.isArray(m.protocols) ? m.protocols.join(",") : String(m.protocols ?? "");
    return [m.modelId ?? "", m.model, m.provider, protocols, clients, effort];
  });
  return renderTable(["MODEL_ID", "MODEL", "PROVIDER", "PROTOCOL", "CLIENTS", "EFFORT"], rows);
}

// /pigeon:list — two separate tables: configured (key-based) models and native (keyless) models.
export function renderModelList(models) {
  if (!models || models.length === 0) {
    return "No models configured yet. Add one with /pigeon:config.";
  }
  const configured = models.filter((m) => !m.native);
  const native = models.filter((m) => m.native);
  const sections = [];
  if (configured.length) {
    sections.push(`Configured models\n${renderModelTable(configured)}`);
  }
  if (native.length) {
    sections.push(`Native models (keyless — your own codex / claude)\n${renderModelTable(native)}`);
  }
  return `${sections.join("\n\n")}\n\n* = default`;
}

// /pigeon:list — a one-line hint of built-in native providers detected on this machine (client installed)
// that have no model yet. No table — just name them so the user knows they can hang a keyless model on one.
// providers: [{ provider, protocol, client }]
export function renderNativeProviders(providers) {
  if (!providers || providers.length === 0) {
    return "";
  }
  const names = providers.map((p) => p.provider).join(", ");
  return `Native providers available (no key needed): ${names} — add a model on one with /pigeon:config.`;
}

function elapsed(startIso, endIso) {
  const start = Date.parse(startIso ?? "");
  if (!Number.isFinite(start)) {
    return "";
  }
  const end = endIso ? Date.parse(endIso) : Date.now();
  const total = Math.max(0, Math.round((end - start) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

function statusBadge(job) {
  if (job.status === "running" && job.suspectedStuck) {
    return "running(possibly stuck)";
  }
  return job.status;
}

// One-line summary for a single job.
function jobLine(job) {
  const parts = [
    job.id,
    statusBadge(job),
    `${job.model}/${job.client}/${job.effort ?? "-"}`,
    elapsed(job.started_at, job.status === "running" ? null : job.last_heartbeat)
  ];
  return parts.filter(Boolean).join("  ");
}

// /pigeon:status (all) — list of assessed jobs. `page`, when given, is the pagination
// context { page, pageSize, total } for the slice being shown; it only adds a footer line.
export function renderStatusList(jobs, page) {
  const shown = jobs ? jobs.length : 0;
  if (shown === 0) {
    // No jobs at all vs. a page past the end of a non-empty list.
    if (page && page.total > 0) {
      return `No jobs on page ${page.page} (total ${page.total}). Go back with /pigeon:status 1.`;
    }
    return "No pigeon jobs. Dispatch one with /pigeon:work.";
  }
  const isActive = (s) => s === "running" || s === "queued"; // queued = waiting on the lock, also counts as in progress
  const running = jobs.filter((j) => isActive(j.status));
  const finished = jobs.filter((j) => !isActive(j.status));
  const sections = [];
  if (running.length) {
    sections.push(["In progress:", ...running.map((j) => `  ${jobLine(j)}`)].join("\n"));
    if (running.some((j) => j.suspectedStuck)) {
      sections.push("Tip: a job that looks stuck can be terminated with /pigeon:cancel <job-id>.");
    }
  }
  if (finished.length) {
    sections.push(["Finished:", ...finished.map((j) => `  ${jobLine(j)}`)].join("\n"));
  }
  const footer = paginationFooter(page, shown);
  if (footer) {
    sections.push(footer);
  }
  return sections.join("\n\n");
}

// Footer under a paginated status list: position + how to reach the next page.
function paginationFooter(page, shown) {
  if (!page || page.total <= shown) {
    return ""; // single page — nothing more to show
  }
  const start = (page.page - 1) * page.pageSize + 1;
  const end = start + shown - 1;
  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const next = page.page < totalPages ? ` Next page: /pigeon:status ${page.page + 1}.` : "";
  return `Showing ${start}-${end} of ${page.total} (page ${page.page}/${totalPages}).${next}`;
}

// /pigeon:status <job-id> (single).
export function renderStatusOne(job) {
  const lines = [
    `job:        ${job.id}`,
    `status:     ${statusBadge(job)}`,
    `model:      ${job.model}`,
    `client:     ${job.client}`,
    `effort:     ${job.effort ?? "-"}`,
    `cwd:        ${job.cwd}`,
    `pid:        ${job.pid ?? "-"}`,
    `started:    ${job.started_at}`,
    `heartbeat:  ${job.last_heartbeat ?? "-"}`,
    `elapsed:    ${elapsed(job.started_at, job.status === "running" ? null : job.last_heartbeat)}`
  ];
  if (job.exit_code != null) {
    lines.push(`exit_code:  ${job.exit_code}`);
  }
  if (job.error) {
    lines.push(`error:      ${job.error}`);
  }
  if (job.status === "running" && job.suspectedStuck) {
    lines.push("");
    lines.push("Tip: heartbeat timed out, possibly stuck. You can run /pigeon:cancel " + job.id);
  }
  return lines.join("\n");
}

// /pigeon:result — when done, print the full result; otherwise report the current status.
export function renderResult(job, resultText) {
  if (job.status === "done") {
    return resultText && resultText.trim() ? resultText : "(job finished, but produced no output text)";
  }
  if (job.status === "queued") {
    return `job ${job.id} is still queued (waiting for the previous task on the same thread to finish) and hasn't started. Check with /pigeon:status ${job.id}.`;
  }
  if (job.status === "running") {
    const stuck = job.suspectedStuck ? " (possibly stuck)" : "";
    return `job ${job.id} is still running${stuck}, no final result yet. Check progress with /pigeon:status ${job.id}.`;
  }
  // failure terminal states
  const reason = job.error ? `: ${job.error}` : "";
  return `job ${job.id} has status ${job.status}${reason}. There is no successful result to fetch.`;
}

// Dispatch-success message.
export function renderWorkAccepted(job) {
  return [
    `Dispatched job ${job.id} in the background (${job.model}/${job.client}/${job.effort ?? "-"}).`,
    `Check progress: /pigeon:status ${job.id}`,
    `Fetch result:   /pigeon:result ${job.id}`
  ].join("\n");
}

// Cancel-result message.
export function renderCancel(job, result) {
  const how = result?.delivered ? `process tree killed (${result.method})` : "process no longer exists";
  return `job ${job.id} cancelled (status=killed), ${how}.`;
}
