# Standalone Agent Pigeon

Pigeon owns task sessions, per-turn executions, controls, and collected history. A terminal, Claude Code plugin, Hermes plugin, or another program calls the same CLI. The host integration and the runner are independent: a Hermes host can dispatch to Codex, and a Claude host can dispatch to Hermes.

This is the development workspace implementation. Validation distinguishes live native-runner tests from mocked explicit-provider tests. A passing provider mock verifies routing and control behavior under simulated responses; it does not establish success against a real third-party endpoint. Live native results apply to the tested local runner/version/model, not every authentication mode or host notification flow. Model names in examples are placeholders.

## Installation

Requires Node.js **22.13 or later**, npm, and the runner(s) you want to use. The state store uses built-in `node:sqlite`, which is experimental on supported Node 22 releases and may print an experimental warning on stderr. macOS/Linux are the primary process-control targets.

```sh
npm install
npm link --workspace agent-pigeon
pigeon --help
pigeon capabilities --json
```

Run these commands at the repository root. The npm workspace install and link flow was checked with an isolated temporary prefix; no registry publication is implied. The link points to the checkout, so keep it in place. Without a global link, after `npm install` use `node /absolute/path/to/agent-pigeon/packages/cli/src/index.mjs ...` or `npm run pigeon -- ...` from the repo root. The absolute Node entry preserves the caller's working directory. Integration copies do not include the CLI/core packages.

## Configuration

`PIGEON_HOME` selects the state/config root; the default is `~/.pigeon`. Create or edit `config.json` there. Prefer an environment reference for a service key:

```json
{
  "version": 2,
  "providers": {
    "service": {
      "protocols": ["openai-responses"],
      "base_url": {"openai-responses": "https://example.com/v1"},
      "api_key_env": "PIGEON_SERVICE_KEY"
    }
  },
  "presets": {
    "coding": {
      "provider": "service",
      "runner": "codex",
      "model": "REPLACE_WITH_REAL_MODEL_ID"
    }
  }
}
```

The endpoint and model above are placeholders. Set the referenced variable in the invoking process's environment, then run `pigeon config validate --json`. Validation checks configuration structure and route compatibility; it does not call the provider or prove access. Plain `api_key` is also supported and remains plaintext in your local config. Do not put keys in tasks or shared logs.

For an endpoint that requires no authentication, the provider syntax is `"auth": {"type": "none"}` with no `api_key` or `api_key_env`. Support is runner-specific: Codex advertises this mode and uses a fresh randomly named provider with OpenAI authentication disabled, preventing inherited credentials from an ambient provider configuration. Claude rejects `none` during route validation and in its adapter; use API-key or runner-managed authentication instead. Hermes also rejects explicit `none` during route validation and in its adapter because the Gateway cannot guarantee that a profile key will not be inherited. Currently only Codex supports explicit unauthenticated providers; use API-key or native runner-managed authentication with the other runners. A native runner using an existing login is runner-managed authentication, not this unauthenticated mode.

`pigeon capabilities --json` reports each runner's `authentication`, `resume`, `events`, `steer`, `cancel`, `steerMode`, and `limitations`. Its `binary_available` field only checks for an executable on PATH. It does not validate authentication, provider access, Hermes environment discovery, or Gateway readiness. Read limitations alongside the booleans; for example, Hermes lists `managed-worker-unsupported`. These declarations describe adapter support rather than a live health check.

A preset is a named set of options. Explicit arguments override preset fields and the resulting route is validated. `--model` always names the actual backend model ID in the standalone CLI. Effort is optional; an accepted runner effort value does not guarantee that a given model honors it.

| Runner | Explicit provider protocol | Control transport |
|---|---|---|
| `claude` | `anthropic-messages` | stream JSON |
| `codex` | `openai-responses` | App Server |
| `hermes` | `openai-chat-completions` | existing Gateway |

Without a provider/preset, `pigeon run --runner codex ...` uses runner-managed authentication/configuration. Built-in identities are `claude-native`, `codex-native`, and `hermes-native`; do not define those names as custom providers. Pigeon does not change the runner's personal installation, default provider, or authentication files. Native execution can still create ordinary runner history/logs and share its resource limits. Delegated agents can run tools and change project files; provide a precise task and working directory.

## Sessions, turns, and JSON

```sh
pigeon run --preset coding --background --json -- "Review src and report defects"
pigeon run --provider service --runner codex --model REAL_MODEL_ID --effort high --background --json -- "Review src"
pigeon run --runner hermes --background --json -- "Summarize this repository"
pigeon resume pgs_SESSION --background --json -- "Now add tests"
pigeon steer pge_EXECUTION --json -- "Prioritize the failing login tests"
pigeon status pge_EXECUTION --json
pigeon cancel pge_EXECUTION --json
pigeon wait pge_EXECUTION --json
pigeon result pge_EXECUTION --json
pigeon messages pgs_SESSION -n 10
pigeon events pge_EXECUTION --json
pigeon events pge_EXECUTION --json --follow
pigeon sessions --json
pigeon executions --session pgs_SESSION --json
```

