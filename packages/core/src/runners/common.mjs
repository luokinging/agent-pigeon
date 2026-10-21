import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const MAX_BYTES = 8 * 1024 * 1024;
export const timeoutMs = () => Number(process.env.PIGEON_RUNNER_RPC_TIMEOUT_MS) || 30_000;
export function error(code, message) { return Object.assign(new Error(message), { code }); }
export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
export function timed(promise, label, ms = timeoutMs()) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(error('RUNNER_TIMEOUT', `${label} timed out; outcome may be unknown`)), ms);
  })]).finally(() => clearTimeout(timer));
}
export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets.filter(x => typeof x === 'string' && x.length)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(Bearer\s+)[\w.\-]+/gi, '$1[REDACTED]').replace(/((?:api[_-]?key|token|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
export function redactData(value, secrets = []) {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactData(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactData(item, secrets)]));
  return value;
}
export function safeError(cause, binding) {
  return error(cause.code || 'RUNNER_ERROR', redact(cause.message, [binding.apiKey]));
}
export function childEnv(binding) {
  const env = { ...process.env };
  if (binding.scope) env[{ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', hermes: 'HERMES_HOME' }[binding.runner]] = binding.scope;
  return env;
}
export function taskText(task) {
  const text = typeof task === 'string' ? task : task?.text ?? task?.prompt;
  if (typeof text !== 'string' || !text.trim()) throw error('INVALID_TASK', 'Runner task must be non-empty text');
  return text;
}
export function lifecycle(onEvent = () => {}, secrets = []) {
  const completion = deferred(), terminal = deferred();
  let settled = false, closer = async () => {}, closed;
  const state = {
    done: completion.promise, terminal: terminal.promise,
    get settled() { return settled; },
    emit(type, data) { onEvent(type, redactData(data, secrets)); },
    setCloser(fn) { closer = fn; },
    finish(result, failure) {
      if (settled) return;
      settled = true;
      const safe = failure && error(failure.code || 'RUNNER_ERROR', redact(failure.message, secrets));
      terminal.resolve({ status: safe?.code === 'RUNNER_CANCELLED' ? 'cancelled' : safe ? 'failed' : 'completed', error: safe });
      if (safe) completion.reject(safe); else completion.resolve(redactData(result, secrets));
      queueMicrotask(() => state.close().catch(() => {}));
    },
    active() { if (settled || closed) throw error('EXECUTION_FINISHED', 'Execution is no longer active'); },
    close() {
      if (!closed) {
        if (!settled) state.finish(null, error('RUNNER_DISCONNECTED', 'Runner connection closed; execution outcome is unknown'));
        closed = Promise.resolve().then(closer);
      }
      return closed;
    },
  };
  return state;
}

// Bounded JSONL transport. stderr is drained but never persisted or forwarded (including split secrets).
export function transport(command, args, { cwd, env, onMessage, onFailure }) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const spawned = deferred(), exited = deferred();
  let buffer = '', failed = false, closing = false;
  const fail = cause => {
    if (failed || closing) return;
    failed = true;
    spawned.reject(cause);
    onFailure(cause);
  };
  child.once('spawn', () => spawned.resolve());
  child.on('error', e => { fail(error('RUNNER_PROCESS_ERROR', e.message)); exited.resolve(); });
  child.stdin.on('error', e => fail(error('RUNNER_DISCONNECTED', `Runner stdin failed: ${e.code}; outcome unknown`)));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (failed || closing) return;
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line) > MAX_BYTES) { fail(error('RUNNER_OUTPUT_LIMIT', 'Runner JSONL frame exceeds 8 MiB')); return; }
      if (!line.trim()) continue;
      try { onMessage(JSON.parse(line)); } catch (e) { fail(error(e.code || 'RUNNER_PROTOCOL_ERROR', e.message)); return; }
    }
    if (Buffer.byteLength(buffer) > MAX_BYTES) fail(error('RUNNER_OUTPUT_LIMIT', 'Runner JSONL buffer exceeds 8 MiB'));
  });
  child.stdout.on('end', () => fail(error('RUNNER_DISCONNECTED', 'Runner stdout disconnected before terminal result; outcome unknown')));
  child.stderr.resume();
  child.once('close', (code, signal) => {
    exited.resolve();
    fail(error('RUNNER_DISCONNECTED', `Runner exited (${signal || code}) before terminal result; outcome unknown`));
  });
  return {
    ready: spawned.promise,
    async send(message) {
      await spawned.promise;
      if (closing || failed || !child.stdin.writable) throw error('RUNNER_DISCONNECTED', 'Runner connection is unavailable; outcome unknown');
      const line = JSON.stringify(message) + '\n';
      if (Buffer.byteLength(line) > MAX_BYTES || child.stdin.writableLength > MAX_BYTES) throw error('RUNNER_INPUT_LIMIT', 'Runner input buffer exceeds 8 MiB');
      await timed(new Promise((resolve, reject) => child.stdin.write(line, e => e ? reject(e) : resolve())), 'Runner write');
    },
    async close() {
      if (closing) return exited.promise;
      closing = true;
      child.stdin.end();
      // Only this child, never its process group or a shared gateway.
      const terminate = setTimeout(() => child.kill('SIGTERM'), 150);
      const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
      try { await timed(exited.promise, 'Runner close', 3000); }
      finally { clearTimeout(terminate); clearTimeout(kill); }
    },
  };
}
export function rpcChannel(send) {
  const pending = new Map();
  return {
    async request(method, params) {
      if (pending.size >= 256) throw error('RUNNER_INPUT_LIMIT', 'Too many pending runner requests');
      const id = randomUUID(), wait = deferred();
      pending.set(id, wait);
      try { await send({ jsonrpc: '2.0', id, method, params }); return await timed(wait.promise, method); }
      finally { pending.delete(id); }
    },
    receive(message) {
      const wait = pending.get(message.id);
      if (!wait || message.method) return false;
      if (message.error) wait.reject(error(message.error.code || 'RUNNER_RPC_ERROR', message.error.message || 'Runner request failed'));
      else wait.resolve(message.result);
      return true;
    },
    rejectAll(e) { for (const wait of pending.values()) wait.reject(e); pending.clear(); },
  };
}
export async function confirmedCancel(state, request) {
  state.active();
  // A terminal event may precede its RPC response. It is already authoritative.
  await Promise.race([request(), state.terminal]);
  const verdict = await timed(state.terminal, 'Cancellation confirmation');
  if (verdict.error && verdict.status !== 'cancelled') throw verdict.error;
  return { status: verdict.status, confirmed: true };
}
export function boundedText(text) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw error('RUNNER_OUTPUT_LIMIT', 'Assistant text exceeds 8 MiB');
  return text;
}
