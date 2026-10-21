# Host integrations

All integrations invoke the standalone CLI. Install the npm workspace first (see [standalone guide](standalone.md)). `PIGEON_CLI` optionally names **one executable or `.mjs`/`.js` file path**, not a command string with flags. Otherwise wrappers locate `pigeon` on PATH. Their final fallback is `packages/cli/src/index.mjs` relative to a complete repository checkout; copying a plugin alone removes that fallback. `PIGEON_HOME` is inherited by the child CLI.

## Claude Code

The repository's only Claude Code plugin is `pigeon-standalone`. Its installable root is `integrations/claude-code`, containing `.claude-plugin/plugin.json`, commands, skills, and a CLI launcher. It has no SessionEnd hooks.

For a local session:

```sh
claude plugin validate /absolute/path/to/agent-pigeon/integrations/claude-code
claude --plugin-dir /absolute/path/to/agent-pigeon/integrations/claude-code
```

Then use:

```text
/pigeon-standalone:pigeon run --preset coding -- Review src
/pigeon-standalone:pigeon resume pgs_SESSION -- Add tests
/pigeon-standalone:pigeon status pge_EXECUTION
```

The plugin ships a namespaced `dispatch` skill as well, keeping its name distinct from the `pigeon` command. The command submits `run/resume --background --json`, waits for runner control readiness, and reports both IDs and status (normally `running`, or terminal `completed` for a fast task). Ready means the runner control channel is ready, not merely that the manager started. Startup defaults to 120 seconds (`PIGEON_STARTUP_TIMEOUT_MS` in milliseconds); it does not wait for task completion. Give the submitting Bash call at least the startup timeout plus 30 seconds (150000 ms by default). Startup error JSON preserves top-level `session_id`, `execution_id`, and `status` when an execution was created. By default, immediately after a successful submission returns, use a second Claude Bash call with `run_in_background: true` to run `wait EXECUTION --json`, before ending the host turn. No readiness status polling is needed before the waiter or before steer after `running`. That waiter's completion is what Claude can notify about. Hosts without a background task callback must use status/result instead. This is an instruction-driven host integration; manifest validation alone does not prove a full conversational notification test.

To distribute it through a Claude marketplace, use `integrations/claude-code` as the plugin source directory. A cached/copied plugin needs the standalone CLI linked/installed separately or an absolute `PIGEON_CLI` path.

## Hermes

The installable native plugin root is `integrations/hermes`:

```text
plugin.yaml
__init__.py
```

Its format and callbacks were checked against the local Hermes source: `hermes_cli/plugins.py`, `hermes_cli/plugins_manifest.py`, and `website/docs/developer-guide/plugins/index.md`. It uses documented `register(ctx)`, `ctx.register_tool(...)`, and `ctx.register_command(...)`; it defines no invented pip entry point and imports no private Hermes runtime into the plugin. Python's standard library launches the Node CLI as an argv list, with no shell interpretation.

Validate before installation:

```sh
hermes plugins doctor /absolute/path/to/agent-pigeon/integrations/hermes --ci
```

Doctor copies the plugin into a temporary Hermes home and uses real discovery, manifest parsing, import, and tool registration. To isolate even the host command's startup from your personal configuration, invoke it with a temporary home:

```sh
check_home=$(mktemp -d)
HERMES_HOME="$check_home" HERMES_ENABLE_PROJECT_PLUGINS=0 \
  hermes plugins doctor /absolute/path/to/agent-pigeon/integrations/hermes --ci
```

Remove the temporary directory when done. Validation does not install/enable the plugin in your normal home. The check performed during development called Hermes's `doctor_plugin` through its existing Python interpreter with an outer temporary `HERMES_HOME`, and registered one tool with zero hooks.

For installation, copy the contents of `integrations/hermes` into a new `$HERMES_HOME/plugins/pigeon/` directory (default `~/.hermes/plugins/pigeon/`), then enable it with `hermes plugins enable pigeon` and start a new session. These are user installation steps; development checks do not perform them. Ensure `pigeon` is on the Hermes process's PATH, or export an absolute `PIGEON_CLI` before launching Hermes. Use `hermes plugins list` to inspect its installed key and errors.

The `pigeon` tool accepts structured fields:

```json
{"action":"run","preset":"coding","cwd":"/absolute/project","task":"Review src"}
```

```json
{"action":"status","id":"pge_EXECUTION"}
```

