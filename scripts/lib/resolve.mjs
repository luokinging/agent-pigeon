// resolve.mjs — (model, client?, effort?) → full execution context.
// Contains ALL the ordered fail-fast validation. Every error lists the available
// options so the caller (and the user) can self-correct.
//
// Returned execution context (the contract other modules rely on):
//
//   {
//     model,            // model name as given
//     modelId,          // model.model_id (what the client actually receives)
//     provider,         // provider name
//     protocol,         // protocol the chosen client speaks (== adapter.protocol)
//     client,           // resolved client name
//     adapter,          // the client adapter object (adapter interface)
//     effort,           // resolved effort (legal for client)
//     baseUrl,          // provider.base_url[protocol]
//     apiKey,           // provider.api_key (plaintext)
//     binaryPath,       // absolute path to the client binary (PATH-resolved)
//     cwd,              // absolute working dir
//     threadKey,        // sha1(cwd|model|client) — resume/serialization key
//   }
//
// On any validation failure throws a ResolveError with a `.code` and a message
// that already enumerates the valid alternatives.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  getModel,
  getProvider,
  providerForModel,
  defaultClient,
  defaultEffortForClient,
  compatibleClients,
  clientValidForModel,
  listModels,
  isNativeProvider,
} from "./registry.mjs";
import { getClient } from "./clients/index.mjs";

export class ResolveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResolveError";
    this.code = code;
  }
}

// thread_key = sha1(cwd|model|client). resume + same-thread serialization key.
export function threadKey(cwd, model, client) {
  return createHash("sha1").update(`${cwd}|${model}|${client}`).digest("hex");
}

