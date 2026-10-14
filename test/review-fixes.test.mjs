// Regression coverage for the codex-review fixes:
//  P1  assessJob() must kill runner+client process trees before marking timeout.
//  P2  config-set must refuse to overwrite a hand-broken config.json.
//  P2  SessionStart hook must persist the main session id for later cleanup.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { procToken } from "../scripts/lib/process.mjs";

import {
  makeHome,
  sampleConfig,
  writeConfigFile,
  runPigeon,
  runCleanup,
  jobsDir,
  readJobFile,
  waitForJob,
} from "./helpers.mjs";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn a detached long sleeper (its own process group, like a real client/runner).
function sleeper(seconds = 30) {
  const c = spawn("sleep", [String(seconds)], { detached: true, stdio: "ignore" });
  c.unref();
  return c.pid;
}

test("P1: assessJob kills runner+client trees before marking a wedged job timeout", async () => {
  const h = setup();
  const runner = sleeper(30);
  const client = sleeper(30);
  try {
    const id = "glm-5.2-wedged";
    const rec = {
      id,
      status: "running",
      pid: runner, // runner alive (wedged) — NOT dead, so it's the timeout branch, not crashed
      pid_token: procToken(runner),
      client_pid: client,
      client_pid_token: procToken(client),
      model: "glm-5.2",
      client: "claude",
      effort: "high",
      thread_key: "tk",
      session_id: "s",
      claude_session: null,
      cwd: h.home,
      started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
      last_heartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      timeout_ms: 1000, // already exceeded
      exit_code: null,
      error: null,
    };
    fs.mkdirSync(jobsDir(h.pigeonHome), { recursive: true });
    fs.writeFileSync(path.join(jobsDir(h.pigeonHome), `${id}.json`), JSON.stringify(rec));

    // /pigeon:status invokes assessJob.
    const r = runPigeon(["status", id], { home: h.home });
    assert.equal(r.status, 0, r.stderr);

    const job = readJobFile(h.pigeonHome, id);
    assert.equal(job.status, "timeout", "wedged job must be marked timeout");

    // both trees must be gone (no orphan client)
    for (let i = 0; i < 40 && (alive(runner) || alive(client)); i++) await wait(50);
    assert.equal(alive(runner), false, "runner tree must be killed");
    assert.equal(alive(client), false, "client tree must be killed (no orphan)");
  } finally {
    try { process.kill(-runner, "SIGKILL"); } catch {}
    try { process.kill(-client, "SIGKILL"); } catch {}
    h.cleanup();
  }
});

test("P2: config-set refuses to overwrite a hand-broken config.json", () => {
  const h = setup();
  try {
    const cfgPath = path.join(h.pigeonHome, "config.json");
    fs.writeFileSync(cfgPath, "{ this is not json ::::"); // hand-broken
    const before = fs.readFileSync(cfgPath, "utf8");

    const payload = JSON.stringify(sampleConfig());
    const r = runPigeon(["config-set", "--json", payload], { home: h.home });

    assert.notEqual(r.status, 0, "must fail rather than silently overwrite");
    assert.match(r.stderr, /parse|refused|hand-broken/, "error must explain the refusal");
    assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "broken file must be preserved untouched");
  } finally {
    h.cleanup();
  }
});

test("P2: SessionStart registers an active session; sole active session tags new work", async () => {
  const h = setup();
  try {
    const r = runCleanup(["SessionStart"], {
      home: h.home,
      input: JSON.stringify({ session_id: "sess-ONE" }),
    });
    assert.equal(r.status, 0, r.stderr);
    const af = path.join(h.pigeonHome, "active-sessions.json");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(af, "utf8")).map((e) => e.id),
      ["sess-ONE"]
    );

    // work has no CLAUDE_SESSION_ID env -> falls back to the sole active session.
    const w = runPigeon(["work", "--model", "glm-5.2", "--", "x"], {
      home: h.home,
      env: { MOCK_RESULT: "ok" },
    });
    const id = w.stdout.match(/job\s+([^\s(]+)/)[1];
    const job = await waitForJob(h.pigeonHome, id, (j) => j.status === "done");
    assert.equal(job.claude_session, "sess-ONE", "sole active session must tag the job");
  } finally {
    h.cleanup();
  }
});

