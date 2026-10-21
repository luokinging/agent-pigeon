import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../packages/core/src/store.mjs";
import { control, descriptorPath } from "../packages/core/src/runtime.mjs";

const CLI = fileURLToPath(new URL("../packages/cli/src/index.mjs", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 6000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() >= end) throw new Error("Runtime regression condition timed out");
    await pause(20);
  }
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pigeon-runtime-"));
  const root = path.join(dir, "state");
  const bin = path.join(dir, "mock-claude.cjs");
  const gate = path.join(dir, "release");
  const received = path.join(dir, "received");
  const runnerPid = path.join(dir, "runner-pid");
  const a = path.join(dir, "a"), b = path.join(dir, "nested", "b");
  fs.mkdirSync(a); fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(process.env.RUNTIME_RUNNER_PID, String(process.pid));
const sid = 'runtime-fixture-session';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const init = {type:'system', subtype:'init', session_id:sid};
const result = {type:'result', subtype:'success', session_id:sid, result:'completed fixture'};
let first = true;
readline.createInterface({input:process.stdin}).on('line', line => {
  const value = JSON.parse(line);
  if (value.type === 'control_request') {
    // Deliberately never send the RPC acknowledgement: terminal is authoritative.
    send({type:'result', subtype:'error_during_execution', is_error:true, errors:['interrupted']});
    return;
  }
  if (value.type !== 'user') return;
  if (!first) { send(value); return; }
  first = false;
  fs.writeFileSync(process.env.RUNTIME_RECEIVED, 'received');
  const task = value.message.content;
  if (task === 'gated' || task === 'gated-hold') {
    const timer = setInterval(() => {
      if (!fs.existsSync(process.env.RUNTIME_GATE)) return;
      clearInterval(timer);
      // Deliver initialization and completion in the same transport frame.
      process.stdout.write(JSON.stringify(init)+'\\n'+(task === 'gated' ? JSON.stringify(result)+'\\n' : ''));
    }, 10);
  } else {
    send(init);
    if (task !== 'hold') send(result);
  }
});
`, { mode: 0o755 });
  const env = {
    ...process.env,
    PIGEON_HOME: root,
    PIGEON_CLAUDE_BIN: bin,
    PIGEON_RUNNER_RPC_TIMEOUT_MS: "3000",
    PIGEON_STARTUP_TIMEOUT_MS: "6000",
    CLAUDE_CONFIG_DIR: path.join(dir, "claude-home"),
    RUNTIME_GATE: gate,
    RUNTIME_RECEIVED: received,
    RUNTIME_RUNNER_PID: runnerPid,
  };
  const executions = new Set();
  const children = new Set();
  function latest() {
    if (!fs.existsSync(path.join(root, "state.db"))) return undefined;
    const store = new Store(root);
    try {
      const execution = store.listExecutions({ limit: 1 })[0];
      if (execution) executions.add(execution.id);
      return execution;
    } finally { store.close(); }
  }
  function spawnCommand(args, extraEnv = {}, cwd = a) {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const pending = { child, stdout: "", stderr: "", settled: false };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { pending.stdout += chunk; });
    child.stderr.on("data", chunk => { pending.stderr += chunk; });
    pending.done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => {
        pending.settled = true;
        children.delete(child);
        let data;
        try { data = JSON.parse(pending.stdout); } catch {}
        if (data?.execution_id) executions.add(data.execution_id);
        resolve({ status, signal, data, stdout: pending.stdout, stderr: pending.stderr });
      });
    });
    return pending;
  }
  function read(id) {
    const store = new Store(root);
    try { return store.getExecution(id); } finally { store.close(); }
  }
  function run(args, cwd = a, extraEnv = {}) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 8000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const data = JSON.parse(result.stdout);
    if (data.execution_id) executions.add(data.execution_id);
    return data;
  }
  t.after(async () => {
    latest();
    fs.writeFileSync(gate, "release");
    for (const child of children) child.kill("SIGTERM");
    for (const id of executions) {
      const execution = read(id);
      if (fs.existsSync(descriptorPath(root, id)) && execution.pid) {
        try { process.kill(execution.pid, "SIGTERM"); } catch {}
      }
      await until(() => !fs.existsSync(descriptorPath(root, id))).catch(() => {
        if (execution.pid) { try { process.kill(execution.pid, "SIGKILL"); } catch {} }
      });
    }
    if (fs.existsSync(runnerPid)) {
      try { process.kill(Number(fs.readFileSync(runnerPid, "utf8")), "SIGKILL"); } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { root, gate, received, runnerPid, a, b, run, read, latest, spawnCommand,
    start(task) { return run(["run", "--runner", "claude", "--background", "--json", "--", task]); },
    async terminal(id) { return until(() => {
      const value = read(id);
      return ["completed", "canceled", "failed", "unknown"].includes(value.status) && value;
    }); },
    async cleaned(id) { await until(() => !fs.existsSync(descriptorPath(root, id))); },
  };
}

test("startup SIGTERM preserves a terminal result received with runner initialization", { timeout: 15000 }, async t => {
  const f = fixture(t);
  const pending = f.spawnCommand(["run", "--runner", "claude", "--background", "--json", "--", "gated"]);
  await until(() => fs.existsSync(f.received));
  const starting = f.latest();
  assert.equal(starting.status, "starting");
  process.kill(starting.pid, "SIGTERM");
  // Allow the worker's signal callback to run while runner initialization is gated.
  await pause(100);
  assert.equal(pending.settled, false, pending.stdout + pending.stderr);
  assert.equal(pending.stdout, "", "run must not publish IDs before runner readiness");
  assert.equal(f.read(starting.id).status, "starting");
  assert.ok(fs.existsSync(descriptorPath(f.root, starting.id)));
  fs.writeFileSync(f.gate, "release");
  const started = await pending.done;
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.equal(started.data.execution_id, starting.id);
  assert.equal(started.data.status, "completed");
  const result = f.read(starting.id);
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.result, "completed fixture");
  await f.cleaned(starting.id);
});

for (const mode of ["run", "resume"]) {
  test(`${mode} waits for runner initialization and immediately accepts steer and cancel`, { timeout: 15000 }, async t => {
    const f = fixture(t);
    let session;
    if (mode === "resume") {
      const first = f.start("fast");
      session = first.session_id;
      await f.terminal(first.execution_id);
      await f.cleaned(first.execution_id);
      fs.rmSync(f.received);
    }
    const args = mode === "run" ? ["run", "--runner", "claude"] : ["resume", session];
    const pending = f.spawnCommand([...args, "--background", "--json", "--", "gated-hold"]);
    await until(() => fs.existsSync(f.received));
    const starting = f.latest();
    assert.equal(starting.status, "starting");
    await pause(100);
    assert.equal(pending.settled, false, pending.stdout + pending.stderr);
    assert.equal(pending.stdout, "");
    fs.writeFileSync(f.gate, "release");
    const started = await pending.done;
    assert.equal(started.status, 0, started.stdout + started.stderr);
    assert.equal(started.data.execution_id, starting.id);
    assert.equal(started.data.session_id, session || starting.session_id);
    assert.equal(started.data.status, "running");
    const steered = f.run(["steer", started.data.execution_id, "--json", "--", "immediate steering"]);
    assert.equal(steered.status, "accepted");
    const canceled = f.run(["cancel", started.data.execution_id, "--json"]);
    assert.equal(canceled.confirmed, true);
    assert.equal((await f.terminal(starting.id)).status, "canceled");
    await f.cleaned(starting.id);
  });
}

test("startup timeout retains unknown outcome and IDs, blocks resume and cleans processes", { timeout: 15000 }, async t => {
  const f = fixture(t);
  const first = f.start("fast");
  await f.terminal(first.execution_id);
  await f.cleaned(first.execution_id);
  fs.rmSync(f.received);
  const pending = f.spawnCommand(["resume", first.session_id, "--background", "--json", "--", "gated-hold"], {
    PIGEON_STARTUP_TIMEOUT_MS: "1000",
    PIGEON_RUNNER_RPC_TIMEOUT_MS: "2000",
  });
  await until(() => fs.existsSync(f.received));
  const starting = f.latest();
  const runnerPid = Number(fs.readFileSync(f.runnerPid, "utf8"));
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath(f.root, starting.id), "utf8"));
  const failed = await pending.done;
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  assert.equal(failed.data.session_id, first.session_id);
  assert.equal(failed.data.execution_id, starting.id);
  assert.equal(failed.data.status, "unknown");
  assert.match(failed.data.error.message, /startup|ready|initializ|timed?\s*out|timeout/i);
  assert.equal(f.read(starting.id).status, "unknown");
  await f.cleaned(starting.id);
  await until(() => {
    try { process.kill(starting.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
  });
  await until(() => {
    try { process.kill(runnerPid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
  });
  assert.equal(fs.existsSync(path.dirname(descriptor.socket)), false);
  assert.equal(f.read(starting.id).status, "unknown", "cleanup must not overwrite uncertainty with cancellation");
  const resumed = await f.spawnCommand(["resume", first.session_id, "--background", "--json", "--", "must not run"]).done;
  assert.notEqual(resumed.status, 0);
  assert.match(resumed.data.error.message, /unknown|reconcil/i);
  assert.equal(f.latest().id, starting.id, "rejected resume must not create another execution");
});

test("resume with a removed saved cwd fails definitively and succeeds after cwd restoration", { timeout: 15000 }, async t => {
  const f = fixture(t);
  const first = f.start("fast");
  await f.terminal(first.execution_id);
  await f.cleaned(first.execution_id);
  fs.rmSync(f.a, { recursive: true });
  const failed = await f.spawnCommand(["resume", first.session_id, "--background", "--json", "--", "fast"], {}, f.b).done;
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.equal(failed.data.error.code, "ENOENT");
  assert.equal(failed.data.session_id, first.session_id);
  assert.match(failed.data.execution_id, /^pge_/);
  assert.notEqual(failed.data.execution_id, first.execution_id);
  assert.equal(failed.data.status, "failed");
  const persisted = f.read(failed.data.execution_id);
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.pid, null, "a worker that failed to spawn must never acquire execution ownership");
  assert.equal(fs.existsSync(descriptorPath(f.root, persisted.id)), false);
  fs.mkdirSync(f.a);
  const resumed = f.run(["resume", first.session_id, "--background", "--json", "--", "fast"], f.b);
  assert.equal(resumed.session_id, first.session_id);
  assert.notEqual(resumed.execution_id, failed.data.execution_id);
  assert.equal((await f.terminal(resumed.execution_id)).status, "completed");
  await f.cleaned(resumed.execution_id);
});

for (const status of ["completed", "failed"]) {
  test(`startup deadline preserves an externally recorded ${status} outcome`, { timeout: 15000 }, async t => {
    const f = fixture(t);
    const pending = f.spawnCommand(["run", "--runner", "claude", "--background", "--json", "--", "gated-hold"], {
      PIGEON_STARTUP_TIMEOUT_MS: "1000",
      PIGEON_RUNNER_RPC_TIMEOUT_MS: "3000",
    });
    await until(() => fs.existsSync(f.received));
    const starting = f.latest();
    const runnerPid = Number(fs.readFileSync(f.runnerPid, "utf8"));
    assert.equal(starting.status, "starting");
    assert.equal(pending.settled, false);
    const store = new Store(f.root);
    try {
      store.finishExecution(starting.id, status === "completed"
        ? { status, result: "externally confirmed completion" }
        : { status, error: "externally confirmed failure" });
    } finally { store.close(); }
    // Keep initialization gated through the parent's deadline: no ready/error IPC
    // can resolve launch before it reads the already durable terminal outcome.
    const returned = await pending.done;
    assert.equal(returned.status, status === "completed" ? 0 : 1, returned.stdout + returned.stderr);
    assert.equal(returned.data.execution_id, starting.id);
    assert.equal(returned.data.session_id, starting.session_id);
    assert.equal(returned.data.status, status);
    if (status === "failed") {
      assert.equal(returned.data.error.code, "STARTUP_EXIT");
      assert.equal(returned.data.error.message, "externally confirmed failure");
    }
    fs.writeFileSync(f.gate, "release");
    await f.cleaned(starting.id);
    for (const pid of [starting.pid, runnerPid]) {
      await until(() => {
        try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
      });
    }
    const persisted = f.read(starting.id);
    assert.equal(persisted.status, status);
    if (status === "completed") assert.equal(persisted.result, "externally confirmed completion");
    else assert.equal(persisted.error, "externally confirmed failure");
  });
}

test("cancel completes when terminal precedes the missing interrupt acknowledgement", { timeout: 15000 }, async t => {
  const f = fixture(t);
  const { execution_id: id } = f.start("hold");
  assert.equal(f.read(id).status, "running");
  const response = await control(id, "cancel", undefined, { root: f.root, timeout: 4000 });
  assert.equal(response.confirmed, true);
  assert.equal(response.status, "cancelled");
  assert.equal((await f.terminal(id)).status, "canceled");
  await f.cleaned(id);
  const store = new Store(f.root);
  try { assert.equal(store.listEvents(id).filter(event => event.type === "finished").length, 1); }
  finally { store.close(); }
});

test("relative PIGEON_HOME resumes from another cwd using the original state database", { timeout: 15000 }, async t => {
  const f = fixture(t);
  const first = f.run(["run", "--runner", "claude", "--background", "--json", "--", "fast"], f.a, { PIGEON_HOME: "../state" });
  assert.equal((await f.terminal(first.execution_id)).status, "completed");
  await f.cleaned(first.execution_id);
  const second = f.run(["resume", first.session_id, "--background", "--json", "--", "fast"], f.b, { PIGEON_HOME: "../../state" });
  assert.equal(second.session_id, first.session_id);
  assert.notEqual(second.execution_id, first.execution_id);
  assert.equal((await f.terminal(second.execution_id)).status, "completed");
  await f.cleaned(second.execution_id);
});

test("split UTF-8 steering is preserved and records one acceptance event", { timeout: 15000 }, async t => {
  const f = fixture(t);
  const { execution_id: id } = f.start("hold");
  assert.equal(f.read(id).status, "running");
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath(f.root, id), "utf8"));
  const text = "请继续中文任务";
  const messageId = "runtime-split-utf8";
  const frame = Buffer.from(JSON.stringify({ token: descriptor.token, action: "steer", text, messageId }) + "\n");
  const split = frame.indexOf(Buffer.from("请")) + 1;
  const response = await new Promise((resolve, reject) => {
    const socket = net.createConnection(descriptor.socket);
    let buffer = "", timer;
    const finish = (error, value) => {
      clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(4000, () => finish(new Error("Control response timeout")));
    socket.on("error", finish);
    socket.on("connect", () => {
      socket.write(frame.subarray(0, split));
      timer = setTimeout(() => socket.write(frame.subarray(split)), 50);
    });
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.includes("\n")) {
        try { finish(null, JSON.parse(buffer.slice(0, buffer.indexOf("\n")))); }
        catch (error) { finish(error); }
      }
    });
  });
  assert.equal(response.ok, true, response.error);
  const store = new Store(f.root);
  try {
    const accepted = store.listEvents(id).filter(event => event.type === "input" && event.data.id === messageId && event.data.status === "accepted");
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].data.text, text);
  } finally { store.close(); }
  await control(id, "cancel", undefined, { root: f.root, timeout: 4000 });
  await f.cleaned(id);
});
