// Coverage for the codex client path (work + continue/resume) and render purity.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sampleConfig,
  makeHome,
  writeConfigFile,
  runPigeon,
  parseJobId,
  readJobFile,
  waitForJob,
} from "./helpers.mjs";

import { renderModelList, renderStatusList, renderResult, renderNativeProviders } from "../scripts/lib/render.mjs";
import claude from "../scripts/lib/clients/claude.mjs";
import codex from "../scripts/lib/clients/codex.mjs";

function setup() {
  const h = makeHome();
  writeConfigFile(h.pigeonHome, sampleConfig());
  return h;
}

test("codex work runs to done and parses JSONL result + session id", async () => {
  const h = setup();
  try {
    const r = runPigeon(["work", "--model", "gpt-5-codex", "--client", "codex", "--", "do codex"], {
      home: h.home,
      env: { MOCK_RESULT: "codex result text" },
    });
    assert.equal(r.status, 0, r.stderr);
    const id = parseJobId(r.stdout);
    const job = await waitForJob(h.pigeonHome, id, (j) => j.status === "done");
    assert.equal(job.status, "done");
    assert.equal(job.result_text, "codex result text");
    assert.equal(job.session_id, "codex-mock-session");
  } finally {
    h.cleanup();
  }
});

test("codex continue resumes the prior session (codex supports resume)", async () => {
  const h = setup();
  try {
    const base = runPigeon(["work", "--model", "gpt-5-codex", "--", "base codex"], { home: h.home });
    const baseId = parseJobId(base.stdout);
    await waitForJob(h.pigeonHome, baseId, (j) => j.status === "done");

    const cont = runPigeon(["continue", baseId, "--", "more codex"], { home: h.home });
    assert.equal(cont.status, 0, cont.stderr);
    const contId = parseJobId(cont.stdout);
    const job = await waitForJob(h.pigeonHome, contId, (j) => j.status === "done", {
      timeoutMs: 8000,
    });
    assert.equal(job.status, "done");
  } finally {
    h.cleanup();
  }
});

test("claude buildInvocation: pins --session-id (fresh) and unsets AUTH_TOKEN", () => {
  const inv = claude.buildInvocation({
    taskPrompt: "hi",
    modelId: "GLM-5.2",
    baseUrl: "https://b",
    apiKey: "k",
    effort: "high",
    sessionId: "sess-1",
    resume: false,
  });
  assert.equal(inv.command, "claude");
  assert.ok(inv.argv.includes("--session-id"));
  assert.ok(inv.argv.includes("sess-1"));
  assert.equal(inv.env.ANTHROPIC_AUTH_TOKEN, null, "AUTH_TOKEN must be flagged for unset");
  assert.equal(inv.env.ANTHROPIC_BASE_URL, "https://b");

  const res = claude.buildInvocation({
    taskPrompt: "hi",
    modelId: "GLM-5.2",
    baseUrl: "https://b",
    apiKey: "k",
    effort: "high",
    sessionId: "sess-1",
    resume: true,
  });
  assert.ok(res.argv.includes("--resume"));
  assert.equal(res.argv.includes("--session-id"), false);
});

test("codex buildInvocation: resume uses 'exec resume <session>'", () => {
  const inv = codex.buildInvocation({
    taskPrompt: "hi",
    modelId: "gpt-5-codex",
    baseUrl: "https://b",
    apiKey: "k",
    effort: "high",
    sessionId: "cs-1",
    resume: true,
  });
  // shape: exec resume [OPTIONS] [SESSION_ID] [PROMPT] — options come before the session id
  assert.deepEqual(inv.argv.slice(0, 2), ["exec", "resume"]);
  assert.ok(inv.argv.includes("--json"), "resume must also emit JSONL");
  const sid = inv.argv.indexOf("cs-1");
  assert.ok(sid > 2, "session id must come AFTER options");
  assert.equal(inv.argv[sid + 1], "hi", "prompt must come right after session id");
  assert.ok(inv.argv.indexOf("--ignore-user-config") < sid, "options precede session id");
  assert.equal(inv.env.PIGEON_API_KEY, "k");
});

