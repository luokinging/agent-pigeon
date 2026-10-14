// registry.mjs — pure projections over a loaded config.
// Answers: model → provider → protocol; default client; default effort.
// No I/O, no validation side effects (validation lives in resolve.mjs).

import { CLIENTS, getClient, knownClientNames } from "./clients/index.mjs";
import { getNativeProvider, isNativeProvider } from "./native.mjs";

export function listModels(config) {
  return Object.keys(config.models || {});
}

export function getModel(config, modelName) {
  return (config.models && config.models[modelName]) || null;
}

// Config providers first, then built-in native providers (codex-native / claude-native).
// Native providers are auto-present so a model can reference one without it being in config.
export function getProvider(config, providerName) {
  return (config.providers && config.providers[providerName]) || getNativeProvider(providerName) || null;
}

export { isNativeProvider };

// Provider for a given model name.
export function providerForModel(config, modelName) {
  const m = getModel(config, modelName);
  if (!m) return null;
  return getProvider(config, m.provider);
}

// Default client = first entry in model.clients.
export function defaultClient(model) {
  if (!model || !Array.isArray(model.clients) || !model.clients.length) return null;
  return model.clients[0];
}

// Default effort = first entry in model.effort that is legal for the given client.
export function defaultEffortForClient(model, clientName) {
  const adapter = getClient(clientName);
  if (!adapter || !model || !Array.isArray(model.effort)) return null;
  for (const e of model.effort) {
    if (adapter.allowedEffort.has(e)) return e;
  }
  return null;
}

// Clients listed by the model that are both known AND protocol-compatible with
// the model's provider. Used for "available client" hints in error messages.
export function compatibleClients(config, modelName) {
  const model = getModel(config, modelName);
  const prov = providerForModel(config, modelName);
  if (!model || !Array.isArray(model.clients)) return [];
  return model.clients.filter((c) => {
    const adapter = getClient(c);
    if (!adapter) return false;
    if (!prov || !Array.isArray(prov.protocols)) return false;
    return prov.protocols.includes(adapter.protocol);
  });
}

// Is `clientName` a valid driver for `modelName`?
// Returns { ok, reason } so resolve.mjs can produce precise errors.
export function clientValidForModel(config, modelName, clientName) {
  const model = getModel(config, modelName);
  if (!model) return { ok: false, reason: "model-missing" };
  if (!Array.isArray(model.clients) || !model.clients.includes(clientName)) {
    return { ok: false, reason: "not-in-model-clients" };
  }
  const adapter = getClient(clientName);
  if (!adapter) return { ok: false, reason: "unknown-client" };
  const prov = providerForModel(config, modelName);
  if (!prov || !Array.isArray(prov.protocols) || !prov.protocols.includes(adapter.protocol)) {
    return { ok: false, reason: "protocol-incompatible" };
  }
  return { ok: true };
}

export { CLIENTS, getClient, knownClientNames };
