---
description: Configure pigeon providers / models / api keys / base urls / effort lists / default client via a natural-language back-and-forth.
allowed-tools: Bash(node:*), AskUserQuestion
---

This command takes no arguments — the user just ran `/pigeon:config` and hasn't said what to configure yet. You configure pigeon's `~/.pigeon/config.json`: the runtime doesn't parse natural language, so you turn what the user says into a structured JSON patch, confirm it, then persist it by calling the runtime.

Start by asking what they want to set, with concrete options: add or edit a provider (its base_url per protocol + api key); add or edit a model (its provider, the model_id passed to the client, which clients can drive it, and — only if that model supports it — an effort list); or set a model's default client / effort ordering. Use `AskUserQuestion` for the high-level choice if it helps, then collect the specifics in conversation. Don't assume — if a needed field is missing (a protocol's base_url, the api key, the provider a model belongs to), ask for it.

Turn the answer into the config-set patch shape (it mirrors `~/.pigeon/config.json`; include only the keys being set — a partial patch is fine):

```jsonc
{
  "providers": {
    "<name>": {
      "protocols": ["anthropic", "openai"],
      "base_url": { "anthropic": "https://...", "openai": "https://..." },
      "api_key": "<plaintext>"
    }
  },
  "models": {
    "<name>": {
      "provider": "<provider-name>",
      "model_id": "<id passed to the client>",
      "clients": ["claude", "codex"],
      "effort":  ["high", "medium", "low"]
    }
  }
}
```

`clients` and `effort` are ordered — the first entry is the default. `effort` is optional; include it only for models that actually support effort levels. Known clients are `claude` (anthropic protocol) and `codex` (openai protocol), and a model's clients must be drivable by its provider's protocols.

**Native providers — run a client keyless, no api key.** Besides configured (key + endpoint) providers, pigeon auto-provides two **native providers** that need no config: `codex-native` (openai) and `claude-native` (anthropic). A model on a native provider injects no auth — the client uses whatever it already has on this machine (its own session, or a global env). They appear automatically when the client binary is installed.

Use this when the user wants to run a model through `codex` / `claude` **without** giving pigeon a key — e.g. "use my Codex for gpt-5.5 and gpt-5.4". You hang one model per `model_id` on the native provider, and they can run in parallel:

```jsonc
{
  "models": {
    "gpt-5.5": { "provider": "codex-native", "model_id": "gpt-5.5", "clients": ["codex"] },
    "gpt-5.4": { "provider": "codex-native", "model_id": "gpt-5.4", "clients": ["codex"] }
  }
}
```

Note: a native-provider model carries **no `api_key`, no `base_url`** — you only write the model (the provider is built-in). Before saving, sanity-check the CLI and a model id:
- `codex --version` (if missing, tell the user to install the `codex` CLI and stop).
- Confirm the `model_id` runs: `codex exec -m <id> 'say OK'`. (A ChatGPT-account login accepts only the models that account is entitled to — e.g. `gpt-5.5` / `gpt-5.4` — and rejects others with HTTP 400; pick one that works.)
- Do not add a native provider to `providers` — it is auto-present; just reference it from the model.

Echo back a readable summary of exactly what will be written and get an explicit yes before writing. If the patch would overwrite a value that already exists, call that out and confirm the overwrite first — to see what's already there, run `pigeon.mjs list`. Then persist:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pigeon.mjs" config-set --json '<structured JSON>'
```

The runtime validates the patch (provider protocols legal, base_url matches each protocol, model.provider exists, clients known and protocol-compatible, each effort item legal for at least one client) and atomically writes the file. If it rejects the patch, relay the error and fix the JSON rather than retrying blindly. Show the runtime's success or error output to the user when done.