// Resolve a client binary on PATH (honours a leading test/mock-bin override).
// Returns absolute path or null. No execution — just existence + executable bit.
export function resolveBinary(command, env = process.env) {
  if (command.includes(path.sep)) {
    return isExecutable(command) ? path.resolve(command) : null;
  }
  const PATH = env.PATH || "";
  const exts = process.platform === "win32" ? (env.PATHEXT || ".EXE").split(";") : [""];
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// /pigeon:continue only: rebuild the execution context from the job's persisted **original backend
// identity** (provider/model_id/protocol/client/effort/wire_api), taking only api_key/base_url at
// their **current** values (allows credential rotation).
// Bypasses the model alias → even if the model name is later repointed to a different
// model_id/provider, the old thread still resumes against the original backend.
export function resolveForContinue(config, base, opts = {}) {
  const env = opts.env || process.env;
  const cwd = base.cwd ? path.resolve(base.cwd) : process.cwd();

  // Back-compat: jobs created before native moved to the provider layer persisted native:true with
  // no provider (and no pinned model_id). Rebuild that keyless context directly from the client.
  if (base.native && !base.provider) {
    const adapter = getClient(base.client);
    if (!adapter) {
      throw new ResolveError("client-invalid", `The original job's client "${base.client}" is unavailable.`);
    }
    const binaryPath = resolveBinary(base.client, env);
    if (!binaryPath) {
      throw new ResolveError("client-not-installed", `client "${base.client}" is not installed; cannot continue.`);
    }
    if (base.effort && !adapter.allowedEffort.has(base.effort)) {
      throw new ResolveError("effort-invalid", `effort "${base.effort}" is invalid for client "${base.client}".`);
    }
    return {
      model: base.model,
      modelId: base.model_id ?? null,
      provider: null,
      protocol: base.protocol ?? adapter.protocol,
      client: base.client,
      adapter,
      effort: base.effort ?? null,
      baseUrl: null,
      apiKey: null,
      binaryPath,
      cwd,
      threadKey: base.thread_key ?? threadKey(cwd, base.model, base.client),
      wireApi: null,
      timeoutMs: Number.isFinite(base.timeout_ms) ? base.timeout_ms : null,
      native: true,
    };
  }

  const provider = getProvider(config, base.provider);
  if (!provider) {
    throw new ResolveError("provider-missing", `The original job's provider "${base.provider}" no longer exists; cannot continue.`);
  }
  const adapter = getClient(base.client);
  if (!adapter) {
    throw new ResolveError("client-invalid", `The original job's client "${base.client}" is unavailable.`);
  }
  const protocol = base.protocol ?? adapter.protocol;
  if (!Array.isArray(provider.protocols) || !provider.protocols.includes(protocol)) {
    throw new ResolveError("protocol-incompatible", `provider "${base.provider}" no longer supports protocol "${protocol}"; cannot continue.`);
  }
  const binaryPath = resolveBinary(base.client, env);
  if (!binaryPath) {
    throw new ResolveError("client-not-installed", `client "${base.client}" is not installed; cannot continue.`);
  }
  if (base.effort && !adapter.allowedEffort.has(base.effort)) {
    throw new ResolveError("effort-invalid", `effort "${base.effort}" is invalid for client "${base.client}".`);
  }
  // Native providers (codex-native / claude-native) inherit the client's own auth → no key/base_url.
  const native = isNativeProvider(provider);
  let baseUrl = null;
  let apiKey = null;
  if (!native) {
    baseUrl = provider.base_url && provider.base_url[protocol];
    if (!baseUrl) {
      throw new ResolveError("base-url-missing", `provider "${base.provider}" is missing a base_url for the ${protocol} protocol.`);
    }
    if (typeof provider.api_key !== "string" || provider.api_key.trim() === "") {
      throw new ResolveError("api-key-missing", `provider "${base.provider}" is missing api_key.`);
    }
    apiKey = provider.api_key;
  }

  return {
    model: base.model,
    modelId: base.model_id ?? base.model,
    provider: base.provider,
    protocol,
    client: base.client,
    adapter,
    effort: base.effort,
    baseUrl,
    apiKey,
    binaryPath,
    cwd,
    threadKey: base.thread_key ?? threadKey(cwd, base.model, base.client),
    wireApi: base.wire_api ?? null,
    timeoutMs: Number.isFinite(base.timeout_ms) ? base.timeout_ms : null,
    native,
  };
}

// Main entry. Ordered fail-fast validation.
//   opts = { model, client?, effort?, taskPrompt?, cwd?, env? }
// taskPrompt is validated here (§8.7) when provided; resolve is also usable for
// `continue`/dry checks by passing a non-empty taskPrompt.
export function resolve(config, opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();

  // §8.1 — --model missing
  const model = opts.model;
  if (!model || typeof model !== "string" || model.trim() === "") {
    throw new ResolveError("model-missing", "Missing --model. Specify a model with --model <name>.");
  }

  // §8.2 — model not in config
  const modelDef = getModel(config, model);
  if (!modelDef) {
    const known = listModels(config);
    throw new ResolveError(
      "model-unknown",
      `Unknown model "${model}". Known models: ${known.length ? known.join(", ") : "(none — run /pigeon:config first)"}.`
    );
  }

  const providerName = modelDef.provider;
  const provider = getProvider(config, providerName);
  if (!provider) {
    throw new ResolveError(
      "provider-missing",
      `The provider "${providerName}" referenced by model "${model}" does not exist. Check your config or run /pigeon:config.`
    );
  }

  // §8.3 — resolve client
  let client = opts.client;
  if (client) {
    const check = clientValidForModel(config, model, client);
    if (!check.ok) {
      const avail = compatibleClients(config, model);
      let why;
      if (check.reason === "not-in-model-clients") {
        why = `client "${client}" is not in model "${model}"'s clients list`;
      } else if (check.reason === "unknown-client") {
        why = `unknown client "${client}"`;
      } else if (check.reason === "protocol-incompatible") {
        const adapter = getClient(client);
        why = `client "${client}" speaks the ${adapter ? adapter.protocol : "?"} protocol, which is incompatible with the protocols exposed by provider "${providerName}"`;
      } else {
        why = `client "${client}" is unavailable`;
      }
      throw new ResolveError(
        "client-invalid",
        `${why}. Clients available for this model: ${avail.length ? avail.join(", ") : "(none)"}.`
      );
    }
  } else {
    client = defaultClient(modelDef);
    if (!client) {
      throw new ResolveError("client-missing", `model "${model}" has no clients configured.`);
    }
    // default client must still be protocol-compatible
    const check = clientValidForModel(config, model, client);
    if (!check.ok) {
      const avail = compatibleClients(config, model);
      throw new ResolveError(
        "client-invalid",
        `The default client "${client}" for model "${model}" is unavailable (${check.reason}). Available clients: ${avail.length ? avail.join(", ") : "(none)"}.`
      );
    }
  }

  const adapter = getClient(client);
  const protocol = adapter.protocol;

  // §8.4 — client binary installed?
  const binaryPath = resolveBinary(client, env);
  if (!binaryPath) {
    const avail = compatibleClients(config, model).filter((c) => resolveBinary(c, env));
    throw new ResolveError(
      "client-not-installed",
      `client "${client}" is not installed (no executable "${client}" found on PATH). Install it, or switch to an installed client: ${avail.length ? avail.join(", ") : "(none available)"}.`
    );
  }

  // §8.5 — resolve effort (OPTIONAL: a model may declare no effort, e.g. providers with no thinking control)
  const hasEffort = Array.isArray(modelDef.effort) && modelDef.effort.length > 0;
  let effort = opts.effort;
  if (effort) {
    if (!hasEffort) {
      throw new ResolveError(
        "effort-unsupported",
        `model "${model}" has no configured effort; drop --effort (this model exposes no effort/thinking control).`
      );
    }
    const inModel = modelDef.effort.includes(effort);
    const legalForClient = adapter.allowedEffort.has(effort);
    if (!inModel || !legalForClient) {
      const legal = modelDef.effort.filter((e) => adapter.allowedEffort.has(e));
      throw new ResolveError(
        "effort-invalid",
        `effort "${effort}" is invalid for model "${model}" + client "${client}". Valid values: ${legal.length ? legal.join(", ") : "(none — model " + model + "'s effort list has no valid entry for client " + client + ")"}.`
      );
    }
  } else if (hasEffort) {
    effort = defaultEffortForClient(modelDef, client);
    if (!effort) {
      throw new ResolveError(
        "effort-missing",
        `None of the entries in model "${model}"'s effort list [${modelDef.effort.join(", ")}] is valid for client "${client}".`
      );
    }
  } else {
    effort = null; // model has no effort
  }

  // §8.6 — credentials. A native provider (codex-native / claude-native) inherits the client's
  // own auth (its session, or a global env), so pigeon needs no provider base_url/api_key.
  const native = isNativeProvider(provider);
  let baseUrl = null;
  let apiKey = null;
  if (!native) {
    baseUrl = provider.base_url && provider.base_url[protocol];
    if (!baseUrl) {
      throw new ResolveError(
        "base-url-missing",
        `provider "${providerName}" is missing a base_url for the ${protocol} protocol. Run /pigeon:config to fill it in.`
      );
    }
    if (typeof provider.api_key !== "string" || provider.api_key.trim() === "") {
      throw new ResolveError(
        "api-key-missing",
        `provider "${providerName}" is missing api_key. Run /pigeon:config to fill it in.`
      );
    }
    apiKey = provider.api_key;
  }

  // §8.7 — task prompt non-empty (only checked when provided)
  if (opts.taskPrompt !== undefined) {
    if (typeof opts.taskPrompt !== "string" || opts.taskPrompt.trim() === "") {
      throw new ResolveError("task-empty", "Task body is empty. Provide the task content after `--`.");
    }
  }

  // Optional wire_api (only for the openai protocol / codex client): model takes precedence,
  // then provider; if absent let the adapter decide (codex >=0.139 defaults to responses).
  const wireApi = modelDef.wire_api ?? provider.wire_api ?? null;

  // Optional per-model/provider timeout (ms). Returns null when absent → no execution time limit.
  const timeoutMs = Number.isFinite(modelDef.timeout_ms)
    ? modelDef.timeout_ms
    : Number.isFinite(provider.timeout_ms)
      ? provider.timeout_ms
      : null;

  return {
    timeoutMs,
    model,
    modelId: modelDef.model_id,
    provider: providerName,
    protocol,
    client,
    adapter,
    effort,
    baseUrl,
    apiKey,
    binaryPath,
    cwd,
    threadKey: threadKey(cwd, model, client),
    wireApi,
    native,
  };
}
