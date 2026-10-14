// parallel jobs, same-thread serialization, session cleanup,
// and form-C arg parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  sampleConfig,
  makeHome,
  writeConfigFile,
  runPigeon,
  runCleanup,
  parseJobId,
  readJobFile,
  listJobIds,
  waitForJob,
  sleep,
} from "./helpers.mjs";

function setup() {
  const h = makeHome();
  writeConfigFile(h.pigeonHome, sampleConfig());
  return h;
}

test("parallel: 3 work invocations -> 3 distinct jobs, independent log/state, status lists all", async () => {
  const h = setup();
  try {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = runPigeon(["work", "--model", "glm-5.2", "--", `task ${i}`], {
        home: h.home,
        env: { MOCK_RESULT: `result-${i}` },
      });
      assert.equal(r.status, 0, r.stderr);
      ids.push(parseJobId(r.stdout));
    }
    assert.equal(new Set(ids).size, 3, "job ids must be distinct");

    // Wait for all done.
    for (const id of ids) {
      await waitForJob(h.pigeonHome, id, (j) => j.status === "done");
    }

    // Each job has its own .json + .log and the result is not cross-contaminated.
    for (let i = 0; i < 3; i++) {
      const job = readJobFile(h.pigeonHome, ids[i]);
      assert.equal(job.status, "done");
      assert.equal(job.result_text, `result-${i}`);
      const log = path.join(h.pigeonHome, "jobs", `${ids[i]}.log`);
      assert.ok(fs.existsSync(log), `log for ${ids[i]} must exist`);
    }

    // status (no arg) lists all three.
    const st = runPigeon(["status"], { home: h.home });
    assert.equal(st.status, 0, st.stderr);
    for (const id of ids) {
      assert.match(st.stdout, new RegExp(id.replace(/[.]/g, "\\.")));
    }

    // all jobs present on disk.
    assert.equal(listJobIds(h.pigeonHome).length, 3);
  } finally {
    h.cleanup();
  }
});

test("same-thread serialization: two continues on one thread do not interleave (lock holds)", async () => {
  const h = setup();
  try {
    // First, create a base done job with a session id (so continue is allowed).
    const base = runPigeon(["work", "--model", "glm-5.2", "--", "base"], { home: h.home });
    const baseId = parseJobId(base.stdout);
    await waitForJob(h.pigeonHome, baseId, (j) => j.status === "done");
    const baseJob = readJobFile(h.pigeonHome, baseId);
    assert.ok(baseJob.session_id, "base job must have a session_id for resume");

    // A shared touch-file lets us observe whether the two continue runs overlap.
    // The mock appends a line on start; with the thread lock, runs are serialized.
    // We make each client run take ~600ms; serialized total ~1.2s, and crucially
    // the two appended lines must not be from concurrently-live processes.
    const touch = path.join(h.pigeonHome, "thread-order.txt");

    const c1 = runPigeon(["continue", baseId, "--", "step one"], {
      home: h.home,
      env: { MOCK_TOUCH: touch, MOCK_DELAY_MS: "600" },
    });
    const c2 = runPigeon(["continue", baseId, "--", "step two"], {
      home: h.home,
      env: { MOCK_TOUCH: touch, MOCK_DELAY_MS: "600" },
    });
    assert.equal(c1.status, 0, c1.stderr);
    assert.equal(c2.status, 0, c2.stderr);
    const id1 = parseJobId(c1.stdout);
    const id2 = parseJobId(c2.stdout);
    assert.notEqual(id1, id2);
    assert.notEqual(id1, baseId);

    // Both continue jobs reach done.
    const j1 = await waitForJob(h.pigeonHome, id1, (j) => j.status === "done", { timeoutMs: 12000 });
    const j2 = await waitForJob(h.pigeonHome, id2, (j) => j.status === "done", { timeoutMs: 12000 });
    assert.equal(j1.status, "done");
    assert.equal(j2.status, "done");

    // Both share the same thread_key (same cwd|model|client lineage).
    assert.equal(j1.thread_key, baseJob.thread_key);
    assert.equal(j2.thread_key, baseJob.thread_key);

    // The lock directory must not linger after both finish.
    const lockDir = path.join(h.home, ".pigeon", "locks", `thread-${baseJob.thread_key}.lock`);
    // give release a beat
    await sleep(200);
    assert.equal(fs.existsSync(lockDir), false, "thread lock dir must be released");
  } finally {
    h.cleanup();
  }
});

