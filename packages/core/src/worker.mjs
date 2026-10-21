import fs from "node:fs";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { Store } from "./store.mjs";
import { startRunner } from "./runners/index.mjs";
import { createControlLocation, descriptorPath, TERMINAL } from "./runtime.mjs";

process.once("message", async ({ root, executionId, binding }) => {
  const store = new Store(root);
  const location = createControlLocation();
  const descriptor = descriptorPath(root, executionId);
  let runner;
  let done = false;
  let shuttingDown = false;
  let controlQueue = Promise.resolve();
  const sockets = new Set();
  let startupReported = false;
  const reportStartup = (message) => {
    if (startupReported) return;
    startupReported = true;
    if (process.connected) {
      try { process.send(message, () => {}); } catch { /* Caller detached; retain execution ownership. */ }
    }
  };
  const redact = (value) => {
    const text = String(value);
    return binding.apiKey ? text.split(binding.apiKey).join("[redacted]") : text;
  };
  const redactData = (value) => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(redactData);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactData(item)]));
    return value;
  };
  const record = (type, data = {}) => {
    const clean = redactData(data);
    if (type === "session" && clean.runnerSessionId) store.setRunnerSession(session.id, clean.runnerSessionId);
    if (type === "execution" && clean.runnerExecutionId) store.patchExecution(executionId, { runner_execution_id: clean.runnerExecutionId });
    store.appendEvent(executionId, type, clean);
  };
  const execution = store.getExecution(executionId);
  const session = store.getSession(execution.session_id);
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(35000, () => socket.destroy());
    let buffer = "";
    let received = false;
    socket.on("data", (chunk) => {
      if (received) return;
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) return socket.destroy();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      received = true;
      controlQueue = controlQueue.then(async () => {
        try {
          const request = JSON.parse(buffer.slice(0, end));
          const token = Buffer.from(String(request.token || ""));
          const expected = Buffer.from(location.token);
          if (token.length !== expected.length || !timingSafeEqual(token, expected)) throw new Error("Invalid control token");
          if (done || TERMINAL.has(store.getExecution(executionId).status)) throw new Error("Execution has already ended");
          if (!runner) throw new Error("Runner is still starting; retry after it becomes ready");
          let result;
          if (request.action === "steer") {
            if (typeof request.text !== "string" || !request.text.trim()) throw new Error("Steering message must not be empty");
            result = await runner.steer(request.text, { messageId: request.messageId });
          } else if (request.action === "cancel") {
            store.patchExecution(executionId, { status: "canceling" });
            try { result = await runner.cancel(); }
            catch (error) {
              if (!TERMINAL.has(store.getExecution(executionId).status)) store.patchExecution(executionId, { status: "running" });
              throw error;
            }
          } else throw new Error("Unknown control action");
          socket.end(JSON.stringify({ ok: true, result: result ?? { status: "accepted" } }) + "\n");
        } catch (error) {
          socket.end(JSON.stringify({ ok: false, error: redact(error.message) }) + "\n");
        }
      });
    });
  });

  const stop = async () => {
    if (shuttingDown || done) return;
    shuttingDown = true;
    try {
      // Startup may already have submitted work. Keep ownership until it resolves,
      // then cancel through the backend rather than discarding the control endpoint.
      if (!runner) return;
      await runner.cancel();
    } catch (error) {
      store.finishExecution(executionId, { status: "unknown", error: redact(error.message) });
      await runner?.close().catch(() => {});
      done = true;
      for (const socket of sockets) socket.destroy();
      server.close();
      fs.rmSync(descriptor, { force: true });
      fs.rmSync(location.dir, { recursive: true, force: true });
      process.exitCode = 1;
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(location.socket, resolve); });
    fs.chmodSync(location.socket, 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ socket: location.socket, token: location.token, pid: process.pid }), { mode: 0o600 });
    store.patchExecution(executionId, { pid: process.pid, socket: location.socket });
    if (TERMINAL.has(store.getExecution(executionId).status)) throw new Error("Execution was closed before runner startup");
    runner = await startRunner({ binding, session, execution, task: execution.task, onEvent: record });
    if (shuttingDown || TERMINAL.has(store.getExecution(executionId).status)) {
      try { await runner.cancel(); }
      catch (error) { if (error.code !== "EXECUTION_FINISHED") throw error; }
    }
    if (!TERMINAL.has(store.getExecution(executionId).status)) store.patchExecution(executionId, { status: "running", started_at: new Date().toISOString() });
    record("started", { runner: binding.runner });
    let alreadyFinished = false;
    const completion = runner.done.then(
      (result) => { alreadyFinished = true; return { result }; },
      (error) => { alreadyFinished = true; return { error }; },
    );
    // A runner can deliver its final event in the initialization frame. Persist
    // that outcome before acknowledging startup instead of advertising running.
    await Promise.resolve();
    if (!alreadyFinished) reportStartup({ type: "ready" });
    const outcome = await completion;
    if (outcome.error) throw outcome.error;
    const result = outcome.result;
    if (result.runnerSessionId) store.setRunnerSession(session.id, result.runnerSessionId);
    if (result.runnerExecutionId) store.patchExecution(executionId, { runner_execution_id: result.runnerExecutionId });
    store.finishExecution(executionId, { status: "completed", result: redact(result.text ?? "") });
    reportStartup({ type: "ready" });
  } catch (error) {
    const uncertain = new Set(["RUNNER_DISCONNECTED", "RUNNER_TIMEOUT", "RUNNER_PROTOCOL_ERROR", "RUNNER_OUTPUT_LIMIT"]);
    const status = error.code === "RUNNER_CANCELLED" ? "canceled" : uncertain.has(error.code) ? "unknown" : "failed";
    store.finishExecution(executionId, { status, error: redact(error.message) });
    reportStartup({ type: "error", code: error.code || "RUNNER_ERROR", error: redact(error.message) });
  } finally {
    done = true;
    await controlQueue;
    await runner?.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(descriptor, { force: true });
    fs.rmSync(location.dir, { recursive: true, force: true });
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    if (process.connected) process.disconnect();
    store.close();
  }
});