test("codex buildInvocation: fresh run injects --json + wire_api(default responses) + explicit override", () => {
  const fresh = codex.buildInvocation({
    taskPrompt: "hi",
    modelId: "glm-5.2",
    baseUrl: "https://b",
    apiKey: "k",
    effort: "high",
    sessionId: "cs-1",
    resume: false,
  });
  const joined = fresh.argv.join(" ");
  assert.ok(fresh.argv.includes("--json"), "must request JSONL events");
  // codex >=0.139 removed wire_api="chat"; "responses" is the only value it loads, so it's the default.
  assert.match(joined, /model_providers\.pigeon\.wire_api="responses"/, "default wire_api is responses");
  assert.equal(codex.supportsResume, true);

  // codex-native models (name contains "codex") also use responses.
  const auto = codex.buildInvocation({
    taskPrompt: "hi",
    modelId: "gpt-5-codex",
    baseUrl: "https://b",
    apiKey: "k",
    effort: "high",
    sessionId: "cs-1",
    resume: false,
  });
  assert.match(auto.argv.join(" "), /model_providers\.pigeon\.wire_api="responses"/, "gpt-5-codex uses responses");

  // an explicit wireApi override still passes through verbatim (e.g. forcing "chat" for an older codex).
  const explicit = codex.buildInvocation({
    taskPrompt: "hi",
    modelId: "some-openai-model",
    baseUrl: "https://b",
    apiKey: "k",
    effort: "high",
    sessionId: "cs-1",
    resume: false,
    wireApi: "chat",
  });
  assert.match(explicit.argv.join(" "), /model_providers\.pigeon\.wire_api="chat"/, "explicit wireApi wins");
});

test("codex parseResult: from a log+JSONL mix, returns only the LAST agent message", () => {
  const raw = [
    "[2026-06-17] starting codex exec ...",
    "tool: reading files",
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first chunk" } }),
    "tool: running tests",
    JSON.stringify({ msg: { type: "agent_message", message: "FINAL ANSWER" } }),
  ].join("\n");
  assert.equal(codex.parseResult(raw), "FINAL ANSWER");
});

test("codex extractSessionId: reads thread_id from a thread.started event (real codex shape)", () => {
  const raw = [
    JSON.stringify({ type: "thread.started", thread_id: "019ed8d0-cc1a-7fd0-a814-47b18f3410e6" }),
    JSON.stringify({ type: "agent_message", text: "hello" }),
  ].join("\n");
  assert.equal(codex.extractSessionId(raw, { sessionId: "fallback" }), "019ed8d0-cc1a-7fd0-a814-47b18f3410e6");
  // legacy session_id shape still works
  assert.equal(codex.extractSessionId(JSON.stringify({ session_id: "abc12345" }), {}), "abc12345");
  // nothing parseable → fall back to ctx.sessionId
  assert.equal(codex.extractSessionId("no json here", { sessionId: "fb" }), "fb");
});

test("delegated runs are isolated from local config (claude --bare, codex --ignore-*)", () => {
  const c = claude.buildInvocation({
    taskPrompt: "hi", modelId: "GLM-5.2", baseUrl: "https://b", apiKey: "k",
    effort: "high", sessionId: "s", resume: false,
  });
  assert.ok(c.argv.includes("--bare"), "claude delegate must run bare (no caller hooks/plugins/CLAUDE.md)");

  const x = codex.buildInvocation({
    taskPrompt: "hi", modelId: "gpt-5-codex", baseUrl: "https://b", apiKey: "k",
    effort: "high", sessionId: "s", resume: false,
  });
  const j = x.argv.join(" ");
  assert.match(j, /--ignore-user-config/);
  assert.match(j, /--ignore-rules/);
});

