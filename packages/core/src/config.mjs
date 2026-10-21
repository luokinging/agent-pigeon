// Configuration and immutable session routing. Node built-ins only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RUNNERS = Object.freeze(Object.fromEntries([
  ["claude", ["anthropic-messages"], ["low", "medium", "high", "xhigh", "max"]],
  ["codex", ["openai-responses"], ["none", "minimal", "low", "medium", "high", "xhigh"]],
  ["hermes", ["openai-chat-completions"], ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]],
].map(([name, protocols, efforts]) => [name, Object.freeze({
  name, protocols: Object.freeze(protocols), efforts: Object.freeze(efforts),
  mode: { claude: "stream-json", codex: "app-server", hermes: "gateway" }[name],
  authentication: Object.freeze(name === "codex" ? ["runner-managed", "api-key", "none"] : ["runner-managed", "api-key"]),
  native: true, resume: true, events: true, steer: true, cancel: true,
  steerMode: { claude: "execution-boundary", codex: "after-tool-completion", hermes: "gateway-boundary" }[name],
  limitations: Object.freeze(name === "hermes" ? ["managed-worker-unsupported"] : []),
})])));

const PROTOCOLS = new Set(Object.values(RUNNERS).flatMap((r) => r.protocols));
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim() !== "";
const nativeRunner = (name) => Object.keys(RUNNERS).find((r) => name === `${r}-native`);

export function home() {
  return process.env.PIGEON_HOME || path.join(os.homedir(), ".pigeon");
}

