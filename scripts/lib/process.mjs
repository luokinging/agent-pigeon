// Process primitives: detached background spawn, kill the whole process tree, kill -0 liveness probe.
// Adapted from codex lib/process.mjs's terminateProcessTree (process-group first).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

// kill -0: liveness probe only, sends no real signal. Returns true if pid is alive.
export function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: process exists but no permission (still counts as alive); ESRCH: does not exist.
    return error?.code === "EPERM";
  }
}

// Process identity token: distinguishes "same PID but already recycled/reused by the OS". Uses
// `ps -o lstart=,args=` -- start time + full command line. For pigeon's runner, args contain a unique
// job-id (node …/pigeon.mjs __run-job <id>), so even if a PID is reused within the same second, a
// differing command line tells them apart (collision-resistant). Store its token alongside the pid.
// Short retry to avoid an occasional ps failure leaving us without a token.
export function procToken(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (process.platform === "win32") return null; // win handled separately; POSIX is primary
  for (let i = 0; i < 3; i += 1) {
    const r = spawnSync("ps", ["-o", "lstart=,args=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true
    });
    if (!r.error && r.status === 0) {
      const s = (r.stdout || "").replace(/\s+/g, " ").trim();
      if (s) return s;
    }
    // Process does not exist → ps exits non-zero, return null directly (no retry needed)
    if (r.status != null && r.status !== 0) return null;
    // error (e.g. transient failure spawning ps) → retry after a short backoff
    if (i < 2) {
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

// For crash detection (fail-SAFE): is the pid "still alive and still the same process as before"?
// Falls back to bare isAlive when the token is missing -- better to not misjudge a live process as
// crashed (don't proactively declare death when the token is absent).
export function aliveAndOurs(pid, token) {
  if (!isAlive(pid)) return false;
  if (!token) return true;
  const cur = procToken(pid);
  return cur != null && cur === token;
}

// Used for killing / stealing locks. On POSIX, **fail-CLOSED**: must positively verify (token match)
// to count as ours; missing/mismatched is rejected, preferring not to kill (avoid killing the wrong
// process). Windows has no token mechanism → fall back to bare liveness (best-effort) -- otherwise
// fail-closed would let locks be stolen at will and make cancel/cleanup all no-ops. The PID-reuse
// hardening is POSIX-only.
export function verifiedOurs(pid, token) {
  if (!isAlive(pid)) return false;
  if (process.platform === "win32") return true; // Windows best-effort: no identity primitive, fall back to bare liveness
  if (!token) return false; // POSIX has a token mechanism but we didn't get one → fail-closed
  const cur = procToken(pid);
  return cur != null && cur === token;
}

// Only kill the process tree when **positively verified** to be the original process (skip on reuse / unverifiable, never kill an unrelated process).
export function terminateTreeIfOurs(pid, token, options = {}) {
  if (!verifiedOurs(pid, token)) {
    return { attempted: false, delivered: false, method: "skipped" };
  }
  return terminateProcessTree(pid, options);
}

// Whether the binary is available (self-check). Runs a probe command via spawnSync.
export function binaryAvailable(command, probeArgs = ["--help"], options = {}) {
  const result = spawnSync(command, probeArgs, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true
  });
  if (result.error?.code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  return { available: true, detail: (result.stdout || result.stderr || "ok").trim() };
}

// Background launch: detached + own process group (setsid semantics), stdout/stderr redirected to logFile.
// After the parent unrefs it can exit immediately while the child keeps running. Returns the pid.
export function spawnDetached(command, argv, { cwd, env, logFile } = {}) {
  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");
  const child = spawn(command, argv, {
    cwd,
    env,
    detached: true, // becomes its own process group (group id == child.pid), making whole-tree kill easy
    stdio: ["ignore", out, err],
    windowsHide: true
  });
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);
  if (!child.pid) {
    throw new Error(`failed to spawn ${command}`);
  }
  return child.pid;
}

function looksLikeMissingProcess(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

// Kill the whole process tree: a detached child is its own process group, so kill(-pid) hits the entire group.
// Falls back to a single pid on failure. Returns { attempted, delivered, method }.
export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return { attempted: false, delivered: false, method: null };
  }
  const platform = options.platform ?? process.platform;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const signal = options.signal ?? "SIGTERM";

  if (platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true
    });
    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill" };
    }
    const combined = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    if (!result.error && looksLikeMissingProcess(combined)) {
      return { attempted: true, delivered: false, method: "taskkill" };
    }
    // Fall back to single-process kill
    try {
      killImpl(pid);
      return { attempted: true, delivered: true, method: "kill" };
    } catch (error) {
      if (error?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "kill" };
      }
      throw error;
    }
  }

  // POSIX: hit the whole group first (negative pid)
  try {
    killImpl(-pid, signal);
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { attempted: true, delivered: false, method: "process-group" };
    }
    // Group kill failed (e.g. no group was formed) → fall back to single process
    try {
      killImpl(pid, signal);
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}
