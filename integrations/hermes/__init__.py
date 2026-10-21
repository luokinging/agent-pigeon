"""Hermes host integration. Execution, persistence and controls belong to Pigeon."""
import json
import math
import os
from pathlib import Path
import shlex
import shutil
import subprocess

ACTIONS = ("run", "resume", "steer", "cancel", "status", "result", "messages", "events", "capabilities", "validate")
SCHEMA = {
    "name": "pigeon",
    "description": (
        "Delegate with run/resume, wait for runner control readiness (120s startup default), "
        "then return Pigeon session_id/execution_id/status without waiting for task completion. "
        "Inspect status/result/messages/events; steer affects the current execution. "
        "No automatic completion notification; call status/result later. "
        "Use an absolute cwd for delegation. Model is an actual model ID, preset is a named route."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(ACTIONS)},
            "id": {"type": "string", "description": "Session ID for resume/messages; execution ID for controls/results/events."},
            "task": {"type": "string", "description": "Self-contained task or steering message."},
            **{key: {"type": "string"} for key in ("preset", "provider", "runner", "protocol", "model", "effort")},
            "cwd": {"type": "string", "description": "Absolute working directory for a new run; resume uses the stored directory."},
            "n": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Latest messages, default 10."},
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}


def _cli():
    # An override is one executable or .mjs/.js file, never a shell command.
    override = os.environ.get("PIGEON_CLI")
    if override:
        if Path(override).suffix in (".mjs", ".js"):
            node = shutil.which("node")
            if not node or not Path(override).is_file():
                raise ValueError("PIGEON_CLI must name an existing JS file and node must be on PATH")
            return [node, str(Path(override).resolve())]
        executable = shutil.which(override)
        if not executable:
            raise ValueError("PIGEON_CLI executable was not found")
        return [executable]
    executable = shutil.which("pigeon")
    if executable:
        return [executable]
    # Only a complete source checkout has this sibling. Installed plugins need PATH/override.
    source = Path(__file__).resolve().parents[2] / "packages/cli/src/index.mjs"
    node = shutil.which("node")
    if node and source.is_file():
        return [node, str(source)]
    raise ValueError("Install/link agent-pigeon on PATH or set PIGEON_CLI to its executable or index.mjs")


def _text(args, key):
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string")
    return value


def _arguments(args):
    action = args.get("action")
    if action not in ACTIONS:
        raise ValueError("Unsupported action. wait/events --follow require a host background shell; this plugin does not install a notification watcher.")
    allowed = {"action"}
    if action == "run":
        allowed |= {"task", "preset", "provider", "runner", "protocol", "model", "effort", "cwd"}
    elif action in ("resume", "steer"):
        allowed |= {"id", "task"}
    elif action in ("cancel", "status", "result", "events"):
        allowed.add("id")
    elif action == "messages":
        allowed |= {"id", "n"}
    if set(args) - allowed:
        raise ValueError("Unsupported fields for this action: " + ", ".join(sorted(set(args) - allowed)))
    argv = ["config", "validate"] if action == "validate" else [action]
    if "id" in allowed:
        identity = _text(args, "id")
        if identity.startswith("-"):
            raise ValueError("id cannot start with '-'")
        argv.append(identity)
    if action == "run":
        for key in ("preset", "provider", "runner", "protocol", "model", "effort"):
            if key in args:
                argv.extend(["--" + key, _text(args, key)])
    if action in ("run", "resume"):
        argv.append("--background")
    if action == "messages":
        n = args.get("n", 10)
        if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= 100:
            raise ValueError("n must be an integer from 1 to 100")
        argv.extend(["-n", str(n)])
    # The tool envelope needs structured output, including messages.
    argv.append("--json")
    if action in ("run", "resume", "steer"):
        argv.extend(["--", _text(args, "task")])
    cwd = args.get("cwd")
    if cwd is not None and (not isinstance(cwd, str) or not Path(cwd).is_absolute() or not Path(cwd).is_dir()):
        raise ValueError("cwd must be an existing absolute directory")
    return argv, cwd