test("buildInvocation omits effort when the model has none (effort optional)", () => {
  const c = claude.buildInvocation({
    taskPrompt: "x", modelId: "M", baseUrl: "https://b", apiKey: "k",
    effort: null, sessionId: "s", resume: false,
  });
  assert.equal(c.argv.includes("--effort"), false, "claude must not pass --effort when there is none");

  const x = codex.buildInvocation({
    taskPrompt: "x", modelId: "M", baseUrl: "https://b", apiKey: "k",
    effort: null, sessionId: "s", resume: false,
  });
  assert.doesNotMatch(x.argv.join(" "), /model_reasoning_effort/, "codex must not set effort when there is none");
});

test("renderModelList marks defaults with * and shows MODEL_ID as the first column", () => {
  const out = renderModelList([
    {
      model: "glm-5.2",
      modelId: "GLM-5.2[1m]",
      provider: "zhipu",
      protocols: ["anthropic", "openai"],
      clients: ["claude", "codex"],
      defaultClient: "claude",
      effort: ["high", "low"],
      defaultEffort: "high",
    },
  ]);
  assert.match(out, /claude\*/);
  assert.match(out, /high\*/);
  assert.doesNotMatch(out, /codex\*/);
  // MODEL_ID is the first column, and the real id is shown
  assert.match(out, /^MODEL_ID\s+MODEL\s+PROVIDER/m, "MODEL_ID is the first column");
  assert.match(out, /GLM-5\.2\[1m\]\s+glm-5\.2\s+zhipu/, "real model_id precedes the alias");
});

test("renderNativeProviders: one-line hint (no table); empty when none detected", () => {
  assert.equal(renderNativeProviders([]), "", "no detected native providers => no hint");
  const out = renderNativeProviders([
    { provider: "codex-native", protocol: "openai", client: "codex" },
    { provider: "claude-native", protocol: "anthropic", client: "claude" },
  ]);
  assert.equal(out.split("\n").length, 1, "must be a single line, not a table");
  assert.match(out, /Native providers available/);
  assert.match(out, /codex-native, claude-native/);
  assert.match(out, /\/pigeon:config/);
  assert.doesNotMatch(out, /PROTOCOL|CLIENT/, "no table headers");
});

test("renderStatusList handles empty input", () => {
  assert.match(renderStatusList([]), /No pigeon jobs/);
});

test("renderStatusList paginates: footer points to the next page, and shows only the slice", () => {
  const slice = Array.from({ length: 10 }, (_, i) => ({
    id: `glm-${i}`, status: "done", model: "glm", client: "claude", effort: "high", started_at: "x",
  }));
  const out = renderStatusList(slice, { page: 1, pageSize: 10, total: 23 });
  assert.match(out, /Showing 1-10 of 23 \(page 1\/3\)/);
  assert.match(out, /Next page: \/pigeon:status 2/);

  // last page: no "next page" hint
  const last = renderStatusList(slice.slice(0, 3), { page: 3, pageSize: 10, total: 23 });
  assert.match(last, /page 3\/3/);
  assert.doesNotMatch(last, /Next page/);

  // single page (total fits): no footer at all
  const one = renderStatusList(slice.slice(0, 2), { page: 1, pageSize: 10, total: 2 });
  assert.doesNotMatch(one, /Showing|Next page/);

  // a page past the end of a non-empty list
  const past = renderStatusList([], { page: 9, pageSize: 10, total: 23 });
  assert.match(past, /No jobs on page 9 \(total 23\)/);
});

test("queued jobs render as in-progress, not finished", () => {
  const list = renderStatusList([
    { id: "j-1", status: "queued", model: "glm-5.2", client: "claude", effort: "high", started_at: "x" },
  ]);
  assert.match(list, /In progress/);
  assert.doesNotMatch(list, /Finished/);

  const res = renderResult({ id: "j-1", status: "queued" }, null);
  assert.match(res, /queued|hasn't started/);
  assert.doesNotMatch(res, /no successful result/);
});
