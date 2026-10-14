// File lock: based on mkdir atomicity (O_EXCL semantics).
// Uses: config write lock (prevent concurrent-write corruption), serializing continue for the same
// thread_key (prevent corrupting thread history). The lock records the holder's pid + timestamp; a
// stale lock whose holding process is dead gets preempted (stale steal).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isAlive, procToken, verifiedOurs } from "./process.mjs";

// PIGEON_HOME takes precedence, aligned with config.mjs / jobs.mjs (otherwise locks and state land in different trees).
const LOCK_ROOT = path.join(process.env.PIGEON_HOME || path.join(os.homedir(), ".pigeon"), "locks");
const STALE_MS = 60_000; // a lock older than this whose holder is dead → preemptible
const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

function lockDir(name) {
  return path.join(LOCK_ROOT, `${name}.lock`);
}

function sleepSync(ms) {
  // Blocking sleep, acceptable in lock-wait scenarios (short critical sections)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

// Atomic acquire: mkdir the lock's own directory (EEXIST if it already exists).
function attemptMkdir(dir) {
  try {
    fs.mkdirSync(dir);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function ensureRoot() {
  fs.mkdirSync(LOCK_ROOT, { recursive: true });
}

function isStale(dir) {
  const meta = readLockMeta(dir);
  if (!meta) {
    // No meta: may be mid-write, fall back to mtime once
    try {
      const age = Date.now() - fs.statSync(dir).mtimeMs;
      return age > STALE_MS;
    } catch {
      return true;
    }
  }
  const age = Date.now() - (meta.acquiredAt ?? 0);
  // Positively verify the holder is "still the same process as before" → don't steal.
  if (meta.pid && verifiedOurs(meta.pid, meta.token)) {
    return false;
  }
  // Token missing but the holder's PID is still alive (perhaps a transient ps failure at acquire time
  // left no token) → grant an age-based grace: don't rip away a still-alive legitimate lock over a
  // single transient failure; only steal past STALE_MS (a safety net against real deadlocks).
  if (meta.pid && !meta.token && isAlive(meta.pid)) {
    return age > STALE_MS;
  }
  // Dead / PID reused (token mismatch) → stealable.
  return !meta.pid || age > 0 ? true : age > STALE_MS;
}

function steal(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// Acquire the lock, returns a release function. Throws on timeout.
export function acquireLock(name, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  ensureRoot();
  const dir = lockDir(name);
  // A non-finite timeoutMs (Infinity / null) means "wait indefinitely" — no deadline, just keep
  // polling until the lock is acquired or a dead holder is preempted. (No timer is involved here —
  // the loop sleeps a fixed POLL_MS — so there's no setTimeout(Infinity) clamping concern.)
  const hasDeadline = Number.isFinite(timeoutMs);
  const deadline = hasDeadline ? Date.now() + timeoutMs : Infinity;

  for (;;) {
    if (attemptMkdir(dir)) {
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ pid: process.pid, token: procToken(process.pid), acquiredAt: Date.now() }),
        "utf8"
      );
      let released = false;
      return () => {
        if (released) return;
        released = true;
        steal(dir);
      };
    }

    // Didn't get it: stale lock (holder dead) → preempt
    if (isStale(dir)) {
      steal(dir);
      continue;
    }

    if (hasDeadline && Date.now() >= deadline) {
      const meta = readLockMeta(dir);
      throw new Error(
        `lock "${name}" busy${meta?.pid ? ` (held by pid ${meta.pid})` : ""}; timed out after ${timeoutMs}ms`
      );
    }
    sleepSync(POLL_MS);
  }
}

// Execute fn synchronously under lock protection.
export function withLock(name, fn, options = {}) {
  const release = acquireLock(name, options);
  try {
    return fn();
  } finally {
    release();
  }
}

export const CONFIG_LOCK = "config";

// Same-thread serialization lock name: derived from thread_key.
export function threadLockName(threadKey) {
  return `thread-${threadKey}`;
}
