import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUNNERS, home, loadConfig, validateConfig, resolveBinding, publicBinding, restoreBinding } from "../packages/core/src/config.mjs";

function sampleConfig() {
  return {
    version: 1,
    providers: {
      service: {
        protocols: ["anthropic", "openai"],
        base_url: { anthropic: "https://example.com/anthropic", openai: "https://example.com/v1" },
        api_key: "test-key",
      },
      chat: {
        protocols: ["openai-chat-completions"],
        base_url: { "openai-chat-completions": "https://chat.example.com/v1" },
        api_key: "chat-key",
      },
    },
    models: {
      coding: { provider: "service", model_id: "actual-model", clients: ["codex", "claude"], effort: ["high", "medium"] },
    },
    presets: {
      coding: { provider: "service", runner: "codex", protocol: "openai-responses", model: "actual-model", effort: "high" },
    },
  };
}

function withEnv(t, key, value) {
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  });
}

const resolve = (options, config = sampleConfig()) => resolveBinding(options, { config, cwd: "/tmp/pigeon-work" });

test("capabilities expose concrete protocols and execution interfaces", () => {
  assert.deepEqual(RUNNERS.claude.protocols, ["anthropic-messages"]);
  assert.deepEqual(RUNNERS.codex.protocols, ["openai-responses"]);
  assert.deepEqual(RUNNERS.hermes.protocols, ["openai-chat-completions"]);
  assert.equal(RUNNERS.hermes.mode, "gateway");
  assert.deepEqual(JSON.parse(JSON.stringify(RUNNERS)).codex.efforts, RUNNERS.codex.efforts);
});

test("capabilities describe session controls and runner steering boundaries", () => {
  const capabilities = JSON.parse(JSON.stringify(RUNNERS));
  const boundaries = { claude: "execution-boundary", codex: "after-tool-completion", hermes: "gateway-boundary" };
  for (const [runner, metadata] of Object.entries(capabilities)) {
    for (const control of ["resume", "events", "steer", "cancel"]) assert.equal(metadata[control], true);
    assert.equal(metadata.steerMode, boundaries[runner]);
    assert.equal(Object.hasOwn(metadata, "installed"), false);
    assert.deepEqual(metadata.authentication, runner === "codex" ? ["runner-managed", "api-key", "none"] : ["runner-managed", "api-key"]);
    assert.deepEqual(metadata.limitations, runner === "hermes" ? ["managed-worker-unsupported"] : []);
  }
});

test("loadConfig honors PIGEON_HOME and never rewrites missing, valid, or broken files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pigeon-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  withEnv(t, "PIGEON_HOME", path.join(dir, "missing"));
  assert.equal(home(), path.join(dir, "missing"));
  assert.deepEqual(loadConfig().providers, {});
  assert.equal(fs.existsSync(home()), false);
  process.env.PIGEON_HOME = dir;
  const file = path.join(dir, "config.json");
  const original = JSON.stringify(sampleConfig(), null, 3);
  fs.writeFileSync(file, original);
  assert.deepEqual(loadConfig(), sampleConfig());
  assert.equal(fs.readFileSync(file, "utf8"), original);
  for (const broken of ["", '{"api_key": "private-value", broken}', "null", "[]"]) {
    fs.writeFileSync(file, broken);
    assert.throws(loadConfig, (error) => !error.message.includes("private-value"));
    assert.equal(fs.readFileSync(file, "utf8"), broken);
  }
});

test("native runner mode uses each runner's existing configuration and optional model", (t) => {
  for (const [runner, variable] of [["claude", "CLAUDE_CONFIG_DIR"], ["codex", "CODEX_HOME"], ["hermes", "HERMES_HOME"]]) {
    withEnv(t, variable, `/tmp/${runner}-identity`);
    const binding = resolve({ runner }, {});
    assert.equal(binding.provider, `${runner}-native`);
    assert.equal(binding.scope, `/tmp/${runner}-identity`);
    assert.equal(binding.native, true);
    assert.equal(binding.authMode, "runner-managed");
    assert.equal(binding.mode, RUNNERS[runner].mode);
    assert.equal(binding.apiKey, null);
    assert.equal(binding.baseUrl, null);
    assert.equal(binding.protocol, null);
    assert.equal(binding.model, null);
    assert.equal(resolve({ runner, model: "custom-model" }, {}).model, "custom-model");
    assert.equal(resolve({ provider: `${runner}-native` }, {}).runner, runner);
  }
});