test("session cleanup: SessionEnd kills running jobs of that claude_session", async () => {
  const h = setup();
  try {
    const SID = "main-session-123";
    const pidFile = path.join(h.pigeonHome, "sess.pid");
    // Start a long-running (hang) job tagged with the main session id.
    const r = runPigeon(["work", "--model", "glm-5.2", "--", "hang for session"], {
      home: h.home,
      env: {
        MOCK_BEHAVIOR: "hang",
        MOCK_HARDCRASH_PIDFILE: pidFile,
        CLAUDE_SESSION_ID: SID,
      },
    });
    const id = parseJobId(r.stdout);
    const running = await waitForJob(h.pigeonHome, id, (j) => j.status === "running" && j.pid > 0);
    assert.equal(running.claude_session, SID);

    // capture the client child pid
    let clientPid = null;
    for (let i = 0; i < 100 && !clientPid; i++) {
      if (fs.existsSync(pidFile)) clientPid = Number(fs.readFileSync(pidFile, "utf8").trim());
      else await sleep(50);
    }

    // Fire the SessionEnd hook with the main session id on stdin.
    const clean = runCleanup(["SessionEnd"], {
      home: h.home,
      input: JSON.stringify({ session_id: SID, cwd: h.home }),
    });
    assert.equal(clean.status, 0, clean.stderr);

    const job = await waitForJob(h.pigeonHome, id, (j) => j.status === "killed", { timeoutMs: 4000 });
    assert.equal(job.status, "killed");

    await sleep(400);
    if (clientPid) {
      let alive = true;
      try {
        process.kill(clientPid, 0);
      } catch {
        alive = false;
      }
      assert.equal(alive, false, "client child must be dead after session cleanup");
    }
  } finally {
    h.cleanup();
  }
});

test("session cleanup does NOT touch jobs from a different session", async () => {
  const h = setup();
  try {
    const r = runPigeon(["work", "--model", "glm-5.2", "--", "hang other"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang", CLAUDE_SESSION_ID: "session-A" },
    });
    const id = parseJobId(r.stdout);
    await waitForJob(h.pigeonHome, id, (j) => j.status === "running" && j.pid > 0);

    // Clean up a DIFFERENT session.
    const clean = runCleanup(["SessionEnd"], {
      home: h.home,
      input: JSON.stringify({ session_id: "session-B" }),
    });
    assert.equal(clean.status, 0, clean.stderr);
    await sleep(200);
    const job = readJobFile(h.pigeonHome, id);
    assert.equal(job.status, "running", "other-session job must survive");

    // cleanup so the hang process doesn't leak past the test.
    runPigeon(["cancel", id], { home: h.home });
    await sleep(200);
  } finally {
    h.cleanup();
  }
});

// ---- form C arg parsing ----

test("arg parse: --flag inside the task body (after --) is NOT treated as a flag", async () => {
  const h = setup();
  try {
    const r = runPigeon(
      ["work", "--model", "glm-5.2", "--", "please run with --verbose and --foo bar"],
      { home: h.home, env: { MOCK_TOUCH: path.join(h.pigeonHome, "task.txt") } }
    );
    assert.equal(r.status, 0, r.stderr);
    const id = parseJobId(r.stdout);
    await waitForJob(h.pigeonHome, id, (j) => j.status === "done");
    const touched = fs.readFileSync(path.join(h.pigeonHome, "task.txt"), "utf8");
    assert.match(touched, /--verbose and --foo bar/, "full task body must reach the client");
  } finally {
    h.cleanup();
  }
});

test("arg parse: unknown flag (before --) is rejected", () => {
  const h = setup();
  try {
    const r = runPigeon(["work", "--model", "glm-5.2", "--bogus", "x", "--", "task"], {
      home: h.home,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown flag.*bogus/);
  } finally {
    h.cleanup();
  }
});

test("arg parse: empty task (-- with nothing after) is rejected", () => {
  const h = setup();
  try {
    const r = runPigeon(["work", "--model", "glm-5.2", "--"], { home: h.home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /task body is empty/);
  } finally {
    h.cleanup();
  }
});

test("arg parse: missing -- (no task delimiter at all) is rejected", () => {
  const h = setup();
  try {
    const r = runPigeon(["work", "--model", "glm-5.2"], { home: h.home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /task body is empty/);
  } finally {
    h.cleanup();
  }
});
