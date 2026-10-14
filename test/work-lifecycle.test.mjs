// work lifecycle with the mock client:
//   done / failed (crash) / crashed (hard-crash) / timeout (hang) / killed (cancel).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  sampleConfig,
  makeHome,
  writeConfigFile,
  runPigeon,
  parseJobId,
  readJobFile,
  waitForJob,
  listJobIds,
  sleep,
} from "./helpers.mjs";

function setup() {
  const h = makeHome();
  writeConfigFile(h.pigeonHome, sampleConfig());
  return h;
}

test("work returns a job-id immediately and does not block; runs to done", async () => {
  const h = setup();
  try {
    const t0 = Date.now();
    const r = runPigeon(["work", "--model", "glm-5.2", "--", "hello world"], { home: h.home });
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 0, r.stderr);
    const id = parseJobId(r.stdout);
    assert.ok(id, `expected a job-id in: ${r.stdout}`);
    // Non-blocking: the foreground command returns fast (well under client run).
    assert.ok(elapsed < 4000, `work should return promptly, took ${elapsed}ms`);

    const job = await waitForJob(h.pigeonHome, id, (j) => j.status === "done");
    assert.equal(job.status, "done");
    assert.equal(job.exit_code, 0);
    assert.equal(job.result_text, "claude mock done");
    // _exec scratch field must be stripped on finalize.
    assert.equal(job._exec, undefined);

    // result command surfaces the text.
    const res = runPigeon(["result", id], { home: h.home });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /claude mock done/);
  } finally {
    h.cleanup();
  }
});

test("run (foreground): prints the model result inline, exits 0, creates NO job file", () => {
  const h = setup();
  try {
    const r = runPigeon(["run", "--model", "glm-5.2", "--", "hello"], {
      home: h.home,
      env: { MOCK_RESULT: "INLINE-RESULT-OK" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /INLINE-RESULT-OK/);
    assert.equal(listJobIds(h.pigeonHome).length, 0, "foreground run must not create a job file");
  } finally {
    h.cleanup();
  }
});

test("run (foreground): non-zero client exit -> non-zero status + friendly error", () => {
  const h = setup();
  try {
    const r = runPigeon(["run", "--model", "glm-5.2", "--", "x"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "authfail" },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /authentication/);
    assert.equal(listJobIds(h.pigeonHome).length, 0);
  } finally {
    h.cleanup();
  }
});

test("crash: client exits non-zero -> status=failed with error", async () => {
  const h = setup();
  try {
    const r = runPigeon(["work", "--model", "glm-5.2", "--", "boom"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "crash" },
    });
    const id = parseJobId(r.stdout);
    const job = await waitForJob(h.pigeonHome, id, (j) => j.status !== "running" && j.status !== "queued");
    assert.equal(job.status, "failed");
    assert.ok(job.error && job.error.length > 0, "failed job must carry an error");
  } finally {
    h.cleanup();
  }
});

test("authfail stderr maps to an auth-friendly error", async () => {
  const h = setup();
  try {
    const r = runPigeon(["work", "--model", "glm-5.2", "--", "x"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "authfail" },
    });
    const id = parseJobId(r.stdout);
    const job = await waitForJob(h.pigeonHome, id, (j) => j.status !== "running" && j.status !== "queued");
    assert.equal(job.status, "failed");
    assert.match(job.error, /authentication/);
  } finally {
    h.cleanup();
  }
});

test("netfail stderr maps to a connectivity-friendly error", async () => {
  const h = setup();
  try {
    const r = runPigeon(["work", "--model", "glm-5.2", "--", "x"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "netfail" },
    });
    const id = parseJobId(r.stdout);
    const job = await waitForJob(h.pigeonHome, id, (j) => j.status !== "running" && j.status !== "queued");
    assert.equal(job.status, "failed");
    assert.match(job.error, /network/);
  } finally {
    h.cleanup();
  }
});

test("chatonly stderr (codex on a Chat-Completions-only endpoint) maps to an actionable error", async () => {
  const h = setup();
  try {
    const r = runPigeon(["work", "--model", "gpt-5-codex", "--", "x"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "chatonly" },
    });
    const id = parseJobId(r.stdout);
    const job = await waitForJob(h.pigeonHome, id, (j) => j.status !== "running" && j.status !== "queued");
    assert.equal(job.status, "failed");
    // Must name the real cause (Chat-Completions-only / Responses API) and point to the anthropic client,
    // not just echo codex's cryptic "missing field `models`".
    assert.match(job.error, /Chat.?Completions|Responses API/i);
    assert.match(job.error, /anthropic|claude/i);
  } finally {
    h.cleanup();
  }
});

