// Native providers (codex-native / claude-native): a model source whose auth pigeon
// does NOT inject. Models pin their own model_id and run keyless via the client's login.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { MOCK_BIN } from "./helpers.mjs";
import { resolve, resolveForContinue, ResolveError } from "../scripts/lib/resolve.mjs";
import { getProvider, isNativeProvider } from "../scripts/lib/registry.mjs";
import { validateConfig } from "../scripts/lib/config.mjs";

// PATH with the mock claude/codex so resolve finds the client binaries hermetically.
const ENV = { ...process.env, PATH: `${MOCK_BIN}${path.delimiter}${process.env.PATH || ""}` };

// Two models on the same native provider — the gpt-5.5 / gpt-5.4 use case.
function cfg() {
  return {
    version: 1,
    providers: {},
    models: {
      "gpt-5.5": { provider: "codex-native", model_id: "gpt-5.5", clients: ["codex"] },
      "gpt-5.4": { provider: "codex-native", model_id: "gpt-5.4", clients: ["codex"] },
    },
  };
}

test("native providers are auto-present (not in config) and marked native", () => {
  assert.ok(isNativeProvider(getProvider({ providers: {} }, "codex-native")));
  assert.ok(isNativeProvider(getProvider({ providers: {} }, "claude-native")));
  assert.equal(getProvider({ providers: {} }, "nope"), null);
  // a configured provider is not native
  assert.equal(isNativeProvider({ protocols: ["openai"], base_url: {}, api_key: "k" }), false);
});

test("config validation: a model may reference a native provider with no key/base_url", () => {
  assert.deepEqual(validateConfig(cfg()), [], "two codex-native models validate cleanly");

  // a CONFIGURED provider still must carry key + base_url
  const bad = { version: 1, providers: { p: { protocols: ["openai"] } }, models: {} };
  assert.ok(validateConfig(bad).some((e) => /base_url|api_key/.test(e)));
});

test("config validation: a native provider name cannot be shadowed by a config provider", () => {
  const shadow = {
    version: 1,
    providers: { "codex-native": { protocols: ["openai"], base_url: { openai: "https://x" }, api_key: "k" } },
    models: {},
  };
  assert.ok(
    validateConfig(shadow).some((e) => /reserved built-in native provider/.test(e)),
    "defining a provider named codex-native must be rejected"
  );

  // a configured provider must not mark itself native via authMode (would silently skip its key/base_url)
  const sneaky = {
    version: 1,
    providers: { p: { authMode: "native", protocols: ["openai"], base_url: { openai: "https://x" }, api_key: "k" } },
    models: {},
  };
  assert.ok(
    validateConfig(sneaky).some((e) => /authMode/.test(e)),
    "a config provider setting authMode must be rejected"
  );
});

test("resolveForContinue: legacy native job (native:true, no provider) still resumes keyless", () => {
  // shape persisted by the pre-rework native-MODEL design
  const legacy = {
    model: "codex", model_id: null, provider: null, protocol: "openai",
    client: "codex", effort: null, native: true, cwd: process.cwd(), thread_key: "tk",
  };
  const ctx = resolveForContinue(cfg(), legacy, { env: ENV });
  assert.equal(ctx.native, true);
  assert.equal(ctx.baseUrl, null);
  assert.equal(ctx.apiKey, null);
  assert.equal(ctx.client, "codex");
});

test("resolve(native model): no baseUrl/apiKey, model_id pinned, native flag set", () => {
  const a = resolve(cfg(), { model: "gpt-5.5", taskPrompt: "hi", env: ENV });
  assert.equal(a.native, true);
  assert.equal(a.provider, "codex-native");
  assert.equal(a.baseUrl, null);
  assert.equal(a.apiKey, null);
  assert.equal(a.modelId, "gpt-5.5", "native models pin their own model id");
  assert.equal(a.client, "codex");

  // the sibling model on the same native provider resolves to its own id (parallel use)
  const b = resolve(cfg(), { model: "gpt-5.4", taskPrompt: "hi", env: ENV });
  assert.equal(b.modelId, "gpt-5.4");
  assert.notEqual(a.threadKey, b.threadKey, "distinct models => distinct threads");
});

test("resolve(native): effort forwards when given, rejects illegal", () => {
  const c = { ...cfg() };
  c.models["gpt-5.5"] = { provider: "codex-native", model_id: "gpt-5.5", clients: ["codex"], effort: ["high", "low"] };
  assert.equal(resolve(c, { model: "gpt-5.5", effort: "high", taskPrompt: "x", env: ENV }).effort, "high");
  assert.throws(
    () => resolve(c, { model: "gpt-5.5", effort: "ultra", taskPrompt: "x", env: ENV }),
    (e) => e instanceof ResolveError && /effort "ultra" is invalid/.test(e.message)
  );
});

test("resolveForContinue(native job): rebuilds keyless from the native provider", () => {
  const base = {
    model: "gpt-5.5", model_id: "gpt-5.5", provider: "codex-native", protocol: "openai",
    client: "codex", effort: null, native: true, cwd: process.cwd(), thread_key: "tk",
  };
  const ctx = resolveForContinue(cfg(), base, { env: ENV });
  assert.equal(ctx.native, true);
  assert.equal(ctx.baseUrl, null);
  assert.equal(ctx.apiKey, null);
  assert.equal(ctx.modelId, "gpt-5.5");
});
