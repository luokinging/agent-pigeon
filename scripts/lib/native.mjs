// native.mjs — built-in "native" providers: a model source whose auth pigeon does
// NOT inject. pigeon passes no api_key / base_url; the client uses whatever it
// already has on this machine (its own session, or a globally-set env). These
// providers are auto-present (never written to config) — one per client protocol.
// A model references one and pins its own model_id to run keyless; you can hang
// several models on the same native provider (e.g. gpt-5.5 and gpt-5.4 on
// codex-native) and run them in parallel.
//
// Availability is the client binary's presence, checked at list/resolve time —
// a model on codex-native only shows/runs when the `codex` CLI is installed.
//
// A native provider: { authMode:"native", protocols:[<the protocol its clients speak>] }.

export const NATIVE_PROVIDERS = Object.freeze({
  "codex-native": Object.freeze({ authMode: "native", protocols: ["openai"] }),
  "claude-native": Object.freeze({ authMode: "native", protocols: ["anthropic"] }),
});

export function isNativeProviderName(name) {
  return Object.prototype.hasOwnProperty.call(NATIVE_PROVIDERS, name);
}

export function getNativeProvider(name) {
  return isNativeProviderName(name) ? NATIVE_PROVIDERS[name] : null;
}

export function nativeProviderNames() {
  return Object.keys(NATIVE_PROVIDERS);
}

// True for a provider object whose auth is inherited from the client (no key injection).
export function isNativeProvider(provider) {
  return Boolean(provider && provider.authMode === "native");
}