test("P2: with two active sessions, new work is tagged null (no cross-session attribution)", async () => {
  const h = setup();
  try {
    runCleanup(["SessionStart"], { home: h.home, input: JSON.stringify({ session_id: "sess-A" }) });
    runCleanup(["SessionStart"], { home: h.home, input: JSON.stringify({ session_id: "sess-B" }) });

    const w = runPigeon(["work", "--model", "glm-5.2", "--", "x"], {
      home: h.home,
      env: { MOCK_RESULT: "ok" },
    });
    const id = w.stdout.match(/job\s+([^\s(]+)/)[1];
    const job = await waitForJob(h.pigeonHome, id, (j) => j.status === "done");
    assert.equal(job.claude_session, null, "ambiguous (2 active) must not guess a session");
  } finally {
    h.cleanup();
  }
});

test("P2: config-set merges a partial patch (does not delete untouched providers/models)", () => {
  const h = setup(); // starts with full sampleConfig on disk
  try {
    // partial patch: only change zhipu's api_key
    const patch = JSON.stringify({ providers: { zhipu: { api_key: "rotated-key" } } });
    const r = runPigeon(["config-set", "--json", patch], { home: h.home });
    assert.equal(r.status, 0, r.stderr);

    const cfg = JSON.parse(fs.readFileSync(path.join(h.pigeonHome, "config.json"), "utf8"));
    assert.equal(cfg.providers.zhipu.api_key, "rotated-key", "patched field applied");
    assert.ok(cfg.providers.zhipu.base_url.anthropic, "untouched zhipu.base_url preserved");
    assert.ok(cfg.providers.openai, "untouched openai provider preserved");
    assert.ok(cfg.models["glm-5.2"], "untouched models preserved");
  } finally {
    h.cleanup();
  }
});

test("P2: per-model timeout_ms in config is honoured (not the 600s default)", async () => {
  const h = makeHome();
  try {
    const cfg = sampleConfig();
    cfg.models["glm-5.2"].timeout_ms = 1200; // tiny, config-driven
    writeConfigFile(h.pigeonHome, cfg);

    // hang forever; only the config timeout can end it (no PIGEON_TIMEOUT_MS env).
    const r = runPigeon(["work", "--model", "glm-5.2", "--", "hang"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang" },
    });
    assert.equal(r.status, 0, r.stderr);
    const id = r.stdout.match(/job\s+([^\s(]+)/)[1];

    // Must flip to timeout well within a few seconds (proving ~1.2s config, not 600s).
    const job = await waitForJob(h.pigeonHome, id, (j) => j.status === "timeout", { timeoutMs: 6000 });
    assert.equal(job.status, "timeout", "config timeout_ms must drive the wall-clock kill");
  } finally {
    h.cleanup();
  }
});

test("P2: continue on a still-running codex job is rejected (session id not stable yet)", async () => {
  const h = setup();
  try {
    // codex's resume session id is only known after completion -> reject while running.
    const base = runPigeon(["work", "--model", "gpt-5-codex", "--client", "codex", "--", "hang"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang" },
    });
    const baseId = base.stdout.match(/job\s+([^\s(]+)/)[1];
    await waitForJob(h.pigeonHome, baseId, (j) => j.status === "running" && j.pid > 0);

    const cont = runPigeon(["continue", baseId, "--", "more"], { home: h.home });
    assert.notEqual(cont.status, 0, "codex continue must wait for the base to be done");
    assert.match(cont.stderr, /after the task completes|done/);

    runPigeon(["cancel", baseId], { home: h.home });
  } finally {
    h.cleanup();
  }
});

test("P1: continue on a still-running claude job is allowed (queued behind it via thread lock)", async () => {
  const h = setup();
  try {
    // claude pins --session-id up front, so a follow-up can queue behind a running job.
    const base = runPigeon(["work", "--model", "glm-5.2", "--", "hang"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang" },
    });
    const baseId = base.stdout.match(/job\s+([^\s(]+)/)[1];
    await waitForJob(h.pigeonHome, baseId, (j) => j.status === "running" && j.pid > 0);

    const cont = runPigeon(["continue", baseId, "--", "more"], { home: h.home });
    assert.equal(cont.status, 0, cont.stderr); // accepted, not rejected
    const contId = cont.stdout.match(/job\s+([^\s(]+)/)[1];
    // the queued continuation exists and is not terminal yet (waiting on the lock)
    const q = readJobFile(h.pigeonHome, contId);
    assert.ok(q && (q.status === "queued" || q.status === "running"), "continuation should be active/queued");

    runPigeon(["cancel", baseId], { home: h.home });
    runPigeon(["cancel", contId], { home: h.home });
  } finally {
    h.cleanup();
  }
});

test("SessionStart writes 'export PIGEON_SESSION_ID' into $CLAUDE_ENV_FILE", () => {
  const h = setup();
  try {
    const envFile = path.join(h.home, "claude-env");
    fs.writeFileSync(envFile, "");
    const r = runCleanup(["SessionStart"], {
      home: h.home,
      env: { CLAUDE_ENV_FILE: envFile },
      input: JSON.stringify({ session_id: "sess-ENV" }),
    });
    assert.equal(r.status, 0, r.stderr);
    const written = fs.readFileSync(envFile, "utf8");
    assert.match(written, /export PIGEON_SESSION_ID='sess-ENV'/, "per-session id must be exported to env file");
  } finally {
    h.cleanup();
  }
});

test("work prefers PIGEON_SESSION_ID env for job ownership", async () => {
  const h = setup();
  try {
    const w = runPigeon(["work", "--model", "glm-5.2", "--", "x"], {
      home: h.home,
      env: { PIGEON_SESSION_ID: "sess-PIGEON", MOCK_RESULT: "ok" },
    });
    const id = w.stdout.match(/job\s+([^\s(]+)/)[1];
    const job = await waitForJob(h.pigeonHome, id, (j) => j.status === "done");
    assert.equal(job.claude_session, "sess-PIGEON");
  } finally {
    h.cleanup();
  }
});

test("SessionEnd of the last session also reaps unowned running jobs (no leak)", async () => {
  const h = setup();
  try {
    // No session vars and no active sessions -> job is unowned (claude_session null).
    const r = runPigeon(["work", "--model", "glm-5.2", "--", "hang"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang" },
    });
    const id = r.stdout.match(/job\s+([^\s(]+)/)[1];
    const running = await waitForJob(h.pigeonHome, id, (j) => j.status === "running" && j.pid > 0);
    assert.equal(running.claude_session, null, "job should be unowned");

    // SessionEnd with no active sessions => this is the last session => reap unowned.
    const clean = runCleanup(["SessionEnd"], {
      home: h.home,
      input: JSON.stringify({ session_id: "sess-LAST" }),
    });
    assert.equal(clean.status, 0, clean.stderr);
    const job = await waitForJob(h.pigeonHome, id, (j) => j.status === "killed", { timeoutMs: 4000 });
    assert.equal(job.status, "killed", "unowned job must be reaped when the last session ends");
  } finally {
    h.cleanup();
  }
});

test("continue assesses base liveness: a hard-crashed base is rejected, not queued", async () => {
  const h = setup();
  const dead = sleeper(30);
  try {
    // kill the would-be runner so its pid is dead
    try { process.kill(dead, "SIGKILL"); } catch {}
    await wait(150);

    // craft a job that still says "running" on disk but whose runner pid is dead
    const id = "glm-5.2-deadbase";
    const rec = {
      id, status: "running", pid: dead, client_pid: null,
      model: "glm-5.2", client: "claude", effort: "high",
      thread_key: "tk", session_id: "11111111-1111-1111-1111-111111111111",
      claude_session: null, cwd: h.home,
      started_at: new Date().toISOString(), last_heartbeat: new Date().toISOString(),
      timeout_ms: 600000, exit_code: null, error: null,
    };
    fs.mkdirSync(jobsDir(h.pigeonHome), { recursive: true });
    fs.writeFileSync(path.join(jobsDir(h.pigeonHome), `${id}.json`), JSON.stringify(rec));

    const cont = runPigeon(["continue", id, "--", "more"], { home: h.home });
    assert.notEqual(cont.status, 0, "continue must reject a crashed base, not queue a doomed resume");
    assert.match(cont.stderr, /crashed|cannot be continued/);
    // and the assessment got persisted
    const after = readJobFile(h.pigeonHome, id);
    assert.equal(after.status, "crashed");
  } finally {
    h.cleanup();
  }
});

test("continue survives later model config edits (historical client/effort still resumable)", async () => {
  const h = setup();
  try {
    const base = runPigeon(["work", "--model", "glm-5.2", "--", "base"], {
      home: h.home,
      env: { MOCK_RESULT: "ok" },
    });
    const baseId = base.stdout.match(/job\s+([^\s(]+)/)[1];
    await waitForJob(h.pigeonHome, baseId, (j) => j.status === "done");

    // user edits the model AFTER the job: drops 'claude' from clients and changes effort list
    const cfg = sampleConfig();
    cfg.models["glm-5.2"].clients = ["codex"]; // claude no longer listed
    cfg.models["glm-5.2"].effort = ["low"]; // 'high' no longer listed
    writeConfigFile(h.pigeonHome, cfg);

    // continue must still resume the old claude thread despite the config drift
    const cont = runPigeon(["continue", baseId, "--", "more"], { home: h.home });
    assert.equal(cont.status, 0, cont.stderr);
  } finally {
    h.cleanup();
  }
});

test("P2: provider api key is never serialized into the job file", async () => {
  const h = makeHome();
  try {
    const cfg = sampleConfig();
    cfg.providers.zhipu.api_key = "SECRET-DO-NOT-PERSIST";
    writeConfigFile(h.pigeonHome, cfg);

    const r = runPigeon(["work", "--model", "glm-5.2", "--", "hang"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang" },
    });
    const id = r.stdout.match(/job\s+([^\s(]+)/)[1];
    await waitForJob(h.pigeonHome, id, (j) => j.status === "running" && j.pid > 0);

    const raw = fs.readFileSync(path.join(jobsDir(h.pigeonHome), `${id}.json`), "utf8");
    assert.doesNotMatch(raw, /SECRET-DO-NOT-PERSIST/, "api key must not appear in the job file");
    const job = JSON.parse(raw);
    assert.equal(job._exec?.apiKey, undefined, "_exec must not carry the api key");

    runPigeon(["cancel", id], { home: h.home });
  } finally {
    h.cleanup();
  }
});

test("P2: task via --stdin preserves apostrophes/quotes/newlines byte-for-byte", async () => {
  const h = setup();
  try {
    const touch = path.join(h.pigeonHome, "task.txt");
    const task = "don't `rm` \"x\" $VAR\n  keep   indent\nline3";
    const r = runPigeon(["work", "--model", "glm-5.2", "--stdin"], {
      home: h.home,
      env: { MOCK_TOUCH: touch },
      input: task + "\n", // heredoc adds a trailing newline; pigeon strips exactly one
    });
    assert.equal(r.status, 0, r.stderr);
    const id = r.stdout.match(/job\s+([^\s(]+)/)[1];
    await waitForJob(h.pigeonHome, id, (j) => j.status === "done");
    const got = fs.readFileSync(touch, "utf8");
    // mock writes "claude <session-id> <prompt>\n"; the prompt must contain our task verbatim.
    assert.ok(got.includes(task), `stdin task must reach the client unchanged; got: ${JSON.stringify(got)}`);
  } finally {
    h.cleanup();
  }
});

test("P1: active-sessions self-heals stale entries (TTL), so lastSession is reachable", () => {
  const h = setup();
  try {
    const af = path.join(h.pigeonHome, "active-sessions.json");
    // two stale entries (older than the 48h TTL) that nobody removed
    const old = new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString();
    fs.writeFileSync(af, JSON.stringify([{ id: "stale-A", at: old }, { id: "stale-B", at: old }]));

    // a fresh SessionStart should prune the stale ones while adding its own
    const r = runCleanup(["SessionStart"], {
      home: h.home,
      input: JSON.stringify({ session_id: "fresh-1" }),
    });
    assert.equal(r.status, 0, r.stderr);
    const ids = JSON.parse(fs.readFileSync(af, "utf8")).map((e) => e.id);
    assert.deepEqual(ids, ["fresh-1"], "stale entries pruned; only the fresh one remains");
  } finally {
    h.cleanup();
  }
});

test("FIFO: same-thread jobs execute in submission order (not lock-race order)", async () => {
  const h = setup();
  try {
    const order = path.join(h.pigeonHome, "order.txt"); // mock appends the prompt on start
    const a = runPigeon(["work", "--model", "glm-5.2", "--", "AAA"], {
      home: h.home,
      env: { MOCK_TOUCH: order, MOCK_DELAY_MS: "300" },
    });
    const b = runPigeon(["work", "--model", "glm-5.2", "--", "BBB"], {
      home: h.home,
      env: { MOCK_TOUCH: order, MOCK_DELAY_MS: "300" },
    });
    const idA = a.stdout.match(/job\s+([^\s(]+)/)[1];
    const idB = b.stdout.match(/job\s+([^\s(]+)/)[1];
    await waitForJob(h.pigeonHome, idA, (j) => j.status === "done", { timeoutMs: 12000 });
    await waitForJob(h.pigeonHome, idB, (j) => j.status === "done", { timeoutMs: 12000 });
    const txt = fs.readFileSync(order, "utf8");
    assert.ok(txt.indexOf("AAA") < txt.indexOf("BBB"), `A must run before B; got: ${JSON.stringify(txt)}`);
  } finally {
    h.cleanup();
  }
});

test("resume re-validation: continue fails if the base never reached 'done'", async () => {
  const h = setup();
  try {
    // claude base that hangs; continue is accepted (claude pins session id) and queues behind it.
    const base = runPigeon(["work", "--model", "glm-5.2", "--", "hang"], {
      home: h.home,
      env: { MOCK_BEHAVIOR: "hang" },
    });
    const baseId = base.stdout.match(/job\s+([^\s(]+)/)[1];
    await waitForJob(h.pigeonHome, baseId, (j) => j.status === "running" && j.pid > 0);

    const cont = runPigeon(["continue", baseId, "--", "more"], { home: h.home });
    assert.equal(cont.status, 0, cont.stderr);
    const contId = cont.stdout.match(/job\s+([^\s(]+)/)[1];

    // base is cancelled (ends 'killed', not 'done'); the queued continuation now gets its turn
    // and must refuse to resume a session that was never established.
    runPigeon(["cancel", baseId], { home: h.home });
    const job = await waitForJob(h.pigeonHome, contId, (j) => j.status === "failed", { timeoutMs: 8000 });
    assert.equal(job.status, "failed");
    assert.match(job.error || "", /session was not established|cannot continue/);
  } finally {
    h.cleanup();
  }
});

test("queued job with pid:0 (runner not yet backfilled) is NOT falsely crashed by status", () => {
  const h = setup();
  try {
    const id = "glm-5.2-q0";
    const now = new Date().toISOString();
    const rec = {
      id, status: "queued", pid: 0, pid_token: null, client_pid: null, client_pid_token: null,
      seq: 1, model: "glm-5.2", client: "claude", effort: "high", thread_key: "tk",
      session_id: "s", claude_session: null, cwd: h.home,
      started_at: now, last_heartbeat: now, timeout_ms: 600000, exit_code: null, error: null,
    };
    fs.mkdirSync(jobsDir(h.pigeonHome), { recursive: true });
    fs.writeFileSync(path.join(jobsDir(h.pigeonHome), `${id}.json`), JSON.stringify(rec));

    const r = runPigeon(["status", id], { home: h.home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJobFile(h.pigeonHome, id).status, "queued", "pid:0 queued job must stay queued, not crashed");
  } finally {
    h.cleanup();
  }
});

test("PID reuse: a running job whose pid_token no longer matches is crashed, NOT killed", async () => {
  const h = setup();
  const live = sleeper(30); // an unrelated, live process holding a (possibly reused) pid
  try {
    const id = "glm-5.2-reuse";
    const now = new Date().toISOString();
    const rec = {
      id, status: "running", pid: live, pid_token: "STALE-TOKEN-does-not-match", client_pid: null, client_pid_token: null,
      seq: 1, model: "glm-5.2", client: "claude", effort: "high", thread_key: "tk",
      session_id: "s", claude_session: null, cwd: h.home,
      started_at: now, last_heartbeat: now, timeout_ms: 600000, exit_code: null, error: null,
    };
    fs.mkdirSync(jobsDir(h.pigeonHome), { recursive: true });
    fs.writeFileSync(path.join(jobsDir(h.pigeonHome), `${id}.json`), JSON.stringify(rec));

    const r = runPigeon(["status", id], { home: h.home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJobFile(h.pigeonHome, id).status, "crashed", "token mismatch => treat as dead/crashed");
    await wait(150);
    assert.equal(alive(live), true, "the unrelated (reused-pid) process must NOT be killed");
  } finally {
    try { process.kill(live, "SIGKILL"); } catch {}
    h.cleanup();
  }
});

test("cancel refuses a finishing job (client already exited) so the real result is not clobbered", async () => {
  const h = setup();
  const runner = sleeper(30); // runner still alive (mid finalize)
  const deadClient = sleeper(30);
  try {
    process.kill(deadClient, "SIGKILL"); // client already exited
    await wait(150);

    const id = "glm-5.2-finishing";
    const now = new Date().toISOString();
    const rec = {
      id, status: "running", pid: runner, pid_token: procToken(runner),
      client_pid: deadClient, client_pid_token: "stale", seq: 1,
      model: "glm-5.2", client: "claude", effort: "high", thread_key: "tk",
      session_id: "s", claude_session: null, cwd: h.home,
      started_at: now, last_heartbeat: now, timeout_ms: 600000, exit_code: null, error: null,
    };
    fs.mkdirSync(jobsDir(h.pigeonHome), { recursive: true });
    fs.writeFileSync(path.join(jobsDir(h.pigeonHome), `${id}.json`), JSON.stringify(rec));

    const r = runPigeon(["cancel", id], { home: h.home });
    assert.notEqual(r.status, 0, "cancel must refuse a job whose client already exited");
    assert.match(r.stderr, /finalizing|cannot cancel/);
    assert.equal(readJobFile(h.pigeonHome, id).status, "running", "must not clobber to killed");
  } finally {
    try { process.kill(runner, "SIGKILL"); } catch {}
    h.cleanup();
  }
});

test("effort is optional: a no-effort model runs; passing --effort to it is rejected", async () => {
  const h = makeHome();
  try {
    const cfg = sampleConfig();
    cfg.models["noeffort"] = { provider: "zhipu", model_id: "NE-1", clients: ["claude"] }; // no effort key
    writeConfigFile(h.pigeonHome, cfg);

    const ok = runPigeon(["run", "--model", "noeffort", "--", "x"], {
      home: h.home,
      env: { MOCK_RESULT: "ran-without-effort" },
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /ran-without-effort/);

    const bad = runPigeon(["run", "--model", "noeffort", "--effort", "high", "--", "x"], { home: h.home });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /no configured effort|drop --effort/);
  } finally {
    h.cleanup();
  }
});

test("config-set accepts a model with no effort (effort is optional)", () => {
  const h = setup();
  try {
    const patch = JSON.stringify({
      providers: { acme: { protocols: ["anthropic"], base_url: { anthropic: "https://a" }, api_key: "k" } },
      models: { "acme-x": { provider: "acme", model_id: "AX", clients: ["claude"] } },
    });
    const r = runPigeon(["config-set", "--json", patch], { home: h.home });
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(fs.readFileSync(path.join(h.pigeonHome, "config.json"), "utf8"));
    assert.ok(cfg.models["acme-x"], "no-effort model must be saved");
    assert.equal(cfg.models["acme-x"].effort, undefined);
  } finally {
    h.cleanup();
  }
});

function setup() {
  const h = makeHome();
  writeConfigFile(h.pigeonHome, sampleConfig());
  return h;
}
