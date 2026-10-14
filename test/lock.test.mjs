// Lock no-deadline path: a non-finite timeout (Infinity) means "wait indefinitely" and must not
// hang on a free lock nor be clamped by any timer. A finite timeout still times out on contention.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquireLock } from "../scripts/lib/lock.mjs";

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pigeon-lock-"));
  process.env.PIGEON_HOME = home;
  return home;
}

test("acquireLock(Infinity): returns immediately on a free lock (no hang, no timer clamp)", () => {
  const home = freshHome();
  try {
    const release = acquireLock("t", { timeoutMs: Infinity });
    assert.equal(typeof release, "function");
    release();
    // re-acquire after release still works
    const r2 = acquireLock("t", { timeoutMs: Infinity });
    assert.equal(typeof r2, "function");
    r2();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("acquireLock(finite): still times out on a held lock", () => {
  const home = freshHome();
  try {
    const held = acquireLock("t", { timeoutMs: Infinity });
    assert.throws(
      () => acquireLock("t", { timeoutMs: 50 }),
      (e) => /timed out/.test(e.message)
    );
    held();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
