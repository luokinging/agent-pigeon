// Job state layer: CRUD + liveness checks + heartbeat.
// Each job has one ~/.pigeon/jobs/<id>.json file + a same-named .log.
// The job file itself is the source of truth (no central state.json), avoiding concurrent write conflicts.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { aliveAndOurs, terminateTreeIfOurs, verifiedOurs } from "./process.mjs";
import { withLock } from "./lock.mjs";

// Consistent with config.mjs: the PIGEON_HOME env var takes precedence (used by tests/isolated installs/wrappers), otherwise ~/.pigeon.
// All three (config/jobs/lock) must align, otherwise config and the job/log/lock end up in different trees and status/result/cleanup can't read them.
const PIGEON_HOME = process.env.PIGEON_HOME || path.join(os.homedir(), ".pigeon");
const JOBS_DIR = path.join(PIGEON_HOME, "jobs");
const ACTIVE_SESSIONS_FILE = path.join(PIGEON_HOME, "active-sessions.json");
const SEQ_FILE = path.join(PIGEON_HOME, "seq");

export const HEARTBEAT_INTERVAL_MS = 5_000; // runner heartbeat interval (≤5s)
export const HEARTBEAT_STALE_MS = 30_000; // no heartbeat beyond this → suspected stuck
// No default execution time limit: a delegated agent may run for hours. A cap applies only when a
// job carries an explicit timeout_ms (opted into via PIGEON_TIMEOUT_MS or a per-model/provider config).

// Terminal state set
const TERMINAL = new Set(["done", "failed", "timeout", "killed", "crashed"]);
// Active (non-terminal) states: queued (dispatched, waiting for the thread lock) + running (actually running the client).
const ACTIVE = new Set(["queued", "running"]);

export function nowIso() {
  return new Date().toISOString();
}

export function isTerminal(status) {
  return TERMINAL.has(status);
}

export function isActive(status) {
  return ACTIVE.has(status);
}

export function ensureJobsDir() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
}

// ——— Active session registry ———
// SessionStart adds the session id to the set, SessionEnd removes it. A command subprocess can't get its own
// session id (the platform doesn't inject env), so when work records claude_session it only attributes the job
// when there is **exactly one active session** (safe for single-session); with multiple active sessions it doesn't guess
// (returns null), to avoid attributing to the wrong session and being mistakenly killed by another SessionEnd. RMW is done
// inside the lock to prevent concurrent Start/End races.
// Entry format { id, at(ISO) }. Self-healing via TTL: expired entries are dropped on every write and read — so even if some
// SessionEnd fails to remove itself (e.g. on a degraded path with no id in stdin), stale entries won't pile up forever and stall lastSession.
const ACTIVE_SESSION_TTL_MS = 48 * 60 * 60 * 1000;

