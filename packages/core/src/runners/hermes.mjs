import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { boundedText, childEnv, confirmedCancel, error, lifecycle, rpcChannel, taskText, timeoutMs, transport } from './common.mjs';
import { discoverHermes } from './hermes-discovery.mjs';

export async function startHermes({ binding, session = {}, task, onEvent }) {
  if (!binding.native && (binding.authMode === 'none' || !binding.apiKey)) throw error('UNSUPPORTED_AUTH_MODE', 'Hermes custom sessions require an explicit API key; auth:none cannot reliably suppress inherited profile credentials');
  const { root, python } = await discoverHermes();
  const state = lifecycle(onEvent, [binding.apiKey]);
  let runnerSessionId, runnerExecutionId, text = '';
  const rpc = rpcChannel(message => io.send(message));
  const fail = e => { rpc.rejectAll(e); state.finish(null, e); };
  const env = childEnv(binding);
  env.PYTHONDONTWRITEBYTECODE = '1';
  const io = transport(python, ['-I', '-u', fileURLToPath(new URL('./hermes_bridge.py', import.meta.url))], {
    cwd: binding.cwd, env, onFailure: fail,
    onMessage(message) {
      if (rpc.receive(message)) return;
      if (state.settled) return;
      const p = message.params || {};
      if (message.method === 'session') { runnerSessionId = p.runnerSessionId; state.emit('session', p); }
      else if (message.method === 'execution') { runnerExecutionId = p.runnerExecutionId; state.emit('execution', p); }
      else if (message.method === 'fatal') fail(error(p.code || 'HERMES_ERROR', p.message));
      else if (message.method === 'event') {
        if (p.session_id !== runnerSessionId || (p.admission_id ?? p.payload?.admission_id) !== runnerExecutionId) return;
        const payload = p.payload || {}, id = payload.tool_call_id || payload.tool_id;
        if (p.type === 'message.delta' && typeof payload.text === 'string') {
          text = boundedText(text + payload.text);
          state.emit('assistant', { id: runnerExecutionId, text, delta: payload.text, status: 'streaming' });
        } else if (p.type === 'tool.start') state.emit('tool_start', { id, name: payload.tool_name || payload.name, input: payload.args });
        else if (p.type === 'tool.complete') {
          let output = payload.result;
          try { if (typeof output === 'string') output = JSON.parse(output); } catch {}
          state.emit('tool_end', { id, output: output?.output ?? output, status: payload.is_error ? 'failed' : 'completed', exit_code: output?.exit_code ?? null });
        } else if (p.type === 'message.complete') {
          const outcome = payload.outcome;
          if (outcome === 'completed') {
            text = boundedText(payload.text ?? payload.content ?? text);
            state.emit('assistant', { id: runnerExecutionId, text, status: 'completed' });
            state.finish({ text, runnerSessionId, runnerExecutionId });
          } else state.finish(null, error(['interrupted', 'cancelled', 'canceled'].includes(outcome) ? 'RUNNER_CANCELLED' : outcome === 'unknown' ? 'RUNNER_DISCONNECTED' : 'RUNNER_ERROR', `Hermes execution ${outcome || 'failed'}`));
        } else if (p.type === 'error') state.emit('progress', { type: 'error', ...payload });
      } else state.emit('progress', p);
    },
  });
  state.setCloser(async () => { rpc.rejectAll(error('RUNNER_DISCONNECTED', 'Hermes connection closed')); await io.close(); });
  try {
    await io.ready;
    await rpc.request('bootstrap', { root, binding, runnerSessionId: session.runner_session_id, task: taskText(task), timeoutMs: timeoutMs() });
  } catch (e) { fail(e); await state.close(); throw e; }
  return {
    done: state.done,
    async steer(text, { messageId = randomUUID() } = {}) {
      state.active(); taskText(text);
      const ack = await rpc.request('steer', { text });
      if (!['queued', 'accepted'].includes(ack.status)) throw error('STEER_REJECTED', `Hermes steering ${ack.status || 'unconfirmed'}`);
      state.emit('input', { id: messageId, text, status: 'accepted', kind: 'steer' });
      return { status: 'accepted', messageId, observed: ack.status };
    },
    cancel: () => confirmedCancel(state, () => rpc.request('cancel', {})),
    close: () => state.close(),
  };
}