def _compact(value):
    if isinstance(value, str) and len(value) > 4000:
        return {"text": value[:3000] + "\n…\n" + value[-1000:], "truncated": True, "original_chars": len(value)}
    if isinstance(value, list):
        entries = [_compact(item) for item in value[-30:]]
        return {"items": entries, "truncated": True, "original_count": len(value)} if len(value) > 30 else entries
    if isinstance(value, dict):
        return {key: _compact(item) for key, item in value.items()}
    return value


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _response_timeout(action):
    if action not in ("run", "resume"):
        return 30
    try:
        startup_ms = float(os.environ.get("PIGEON_STARTUP_TIMEOUT_MS", "120000"))
    except ValueError:
        startup_ms = 120000.0
    if not math.isfinite(startup_ms) or not startup_ms.is_integer() or not 1 <= startup_ms <= 2147483647:
        startup_ms = 120000
    # This fallback sets only the host waiting budget. Inherit the original env
    # unchanged so the CLI validates invalid values and returns its own error.
    # Allow the CLI to report startup failures with IDs before the host kills it.
    return startup_ms / 1000 + 30


def pigeon_tool(args, **kwargs):
    try:
        if not isinstance(args, dict):
            raise ValueError("Expected an object")
        argv, cwd = _arguments(args)
        completed = subprocess.run(_cli() + argv, cwd=cwd, stdin=subprocess.DEVNULL,
                                   capture_output=True, text=True,
                                   timeout=_response_timeout(args["action"]), check=False)
        text = completed.stdout.strip()
        try:
            data = json.loads(text) if text else None
        except json.JSONDecodeError:
            # events uses JSONL; never follow a live stream in a synchronous tool.
            try:
                data = [json.loads(line) for line in text.splitlines() if line.strip()]
            except json.JSONDecodeError:
                return _json({"ok": False, "exit_code": completed.returncode,
                              "error": "Pigeon returned invalid JSON; verify the standalone CLI version"})
        compact = _compact(data)
        encoded = _json(compact)
        if len(encoded) > 24000:
            compact = {"truncated": True, "original_chars": len(encoded), "preview": encoded[:18000],
                       "hint": "Use the CLI directly or request fewer messages for the full structured view"}
            if isinstance(data, dict):
                for key in ("session_id", "execution_id", "status"):
                    if key in data:
                        compact[key] = data[key]
        response = {"ok": completed.returncode == 0, "exit_code": completed.returncode, "data": compact}
        if completed.returncode and not data:
            response["error"] = "Pigeon CLI failed without structured output; run the same command in a terminal for diagnostics"
        # Do not echo arbitrary stderr: runner diagnostics may contain credentials.
        if args["action"] in ("run", "resume"):
            response["notification"] = "No watcher installed; use status/result with execution_id"
        return _json(response)
    except subprocess.TimeoutExpired:
        return _json({"ok": False, "error": "CLI response timed out; execution may have been accepted. Inspect pigeon executions --json before retrying. Timeout did not cancel any Pigeon execution."})
    except (OSError, ValueError) as exc:
        return _json({"ok": False, "error": str(exc)})


def pigeon_command(raw_args, **kwargs):
    """/pigeon uses the same fields as the tool; shell-like quoting, no shell execution."""
    try:
        tokens = shlex.split(raw_args)
        if not tokens:
            return _json({"actions": ACTIONS, "examples": [
                '/pigeon run --runner codex --cwd /absolute/project -- "Review src"',
                '/pigeon status pge_...', '/pigeon resume pgs_... -- "Add tests"'],
                "notifications": "No automatic watcher. Use status/result; wait requires a host background shell."})
        args = {"action": tokens.pop(0)}
        if args["action"] in ("resume", "steer", "cancel", "status", "result", "messages", "events"):
            if not tokens:
                raise ValueError("Missing session/execution ID")
            args["id"] = tokens.pop(0)
        while tokens:
            token = tokens.pop(0)
            if token == "--":
                args["task"] = " ".join(tokens)
                break
            key = "n" if token == "-n" else token[2:] if token.startswith("--") else ""
            if not key or not tokens or key in args:
                raise ValueError("Expected unique --option VALUE pairs and task after --")
            value = tokens.pop(0)
            args[key] = int(value) if key == "n" else value
        return pigeon_tool(args)
    except ValueError as exc:
        return _json({"ok": False, "error": str(exc)})


def register(ctx):
    ctx.register_tool(name="pigeon", toolset="pigeon", schema=SCHEMA,
                      handler=pigeon_tool, description=SCHEMA["description"])
    ctx.register_command("pigeon", handler=pigeon_command,
                         description="Delegate or inspect independent Pigeon sessions",
                         args_hint="<action> [id] [options] -- task")