test("hard crash: child SIGKILLed, no terminal state written -> status assessed as crashed", async () => {
  const h = setup();
  try {
    const pidFile = path.join(h.pigeonHome, "hardcrash.pid");
    const r = runPigeon(["work", "--model", "glm-5.2", "--", "hardcrash"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hardcrash", MOCK_HARDCRASH_PIDFILE: pidFile },
    });
    const id = parseJobId(r.stdout);

    // Wait until the job is running and the runner pid is recorded.
    const running = await waitForJob(
      h.pigeonHome,
      id,
      (j) => j.status === "running" && j.pid && j.pid > 0
    );
    assert.equal(running.status, "running");

    // SIGKILL the runner process group so it can never write a terminal state.
    // (-pid hits the detached process group: runner + the mock client child.)
    try {
      process.kill(-running.pid, "SIGKILL");
    } catch {
      try {
        process.kill(running.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // Give the OS a moment to reap.
    await sleep(300);

    // The job file is still "running" with a dead pid. status command must
    // assess it as crashed (pid probe in assessJob).
    const beforeStatus = readJobFile(h.pigeonHome, id);
    assert.equal(beforeStatus.status, "running", "runner died without writing terminal state");

    const st = runPigeon(["status", id], { home: h.home });
    assert.equal(st.status, 0, st.stderr);
    assert.match(st.stdout, /crashed/);
    // And the assessment is persisted back.
    const after = readJobFile(h.pigeonHome, id);
    assert.equal(after.status, "crashed");
  } finally {
    h.cleanup();
  }
});

test("timeout is OPT-IN: with PIGEON_TIMEOUT_MS set, a hanging client is wall-clock killed -> status=timeout", async () => {
  const h = setup();
  try {
    // There is no default execution time limit. A cap applies only when opted into — here via the
    // PIGEON_TIMEOUT_MS env override consumed by the runtime.
    const r = runPigeon(["work", "--model", "glm-5.2", "--", "hang"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang", PIGEON_TIMEOUT_MS: "1000" },
    });
    const id = parseJobId(r.stdout);
    const job = await waitForJob(
      h.pigeonHome,
      id,
      (j) => j.status === "timeout",
      { timeoutMs: 12000 }
    );
    assert.equal(job.status, "timeout", `expected timeout, got ${job && job.status}`);
    assert.match(job.error || "", /timeout/);
  } finally {
    h.cleanup();
  }
});

test("no time limit by default: a hanging client keeps running (no timeout_ms, never auto-killed)", async () => {
  const h = setup();
  try {
    // No PIGEON_TIMEOUT_MS and no configured timeout_ms → unlimited. The job persists timeout_ms=null and
    // stays running; it is NOT killed for "running too long".
    const r = runPigeon(["work", "--model", "glm-5.2", "--", "hang"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang" },
    });
    const id = parseJobId(r.stdout);
    const running = await waitForJob(h.pigeonHome, id, (j) => j.status === "running" && j.pid > 0);
    assert.equal(running.timeout_ms, null, "no cap is applied by default");

    // Re-assess after a beat — still running, never flipped to timeout.
    await new Promise((res) => setTimeout(res, 2500));
    const after = readJobFile(h.pigeonHome, id);
    assert.equal(after.status, "running", `expected still running, got ${after && after.status}`);

    runPigeon(["cancel", id], { home: h.home }); // clean up the hang
  } finally {
    h.cleanup();
  }
});

test("cancel: running job is killed -> status=killed, process tree gone", async () => {
  const h = setup();
  try {
    const pidFile = path.join(h.pigeonHome, "cancel.pid");
    const r = runPigeon(["work", "--model", "glm-5.2", "--", "long"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang", MOCK_HARDCRASH_PIDFILE: pidFile },
    });
    const id = parseJobId(r.stdout);
    await waitForJob(h.pigeonHome, id, (j) => j.status === "running" && j.pid > 0);
    // wait until the client child recorded its pid
    let clientPid = null;
    for (let i = 0; i < 100 && !clientPid; i++) {
      if (fs.existsSync(pidFile)) clientPid = Number(fs.readFileSync(pidFile, "utf8").trim());
      else await sleep(50);
    }

    const c = runPigeon(["cancel", id], { home: h.home });
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /killed/);

    const job = readJobFile(h.pigeonHome, id);
    assert.equal(job.status, "killed");

    // Give signals time to propagate, then assert the client child is gone.
    await sleep(400);
    if (clientPid) {
      let alive = true;
      try {
        process.kill(clientPid, 0);
      } catch {
        alive = false;
      }
      assert.equal(alive, false, `client child pid ${clientPid} should be dead after cancel`);
    }
  } finally {
    h.cleanup();
  }
});
