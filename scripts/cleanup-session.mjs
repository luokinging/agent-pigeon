#!/usr/bin/env node
// SessionEnd hook: when the main session ends, kill the process trees of all running pigeon jobs spawned by this session.
// Leave no orphans. The main session id is read from the hook stdin JSON or from an environment variable.
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  activeSessions,
  addActiveSession,
  executionStillLive,
  finalizeJob,
  listRunningBySession,
  listRunningUnowned,
  removeActiveSession
} from "./lib/jobs.mjs";
import { terminateTreeIfOurs } from "./lib/process.mjs";

const SESSION_ID_ENV = "CLAUDE_SESSION_ID";
const PIGEON_SESSION_ID_ENV = "PIGEON_SESSION_ID";

function killJob(job, reason) {
  // The client has already exited (task finished, runner wrapping up) → don't preempt; let the runner
  // write the real result (done/failed), otherwise we'd lose a result that finished "right as the session closed".
  // Returns false to indicate nothing was killed.
  if (!executionStillLive(job)) return false;
  // Still running: first claim the terminal state (killed; terminal-state absorption beats the runner's close wrap-up), then verify identity before killing the process (skipped if reused).
  finalizeJob(job.id, { status: "killed", error: reason });
  terminateTreeIfOurs(job.client_pid, job.client_pid_token, { signal: "SIGKILL" });
  terminateTreeIfOurs(job.pid, job.pid_token, { signal: "SIGTERM" });
  return true;
}

// Kill all running jobs with claude_session == sessionId; when opts.alsoUnowned=true, additionally kill
// all unowned running jobs (claude_session empty) — pass this only when this is the last active session,
// at which point no session can claim them, so killing neither leaks nor accidentally kills another session's job.
export function cleanupSession(sessionId, opts = {}) {
  const killed = [];
  const targets = [];
  if (sessionId) targets.push(...listRunningBySession(sessionId));
  if (opts.alsoUnowned) targets.push(...listRunningUnowned());
  const seen = new Set();
  for (const job of targets) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    const reason =
      sessionId && job.claude_session === sessionId
        ? "Main session ended, auto cleanup"
        : "Unowned job cleaned up when the last session ended";
    if (killJob(job, reason)) killed.push(job.id);
  }
  return killed;
}

// Write PIGEON_SESSION_ID into Claude Code's per-session env file ($CLAUDE_ENV_FILE);
// afterwards every command subprocess of *this session* carries it → work gets its own correct session id,
// and concurrent sessions don't cross-contaminate (official mechanism, same as codex). If the env file is
// unavailable, silently skip (falling back to the active-sessions single-session heuristic).
function exportSessionIdToEnvFile(sessionId) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile || !sessionId) return;
  const escaped = `'${String(sessionId).replace(/'/g, `'\\''`)}'`;
  try {
    fs.appendFileSync(envFile, `export ${PIGEON_SESSION_ID_ENV}=${escaped}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

// Read the main session id from the hook stdin (JSON, field session_id); on failure fall back to env vars.
async function readSessionIdFromStdin() {
  if (process.stdin.isTTY) {
    return null;
  }
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed.session_id ?? parsed.sessionId ?? null;
  } catch {
    return null;
  }
}

async function main() {
  // The hook mode is given by argv[2]: SessionStart | SessionEnd (defaults to SessionEnd).
  const mode = process.argv[2] || "SessionEnd";
  const fromStdin = await readSessionIdFromStdin();
  // stdin takes priority; otherwise use the PIGEON_SESSION_ID that SessionStart wrote into $CLAUDE_ENV_FILE
  // (accurate for this session), then fall back to CLAUDE_SESSION_ID.
  const sessionId =
    fromStdin ?? process.env[PIGEON_SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;

  if (mode === "SessionStart") {
    // 1) Write the per-session env file so this session's work subprocesses get the correct PIGEON_SESSION_ID.
    // 2) Register into the active set (single-session fallback when the env file is unavailable + detecting the "last session").
    if (sessionId) {
      exportSessionIdToEnvFile(sessionId);
      addActiveSession(sessionId);
    }
    process.stdout.write(`pigeon: session ${sessionId ?? "?"} registered\n`);
    return;
  }

  // SessionEnd: determine the session id to end. When stdin/env don't provide one, if there's *exactly one
  // active session*, we can safely infer it (single-session case, no misjudgment); when several are active, don't guess.
  let endId = sessionId;
  if (!endId) {
    const act = activeSessions();
    if (act.length === 1) endId = act[0];
  }
  // "Is this the last session" = no other active session remains besides endId (computed *before* deregistering).
  const lastSession = activeSessions().filter((s) => s !== endId).length === 0;
  if (!endId && !lastSession) {
    process.stdout.write("pigeon cleanup: no session id and multiple active sessions, skipping (to avoid wrongful kills)\n");
    return;
  }
  // Clean up first (jobs can still be found by session id at this point), then deregister — if the hook crashes
  // between the two steps, the session marker remains, so a later SessionEnd can still rediscover and clean them up; nothing ever leaks permanently.
  const killed = cleanupSession(endId, { alsoUnowned: lastSession });
  if (endId) removeActiveSession(endId);
  process.stdout.write(`pigeon cleanup: killed ${killed.length} running job(s)\n`);
}

// Run main only when executed directly as a script (when imported, only cleanupSession is exported).
// Use pathToFileURL to escape the path correctly (so install dirs with spaces/special chars still match),
// otherwise a bare `file://${argv[1]}` would never be equal under a plugin path with spaces → the hook silently fails.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`pigeon cleanup error: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
