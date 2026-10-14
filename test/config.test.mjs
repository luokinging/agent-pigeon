// config: structured config-set validation pass/fail, atomic write,
// broken JSON is never overwritten.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { sampleConfig, makeHome, runPigeon } from "./helpers.mjs";

function configFile(pigeonHome) {
  return path.join(pigeonHome, "config.json");
}

test("config-set with valid structured JSON writes config", () => {
  const h = makeHome();
  try {
    const cfg = sampleConfig();
    const r = runPigeon(["config-set", "--json", JSON.stringify(cfg)], { home: h.home });
    assert.equal(r.status, 0, r.stderr);
    const onDisk = JSON.parse(fs.readFileSync(configFile(h.pigeonHome), "utf8"));
    assert.deepEqual(onDisk.models["glm-5.2"].model_id, "GLM-5.2");
    assert.deepEqual(Object.keys(onDisk.providers).sort(), ["openai", "zhipu"]);
  } finally {
    h.cleanup();
  }
});

test("config-set rejects invalid config (unknown client) and does not write", () => {
  const h = makeHome();
  try {
    const bad = sampleConfig();
    bad.models["glm-5.2"].clients = ["nonsense-client"];
    const r = runPigeon(["config-set", "--json", JSON.stringify(bad)], { home: h.home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown client|validation/);
    assert.equal(fs.existsSync(configFile(h.pigeonHome)), false);
  } finally {
    h.cleanup();
  }
});

test("config-set rejects model referencing missing provider", () => {
  const h = makeHome();
  try {
    const bad = sampleConfig();
    bad.models["glm-5.2"].provider = "ghost";
    const r = runPigeon(["config-set", "--json", JSON.stringify(bad)], { home: h.home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /provider/);
    assert.equal(fs.existsSync(configFile(h.pigeonHome)), false);
  } finally {
    h.cleanup();
  }
});

test("config-set rejects protocol-incompatible client", () => {
  const h = makeHome();
  try {
    const bad = sampleConfig();
    // openai-only provider but list claude (anthropic) on its model
    bad.models["gpt-5-codex"].clients = ["claude"];
    const r = runPigeon(["config-set", "--json", JSON.stringify(bad)], { home: h.home });
    assert.notEqual(r.status, 0);
    assert.equal(fs.existsSync(configFile(h.pigeonHome)), false);
  } finally {
    h.cleanup();
  }
});

test("config-set with malformed --json fails cleanly", () => {
  const h = makeHome();
  try {
    const r = runPigeon(["config-set", "--json", "{not json"], { home: h.home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /JSON/);
  } finally {
    h.cleanup();
  }
});

test("broken on-disk config is NOT overwritten by a failing write", () => {
  const h = makeHome();
  try {
    // Pre-seed a hand-broken config file.
    const broken = "{ this is : not valid json ]";
    fs.writeFileSync(configFile(h.pigeonHome), broken, "utf8");

    // A *valid* full config-set uses saveConfig which overwrites wholesale — that
    // is allowed (the LLM produced a fresh full config). But a malformed payload
    // must never touch the file.
    const r = runPigeon(["config-set", "--json", "{bad"], { home: h.home });
    assert.notEqual(r.status, 0);
    const still = fs.readFileSync(configFile(h.pigeonHome), "utf8");
    assert.equal(still, broken, "broken file must remain byte-identical");
  } finally {
    h.cleanup();
  }
});

test("atomic write leaves no .tmp turds", () => {
  const h = makeHome();
  try {
    const r = runPigeon(["config-set", "--json", JSON.stringify(sampleConfig())], {
      home: h.home,
    });
    assert.equal(r.status, 0, r.stderr);
    const leftovers = fs.readdirSync(h.pigeonHome).filter((n) => n.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    h.cleanup();
  }
});