function readRawActiveSessions() {
  try {
    const arr = JSON.parse(fs.readFileSync(ACTIVE_SESSIONS_FILE, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function freshEntries(raw, now) {
  return raw.filter(
    (e) =>
      e &&
      typeof e.id === "string" &&
      e.id &&
      Number.isFinite(Date.parse(e.at)) &&
      now - Date.parse(e.at) < ACTIVE_SESSION_TTL_MS
  );
}

function writeRawActiveSessions(list) {
  fs.mkdirSync(PIGEON_HOME, { recursive: true });
  const tmp = `${ACTIVE_SESSIONS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list), "utf8");
  fs.renameSync(tmp, ACTIVE_SESSIONS_FILE);
}

function activeIds(now = Date.now()) {
  return freshEntries(readRawActiveSessions(), now).map((e) => e.id);
}

export function addActiveSession(sessionId) {
  if (!sessionId) return;
  withLock("active-sessions", () => {
    const now = Date.now();
    const kept = freshEntries(readRawActiveSessions(), now).filter((e) => e.id !== sessionId);
    kept.push({ id: sessionId, at: new Date(now).toISOString() });
    writeRawActiveSessions(kept);
  });
}

export function removeActiveSession(sessionId) {
  if (!sessionId) return;
  withLock("active-sessions", () => {
    const now = Date.now();
    const kept = freshEntries(readRawActiveSessions(), now).filter((e) => e.id !== sessionId);
    writeRawActiveSessions(kept);
  });
}

// Exactly one active session → return it; otherwise null (don't guess for 0 or multiple concurrent).
export function soleActiveSession() {
  const active = activeIds();
  return active.length === 1 ? active[0] : null;
}

export function jobFile(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

export function jobLogFile(id) {
  return path.join(JOBS_DIR, `${id}.log`);
}

// Globally monotonic increasing sequence number (submission order). FIFO queuing on the same thread uses this to determine "who submitted earlier". read-inc-write inside the lock.
export function nextSeq() {
  return withLock("seq", () => {
    let n = 0;
    try {
      n = parseInt(fs.readFileSync(SEQ_FILE, "utf8"), 10) || 0;
    } catch {
      n = 0;
    }
    n += 1;
    fs.mkdirSync(PIGEON_HOME, { recursive: true });
    const tmp = `${SEQ_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, String(n), "utf8");
    fs.renameSync(tmp, SEQ_FILE);
    return n;
  });
}

// Whether execution is "still in progress" (safe for cancel/cleanup to preempt).
//  - client already started and still alive → still running, can preempt (claim killed + kill).
//  - client already started but already exited → the task has actually finished, the runner is in close→finalize writing the real result
//    (done/failed) → **cannot** preempt, otherwise killed would absorb the just-completed done and lose the result.
//  - client not started yet (queued) → no completed result to lose, can preempt.
export function executionStillLive(job) {
  if (job.client_pid) return verifiedOurs(job.client_pid, job.client_pid_token);
  return true;
}

// Whether the same thread still has a job "submitted earlier (smaller seq) and not yet terminal" — used for the FIFO check.
export function earlierActiveOnThread(threadKeyVal, seq, selfId) {
  if (!Number.isFinite(seq)) return false;
  return listJobs().some(
    (j) =>
      j.thread_key === threadKeyVal &&
      j.id !== selfId &&
      isActive(j.status) &&
      Number.isFinite(j.seq) &&
      j.seq < seq
  );
}

// thread_key = sha1(cwd|model|client), used for resume and the same-thread serialization lock.
export function threadKey(cwd, model, client) {
  return createHash("sha1").update(`${cwd}|${model}|${client}`).digest("hex").slice(0, 16);
}

// job-id = human-readable prefix (model) + random suffix, globally unique.
// Uses 4 bytes (32 bits) of entropy and verifies no same-named job file exists (re-draw on collision), to avoid overwriting an old job's
// .json/.log and corrupting status/result.
export function generateJobId(model) {
  const prefix = String(model).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
  for (let i = 0; i < 50; i++) {
    const id = `${prefix}-${randomBytes(4).toString("hex")}`;
    if (!fs.existsSync(jobFile(id))) return id;
  }
  // Extreme case (nearly impossible): fall back to a longer suffix
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

// Atomic write: tmp + rename. **Private** — any job state change must go through the state-machine API below
// (createRunningJob / markRunning / backfill=patchIfActive / heartbeat / finalizeJob),
// all of which go through transition() for locking + terminal-state absorption. No raw job-state writes from outside the module.
function writeJob(record) {
  ensureJobsDir();
  const file = jobFile(record.id);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

export function readJob(id) {
  const file = jobFile(id);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function listJobs() {
  ensureJobsDir();
  const ids = fs
    .readdirSync(JOBS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5));
  const jobs = [];
  for (const id of ids) {
    const job = readJob(id);
    if (job) {
      jobs.push(job);
    }
  }
  return jobs.sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")));
}

// job id resolution: exact → unique prefix. Throws on ambiguity / not found.
export function resolveJobRef(reference, predicate = () => true) {
  const jobs = listJobs().filter(predicate);
  if (!reference) {
    return jobs[0] ?? null;
  }
  const exact = jobs.find((j) => j.id === reference);
  if (exact) {
    return exact;
  }
  const matches = jobs.filter((j) => j.id.startsWith(reference));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`job reference "${reference}" is not unique, please use a longer job-id`);
  }
  return null;
}

// Create the initial record in the **queued** state (dispatched, waiting for the thread lock). When __run-job acquires the lock and actually
// starts, markRunning() flips it to running and resets started_at to the start moment — wall-clock isn't counted during queuing.
export function createRunningJob({
  id,
  pid,
  model,
  client,
  effort,
  thread_key,
  session_id = null,
  claude_session = null,
  cwd,
  timeout_ms = null, // no execution time limit by default; only set when a cap is explicitly opted into
  seq = null,
  // Backend identity (durable): continue uses these to lock onto the original backend, immune to later remapping of the model alias.
  provider = null,
  model_id = null,
  protocol = null,
  wire_api = null,
  native = false
}) {
  const ts = nowIso();
  const record = {
    id,
    status: "queued",
    pid,
    pid_token: null,
    client_pid_token: null,
    seq,
    model,
    client,
    effort,
    provider,
    model_id,
    protocol,
    wire_api,
    native,
    thread_key,
    session_id,
    claude_session,
    cwd,
    timeout_ms,
    started_at: ts,
    last_heartbeat: ts,
    exit_code: null,
    error: null
  };
  writeJob(record);
  return record;
}

// One lock per job, serializing the read-modify-write of "state transitions".
function jobLockName(id) {
  return `job-${id}`;
}

// ───────────────────────── Sole write entry point for the state machine ─────────────────────────
// All job state changes must go through here. Invariants (structurally guaranteed, no discipline needed at each call site):
//   1) Read-modify-write inside the lock: concurrent changes to the same job are serialized, eliminating stale overwrites.
//   2) Terminal-state absorption: once a job enters a terminal state (done/failed/timeout/killed/crashed), any subsequent transition
//      returns it as-is without modification — the first to set a terminal state wins, and cancel won't be revived by a late finalize.
//   3) If apply(cur) returns a new record, write it; if it returns null, don't write.
// The only exception is createRunningJob (creation, no prior state), which is the job's first write.
function transition(id, apply) {
  return withLock(jobLockName(id), () => {
    const cur = readJob(id);
    if (!cur) return null;
    if (isTerminal(cur.status)) return cur; // terminal-state absorption
    const next = apply(cur);
    if (!next) return cur;
    writeJob(next);
    return next;
  });
}

// queued → running: called when entering the thread lock and actually starting, resetting started_at/last_heartbeat to
// the start moment (time spent queuing for the lock isn't counted in wall-clock). Doesn't flip if already terminal (canceled while queued).
export function markRunning(id) {
  return transition(id, (cur) => {
    const ts = nowIso();
    return { ...cur, status: "running", started_at: ts, last_heartbeat: ts };
  });
}

// Backfill non-terminal fields (pid / client_pid etc.): only written in active state, terminal states aren't revived.
export function patchIfActive(id, patch) {
  return transition(id, (cur) => ({ ...cur, ...patch }));
}

// Periodic runner heartbeat: only updates last_heartbeat in active state, terminal states aren't revived.
export function heartbeat(id) {
  return transition(id, (cur) => ({ ...cur, last_heartbeat: nowIso() }));
}

// Set terminal state (the sole entry point for runner wrap-up / cancel / cleanup / assess timeout·crashed).
// Also **strips _exec** (which holds run parameters and sensitive fields, not retained long-term). Terminal-state absorption is guaranteed by transition.
// patch may carry status/exit_code/error/session_id/result_text.
export function finalizeJob(id, patch = {}) {
  return transition(id, (cur) => {
    const { _exec, ...rest } = cur;
    return { ...rest, ...patch, pid: null, last_heartbeat: nowIso() };
  });
}

// Liveness check — three layered tactics, returns the assessed view (may write back crashed/timeout).
// Doesn't touch already-written terminal states like done/failed/killed.
export function assessJob(job, opts = {}) {
  const now = opts.now ?? Date.now();
  // Already terminal: return directly, with staleness info attached for rendering
  if (isTerminal(job.status)) {
    return { ...job, suspectedStuck: false };
  }

  // queued: waiting for the thread lock, **no wall-clock timeout** (hasn't started yet).
  // Only judge crashed when the runner pid has been **truly backfilled** (pid>0 with identity) yet is no longer alive — otherwise
  // a pid still at placeholder 0 (just created, runner hasn't backfilled) would be misjudged crashed by a concurrent status and a valid job lost.
  if (job.status === "queued") {
    if (job.pid > 0 && !aliveAndOurs(job.pid, job.pid_token)) {
      terminateTreeIfOurs(job.client_pid, job.client_pid_token, { signal: "SIGKILL" });
      const updated = finalizeJob(job.id, {
        status: "crashed",
        error: job.error ?? "process exited while queued (suspected hard crash)"
      });
      return { ...(updated ?? job), suspectedStuck: false };
    }
    return { ...job, suspectedStuck: false };
  }

  if (job.status !== "running") {
    return { ...job, suspectedStuck: false };
  }

  // 1. wall-clock timeout fallback — ONLY when a cap was explicitly opted into (job.timeout_ms set).
  // By default there is no execution time limit, so this check is skipped and a long-running agent is
  // never killed for "running too long" (it's still killed on crash (#2), cancel, or session end).
  // When a cap IS set: kill the process tree first (runner + client are independent groups) before marking
  // terminal, else a stuck runner gets marked terminal while the client keeps running orphaned.
  const startedMs = Date.parse(job.started_at ?? "");
  const timeoutMs = job.timeout_ms;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && Number.isFinite(startedMs) && now - startedMs > timeoutMs) {
    terminateTreeIfOurs(job.client_pid, job.client_pid_token, { signal: "SIGKILL" });
    terminateTreeIfOurs(job.pid, job.pid_token, { signal: "SIGKILL" });
    const updated = finalizeJob(job.id, {
      status: "timeout",
      error: job.error ?? `wall-clock timeout (>${Math.round(timeoutMs / 1000)}s), process tree killed`
    });
    return { ...(updated ?? job), suspectedStuck: false };
  }

  // 2. pid liveness probe: status==running but the runner process is dead (or the PID was reused, not the original one) → crashed.
  // The runner is dead but the client may still be alive (orphaned) → also kill the client subtree (after verifying identity) to eliminate orphans.
  if (!aliveAndOurs(job.pid, job.pid_token)) {
    terminateTreeIfOurs(job.client_pid, job.client_pid_token, { signal: "SIGKILL" });
    const updated = finalizeJob(job.id, {
      status: "crashed",
      error: job.error ?? "process exited but no terminal state was written (suspected hard crash)"
    });
    return { ...(updated ?? job), suspectedStuck: false };
  }

  // 3. Heartbeat freshness: no movement beyond the threshold → mark "suspected stuck" (doesn't change status, just hints it can be canceled)
  const hbMs = Date.parse(job.last_heartbeat ?? job.started_at ?? "");
  const suspectedStuck = Number.isFinite(hbMs) && now - hbMs > HEARTBEAT_STALE_MS;
  return { ...job, suspectedStuck };
}

// Get active jobs (queued/running) that are still active after the liveness check.
export function listActiveJobs() {
  return listJobs()
    .map((j) => assessJob(j))
    .filter((j) => isActive(j.status));
}

// Get active (queued/running) jobs by claude_session (used by SessionEnd cleanup).
export function listRunningBySession(claudeSession) {
  return listJobs().filter((j) => isActive(j.status) && j.claude_session === claudeSession);
}

// Unowned active jobs (claude_session is empty) — when the last active session ends
// and no session can claim them, SessionEnd uses this to clean them up and avoid leaks.
export function listRunningUnowned() {
  return listJobs().filter((j) => isActive(j.status) && !j.claude_session);
}

// Current list of active sessions (used by SessionEnd to decide "is this the last one"), already self-healed by TTL filtering.
export function activeSessions() {
  return activeIds();
}

export { PIGEON_HOME, JOBS_DIR };