export function loadConfig() {
  const file = path.join(home(), "config.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, providers: {}, models: {}, presets: {} };
    throw new Error(`Cannot read config ${file}: ${error.message}`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    // Do not include source text: syntax errors may contain credentials.
    throw new Error(`Invalid JSON in config ${file}; the file was not modified.`);
  }
  if (!object(config)) throw new Error("Config top level must be an object.");
  return config;
}

function protocolName(protocol, provider = {}) {
  if (protocol === "anthropic") return "anthropic-messages";
  if (protocol === "openai") {
    if (provider.wire_api === "chat" || provider.wire_api === "chat-completions") return "openai-chat-completions";
    return "openai-responses";
  }
  return protocol;
}

function endpoint(value) {
  if (!text(value)) throw new Error("Missing base_url for protocol.");
  let url;
  try { url = new URL(value); } catch { throw new Error("base_url must be an HTTP(S) URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("base_url must be an HTTP(S) URL without credentials, query, or fragment.");
  }
  return value;
}

function providerDetails(provider, requireKey = true) {
  if (!object(provider)) throw new Error("Provider must be an object.");
  if (provider.authMode !== undefined || provider.native !== undefined) {
    throw new Error("Use a built-in native provider for runner-managed authentication.");
  }
  if (!Array.isArray(provider.protocols) || !provider.protocols.length) {
    throw new Error("Provider protocols must be a non-empty array.");
  }
  if (provider.wire_api !== undefined && !["responses", "chat", "chat-completions"].includes(provider.wire_api)) {
    throw new Error("Unknown legacy wire_api; select responses or chat explicitly.");
  }
  const endpoints = {};
  for (const value of provider.protocols) {
    const protocol = protocolName(value, provider);
    if (!PROTOCOLS.has(protocol)) throw new Error(`Unknown protocol "${value}".`);
    const urls = provider.base_url ?? provider.baseUrl;
    const url = endpoint(typeof urls === "string" ? urls : object(urls) ? own(urls, value) ?? own(urls, protocol) : null);
    if (endpoints[protocol] && endpoints[protocol] !== url) throw new Error(`Conflicting endpoints for ${protocol}.`);
    endpoints[protocol] = url;
  }
  if (provider.auth !== undefined && !object(provider.auth)) throw new Error("Provider auth must be an object.");
  const authMode = provider.auth?.type ?? "api-key";
  if (!["api-key", "none"].includes(authMode)) throw new Error(`Unsupported authentication type "${authMode}".`);
  const env = provider.api_key_env ?? provider.apiKeyEnv ?? provider.auth?.env;
  const key = provider.api_key ?? provider.apiKey;
  if (env !== undefined && (!text(env) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env))) {
    throw new Error("api_key_env must name an environment variable.");
  }
  if (key !== undefined && !text(key)) throw new Error("api_key must be a non-empty string.");
  if (env !== undefined && key !== undefined) throw new Error("Choose api_key or api_key_env, not both.");
  if (authMode === "none" && (env !== undefined || key !== undefined)) throw new Error("Authentication type none cannot include an API key.");
  const apiKey = authMode === "none" ? null : env ? process.env[env] : key;
  if (authMode === "api-key" && (!env && !key || requireKey && !text(apiKey))) {
    throw new Error("Provider is missing api_key or its configured key environment variable.");
  }
  return { endpoints, authMode, apiKey: apiKey ?? null };
}

function configShape(config) {
  if (!object(config)) throw new Error("Config top level must be an object.");
  for (const key of ["providers", "models", "presets"]) {
    if (config[key] !== undefined && !object(config[key])) throw new Error(`${key} must be an object.`);
  }
}

function runnerOption(options) {
  if (options.runner !== undefined && options.client !== undefined && options.runner !== options.client) {
    throw new Error("Conflicting --runner and --client options.");
  }
  return options.runner ?? options.client;
}

function runnerScope(runner, cwd) {
  const variables = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", hermes: "HERMES_HOME" };
  const value = process.env[variables[runner]] || path.join(os.homedir(), `.${runner}`);
  const expanded = value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(cwd, expanded);
}

function resolve(options, config, cwd, requireKey = true) {
  configShape(config);
  if (!object(options)) throw new Error("Binding options must be an object.");
  for (const key of ["preset", "provider", "runner", "client", "model", "protocol", "effort", "legacyModel"]) {
    if (options[key] !== undefined && !text(options[key])) throw new Error(`${key} must be a non-empty string.`);
  }
  let preset = {};
  if (options.preset !== undefined) {
    preset = own(config.presets ?? {}, options.preset);
    if (!object(preset)) throw new Error(`Unknown preset "${options.preset}".`);
  }
  let legacy = {};
  if (options.legacyModel !== undefined) {
    if (options.preset !== undefined || options.model !== undefined) throw new Error("legacyModel cannot be combined with preset or model.");
    const model = own(config.models ?? {}, options.legacyModel);
    if (!object(model)) throw new Error(`Unknown legacy model "${options.legacyModel}".`);
    legacy = { provider: model.provider, model: model.model_id, runner: model.clients?.[0] };
  }
  const selected = { ...legacy, ...preset };
  for (const key of ["provider", "model", "protocol", "effort"]) {
    if (options[key] !== undefined) selected[key] = options[key];
  }
  let runner = runnerOption(options) ?? runnerOption(selected) ?? nativeRunner(selected.provider) ?? config.defaultRunner;
  if (runner !== undefined && !own(RUNNERS, runner)) throw new Error(`Unknown runner "${runner}".`);
  let provider = selected.provider;
  if (provider === undefined && runner !== undefined) provider = `${runner}-native`;
  if (provider === undefined) {
    const providers = Object.keys(config.providers ?? {});
    if (providers.length !== 1) throw new Error("Specify provider or runner; configuration does not determine a unique provider.");
    [provider] = providers;
  }
  const managedRunner = nativeRunner(provider);
  if (managedRunner && own(config.providers ?? {}, provider) !== undefined) throw new Error("Native provider names are reserved.");
  let details;
  if (managedRunner) {
    runner ??= managedRunner;
    if (runner !== managedRunner) throw new Error(`Provider ${provider} requires runner ${managedRunner}.`);
    if (selected.protocol !== undefined) throw new Error("Native runner-managed mode does not select an API protocol.");
  } else {
    const definition = own(config.providers ?? {}, provider);
    if (!definition) throw new Error(`Unknown provider "${provider}".`);
    details = providerDetails(definition, requireKey);
    if (selected.protocol !== undefined && !PROTOCOLS.has(selected.protocol)) throw new Error(`Unknown protocol "${selected.protocol}".`);
    if (runner === undefined) {
      const candidates = Object.keys(RUNNERS).filter((name) => RUNNERS[name].protocols.some((protocol) =>
        details.endpoints[protocol] && (selected.protocol === undefined || selected.protocol === protocol)));
      if (candidates.length !== 1) throw new Error("Specify runner; configuration does not determine a unique compatible runner.");
      [runner] = candidates;
    }
  }
  if (!own(RUNNERS, runner)) throw new Error(`Unknown runner "${runner}".`);
  if (details && !RUNNERS[runner].authentication.includes(details.authMode)) {
    const error = new Error(`Runner ${runner} does not support authentication type ${details.authMode}; allowed: ${RUNNERS[runner].authentication.join(", ")}.`);
    error.code = "UNSUPPORTED_AUTH_MODE";
    throw error;
  }
  let protocol = null;
  if (!managedRunner) {
    const compatible = RUNNERS[runner].protocols.filter((value) => details.endpoints[value]);
    if (selected.protocol !== undefined) {
      if (!compatible.includes(selected.protocol)) throw new Error(`Protocol ${selected.protocol} is incompatible with provider ${provider} and runner ${runner}.`);
      protocol = selected.protocol;
    } else {
      if (compatible.length !== 1) throw new Error(`Specify a compatible protocol for provider ${provider} and runner ${runner}; no unique protocol is available.`);
      [protocol] = compatible;
    }
    if (!text(selected.model)) throw new Error("Provider mode requires an actual model ID (--model).");
  }
  const model = selected.model ?? null;
  const effort = selected.effort ?? null;
  if (model !== null && !text(model)) throw new Error("model must be a non-empty string.");
  if (effort !== null) {
    if (!RUNNERS[runner].efforts.includes(effort)) throw new Error(`Invalid effort "${effort}" for runner ${runner}. Allowed: ${RUNNERS[runner].efforts.join(", ")}.`);
    // Constraints describe user configuration, not a claim of actual model support.
    for (const entry of Object.values(config.models ?? {})) {
      if (object(entry) && entry.provider === provider && entry.model_id === model && entry.effort !== undefined) {
        if (!Array.isArray(entry.effort) || !entry.effort.includes(effort)) throw new Error(`Effort ${effort} is outside configured model effort constraints for ${model}.`);
      }
    }
  }
  const resolvedCwd = path.resolve(cwd);
  return {
    runner, mode: RUNNERS[runner].mode, provider,
    protocol, model, effort, native: Boolean(managedRunner), cwd: resolvedCwd,
    scope: runnerScope(runner, resolvedCwd), baseUrl: details?.endpoints[protocol] ?? null,
    authMode: details?.authMode ?? "runner-managed", apiKey: details?.apiKey ?? null,
  };
}

export function resolveBinding(options = {}, { config = loadConfig(), cwd = process.cwd() } = {}) {
  return resolve(options, config, cwd);
}

export function validateConfig(config) {
  try { configShape(config); } catch (error) { return [error.message]; }
  const errors = [];
  if (config.defaultRunner !== undefined && !own(RUNNERS, config.defaultRunner)) errors.push("Unknown defaultRunner.");
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    try {
      if (nativeRunner(name)) throw new Error("Native provider names are reserved.");
      providerDetails(provider, false);
    } catch (error) { errors.push(`provider "${name}": ${error.message}`); }
  }
  for (const [name, model] of Object.entries(config.models ?? {})) {
    const tag = `model "${name}"`;
    if (!object(model)) { errors.push(`${tag} must be an object.`); continue; }
    if (!text(model.model_id)) errors.push(`${tag} must have model_id.`);
    if (!text(model.provider) || !nativeRunner(model.provider) && !own(config.providers ?? {}, model.provider)) errors.push(`${tag} references an unknown provider.`);
    if (model.effort !== undefined && (!Array.isArray(model.effort) || model.effort.some((value) => !text(value)))) errors.push(`${tag} effort must be an array of strings.`);
    if (Array.isArray(model.effort) && model.effort.length) {
      const runners = Array.isArray(model.clients) ? model.clients : Object.keys(RUNNERS);
      if (!model.effort.some((effort) => runners.some((runner) => own(RUNNERS, runner)?.efforts.includes(effort)))) {
        errors.push(`${tag} effort has no value allowed by its configured runners.`);
      }
    }
    if (model.clients !== undefined) {
      if (!Array.isArray(model.clients) || !model.clients.length) errors.push(`${tag} clients must be a non-empty array.`);
      else for (const runner of model.clients) {
        try { resolve({ provider: model.provider, model: model.model_id, runner }, config, process.cwd(), false); }
        catch (error) { errors.push(`${tag}: ${error.message}`); }
      }
    }
  }
  for (const [name, preset] of Object.entries(config.presets ?? {})) {
    try {
      if (!object(preset)) throw new Error("Preset must be an object.");
      resolve({ ...preset, preset: name }, config, process.cwd(), false);
    } catch (error) { errors.push(`preset "${name}": ${error.message}`); }
  }
  return errors;
}

