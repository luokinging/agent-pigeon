#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { home, loadConfig, validateConfig, RUNNERS } from "@agent-pigeon/core/config";
import { Store, compactValue, presentMessage } from "@agent-pigeon/core/store";
import { launch, control, waitForExecution, inspectExecution, TERMINAL } from "@agent-pigeon/core/runtime";

const HELP = `agent-pigeon — independent agent sessions

pigeon run --runner claude|codex|hermes [--model ID] [--provider NAME]
           [--protocol NAME] [--effort LEVEL] [--preset NAME]
           [--background] [--json] [--stdin] -- TASK
pigeon resume SESSION [--background] [--json] [--stdin] -- TASK
pigeon steer EXECUTION [--json] [--stdin] -- MESSAGE
pigeon status|wait|result|cancel EXECUTION [--json]
pigeon events EXECUTION [--follow] [--after SEQ] [--json]
pigeon messages SESSION [-n COUNT] [--execution ID] [--raw]
pigeon sessions [-n COUNT] [--json]
pigeon executions [--session ID] [-n COUNT] [--json]
pigeon capabilities [--json]
pigeon config validate [--json]
pigeon legacy <old-command> ...

--model is a real model ID. Use --preset for a named configuration.
Without --provider or --preset, --runner uses its own authentication/config.
--client is an alias for --runner. Legacy commands retain their old semantics
only through 'pigeon legacy' or the existing scripts/pigeon.mjs entry point.
`;
const booleanFlags = new Set(["background", "json", "raw", "stdin", "follow", "help"]);
const valueFlags = new Set(["runner", "client", "provider", "protocol", "model", "effort", "preset", "session", "execution", "after", "n"]);

function parse(argv) {
  const split = argv.indexOf("--");
  const args = split < 0 ? argv : argv.slice(0, split);
  const task = split < 0 ? undefined : argv.slice(split + 1).join(" ");
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const name = arg === "-n" ? "n" : arg === "-h" ? "help" : arg.slice(2);
    if (!arg.startsWith("--") && !["-n", "-h"].includes(arg)) throw new Error(`Unknown option ${arg}`);
    if (Object.hasOwn(flags, name)) throw new Error(`Repeated option ${arg}`);
    if (booleanFlags.has(name)) flags[name] = true;
    else if (valueFlags.has(name)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      flags[name] = value;
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (flags.client && flags.runner && flags.client !== flags.runner) throw new Error("--client and --runner disagree");
  if (flags.client) { flags.runner = flags.client; delete flags.client; }
  return { flags, positional, task };
}
function only(flags, allowed) {
  for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new Error(`--${key} is not supported for this command`);
}
function idArgument(positional) {
  if (positional.length !== 1) throw new Error("Specify exactly one session or execution ID");
  return positional[0];
}
function installedRunner(name) {
  const override = process.env[`PIGEON_${name.toUpperCase()}_BIN`];
  const command = override || name;
  const locations = command.includes("/") ? [command] : (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":").map((dir) => `${dir}/${command}`);
  return locations.some((file) => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
}
function number(value, fallback, min = 1) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) throw new Error(`Expected an integer >= ${min}`);
  return Number(value);
}
function body(task, flags) {
  if (flags.stdin && task !== undefined) throw new Error("Use either --stdin or a task after --");
  const value = flags.stdin ? fs.readFileSync(0, "utf8").replace(/\n$/, "") : task;
  if (!value?.trim()) throw new Error("Provide a task after -- or via --stdin");
  return value;
}
function print(value, json) {
  if (json) console.log(JSON.stringify(value));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}
