// registry / resolve: default client+effort, protocol-incompatible
// client, illegal effort (claude=max ok / codex=max bad; codex=none ok /
// claude=none bad), unknown model, missing key.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolve, ResolveError, threadKey } from "../scripts/lib/resolve.mjs";
import {
  defaultClient,
  defaultEffortForClient,
  compatibleClients,
  clientValidForModel,
  getModel,
} from "../scripts/lib/registry.mjs";
import { sampleConfig, MOCK_BIN } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// env that finds the mock binaries on PATH.
const ENV = { ...process.env, PATH: `${MOCK_BIN}${path.delimiter}${process.env.PATH}` };

test("default client = first in model.clients", () => {
  const cfg = sampleConfig();
  assert.equal(defaultClient(getModel(cfg, "glm-5.2")), "claude");
  assert.equal(defaultClient(getModel(cfg, "gpt-5-codex")), "codex");
});

test("default effort = first model.effort legal for client", () => {
  const cfg = sampleConfig();
  // glm effort=[high,medium,low]; all legal for claude -> high
  assert.equal(defaultEffortForClient(getModel(cfg, "glm-5.2"), "claude"), "high");
});

test("resolve() picks defaults when client/effort omitted", () => {
  const ctx = resolve(sampleConfig(), { model: "glm-5.2", env: ENV });
  assert.equal(ctx.client, "claude");
  assert.equal(ctx.effort, "high");
  assert.equal(ctx.modelId, "GLM-5.2");
  assert.equal(ctx.protocol, "anthropic");
  assert.equal(ctx.baseUrl, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(ctx.apiKey, "zhipu-key");
  assert.ok(ctx.binaryPath && ctx.binaryPath.endsWith("claude"));
  assert.equal(ctx.threadKey, threadKey(ctx.cwd, "glm-5.2", "claude"));
});

test("resolve() honours explicit client + effort", () => {
  const ctx = resolve(sampleConfig(), {
    model: "glm-5.2",
    client: "codex",
    effort: "medium",
    env: ENV,
  });
  assert.equal(ctx.client, "codex");
  assert.equal(ctx.protocol, "openai");
  assert.equal(ctx.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(ctx.effort, "medium");
});

test("missing --model -> ResolveError", () => {
  assert.throws(
    () => resolve(sampleConfig(), { env: ENV }),
    (e) => e instanceof ResolveError && e.code === "model-missing"
  );
});

test("unknown model -> error lists known models", () => {
  try {
    resolve(sampleConfig(), { model: "nope", env: ENV });
    assert.fail("should throw");
  } catch (e) {
    assert.equal(e.code, "model-unknown");
    assert.match(e.message, /glm-5\.2/);
    assert.match(e.message, /gpt-5-codex/);
  }
});

test("protocol-incompatible client -> error", () => {
  // Make a config where the model's provider only exposes openai, but list claude.
  const cfg = sampleConfig();
  cfg.providers.openai.protocols = ["openai"];
  cfg.models["gpt-5-codex"].clients = ["claude", "codex"];
  // clientValidForModel should reject claude (anthropic) against openai-only provider.
  const check = clientValidForModel(cfg, "gpt-5-codex", "claude");
  assert.equal(check.ok, false);
  assert.equal(check.reason, "protocol-incompatible");
  try {
    resolve(cfg, { model: "gpt-5-codex", client: "claude", env: ENV });
    assert.fail("should throw");
  } catch (e) {
    assert.equal(e.code, "client-invalid");
    // available clients should still list codex
    assert.match(e.message, /codex/);
  }
});

test("client not in model.clients -> error", () => {
  try {
    resolve(sampleConfig(), { model: "gpt-5-codex", client: "claude", env: ENV });
    assert.fail("should throw");
  } catch (e) {
    assert.equal(e.code, "client-invalid");
  }
});

test("effort claude=max legal, codex=max illegal", () => {
  const cfg = sampleConfig();
  cfg.models["glm-5.2"].effort = ["max", "high", "low"];
  // claude allows max
  const okCtx = resolve(cfg, { model: "glm-5.2", client: "claude", effort: "max", env: ENV });
  assert.equal(okCtx.effort, "max");
  // codex does NOT allow max
  try {
    resolve(cfg, { model: "glm-5.2", client: "codex", effort: "max", env: ENV });
    assert.fail("codex should reject max");
  } catch (e) {
    assert.equal(e.code, "effort-invalid");
  }
});

test("effort codex=none legal, claude=none illegal", () => {
  const cfg = sampleConfig();
  cfg.models["glm-5.2"].effort = ["none", "medium", "low"];
  // codex allows none
  const okCtx = resolve(cfg, { model: "glm-5.2", client: "codex", effort: "none", env: ENV });
  assert.equal(okCtx.effort, "none");
  // claude does NOT allow none
  try {
    resolve(cfg, { model: "glm-5.2", client: "claude", effort: "none", env: ENV });
    assert.fail("claude should reject none");
  } catch (e) {
    assert.equal(e.code, "effort-invalid");
  }
});

test("default effort skips client-illegal entries", () => {
  const cfg = sampleConfig();
  // For codex, first legal of [max, none, low] is "none" (max illegal, none legal).
  cfg.models["glm-5.2"].effort = ["max", "none", "low"];
  const ctx = resolve(cfg, { model: "glm-5.2", client: "codex", env: ENV });
  assert.equal(ctx.effort, "none");
});

test("missing api_key -> error", () => {
  const cfg = sampleConfig();
  cfg.providers.zhipu.api_key = "";
  try {
    resolve(cfg, { model: "glm-5.2", env: ENV });
    assert.fail("should throw");
  } catch (e) {
    assert.equal(e.code, "api-key-missing");
  }
});

test("missing base_url for protocol -> error", () => {
  const cfg = sampleConfig();
  delete cfg.providers.zhipu.base_url.anthropic;
  try {
    resolve(cfg, { model: "glm-5.2", client: "claude", env: ENV });
    assert.fail("should throw");
  } catch (e) {
    assert.equal(e.code, "base-url-missing");
  }
});

test("client binary not installed -> error", () => {
  // env with a PATH that does NOT include mock-bin or a real claude/codex.
  const emptyEnv = { PATH: "/nonexistent-dir-pigeon-test" };
  try {
    resolve(sampleConfig(), { model: "glm-5.2", client: "claude", env: emptyEnv });
    assert.fail("should throw");
  } catch (e) {
    assert.equal(e.code, "client-not-installed");
  }
});

test("empty taskPrompt -> error when provided", () => {
  try {
    resolve(sampleConfig(), { model: "glm-5.2", taskPrompt: "   ", env: ENV });
    assert.fail("should throw");
  } catch (e) {
    assert.equal(e.code, "task-empty");
  }
});

test("compatibleClients filters by protocol", () => {
  const cfg = sampleConfig();
  assert.deepEqual(compatibleClients(cfg, "glm-5.2"), ["claude", "codex"]);
  assert.deepEqual(compatibleClients(cfg, "gpt-5-codex"), ["codex"]);
});
