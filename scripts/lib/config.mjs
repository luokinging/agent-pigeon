// config.mjs — read/write ~/.pigeon/config.json
// Atomic write (temp file + rename), write lock, refuse-to-overwrite-on-parse-error,
// structural validation.
//
// Zero third-party deps. Node built-ins only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLIENTS } from "./clients/index.mjs";
import { getNativeProvider, isNativeProviderName } from "./native.mjs";

export const CONFIG_VERSION = 1;

export function pigeonHome() {
  return process.env.PIGEON_HOME || path.join(os.homedir(), ".pigeon");
}

export function configPath() {
  return path.join(pigeonHome(), "config.json");
}

function lockPath() {
  return configPath() + ".lock";
}

function ensureHome() {
  fs.mkdirSync(pigeonHome(), { recursive: true });
}

function emptyConfig() {
  return { version: CONFIG_VERSION, providers: {}, models: {} };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// Returns the parsed config, or an empty skeleton if the file does not exist.
// Throws (with a clear message) if the file exists but cannot be parsed — the
// caller must NOT then write back, so we never clobber a hand-broken file.
export function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return emptyConfig();
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err) {
    throw new Error(`Failed to read config file ${p}: ${err.message}`);
  }
  if (raw.trim() === "") return emptyConfig();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse config file ${p} (may have been hand-edited and broken): ${err.message}. The original file was kept and nothing was overwritten. Fix it and retry, or delete the file and run /pigeon:config again.`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file ${p} top level is not an object; the original file was kept and not overwritten.`);
  }
  if (!parsed.providers || typeof parsed.providers !== "object") parsed.providers = {};
  if (!parsed.models || typeof parsed.models !== "object") parsed.models = {};
  if (typeof parsed.version !== "number") parsed.version = CONFIG_VERSION;
  return parsed;
}

// ---------------------------------------------------------------------------
// Write lock (advisory, file-based). Serializes concurrent writers.
// ---------------------------------------------------------------------------