function publicExecution(execution) {
  const { socket, pid, ...rest } = execution;
  for (const key of ["task", "result", "error"]) {
    if (typeof rest[key] === "string") {
      const compact = compactValue(rest[key]);
      rest[key] = compact.text;
      if (compact.truncated) (rest.truncation ??= {})[key] = compact;
    }
  }
  return rest;
}
function resultExit(execution) {
  return execution.status === "completed" ? 0 : execution.status === "canceled" ? 130 : execution.status === "unknown" ? 3 : 1;
}
function showResult(execution, json) {
  if (json) {
    const value = publicExecution(execution);
    // Final results are complete; bounded previews belong to status/messages.
    value.result = execution.result;
    if (value.truncation) delete value.truncation.result;
    print(value, true);
  } else {
    if (execution.result) console.log(execution.result);
    if (execution.error) console.error(execution.error);
    console.log(`Session: ${execution.session_id}\nExecution: ${execution.id} (${execution.status})`);
  }
  if (TERMINAL.has(execution.status)) process.exitCode = resultExit(execution);
}
function renderMessage(message) {
  const m = presentMessage(message);
  const label = m.role === "tool" ? `tool ${m.tool_name || ""}` : m.role;
  const lines = [`[${m.seq}] ${label}${m.kind ? ` · ${m.kind}` : ""}${m.status ? ` · ${m.status}` : ""}`];
  if (m.text) lines.push(typeof m.text === "string" ? m.text : JSON.stringify(m.text));
  if (m.input != null) lines.push(`input: ${typeof m.input === "string" ? m.input : JSON.stringify(m.input)}`);
  if (m.output != null) lines.push(`output: ${typeof m.output === "string" ? m.output : JSON.stringify(m.output)}`);
  if (m.truncation) lines.push(`[truncated: ${Object.keys(m.truncation).join(", ")}]`);
  return lines.join("\n");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["--help", "-h", "help"].includes(command)) { console.log(HELP); return; }
  if (command === "legacy") {
    const script = fileURLToPath(new URL("../../../scripts/pigeon.mjs", import.meta.url));
    if (!fs.existsSync(script)) throw new Error("Legacy entry point is available in the source checkout; use the old plugin for installed legacy jobs");
    const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  const { flags, positional, task } = parse(args);
  if (flags.help) { console.log(HELP); return; }
  const json = Boolean(flags.json || flags.raw);
  if (command === "run" || command === "resume") {
    only(flags, command === "run" ? ["runner", "provider", "protocol", "model", "effort", "preset", "background", "json", "stdin"] : ["background", "json", "stdin"]);
    if (command === "run" && positional.length) throw new Error("Put task text after --");
    const sessionId = command === "resume" ? idArgument(positional) : undefined;
    const accepted = await launch(flags, { sessionId, task: body(task, flags) });
    if (flags.background) { print(accepted, json); return; }
    console.error(`Session: ${accepted.session_id}\nExecution: ${accepted.execution_id}`);
    const result = await waitForExecution(accepted.execution_id);
    showResult(result, json);
    return;
  }
  if (command === "steer" || command === "cancel") {
    only(flags, command === "steer" ? ["json", "stdin"] : ["json"]);
    const id = idArgument(positional);
    if (command === "cancel" && task !== undefined) throw new Error("cancel does not accept a message");
    print(await control(id, command, command === "steer" ? body(task, flags) : undefined), json);
    return;
  }
  if (task !== undefined) throw new Error(`${command} does not accept task text`);
  if (command === "capabilities") {
    only(flags, ["json"]);
    if (positional.length) throw new Error("capabilities takes no arguments");
    const runners = Object.fromEntries(Object.entries(RUNNERS).map(([name, runner]) => [name, { ...runner, binary_available: installedRunner(name) }]));
    print({ version: "2.0.0-dev.0", api_version: 1, runners, note: "Capabilities describe adapter support. Binary availability does not verify authentication, Gateway connectivity, or backend mode/version." }, json);
    return;
  }
  if (command === "config") {
    only(flags, ["json"]);
    if (positional.join(" ") !== "validate") throw new Error("Usage: pigeon config validate [--json]");
    const errors = validateConfig(loadConfig());
    print({ valid: errors.length === 0, errors }, json);
    if (errors.length) process.exitCode = 1;
    return;
  }
  if (command === "wait") {
    only(flags, ["json"]);
    showResult(await waitForExecution(idArgument(positional)), json);
    return;
  }
  const store = new Store(home());
  try {
    if (command === "sessions") {
      only(flags, ["n", "json"]);
      if (positional.length) throw new Error("sessions takes no positional arguments");
      print(store.listSessions({ limit: number(flags.n, 20) }), json);
    } else if (command === "executions") {
      only(flags, ["n", "json", "session"]);
      if (positional.length) throw new Error("executions takes no positional arguments");
      print(store.listExecutions({ sessionId: flags.session, limit: number(flags.n, 20) }).map(publicExecution), json);
    } else if (command === "status" || command === "result") {
      only(flags, ["json"]);
      const execution = await inspectExecution(idArgument(positional));
      if (command === "result") {
        if (!TERMINAL.has(execution.status)) throw new Error(`Execution is ${execution.status}; use wait or events --follow`);
        showResult(execution, json);
      } else print(publicExecution(execution), json);
    } else if (command === "messages") {
      only(flags, ["n", "raw", "json", "execution"]);
      const sessionId = idArgument(positional);
      const messages = store.messages(sessionId, { executionId: flags.execution, limit: number(flags.n, 10) });
      if (json) print({ session_id: sessionId, messages: messages.map((m) => presentMessage(m)) }, true);
      else console.log(`Session ${sessionId}\n\n${messages.map(renderMessage).join("\n\n") || "No messages."}`);
    } else if (command === "events") {
      only(flags, ["after", "follow", "json"]);
      const id = idArgument(positional);
      let cursor = number(flags.after, 0, 0);
      const emit = (event) => { cursor = event.seq; print(event, json); };
      for (;;) {
        const batch = store.listEvents(id, { after: cursor, limit: 100 });
        for (const event of batch) emit(event);
        if (batch.length < 100) break;
      }
      if (flags.follow) await waitForExecution(id, { onEvent: (event) => { if (event.seq > cursor) emit(event); } });
    } else throw new Error(`Unknown command ${command}. Run pigeon --help`);
  } finally { store.close(); }
}

main().catch((error) => {
  const identity = error.execution_id ? { session_id: error.session_id, execution_id: error.execution_id, status: error.status } : {};
  if (process.argv.includes("--json") || process.argv.includes("--raw")) console.log(JSON.stringify({ ...identity, error: { code: error.code || "PIGEON_ERROR", message: error.message } }));
  else {
    console.error(`pigeon: ${error.message}`);
    if (error.execution_id) console.error(`Session: ${error.session_id}\nExecution: ${error.execution_id} (${error.status})`);
  }
  process.exitCode = 1;
});