const PUBLIC_FIELDS = ["runner", "mode", "provider", "protocol", "model", "effort", "native", "cwd", "scope", "baseUrl", "authMode"];

export function publicBinding(binding) {
  // Copy scalar fields only; never serialize arbitrary nested provider or env objects.
  return Object.fromEntries(PUBLIC_FIELDS.filter((key) => Object.hasOwn(binding, key)).map((key) => {
    const value = binding[key];
    if (value !== null && !["string", "boolean"].includes(typeof value)) throw new Error(`Invalid binding field ${key}.`);
    if (key === "baseUrl" && value !== null) endpoint(value);
    return [key, value];
  }));
}

export function restoreBinding(saved, { config = loadConfig() } = {}) {
  if (!object(saved) || PUBLIC_FIELDS.some((key) => !Object.hasOwn(saved, key))) throw new Error("Incomplete saved binding; cannot safely restore session identity.");
  const options = { runner: saved.runner, provider: saved.provider };
  for (const key of ["model", "protocol", "effort"]) if (saved[key] !== null) options[key] = saved[key];
  const binding = resolveBinding(options, { config, cwd: saved.cwd });
  for (const key of PUBLIC_FIELDS) {
    if (binding[key] !== saved[key]) throw new Error(`Session binding ${key} changed; cannot resume against a different route or identity.`);
  }
  return binding;
}
