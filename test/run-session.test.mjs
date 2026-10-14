import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHome, sampleConfig, writeConfigFile, runPigeon, spawn, childEnv, PIGEON, sleep } from "./helpers.mjs";
const sessionId = (out) => out.match(/^Pigeon session: (run-[\da-f-]+)$/m)?.[1];
const recordPath = (h, id) => path.join(h.pigeonHome, "run-sessions", `${id}.json`);
for (const client of ["claude", "codex"]) {
  test(`run ${client}: first turn and follow-ups preserve session, cwd and backend identity`, (t) => {
    const h = makeHome(); t.after(h.cleanup);
    const config = sampleConfig(); writeConfigFile(h.pigeonHome, config);
    const capture = path.join(h.home, "capture.jsonl"); const env = { MOCK_CAPTURE: capture };
    const first = runPigeon(["run", "--model", "glm-5.2", "--client", client, "--", "first"], { home: h.home, env });
    assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, new RegExp(`${client} mock done`));
    const id = sessionId(first.stdout); assert.ok(id);
    const original = JSON.parse(fs.readFileSync(recordPath(h, id)));
    if (client === "codex") assert.equal(original.session_id, "codex-mock-session");
    else assert.match(original.session_id, /^[\da-f-]{36}$/);
    assert.notEqual(original.session_id, id);
    assert.ok(!fs.readFileSync(recordPath(h, id), "utf8").includes("zhipu-key"));
    config.models["glm-5.2"] = { provider: "openai", model_id: "different", clients: ["codex"] };
    config.providers.zhipu.api_key = "rotated-key"; writeConfigFile(h.pigeonHome, config);
    const other = path.join(h.home, "other"); fs.mkdirSync(other);
    for (const args of [["--", "second"], ["--stdin"]]) {
      const next = runPigeon(["run", "--session", id, ...args], { home: other, env: { ...env, HOME: h.home }, input: "third\n" });
      assert.equal(next.status, 0, next.stderr); assert.equal(sessionId(next.stdout), id);
    }
    const calls = fs.readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 3);
    for (const call of calls) assert.equal(call.cwd, fs.realpathSync(h.home));
    assert.equal(calls[1].key, "rotated-key");
    if (client === "claude") {
      assert.equal(calls[0].argv[calls[0].argv.indexOf("--session-id") + 1], original.session_id);
      assert.equal(calls[1].model, "GLM-5.2");
      assert.equal(calls[1].argv[calls[1].argv.indexOf("--resume") + 1], original.session_id);
    } else {
      assert.equal(calls[1].argv[calls[1].argv.indexOf("-m") + 1], "GLM-5.2");
      assert.ok(calls[1].argv.includes(original.session_id));
      assert.ok(calls[1].argv.includes('model_providers.pigeon.base_url="https://open.bigmodel.cn/api/paas/v4"'));
    }
    assert.equal(JSON.parse(fs.readFileSync(recordPath(h, id))).turns, 3);
  });
}
test("run rejects invalid, missing and override sessions without calling a client", (t) => {
  const h = makeHome(); t.after(h.cleanup); writeConfigFile(h.pigeonHome, sampleConfig());
  for (const id of ["../escape", "run-00000000-0000-0000-0000-000000000000"]) {
    const result = runPigeon(["run", "--session", id, "--", "hello"], { home: h.home });
    assert.equal(result.status, 1); assert.match(result.stderr, /invalid|not found/);
  }
  const result = runPigeon(["run", "--session", "anything", "--model", "glm-5.2", "--", "hello"], { home: h.home });
  assert.equal(result.status, 1); assert.match(result.stderr, /inherits/);
});
test("run failures and missing codex ID do not advertise or save successful sessions", (t) => {
  const h = makeHome(); t.after(h.cleanup); writeConfigFile(h.pigeonHome, sampleConfig());
  for (const env of [{ MOCK_BEHAVIOR: "crash" }, { MOCK_BEHAVIOR: "hang", PIGEON_TIMEOUT_MS: "100" }, { MOCK_NO_SESSION: "1" }]) {
    const result = runPigeon(["run", "--model", "glm-5.2", "--client", "codex", "--", "hello"], { home: h.home, env });
    assert.equal(result.status, 1); assert.equal(sessionId(result.stdout), undefined);
  }
  assert.ok(!fs.existsSync(path.join(h.pigeonHome, "run-sessions")));
  const first = runPigeon(["run", "--model", "glm-5.2", "--", "hello"], { home: h.home });
  const id = sessionId(first.stdout); const before = fs.readFileSync(recordPath(h, id), "utf8");
  const failed = runPigeon(["run", "--session", id, "--", "bad"], { home: h.home, env: { MOCK_BEHAVIOR: "crash" } });
  assert.equal(failed.status, 1); assert.equal(sessionId(failed.stdout), undefined);
  assert.equal(fs.readFileSync(recordPath(h, id), "utf8"), before);
  assert.equal(runPigeon(["run", "--session", id, "--", "retry"], { home: h.home }).status, 0);
});
test("run rejects concurrent turns on the same session and releases the lock", async (t) => {
  const h = makeHome(); t.after(h.cleanup); writeConfigFile(h.pigeonHome, sampleConfig());
  const first = runPigeon(["run", "--model", "glm-5.2", "--", "hello"], { home: h.home });
  const id = sessionId(first.stdout); const touch = path.join(h.home, "touch");
  const child = spawn(process.execPath, [PIGEON, "run", "--session", id, "--", "slow"], {
    cwd: h.home, env: childEnv(h.home, { MOCK_DELAY_MS: "700", MOCK_TOUCH: touch }), stdio: "ignore"
  });
  const ended = new Promise((resolve) => child.on("close", resolve));
  for (let i = 0; i < 100 && !fs.existsSync(touch); i++) await sleep(10);
  assert.ok(fs.existsSync(touch));
  const competing = runPigeon(["run", "--session", id, "--", "competing"], { home: h.home });
  assert.equal(competing.status, 1); assert.match(competing.stderr, /lock .* busy/);
  assert.equal(await ended, 0);
  assert.equal(runPigeon(["run", "--session", id, "--", "after"], { home: h.home }).status, 0);
});
