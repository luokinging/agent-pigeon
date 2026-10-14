// index.mjs — client adapter registry.
// Adding a new client = drop a `<name>.mjs` adapter here. registry/resolve/runtime
// never change. Each adapter implements the unified interface:
//   { name, protocol, allowedEffort:Set, buildInvocation, parseResult, extractSessionId }

import claude from "./claude.mjs";
import codex from "./codex.mjs";

const ADAPTERS = [claude, codex];

// name -> adapter
export const CLIENTS = Object.freeze(
  Object.fromEntries(ADAPTERS.map((a) => [a.name, a]))
);

export function getClient(name) {
  return CLIENTS[name] || null;
}

export function knownClientNames() {
  return Object.keys(CLIENTS);
}

// protocol -> [client names that speak it]
export function clientsForProtocol(protocol) {
  return Object.values(CLIENTS)
    .filter((a) => a.protocol === protocol)
    .map((a) => a.name);
}