`run/resume --background --json` waits for the runner's control channel to be ready before returning `session_id`, `execution_id`, and `status`. A successful response normally has `status: "running"`; a fast task may already have terminal `status: "completed"`. The startup timeout defaults to 120 seconds and is configurable with `PIGEON_STARTUP_TIMEOUT_MS` in milliseconds. This waits for startup, not task completion. Ready means runner control readiness, not merely manager startup or guaranteed task success. Startup failures exit nonzero with error JSON containing top-level `session_id`, `execution_id`, and `status` for the created execution; retain them for status/result/events queries. Errors before execution creation may have no IDs. Give the submitting host call a timeout longer than the startup timeout, with a margin for CLI overhead.

Session IDs (`pgs_...`) identify persistent conversations. Execution IDs (`pge_...`) identify individual turns. Status/result records use `id` for the execution's own ID and `session_id` for its parent. Resume retains the session binding and creates a new execution; it does not accept arbitrary runner/provider changes. The working directory and runner home/profile scope remain bound. A changed route or identity can prevent resume; changing credentials does not imply permission to change the endpoint.

States are `starting`, `running`, `canceling`, `completed`, `failed`, `canceled`, and `unknown`. `unknown` means Pigeon cannot establish the outcome. Do not automatically retry or resume it: inspect the native backend and recorded events first. There is currently no `reconcile` command. A cancel acknowledgment can precede terminal state. Steer belongs to the active execution; accepted/buffered does not establish that the runner consumed it. Unsupported controls fail explicitly instead of being simulated by a new turn. Codex can return `queued` with `awaiting_tool_boundary` while a tool is active; Pigeon waits for the tool boundary before forwarding the steer. If the turn ends first, the instruction can be rejected rather than automatically starting another turn.

After a successful background run/resume returns, agents should immediately start `wait EXECUTION --json` through a host background task, before ending their turn (Claude Bash: `run_in_background: true`). This is the default completion workflow; no status polling is needed first, including before steer after a `running` response. Hermes installs no automatic watcher: use a separate host background shell if supported, otherwise query status/result later. A fast terminal execution can be read by the same waiter.

`wait` blocks until a terminal state. `result` requires a terminal execution. Successful result/wait exits 0; failed exits 1; canceled exits 130; unknown exits 3. Command errors can also exit nonzero; read the JSON rather than relying only on the code. `events --json` uses JSONL; `--follow` keeps observing. Diagnostics go to stderr. The CLI preserves the complete stored final `result` field in `result --json` and terminal `wait --json` output. Status and messages are bounded previews with truncation metadata. Use concise `messages SESSION -n N` by default; add `--raw` only for structured collected history. That structured view is bounded and may omit native runner history. Host tools can apply an additional response budget: the Hermes integration marks its own truncation, and the direct CLI remains the way to retrieve the full stored result. Retain both IDs before continuing work. If a submission response is lost, inspect `executions --json` before repeating it.

## Storage and host lifetime

`$PIGEON_HOME/config.json` holds configuration, `state.db` holds sessions/executions/messages/events, and `runtime/` holds active control files/logs. SQLite WAL companion files may appear. IDs are stable independently of a host conversation. The new integrations have no host SessionEnd cleanup: closing Claude, Hermes, or an observer must not cancel shared Pigeon executions. Explicit `cancel` targets an execution.

A plugin does not maintain a second queue, database, or agent runtime. It also does not automatically receive the host conversation as task context. Include the relevant scope in the task body.

## Hermes runner environment bridge

This is separate from the Hermes **host plugin**. The runner connects to the existing Hermes Gateway using a new session and per-session overrides; it does not create a replacement profile/Gateway or edit global routing. Backend mode/version restrictions still apply.

The adapter discovers the environment from the first `hermes` on PATH, inspecting wrappers/symlinks without executing installer or repair logic. It follows up to eight absolute `exec` wrapper hops, recognizes a root inserted into Python `sys.path` or an ancestor containing `hermes_cli/gateway_client.py`, and selects the root's `venv/bin/python`, then `.venv/bin/python`, then a discovered wrapper interpreter. Override discovery with:

```sh
export PIGEON_HERMES_ROOT=/absolute/path/to/hermes-agent
export PIGEON_HERMES_PYTHON=/absolute/path/to/hermes/python
```

Explicit values take precedence; missing pieces can still be discovered. An unsupported layout reports `HERMES_RUNTIME_NOT_FOUND` instead of guessing. The bound Hermes scope is passed as `HERMES_HOME`. This does not read a key into command-line arguments or require you to modify your Hermes install. Gateway authentication/session recovery constraints depend on the installed Hermes version.