test("preset flags override explicitly and revalidate the resulting route", () => {
  const config = sampleConfig();
  const original = structuredClone(config);
  const binding = resolve({ preset: "coding", model: "other-model", effort: "medium" }, config);
  assert.equal(binding.model, "other-model");
  assert.equal(binding.effort, "medium");
  assert.equal(binding.protocol, "openai-responses");
  assert.equal(binding.apiKey, "test-key");
  const changed = resolve({ preset: "coding", client: "claude", protocol: "anthropic-messages" }, config);
  assert.equal(changed.runner, "claude");
  assert.throws(() => resolve({ preset: "coding", runner: "claude" }, config), /incompatible/);
  assert.throws(() => resolve({ preset: "coding", provider: "chat" }, config), /incompatible/);
  assert.deepEqual(config, original);
});

test("model is a literal ID and only legacyModel expands old aliases", () => {
  assert.equal(resolve({ provider: "service", runner: "codex", model: "coding" }).model, "coding");
  assert.equal(resolve({ runner: "codex", model: "coding" }).native, true);
  const legacy = resolve({ legacyModel: "coding" });
  assert.equal(legacy.model, "actual-model");
  assert.equal(legacy.runner, "codex");
  assert.equal(legacy.provider, "service");
  assert.throws(() => resolve({ legacyModel: "coding", model: "actual-model" }), /cannot be combined/);
  assert.throws(() => resolve({ legacyModel: "missing" }), /Unknown legacy model/);
});

test("runner selection requires an explicit default or a unique compatible route", () => {
  assert.throws(() => resolve({ provider: "service", model: "actual-model" }), /unique compatible runner/);
  assert.throws(() => resolve({ model: "actual-model" }), /unique provider/);
  assert.throws(() => resolve({}, {}), /Specify provider or runner/);
  assert.equal(resolve({ provider: "chat", model: "anything" }).runner, "hermes");
  assert.equal(resolve({ provider: "service", protocol: "openai-responses", model: "anything" }).runner, "codex");
  const config = sampleConfig();
  config.defaultRunner = "claude";
  assert.equal(resolve({ provider: "service", model: "anything" }, config).runner, "claude");
  assert.equal(resolve({}, config).provider, "claude-native");
  assert.equal(resolve({ preset: "coding" }, config).runner, "codex");
  assert.equal(resolve({ provider: "hermes-native" }, config).runner, "hermes");
});

test("invalid runner, provider, protocol, model and alias combinations fail", () => {
  const invalid = [
    [{ runner: "unknown" }, /Unknown runner/],
    [{ runner: "codex", client: "claude" }, /Conflicting/],
    [{ provider: "ghost", runner: "codex", model: "m" }, /Unknown provider/],
    [{ preset: "ghost" }, /Unknown preset/],
    [{ provider: "claude-native", runner: "codex" }, /requires runner/],
    [{ runner: "claude", protocol: "anthropic-messages" }, /Native/],
    [{ provider: "service", runner: "codex" }, /actual model ID/],
    [{ provider: "service", runner: "hermes", model: "m" }, /compatible protocol/],
    [{ provider: "chat", runner: "codex", model: "m" }, /compatible protocol/],
    [{ provider: "service", runner: "codex", protocol: "openai", model: "m" }, /Unknown protocol/],
    [{ runner: "codex", model: "" }, /non-empty string/],
  ];
  for (const [options, expected] of invalid) assert.throws(() => resolve(options), expected);
});

