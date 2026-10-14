# Claude Pigeon

> Delegate a chunk of work to **any vendor's model**, running on **any compatible CLI client**, in the background — and fetch the result back.

**pigeon** is a [Claude Code](https://code.claude.com) plugin. From your main Claude session you hand a self-contained task to GLM, DeepSeek, Kimi, MiniMax, Qwen, GPT/Codex — any model reachable through a CLI client on your machine — let it run in the background, and collect the result when it's done.

[简体中文](./README.zh-CN.md)

---

## Highlights

- **Any provider, one workflow** — drive any Anthropic-compatible model through the `claude` CLI, any OpenAI-compatible model through `codex`. Configure once, use them all the same way.
- **Native providers, no key** — run a model through `codex` / `claude` using the auth the client already has on your machine (its own session, or a global env). Hang several models on one native provider (e.g. gpt-xxx + gpt-yyy) and run them in parallel. See [Native providers](#native-providers-run-a-client-keyless).
- **Two background modes** — ride Claude Code's own background (`/pigeon:run`, get auto-notified) or pigeon-managed jobs (`/pigeon:work`, fan out & manage).
- **Parallel fan-out** — fire many tasks at once; track them with status / result / cancel / continue.
- **Natural-language trigger** — say "pigeon …" and it routes for you; no slash required.

## Requirements

- [Claude Code](https://code.claude.com).
- The client CLI you intend to use: **`claude`** (for Anthropic-protocol models) and/or **`codex`** (for OpenAI-protocol models).
- An API key for each configured provider. Models on a **native provider** (`codex-native` / `claude-native`) need none — they reuse the client's own auth.

## Install

```bash
claude plugin marketplace add luokinging/pigeon-cc
claude plugin install pigeon@pigeon-cc
```

Start a new Claude Code session — the `/pigeon:*` commands (and the `pigeon` natural-language trigger) become available.

To update to the latest version later:

```bash
claude plugin marketplace update pigeon-cc   # refresh the marketplace cache first
claude plugin update pigeon@pigeon-cc       # then pull the newest plugin version
```

Restart Claude Code to apply the update.

## Quick start

Model IDs such as `gpt-xxx`, `gpt-yyy`, `glm-xxx`, `GLM-xxx`, `deepseek-xxx`, and `claude-xxx` below are placeholders, not runnable model names. Replace them with IDs supported by your provider and accessible to your account; configure the matching aliases with `/pigeon:config` before running the examples. Effort support and context limits depend on the actual model and endpoint.

```text
/pigeon:config                  # conversational: add models — configured (with a key) or native (keyless)
/pigeon:list                    # see your models
/pigeon:run --model gpt-xxx -- summarize ./src architecture in 5 bullets   # native (your Codex), keyless
/pigeon:run --model glm-xxx -- summarize ./src architecture in 5 bullets   # configured provider; notified when done
```

---

## Native providers (run a client keyless)

A **provider** in pigeon is a model source that says where models come from and how to authenticate. Normally that's an API key + endpoint. A **native provider** is one where pigeon injects **nothing** — no key, no endpoint — and the client uses whatever auth it already has on this machine (its own session, or a global env). pigeon only isolates the run from your settings/hooks/CLAUDE.md; it never touches auth.

Two native providers are built in and auto-present (they're never written to config); each appears when its client is installed:

| Provider        | Protocol  | Client   |
| --------------- | --------- | -------- |
| `codex-native`  | openai    | `codex`  |
| `claude-native` | anthropic | `claude` |

You don't configure the provider — you just hang **models** on it, each pinning its own `model_id`. Several models can share one native provider and run in parallel. For example, "use my Codex for gpt-xxx and gpt-yyy":

```jsonc
"models": {
  "gpt-xxx": { "provider": "codex-native", "model_id": "gpt-xxx", "clients": ["codex"] },
  "gpt-yyy": { "provider": "codex-native", "model_id": "gpt-yyy", "clients": ["codex"] }
}
```
```text
/pigeon:run --model gpt-xxx -- ...      # both run keyless via your Codex login,
/pigeon:run --model gpt-yyy -- ...      # in parallel, each its own model
```

- No key: if you can use `codex` / `claude` yourself, a model on its native provider just works.
- `/pigeon:list` shows the native providers detected on your machine in a separate table — discovery only; hang a model on one to actually run it.
- The model id must be one your client accepts (a ChatGPT-account Codex login accepts only that account's models).

**Fastest setup — just ask Claude Code.** In your Claude Code session, say:

> Check whether the `claude` and `codex` CLIs are installed, and if so, configure the native `codex` and `claude` models for me.

Claude will detect the CLIs, pick model ids they accept, and add the models via `/pigeon:config` — no manual JSON.

> Note: native runs use your own session, so they share its rate limits — fanning out many parallel native jobs can hit them.

---

## Configure

Configure either a **configured provider** (GLM, DeepSeek, Kimi, … — with a key + endpoint) or a **native-provider model** (keyless — just the model id on `codex-native` / `claude-native`).

`/pigeon:config` is **conversational** and takes no arguments. Run it; pigeon asks what you want to set and walks you through it — you answer in plain language, step by step. It never assumes a provider or model; it only stores what you tell it.

```text
You:   /pigeon:config
pigeon:  What would you like to set? (a provider's endpoint + key · a model · a model's default client/effort)
You:   add a provider
pigeon:  Which provider, its protocol(s), base URL, and API key?
You:   call it zhipu, anthropic protocol, https://open.bigmodel.cn/api/anthropic, key sk-…
pigeon:  And a model on it? (provider · the model_id sent to the client · which clients can drive it)
You:   model glm-xxx, model_id GLM-xxx, client claude
pigeon:  Here's what I'll save: <echoes the structured config>. Confirm?
You:   yes
```

### What gets stored

It writes `~/.pigeon/config.json` (plaintext keys — on your machine, never in this repo). A two-provider example:

```jsonc
{
  "version": 1,
  "providers": {
    "zhipu":    { "protocols": ["anthropic"], "base_url": { "anthropic": "https://open.bigmodel.cn/api/anthropic" }, "api_key": "<key>" },
    "deepseek": { "protocols": ["anthropic"], "base_url": { "anthropic": "https://api.deepseek.com/anthropic" },     "api_key": "<key>" }
  },
  "models": {
    "glm-xxx":  { "provider": "zhipu",    "model_id": "GLM-xxx",         "clients": ["claude"], "effort": ["high", "medium", "low"] },
    "deepseek": { "provider": "deepseek", "model_id": "deepseek-xxx", "clients": ["claude"] }
  }
}
```

- `clients` and `effort` are **ordered** — the first entry is the default.
- `effort` is **optional**. Only include it for models that actually support effort/thinking levels; most third-party models have none — just omit it. See [Clients & protocols](#clients--protocols).
- A model's `clients` must be drivable by its provider's protocols (`claude` speaks `anthropic`, `codex` speaks `openai`).

---

## Usage

### `/pigeon:list` — see what's configured

```text
/pigeon:list
```
```text
Configured models
MODEL_ID      MODEL     PROVIDER  PROTOCOL   CLIENTS  EFFORT
------------  --------  --------  ---------  -------  ----------------
GLM-xxx       glm-xxx   zhipu     anthropic  claude*  high*,medium,low
deepseek-xxx  deepseek  deepseek  anthropic  claude*

Native models (keyless — your own codex / claude)
MODEL_ID    MODEL    PROVIDER       PROTOCOL   CLIENTS  EFFORT
----------  -------  -------------  ---------  -------  ------
gpt-xxx     gpt-xxx  codex-native   openai     codex*
claude-xxx  opus     claude-native  anthropic  claude*

* = default
```

`MODEL_ID` is the real id sent to the client; `MODEL` is your alias (what you pass to `--model`). They can differ (a short alias over a long id) or match.

Two tables: **Configured models** (key-based providers) and **Native models** (keyless — on `codex-native` / `claude-native`, auth inherited from the client). Either table is omitted when empty.

If a native provider is detected on this machine (its client is installed) but has no model yet, a one-line hint names it — pure discovery:

```text
Native providers available (no key needed): claude-native — add a model on one with /pigeon:config.
```

Hang a model on it and it joins the Native models table; the hint drops it. When every detected native provider already has a model, there's no hint line.

### `/pigeon:run` — delegate, non-blocking, notify me when done

Best for "delegate one thing and get the result back." pigeon runs the model and Claude Code re-notifies you with its output when it finishes — the conversation is **never blocked**, and there's nothing to poll.

```text
/pigeon:run --model glm-xxx -- write a regex that matches RFC-5322 email addresses, with a short explanation
```
```text
… (you can keep working; when the model finishes, Claude delivers the result)
Pigeon session: run-<uuid>
```

Resume the same underlying thread after completion:

```text
/pigeon:run --session run-<uuid> -- now add tests for that solution
```

Every turn uses Claude Bash `run_in_background: true` and automatically notifies you with the result and the same pigeon session ID; no work job, continue command or polling is needed. The first successful turn saves metadata in `~/.pigeon/run-sessions/` (or `$PIGEON_HOME/run-sessions/`), without credentials. Follow-ups inherit the original model ID, client, effort, working directory and provider identity even if the model alias changes. The original provider's current endpoint and key are used, allowing credential rotation; native sessions inherit client authentication. Concurrent turns on one session are rejected. Failed turns preserve the last successful metadata, though the client may have written partial thread history. Resuming also requires the client's local thread history to remain available.

### `/pigeon:work` — delegate as a managed background job

Best when you fan out many at once, or need `cancel` / `continue`, or want jobs to survive across sessions. Returns a `job-id` immediately; you fetch the result later.

```text
/pigeon:work --model glm-xxx -- refactor src/auth.ts: make login() async/await, keep behavior
```
```text
✓ Dispatched job glm-xxx-a1b2 in the background (glm-xxx/claude/high).
  Check progress: /pigeon:status glm-xxx-a1b2
  Fetch result:   /pigeon:result glm-xxx-a1b2
```

### `/pigeon:status` — check progress

```text
/pigeon:status               # all jobs
/pigeon:status glm-xxx-a1b2  # one job
```
States: `queued · running · done · failed · timeout · killed · crashed` (a stalled job is flagged as suspected-stuck).

### `/pigeon:result` — fetch the output

```text
/pigeon:result glm-xxx-a1b2
```

### `/pigeon:continue` — follow up on the same thread

Resumes the job's thread with a new instruction (runs after it, in submission order).

```text
/pigeon:continue glm-xxx-a1b2 -- now add a unit test for the error path
```

### `/pigeon:cancel` — stop a job

```text
/pigeon:cancel glm-xxx-a1b2
```

### Fan out in parallel

Each `/pigeon:work` is an independent job — dispatch several, then collect:

```text
/pigeon:work --model glm-xxx  -- generate the data model
/pigeon:work --model deepseek -- write the API handlers
/pigeon:work --model glm-xxx  -- write the tests
/pigeon:status                # watch them all
/pigeon:result <job-id>       # collect each as it finishes
```

### Natural language (no slash)

Once installed, you can just say what you want using the **`pigeon`** anchor — the `pigeon:dispatch` skill routes it for you:

> "**pigeon**, delegate this to deepseek and tell me when it's done" · "what models does **pigeon** have?" · "configure **pigeon**" · "where's my **pigeon** job?"

---

## `/pigeon:run` vs `/pigeon:work`

| | `/pigeon:run` | `/pigeon:work` |
|---|---|---|
| Mechanism | rides Claude Code's own background task | pigeon-managed detached job |
| Non-blocking + auto-notify | ✅ native | ❌ (poll status / fetch result) |
| Follow up on the same thread | `run --session <id>`; auto-notify each turn | `continue <job-id>` |
| Managed status / result / cancel | — | ✅ |
| Best for | one task, "tell me when done" | fan-out, lifecycle management |

---

## How it works

Two layers:

- **Protocol layer** — a model is usable by a client when the client speaks a protocol the model's endpoint exposes. GLM exposes the Anthropic protocol, so the `claude` CLI can drive it (just point base URL + key + model). A model that only speaks its own tool's protocol is driven by that tool (e.g. `codex` for OpenAI's Responses API).
- **Application layer** — slash commands + a background runtime. A job is resolved from `(model, client, effort)`, the client is spawned as an isolated headless process, and you interact via the commands above.

Delegated runs are **isolated** from your local config (configured models: `claude --bare`; native-provider models: `claude --setting-sources "" --strict-mcp-config`, which keeps the login while skipping settings/hooks/CLAUDE.md; `codex --ignore-user-config --ignore-rules` for both) and run with bypass-permission so a headless job can read/write files in its working directory. Jobs run under a per-thread **FIFO** lock (same-thread continuations execute in order) and are tracked with a verifiable process identity (a recycled PID can never kill an unrelated process).

> The delegated subprocess does **not** see your main conversation — it only sees the task text you pass (and, for `run --session` or `/pigeon:continue`, its own prior thread). Put the context the task needs into the task itself, or point it at files in the working directory.

---

## Clients & protocols

| Client | Protocol | Drives |
|---|---|---|
| `claude` | anthropic | Claude, plus any Anthropic-compatible endpoint (GLM, DeepSeek, Kimi, MiniMax, Qwen, …) |
| `codex` | openai | OpenAI, plus any OpenAI-compatible endpoint |

**About effort.** Each client CLI *accepts* a fixed set of effort/thinking levels — `claude`: `low / medium / high / xhigh / max`; `codex`: `none / minimal / low / medium / high / xhigh`. But effort is only meaningfully honored by the client's **own** models (Anthropic's for `claude`, OpenAI's for `codex`). **Most third-party Anthropic/OpenAI-compatible models — GLM, DeepSeek, Kimi, MiniMax, Qwen, … — expose no effort/thinking control at all.** Some providers expose their own controls; check the documentation for the specific model and endpoint. So set a model's `effort` list to what *that specific model* actually supports — often just omit it. pigeon only accepts an effort that is in the model's configured list **and** legal for the chosen client.

Adding a client = adding one adapter file; the registry/runtime don't change.

---

## Notes

- **No execution time limit** by default — a delegated agent may run for hours. Jobs end only by finishing, `/pigeon:cancel`, a crash, or the session closing. Opt into a wall-clock cap per model/provider via a `timeout_ms` (ms) field, or globally with the `PIGEON_TIMEOUT_MS` env var.
- **POSIX-focused** (macOS / Linux): uses process groups, signals and `ps` for liveness/identity. Windows is best-effort.
- API keys are stored in plaintext in `~/.pigeon/config.json` on your machine. Rotate keys you've shared.
- Session ownership uses Claude Code's official `CLAUDE_ENV_FILE` mechanism, so each session's background jobs are reaped on its `SessionEnd`.

## License

MIT