It supports `run`, `resume`, `steer`, `cancel`, `status`, `result`, `messages`, `events`, `capabilities`, and `validate` (CLI `config validate`). The corresponding `/pigeon` slash command uses quoted option values:

```text
/pigeon run --runner codex --cwd /absolute/project -- Review src
/pigeon resume pgs_SESSION -- Add regression tests
/pigeon messages pgs_SESSION -n 5
/pigeon result pge_EXECUTION
/pigeon validate
```

`run` and `resume` always add `--background --json`; task text is separated with `--`. The response is a compact JSON envelope containing `ok`, `exit_code`, and `data`. CLI top-level `session_id`, `execution_id`, and `status` are preserved under `data`, including startup failures with nonzero exits and responses that exceed the host's display budget. A successful submission normally returns `running` after runner control readiness; a fast task can already return `completed`. Nonzero terminal results preserve their structured payload. The host tool explicitly truncates long strings/collections; an overall response budget returns a marked preview if needed. This is a separate host-response limit: the standalone CLI's `result EXECUTION --json` preserves the complete stored final result, while status/messages provide bounded previews. Use the direct CLI for the full result. A new run uses the given absolute `cwd`, or the host process working directory when omitted; a resumed session keeps its saved directory.

**No automatic completion watcher is installed for Hermes.** The tool and slash command exclude blocking `wait` and `events --follow`; request status/result later, or use a host-supported background shell running `pigeon wait EXECUTION --json`. Do not promise that Hermes will deliver a callback solely because the CLI submitted a background task. For `run` and `resume`, the child CLI timeout is the configured startup timeout plus 30 seconds: 150 seconds by default, using inherited `PIGEON_STARTUP_TIMEOUT_MS` (an integer from 1 to 2147483647 milliseconds). Invalid values are passed unchanged for the CLI to report a validation error; the host uses its default response budget for that call. Other operations keep a 30-second response limit. These limits bound CLI responses independently of task runtime. If a response times out, the task may already exist; inspect executions before retrying. Killing a timed-out CLI observation does not cancel an accepted execution. Messages use the concise CLI view by default in shell workflows; the Hermes tool uses `--json` to carry structured history in its JSON envelope.

The plugin does not register an end-of-session cleanup hook and does not stop a shared Gateway. Installing the Hermes host plugin is not necessary to select the Hermes runner from another host.

## Generic skill

`integrations/skills/pigeon/SKILL.md` contains the portable operating instructions. Copy that folder into a host's documented skill directory, or have the host read it explicitly. Skill discovery conventions vary; copying the file does not install a CLI or register a native tool. The Claude plugin bundles the same operating instructions under its own `skills/dispatch/` directory, with a different frontmatter name to avoid colliding with its slash command, so the installable plugin is self-contained.

## Repeatable checks

- `claude plugin validate integrations/claude-code` checks the Claude manifest; `sh integrations/claude-code/scripts/pigeon.sh capabilities --json` exercises CLI resolution.
- `hermes plugins doctor /absolute/path/to/integrations/hermes --ci` checks actual Hermes loading. Use a temporary outer `HERMES_HOME` as above.
- Test tool/command argument transport with a fake `PIGEON_CLI` that returns JSON; verify task strings containing shell punctuation remain one argument, run/resume include `--background`, and rejected wait/follow actions never launch a child.
- The generic `integrations/skills/pigeon/SKILL.md` and bundled `integrations/claude-code/skills/dispatch/SKILL.md` have identical operating instructions; only the frontmatter `name` differs to avoid a Claude command/skill name collision.

A repeatable model-free smoke script is included:

```sh
python3 -I integrations/hermes/tests/smoke.py
/absolute/path/to/hermes/python -I integrations/hermes/tests/smoke.py \
  --hermes-root /absolute/path/to/hermes-agent
```

Run from the repository root after `npm install`. The first command checks transport and real CLI capabilities/config validation in temporary homes. The second additionally runs Hermes's real Doctor and invokes both the registered slash command and registered tool. Use the Python interpreter belonging to that existing Hermes installation so its dependencies are available. The test sets temporary `HERMES_HOME` and `PIGEON_HOME` before importing Hermes and does not install anything or read personal configuration/authentication. Its use of the private Doctor runtime helper is confined to test infrastructure; production plugin code uses only documented context registration methods.

These load/transport checks do not call a provider or establish live runner success. Full end-to-end tests additionally require the selected runner, credentials, backend access, and (for Hermes) an available compatible Gateway.