test("effort checks runner syntax and configured model restrictions without inventing support", () => {
  assert.throws(() => resolve({ preset: "coding", effort: "max" }), /Invalid effort/);
  assert.throws(() => resolve({ preset: "coding", effort: "low" }), /configured model effort/);
  assert.equal(resolve({ provider: "service", runner: "codex", model: "unlisted", effort: "low" }).effort, "low");
  for (const effort of ["max", "ultra"]) assert.equal(resolve({ runner: "hermes", effort }, {}).effort, effort);
  const config = sampleConfig();
  config.models.coding.effort = [];
  assert.throws(() => resolve({ preset: "coding" }, config), /configured model effort/);
  assert.equal(resolve({ provider: "service", runner: "codex", model: "actual-model" }, config).effort, null);
});

test("v1 protocols map explicitly, including legacy wire_api chat", () => {
  const config = sampleConfig();
  config.providers.service.wire_api = "chat";
  assert.equal(resolve({ provider: "service", runner: "hermes", model: "m" }, config).protocol, "openai-chat-completions");
  assert.throws(() => resolve({ provider: "service", runner: "codex", model: "m" }, config), /compatible protocol/);
});

test("validation reports malformed structures, reserved providers and invalid presets", () => {
  assert.deepEqual(validateConfig(sampleConfig()), []);
  assert.deepEqual(validateConfig({}), []);
  const invalid = [null, [], { providers: [] }, { models: 1 }, { presets: null }, { defaultRunner: "unknown" }];
  for (const config of invalid) assert.ok(validateConfig(config).length);
  for (const mutate of [
    (c) => { c.providers["codex-native"] = c.providers.service; },
    (c) => { c.providers.service.authMode = "native"; },
    (c) => { c.providers.service.protocols = ["imaginary"]; },
    (c) => { c.providers.service.wire_api = "unknown"; },
    (c) => { c.models.coding.effort = ["imaginary"]; },
    (c) => { c.providers.service.base_url.openai = "not-a-url"; },
    (c) => { c.models.coding.provider = "missing"; },
    (c) => { c.models.coding.clients = ["unknown"]; },
    (c) => { c.models.coding.effort = "high"; },
    (c) => { c.presets.coding.runner = "hermes"; },
    (c) => { c.presets.coding.effort = "max"; },
  ]) {
    const config = sampleConfig();
    mutate(config);
    assert.ok(validateConfig(config).length);
  }
});

test("provider credentials may come from a named env var without reading credential files", (t) => {
  const config = sampleConfig();
  delete config.providers.service.api_key;
  config.providers.service.api_key_env = "PIGEON_TEST_KEY";
  withEnv(t, "PIGEON_TEST_KEY", undefined);
  assert.deepEqual(validateConfig(config), []);
  assert.throws(() => resolve({ preset: "coding" }, config), /key environment variable/);
  process.env.PIGEON_TEST_KEY = "rotating-key";
  assert.equal(resolve({ preset: "coding" }, config).apiKey, "rotating-key");
  config.providers.service.api_key = "ambiguous-key";
  assert.ok(validateConfig(config).length);
});

test("Claude and Hermes reject unauthenticated routes while Codex permits them", () => {
  const config = sampleConfig();
  delete config.providers.service.api_key;
  config.providers.service.auth = { type: "none" };
  config.models = {};
  assert.deepEqual(validateConfig(config), []);
  const binding = resolve({ preset: "coding" }, config);
  assert.equal(binding.authMode, "none");
  assert.equal(binding.apiKey, null);
  assert.throws(() => resolve({ provider: "service", runner: "claude", model: "m" }, config), {
    code: "UNSUPPORTED_AUTH_MODE",
  });
  config.presets.coding.runner = "claude";
  config.presets.coding.protocol = "anthropic-messages";
  assert.ok(validateConfig(config).some((error) => /preset "coding".*authentication type none/.test(error)));
  delete config.providers.chat.api_key;
  config.providers.chat.auth = { type: "none" };
  assert.throws(() => resolve({ provider: "chat", runner: "hermes", model: "m" }, config), {
    code: "UNSUPPORTED_AUTH_MODE",
  });
  config.presets.coding = { provider: "chat", runner: "hermes", model: "m" };
  assert.ok(validateConfig(config).some((error) => /preset "coding".*authentication type none/.test(error)));
  config.presets = {};
  assert.deepEqual(validateConfig(config), []);
});

