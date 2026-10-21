import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../packages/core/src/store.mjs";
import { descriptorPath } from "../packages/core/src/runtime.mjs";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../packages/cli/src/index.mjs", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pigeon-cli-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
const readline = require('node:readline');
const id = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume')+1] : 'mock-session';
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
let first=true, steer='', timer;
send({type:'system',subtype:'init',session_id:id});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);
 if(x.type==='control_request') {
  send({type:'control_response',response:{subtype:'success',request_id:x.request_id,response:{}}});
  if(x.request?.subtype==='interrupt') {clearTimeout(timer);send({type:'result',subtype:'error_during_execution',is_error:true,errors:['interrupted'],result:'interrupted',session_id:id});}
  return;
 }
 if(x.type!=='user')return;
 const text=typeof x.message.content==='string'?x.message.content:JSON.stringify(x.message.content);
 if(!first){steer=text;send({...x});return;}
 first=false;
 send({...x});
 send({type:'assistant',message:{id:'toolmsg',content:[{type:'tool_use',id:'tool1',name:'Bash',input:{command:'sleep'}}]}});
 timer=setTimeout(()=>{
  send({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool1',content:'tool complete',is_error:false}]}});
  const answer='DONE '+text+' '+steer;
  send({type:'assistant',message:{id:'answer',content:[{type:'text',text:answer}]}});
  send({type:'result',subtype:'success',is_error:false,result:answer,session_id:id});
 },text.includes('slow')?3000:100);
});
`, { mode: 0o755 });
  const mockBin = path.join(bin, "claude");
  const root = path.join(dir, "state");
  const env = { ...process.env, PIGEON_HOME: root, PIGEON_CLAUDE_BIN: mockBin,
    PIGEON_STARTUP_TIMEOUT_MS: "6000", PIGEON_RUNNER_RPC_TIMEOUT_MS: "2000",
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: path.join(dir, "claude-home") };
  delete env.CLAUDECODE;
  t.after(async () => {
    if (fs.existsSync(path.join(root, "state.db"))) {
      const store = new Store(root);
      let executions;
      try { executions = store.listExecutions({ limit: 100 }); } finally { store.close(); }
      for (const execution of executions) {
        if (fs.existsSync(descriptorPath(root, execution.id)) && execution.pid) {
          try { process.kill(execution.pid, "SIGTERM"); } catch {}
        }
        await until(() => !fs.existsSync(descriptorPath(root, execution.id))).catch(() => {
          if (execution.pid) { try { process.kill(execution.pid, "SIGKILL"); } catch {} }
        });
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, env, root, mockBin,
    run(args, extraEnv = {}) {
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 15000 });
      let data;
      try { data = JSON.parse(result.stdout); } catch {}
      return { ...result, data };
    },
  };
}
async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  for (;;) {
    const result = fn();
    if (result) return result;
    if (Date.now() > end) throw new Error("Condition timed out");
    await pause(80);
  }
}

test("standalone background execution supports steer, history, results and resume", async (t) => {
  const f = fixture(t);
  const started = f.run(["run", "--runner", "claude", "--background", "--json", "--", "slow original"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const { session_id: session, execution_id: execution } = started.data;
  assert.match(session, /^pgs_/);
  assert.match(execution, /^pge_/);
  assert.equal(started.data.status, "running");
  const steer = f.run(["steer", execution, "--json", "--", "UNIQUE_STEER"]);
  assert.equal(steer.status, 0, steer.stdout + steer.stderr);
  const waited = f.run(["wait", execution, "--json"]);
  assert.equal(waited.status, 0, waited.stdout + waited.stderr);
  assert.match(waited.data.result, /UNIQUE_STEER/);
  assert.ok(waited.data.started_at);
  const messages = f.run(["messages", session, "-n", "2", "--raw"]);
  assert.equal(messages.status, 0, messages.stdout);
  assert.equal(messages.data.messages.length, 2);
  const events = f.run(["events", execution, "--json"]);
  assert.equal(events.status, 0, events.stderr);
  const parsedEvents = events.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(parsedEvents.every((event) => event.execution_id === execution));
  assert.equal(parsedEvents.filter((event) => event.type === "input" && event.data.kind === "steer" && event.data.status === "accepted").length, 1);
  const continued = f.run(["resume", session, "--json", "--", "follow up"]);
  assert.equal(continued.status, 0, continued.stdout + continued.stderr);
  assert.equal(continued.data.session_id, session);
  assert.notEqual(continued.data.id, execution);
  const late = f.run(["steer", execution, "--json", "--", "too late"]);
  assert.equal(late.status, 1);
  assert.match(late.data.error.message, /already completed/);
});

test("concurrent resume is rejected and execution cancellation preserves session identity", async (t) => {
  const f = fixture(t);
  const first = f.run(["run", "--runner", "claude", "--json", "--", "first"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const session = first.data.session_id;
  const next = f.run(["resume", session, "--background", "--json", "--", "slow second"]);
  assert.equal(next.status, 0, next.stdout + next.stderr);
  const execution = next.data.execution_id;
  assert.equal(next.data.status, "running");
  const competing = f.run(["resume", session, "--background", "--json", "--", "third"]);
  assert.equal(competing.status, 1);
  const canceled = f.run(["cancel", execution, "--json"]);
  assert.equal(canceled.status, 0, canceled.stdout + canceled.stderr);
  const end = f.run(["wait", execution, "--json"]);
  assert.equal(end.data.status, "canceled", end.stdout + end.stderr);
  assert.equal(end.status, 130);
});

for (const failure of ["runner-error", "disconnect", "missing-executable"]) {
  test(`background startup ${failure} returns nonzero JSON with durable IDs and status`, async t => {
    const f = fixture(t);
    let extraEnv = {};
    if (failure === "missing-executable") {
      extraEnv.PIGEON_CLAUDE_BIN = path.join(f.dir, "does-not-exist");
    } else {
      fs.writeFileSync(f.mockBin, `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).once('line', () => {
  ${failure === "runner-error"
    ? "process.stdout.write(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:'mock initialization denied'})+'\\n');"
    : "process.exit(42);"}
});
`, { mode: 0o755 });
    }
    const failed = f.run(["run", "--runner", "claude", "--background", "--json", "--", "task"], extraEnv);
    assert.equal(failed.error, undefined, failed.error?.message);
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
    assert.match(failed.data.session_id, /^pgs_/);
    assert.match(failed.data.execution_id, /^pge_/);
    const expected = failure === "disconnect" ? "unknown" : "failed";
    assert.equal(failed.data.status, expected);
    const code = failure === "runner-error" ? "RUNNER_ERROR" : failure === "disconnect" ? "RUNNER_DISCONNECTED" : "RUNNER_PROCESS_ERROR";
    assert.equal(failed.data.error.code, code);
    if (failure === "missing-executable") assert.match(failed.data.error.message, /ENOENT|not found|unavailable|spawn/i);
    if (failure === "runner-error") assert.match(failed.data.error.message, /mock initialization denied/);
    const store = new Store(f.root);
    try {
      const persisted = store.getExecution(failed.data.execution_id);
      assert.equal(persisted.status, expected);
      assert.equal(persisted.session_id, failed.data.session_id);
      assert.equal(store.listEvents(persisted.id).filter(event => event.type === "finished").length, 1);
    } finally { store.close(); }
    await until(() => !fs.existsSync(descriptorPath(f.root, failed.data.execution_id)));
  });
}

test("CLI rejects removed commands and excludes them from help", (t) => {
  const f = fixture(t);
  const help = f.run(["--help"]);
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /legacy|scripts\/pigeon\.mjs/);
  for (const command of ["legacy", "work", "continue", "list", "config-set", "cleanup"]) {
    const result = f.run([command, "--json"]);
    assert.equal(result.status, 1);
    assert.match(result.data.error.message, /Unknown command/);
  }
});

test("CLI rejects unknown options and ambiguous task inputs", (t) => {
  const f = fixture(t);
  for (const args of [
    ["run", "--runner", "claude", "--provider-typo", "x", "--json", "--", "task"],
    ["resume", "pgs_test", "--runner", "codex", "--json", "--", "task"],
    ["messages", "pgs_test", "-n", "-1", "--raw"],
    ["run", "--runner", "claude", "--stdin", "--json", "--", "duplicate"],
  ]) assert.equal(f.run(args).status, 1);
});
