import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "./store.mjs";
import { home, publicBinding, resolveBinding, restoreBinding } from "./config.mjs";

export const TERMINAL = new Set(["completed", "failed", "canceled", "unknown"]);
const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function descriptorPath(root, id) {
  if (!/^pge_[0-9a-f-]+$/.test(id)) throw new Error("Invalid execution ID");
  return path.join(root, "runtime", `${id}.json`);
}

export async function launch(options = {}, { sessionId, task, root = home() } = {}) {
  if (typeof task !== "string" || !task.trim()) throw new Error("Task must not be empty");
  root = path.resolve(root);
  const startupTimeout = Number(process.env.PIGEON_STARTUP_TIMEOUT_MS ?? 120000);
  if (!Number.isSafeInteger(startupTimeout) || startupTimeout < 1 || startupTimeout > 2147483647) {
    throw new Error("PIGEON_STARTUP_TIMEOUT_MS must be a positive integer up to 2147483647");
  }
  const store = new Store(root);
  let execution;
  let child;
  let submitted = false;
  try {
    let session;
    let binding;
    if (sessionId) {
      session = store.getSession(sessionId);
      if (!session.runner_session_id) throw new Error("Session has no resumable runner identity");
      const previous = store.listExecutions({ sessionId, limit: 1 });
      if (previous[0]?.status === "unknown") throw new Error("Previous execution outcome is unknown; reconcile it before resuming");
      binding = restoreBinding(session.binding);
    } else {
      binding = resolveBinding(options);
      session = store.createSession(publicBinding(binding), {
        integration: process.env.PIGEON_INTEGRATION || "cli",
        host_session_id: process.env.PIGEON_SESSION_ID || process.env.CLAUDE_SESSION_ID || null,
      });
    }
    execution = store.createExecution(session.id, task);
    const runtimeDir = path.join(root, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const logFd = fs.openSync(path.join(runtimeDir, `${execution.id}.log`), "a", 0o600);
    try {
      child = spawn(process.execPath, [WORKER], {
        cwd: binding.cwd, detached: true,
        stdio: ["ignore", "ignore", logFd, "ipc"],
        env: { ...process.env, PIGEON_HOME: root },
      });
    } finally {
      fs.closeSync(logFd);
    }
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        const current = store.getExecution(execution.id);
        if (current.status === "completed") { finish(); return; }
        if (TERMINAL.has(current.status)) {
          finish(Object.assign(new Error(current.error || `Execution ${current.status} during startup`), { code: "STARTUP_EXIT" }));
          return;
        }
        child.kill("SIGTERM");
        finish(Object.assign(new Error(`Runner did not become ready within ${startupTimeout} ms; execution outcome is unknown`), { code: "STARTUP_TIMEOUT" }));
      }, startupTimeout);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("message", onMessage);
        child.off("spawn", onSpawn);
        error ? reject(error) : resolve();
      };
      const onError = (error) => finish(error);
      const onExit = (code) => {
        const current = store.getExecution(execution.id);
        if (current.status === "completed") finish();
        else finish(Object.assign(new Error(current.error || `Execution manager exited during startup (${code})`), { code: "STARTUP_EXIT" }));
      };
      const onMessage = (message) => {
        if (message.type === "ready") {
          const current = store.getExecution(execution.id);
          if (current.status === "running" || current.status === "completed") finish();
          else finish(Object.assign(new Error(current.error || `Execution became ${current.status} during startup`), { code: "STARTUP_NOT_READY" }));
        } else if (message.type === "error") finish(Object.assign(new Error(message.error), { code: message.code || "RUNNER_ERROR" }));
      };
      const onSpawn = () => {
        submitted = true;
        child.send({ root, executionId: execution.id, binding }, (error) => { if (error) finish(error); });
      };
      child.once("error", onError);
      child.once("exit", onExit);
      child.on("message", onMessage);
      child.once("spawn", onSpawn);
    });
    if (child.connected) child.disconnect();
    child.unref();
    return { session_id: session.id, execution_id: execution.id, status: store.getExecution(execution.id).status };
  } catch (error) {
    if (execution) {
      const current = store.finishExecution(execution.id, { status: submitted ? "unknown" : "failed", error: error.message });
      error.session_id = current.session_id;
      error.execution_id = current.id;
      error.status = current.status;
    }
    throw error;
  } finally {
    if (child?.connected) child.disconnect();
    child?.unref();
    store.close();
  }
}

export async function control(executionId, action, text, { root = home(), timeout = 30000 } = {}) {
  const store = new Store(root);
  try {
    const execution = store.getExecution(executionId);
    if (TERMINAL.has(execution.status)) throw new Error(`Execution is already ${execution.status}`);
    let descriptor;
    try { descriptor = JSON.parse(fs.readFileSync(descriptorPath(root, executionId), "utf8")); }
    catch { throw new Error("Execution control endpoint is unavailable; do not resubmit the task automatically"); }
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection(descriptor.socket);
      socket.setEncoding("utf8");
      let buffer = "";
      const timer = setTimeout(() => finish(new Error("Control response timed out; delivery outcome is unknown")), timeout);
      let settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        error ? reject(error) : resolve(value);
      }
      socket.on("error", (error) => finish(error));
      socket.on("end", () => finish(new Error("Control connection closed before acknowledgement")));
      socket.on("connect", () => socket.write(JSON.stringify({ token: descriptor.token, action, text, messageId: randomUUID() }) + "\n"));
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 1024 * 1024) return finish(new Error("Control response exceeds size limit"));
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, end));
          response.ok ? finish(null, response.result) : finish(new Error(response.error));
        } catch (error) { finish(error); }
      });
    });
  } finally { store.close(); }
}

export async function waitForExecution(id, { root = home(), onEvent, signal } = {}) {
  const store = new Store(root);
  let cursor = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("Stopped observing; execution may still be running");
      const execution = store.getExecution(id);
      if (onEvent) {
        for (;;) {
          const events = store.listEvents(id, { after: cursor, limit: 100 });
          for (const event of events) { onEvent(event); cursor = event.seq; }
          if (events.length < 100) break;
        }
      }
      if (TERMINAL.has(execution.status)) return execution;
      if (execution.pid) {
        try { process.kill(execution.pid, 0); }
        catch (error) {
          if (error.code === "ESRCH") {
            store.finishExecution(id, { status: "unknown", error: "Execution manager exited without recording a final outcome" });
            continue;
          }
        }
      }
      await delay(150);
    }
  } finally { store.close(); }
}

export async function inspectExecution(id, { root = home() } = {}) {
  const store = new Store(root);
  try {
    const execution = store.getExecution(id);
    if (!TERMINAL.has(execution.status) && execution.pid) {
      try { process.kill(execution.pid, 0); }
      catch (error) {
        if (error.code === "ESRCH") return store.finishExecution(id, { status: "unknown", error: "Execution manager exited without recording a final outcome" });
      }
    }
    return execution;
  } finally { store.close(); }
}

export function createControlLocation() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pigeon-control-"));
  fs.chmodSync(dir, 0o700);
  return { dir, socket: path.join(dir, "control.sock"), token: randomBytes(32).toString("hex") };
}