function acquireLock({ timeoutMs = 5000, staleMs = 30000 } = {}) {
  ensureHome();
  const lp = lockPath();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lp, "wx"); // exclusive create
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return lp;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Stale-lock reclaim.
      try {
        const st = fs.statSync(lp);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.rmSync(lp, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished; retry
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring config write lock (${lp}). There may be a concurrent writer or a leftover lock file.`);
      }
      sleepSync(40);
    }
  }
}

function releaseLock(lp) {
  try {
    fs.rmSync(lp, { force: true });
  } catch {
    /* best effort */
  }
}

function sleepSync(ms) {
  // Busy-ish wait without third-party deps; ms here is tiny (40ms).
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Atomics-based sleep to avoid pure spin.
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, end - Date.now()));
    } catch {
      /* fall through to loop check */
    }
  }
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

// Persists `config` atomically. Validates before writing. Holds the write lock
// for the whole read-merge-write cycle when `mutate` is provided.
export function saveConfig(config) {
  const errors = validateConfig(config);
  if (errors.length) {
    throw new Error("Config validation failed:\n  - " + errors.join("\n  - "));
  }
  ensureHome();
  const lp = acquireLock();
  try {
    // If a config already exists on disk and has been hand-broken (unparseable), refuse to overwrite, error out, and keep the original file.
    const cp = configPath();
    if (fs.existsSync(cp)) {
      const raw = fs.readFileSync(cp, "utf8");
      if (raw.trim()) {
        try {
          JSON.parse(raw);
        } catch (e) {
          throw new Error(
            `Failed to parse existing ~/.pigeon/config.json (likely hand-broken): ${e.message}. ` +
              `Write refused to avoid overwriting it; fix or delete the file and retry.`
          );
        }
      }
    }
    atomicWrite(cp, JSON.stringify(config, null, 2) + "\n");
  } finally {
    releaseLock(lp);
  }
  return config;
}

// Deep-merge a partial patch into a base config object (plain objects merged
// recursively; arrays and scalars replaced wholesale). Used so /pigeon:config can
// send only the fields being edited without wiping untouched providers/models.
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

// /pigeon:config persistence: merge a partial patch into the existing config,
// then validate + atomically write (refuses if the on-disk file is unparseable).
export function patchConfig(patch) {
  if (!isPlainObject(patch)) {
    throw new Error("config patch must be an object");
  }
  return updateConfig((current) => deepMerge(current, patch));
}

// Read-modify-write under a single lock. `mutator(cfg)` mutates and/or returns
// the new config object. Refuses to proceed if the on-disk file is unparseable.
export function updateConfig(mutator) {
  ensureHome();
  const lp = acquireLock();
  try {
    const current = loadConfig(); // throws on parse error → no overwrite
    const next = mutator(current) || current;
    const errors = validateConfig(next);
    if (errors.length) {
      throw new Error("Config validation failed:\n  - " + errors.join("\n  - "));
    }
    atomicWrite(configPath(), JSON.stringify(next, null, 2) + "\n");
    return next;
  } finally {
    releaseLock(lp);
  }
}

function atomicWrite(target, content) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target); // atomic on same filesystem
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

const KNOWN_CLIENTS = new Set(Object.keys(CLIENTS));
// protocol → set of clients that speak it
const PROTOCOL_CLIENTS = (() => {
  const m = {};
  for (const [cname, adapter] of Object.entries(CLIENTS)) {
    if (!m[adapter.protocol]) m[adapter.protocol] = new Set();
    m[adapter.protocol].add(cname);
  }
  return m;
})();

// Returns array of human-readable error strings ([] === valid).
export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["Config top level must be an object."];
  }
  const providers = config.providers;
  const models = config.models;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    errors.push("providers must be an object.");
  }
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    errors.push("models must be an object.");
  }
  if (errors.length) return errors;

  // ---- providers ----
  for (const [pname, prov] of Object.entries(providers)) {
    const tag = `provider "${pname}"`;
    // Native provider names are reserved/built-in — a config provider must not shadow them
    // (doing so would silently turn off keyless auth and start injecting a key/base_url).
    if (isNativeProviderName(pname)) {
      errors.push(`${tag} is a reserved built-in native provider name; don't define it in config — reference it from a model instead.`);
      continue;
    }
    if (!prov || typeof prov !== "object") {
      errors.push(`${tag} must be an object.`);
      continue;
    }
    // `authMode` is reserved for built-in native providers. A configured provider must not set it,
    // else it could mark itself native and have pigeon silently skip its key/base_url.
    if (prov.authMode !== undefined) {
      errors.push(`${tag} must not set "authMode" — it is reserved for built-in native providers.`);
    }
    if (!Array.isArray(prov.protocols) || prov.protocols.length === 0) {
      errors.push(`${tag} must have a non-empty protocols array.`);
    } else {
      for (const proto of prov.protocols) {
        if (!PROTOCOL_CLIENTS[proto]) {
          errors.push(
            `${tag} declares unknown protocol "${proto}". Known protocols: ${Object.keys(PROTOCOL_CLIENTS).join(", ")}.`
          );
        }
      }
    }
    // Configured providers always carry a key + endpoint. (Native providers — codex-native /
    // claude-native — are auto-present and never written to config, so they don't appear here.)
    if (!prov.base_url || typeof prov.base_url !== "object" || Array.isArray(prov.base_url)) {
      errors.push(`${tag} must have a base_url object (keyed by protocol).`);
    } else if (Array.isArray(prov.protocols)) {
      for (const proto of prov.protocols) {
        const u = prov.base_url[proto];
        if (!u || typeof u !== "string") {
          errors.push(`${tag} is missing a base_url for protocol "${proto}".`);
        }
      }
    }
    if (typeof prov.api_key !== "string" || prov.api_key.trim() === "") {
      errors.push(`${tag} is missing api_key.`);
    }
  }

  // ---- models ----
  for (const [mname, model] of Object.entries(models)) {
    const tag = `model "${mname}"`;
    if (!model || typeof model !== "object") {
      errors.push(`${tag} must be an object.`);
      continue;
    }
    // A model may reference a configured provider OR a built-in native provider (codex-native / claude-native).
    const prov = providers[model.provider] || getNativeProvider(model.provider);
    if (!model.provider || typeof model.provider !== "string") {
      errors.push(`${tag} is missing provider.`);
    } else if (!prov) {
      errors.push(`${tag} references a nonexistent provider "${model.provider}".`);
    }
    if (typeof model.model_id !== "string" || model.model_id.trim() === "") {
      errors.push(`${tag} is missing model_id.`);
    }
    if (!Array.isArray(model.clients) || model.clients.length === 0) {
      errors.push(`${tag} must have a non-empty clients array (ordered; first = default).`);
    } else {
      for (const c of model.clients) {
        if (!KNOWN_CLIENTS.has(c)) {
          errors.push(
            `${tag} declares unknown client "${c}". Known clients: ${[...KNOWN_CLIENTS].join(", ")}.`
          );
          continue;
        }
        // protocol compatibility: client.protocol ∈ provider.protocols
        if (prov && Array.isArray(prov.protocols)) {
          const clientProto = CLIENTS[c].protocol;
          if (!prov.protocols.includes(clientProto)) {
            errors.push(
              `${tag}'s client "${c}" speaks the ${clientProto} protocol, but its provider "${model.provider}" only exposes [${prov.protocols.join(", ")}].`
            );
          }
        }
      }
    }
    // effort is OPTIONAL: most third-party models have no effort/thinking control. If present it must be
    // an array; if non-empty, at least one entry must be legal for one of the model's clients.
    if (model.effort !== undefined) {
      if (!Array.isArray(model.effort)) {
        errors.push(`${tag}'s effort, if present, must be an array.`);
      } else if (model.effort.length && Array.isArray(model.clients) && model.clients.length) {
        const validClients = model.clients.filter((c) => KNOWN_CLIENTS.has(c));
        const anyLegal = model.effort.some((e) =>
          validClients.some((c) => CLIENTS[c].allowedEffort.has(e))
        );
        if (validClients.length && !anyLegal) {
          errors.push(
            `${tag}'s effort list [${model.effort.join(", ")}] has no entry that is legal for any of its clients.`
          );
        }
      }
    }
  }

  return errors;
}