test("publicBinding is a scalar whitelist and excludes secret-bearing endpoints", () => {
  const binding = resolve({ preset: "coding" });
  const saved = publicBinding({ ...binding, api_key: "secret", env: { KEY: "secret" }, auth: { token: "secret" }, extra: "secret" });
  assert.equal(Object.hasOwn(saved, "apiKey"), false);
  assert.equal(Object.hasOwn(saved, "env"), false);
  assert.equal(JSON.stringify(saved).includes("secret"), false);
  assert.equal(saved.authMode, "api-key");
  assert.equal(saved.scope, binding.scope);
  assert.equal(saved.mode, "app-server");
  assert.throws(() => publicBinding({ ...binding, scope: { token: "secret" } }), /Invalid binding field/);
  for (const url of ["https://user:password@example.com", "https://example.com?key=secret", "https://example.com#secret"]) {
    assert.throws(() => publicBinding({ ...binding, baseUrl: url }), /without credentials/);
  }
});

test("resume pins provider, model, runner and protocol while refreshing keys", () => {
  const config = sampleConfig();
  const saved = publicBinding(resolve({ preset: "coding" }, config));
  config.presets.coding = { provider: "chat", runner: "hermes", model: "redirected" };
  config.models.coding = { provider: "chat", model_id: "redirected", clients: ["hermes"] };
  config.defaultRunner = "hermes";
  config.providers.service.api_key = "new-key";
  const restored = restoreBinding(saved, { config });
  assert.deepEqual(publicBinding(restored), saved);
  assert.equal(restored.apiKey, "new-key");
  assert.equal(restored.cwd, "/tmp/pigeon-work");
});

test("resume refuses endpoint, authentication, protocol and provider changes", () => {
  const saved = publicBinding(resolve({ preset: "coding" }));
  for (const mutate of [
    (c) => { c.providers.service.base_url.openai = "https://different.example.com/v1"; },
    (c) => { delete c.providers.service.api_key; c.providers.service.auth = { type: "none" }; },
    (c) => { c.providers.service.protocols = ["anthropic"]; },
    (c) => { delete c.providers.service; },
  ]) {
    const config = sampleConfig();
    mutate(config);
    assert.throws(() => restoreBinding(saved, { config }), /changed|incompatible|Unknown provider/);
  }
  assert.throws(() => restoreBinding({ runner: "codex" }, { config: {} }), /Incomplete saved binding/);
});

test("resume checks runner home identity using saved cwd, not caller cwd", (t) => {
  for (const [runner, variable] of [["claude", "CLAUDE_CONFIG_DIR"], ["codex", "CODEX_HOME"], ["hermes", "HERMES_HOME"]]) {
    withEnv(t, variable, "relative-home");
    const saved = publicBinding(resolve({ runner }, {}));
    assert.equal(saved.scope, `/tmp/pigeon-work/relative-home`);
    assert.deepEqual(publicBinding(restoreBinding(saved, { config: {} })), saved);
    process.env[variable] = "/tmp/changed-home";
    assert.throws(() => restoreBinding(saved, { config: {} }), /scope changed/);
  }
});

test("environment key rotation is allowed without changing binding identity", (t) => {
  withEnv(t, "PIGEON_TEST_KEY", "first-key");
  const config = sampleConfig();
  delete config.providers.service.api_key;
  config.providers.service.auth = { type: "api-key", env: "PIGEON_TEST_KEY" };
  const saved = publicBinding(resolve({ preset: "coding" }, config));
  process.env.PIGEON_TEST_KEY = "second-key";
  assert.equal(restoreBinding(saved, { config }).apiKey, "second-key");
});
