"""Bounded, model-free checks. Run with python -I smoke.py [--hermes-root PATH]."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

sys.dont_write_bytecode = True
PLUGIN = Path(__file__).resolve().parents[1]
REPO = PLUGIN.parents[1]


def transport_checks(root):
    spec = importlib.util.spec_from_file_location("pigeon_plugin_smoke", PLUGIN / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    fake = root / "fake-cli.mjs"
    fake.write_text('console.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),startup_timeout:process.env.PIGEON_STARTUP_TIMEOUT_MS??null,session_id:"pgs_test",execution_id:"pge_test"}));')
    os.environ["PIGEON_CLI"] = str(fake)
    task = 'literal $(touch never) ; `command` and "quotes"'
    result = json.loads(plugin.pigeon_tool({"action": "run", "runner": "codex", "cwd": str(root), "task": task}))
    assert result["ok"] and result["data"]["argv"] == ["run", "--runner", "codex", "--background", "--json", "--", task], result
    assert result["data"]["cwd"] == str(root)
    for action in plugin.ACTIONS:
        args = {"action": action}
        if action not in ("run", "capabilities", "validate"):
            args["id"] = "pgs_test" if action in ("resume", "messages") else "pge_test"
        if action in ("run", "resume", "steer"):
            args["task"] = task
        result = json.loads(plugin.pigeon_tool(args))
        assert result["ok"], result
        if action in ("run", "resume"):
            assert "--background" in result["data"]["argv"]
        if action == "messages":
            assert result["data"]["argv"] == ["messages", "pgs_test", "-n", "10", "--json"]
    real_run = plugin.subprocess.run
    for startup, expected in ((None, 150), ("240000", 270), ("1000", 31),
                              ("invalid", 150), ("NaN", 150), ("Infinity", 150), ("-1", 150),
                              ("0.5", 150), ("2147483648", 150)):
        with patch.dict(os.environ):
            os.environ.pop("PIGEON_STARTUP_TIMEOUT_MS", None)
            if startup is not None:
                os.environ["PIGEON_STARTUP_TIMEOUT_MS"] = startup
            for action in plugin.ACTIONS:
                args = {"action": action}
                if action not in ("run", "capabilities", "validate"):
                    args["id"] = "pgs_test" if action in ("resume", "messages") else "pge_test"
                if action in ("run", "resume", "steer"):
                    args["task"] = task
                with patch.object(plugin.subprocess, "run", wraps=real_run) as child:
                    result = json.loads(plugin.pigeon_tool(args))
                    assert result["ok"] and result["data"]["startup_timeout"] == startup
                    assert child.call_args.kwargs["timeout"] == (expected if action in ("run", "resume") else 30)
    for args in ({"action": "wait", "id": "pge_test"},
                 {"action": "events", "id": "pge_test", "follow": True},
                 {"action": "resume", "id": "pgs_test", "runner": "codex", "task": "hi"},
                 {"action": "messages", "id": "pgs_test", "n": False}):
        assert not json.loads(plugin.pigeon_tool(args))["ok"]
    result = json.loads(plugin.pigeon_command('run --runner codex -- "quoted $task; text"'))
    assert result["data"]["argv"][-1] == "quoted $task; text"
    fake.write_text('console.log(JSON.stringify({status:"failed",error:"test"})); process.exitCode=1;')
    result = json.loads(plugin.pigeon_tool({"action": "result", "id": "pge_test"}))
    assert not result["ok"] and result["data"]["status"] == "failed" and result["exit_code"] == 1
    for status in ("running", "completed", "failed"):
        for large in (False, True):
            payload = {"session_id": "pgs_startup", "execution_id": "pge_startup", "status": status}
            if status == "failed":
                payload["error"] = {"code": "STARTUP_FAILED", "message": "runner startup failed"}
            if large:
                payload["details"] = [{"text": "x" * 10000}] * 30
            exit_code = 1 if status == "failed" else 0
            fake.write_text(f'console.log(JSON.stringify({json.dumps(payload)})); process.exitCode={exit_code};')
            for action in ("run", "resume"):
                args = {"action": action, "task": task}
                if action == "resume":
                    args["id"] = "pgs_startup"
                result = json.loads(plugin.pigeon_tool(args))
                assert result["ok"] == (exit_code == 0) and result["exit_code"] == exit_code
                for key in ("session_id", "execution_id", "status"):
                    assert result["data"][key] == payload[key], result
                if large:
                    assert result["data"]["truncated"]
                elif status == "failed":
                    assert result["data"]["error"] == payload["error"]
    fake.write_text('console.log(JSON.stringify({rows:Array.from({length:30},()=>({text:"x".repeat(10000)}))}));')
    result = plugin.pigeon_tool({"action": "events", "id": "pge_test"})
    assert len(result) < 25000 and json.loads(result)["data"]["truncated"]
    fake.write_text('console.log(JSON.stringify({seq:1})); console.log(JSON.stringify({seq:2}));')
    result = json.loads(plugin.pigeon_tool({"action": "events", "id": "pge_test"}))
    assert result["data"] == [{"seq": 1}, {"seq": 2}]
    os.environ["PIGEON_CLI"] = str(REPO / "packages/cli/src/index.mjs")
    for action in ("capabilities", "validate"):
        result = json.loads(plugin.pigeon_tool({"action": action}))
        assert result["ok"], result
    print("PASS transport: actions, literal arguments, startup timeouts, ready/terminal/failure IDs, blocking rejection, failed JSON, truncation, JSONL, real CLI read-only calls")


def load_checks(hermes_root):
    # Outer isolation exists before importing any Hermes modules. No personal config/auth.
    sys.path.insert(0, str(Path(hermes_root).resolve()))
    from hermes_cli.plugin_dev import doctor_plugin, _doctor_runtime
    from tools.registry import registry
    report = doctor_plugin(PLUGIN)
    print(report.format_text())
    assert report.ok
    # This private helper is test infrastructure only; the plugin uses documented ctx APIs.
    with _doctor_runtime(PLUGIN) as host:
        assert "pigeon" in host.registered_tools
        command = host.manager._plugin_commands["pigeon"]["handler"]
        result = json.loads(command("capabilities"))
        assert result["ok"] and "runners" in result["data"], result
        tool = registry.get_entry("pigeon", scope=host.manager.scope_key)
        result = json.loads(tool.handler({"action": "validate"}))
        assert result["ok"] and result["data"]["valid"], result
    print("PASS real Hermes load, registered command, and registered tool invocation")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-root", help="Existing Hermes source root; run with its installed Python for loader checks")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="pigeon-integration-smoke-") as temporary:
        root = Path(temporary).resolve()
        os.environ.update(HERMES_HOME=str(root / "hermes"), PIGEON_HOME=str(root / "pigeon"),
                          HERMES_ENABLE_PROJECT_PLUGINS="0", HERMES_BUNDLED_PLUGINS=str(root / "empty"))
        transport_checks(root)
        if args.hermes_root:
            load_checks(args.hermes_root)


if __name__ == "__main__":
    main()
