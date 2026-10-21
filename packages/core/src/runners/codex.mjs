import { randomUUID } from 'node:crypto';
import { boundedText, childEnv, confirmedCancel, deferred, error, lifecycle, rpcChannel, taskText, timed, transport } from './common.mjs';

export async function startCodex({ binding, session = {}, task, onEvent }) {
  const state = lifecycle(onEvent, [binding.apiKey]), ready = deferred();
  let runnerSessionId, runnerExecutionId, text = '', starting = false;
  const early = [], messages = new Map(), steers = new Map(), openTools = new Set();
  let earlyBytes = 0, assistantBytes = 0, draining = false, cancelling = false;
  const pendingSteers = [];
  function rejectQueued(reason) {
    for (const messageId of pendingSteers.splice(0)) {
      const steer = steers.get(messageId);
      if (steer) state.emit('input', { id: messageId, text: steer.text, kind: 'steer', status: 'rejected', delivered: false, reason });
      steers.delete(messageId);
    }
  }
  async function deliver(messageId) {
    const steer = steers.get(messageId);
    try {
      const result = await rpc.request('turn/steer', { threadId: runnerSessionId, expectedTurnId: runnerExecutionId, clientUserMessageId: messageId, input: [{ type: 'text', text: steer.text }] });
      if (result.turnId !== runnerExecutionId) throw error('RUNNER_PROTOCOL_ERROR', 'Codex steering acknowledgement has a different turn id');
      steer.accepted = true;
      state.emit('input', { id: messageId, text: steer.text, kind: 'steer', status: 'accepted' });
      if (steer.observed) {
        state.emit('input', { id: messageId, text: steer.text, kind: 'steer', status: 'consumed', observed: 'user_message_echo' });
        steers.delete(messageId);
      }
      return { status: 'accepted', messageId, runnerExecutionId };
    } catch (cause) {
      steers.delete(messageId);
      state.emit('input', { id: messageId, text: steer.text, kind: 'steer', status: ['RUNNER_TIMEOUT', 'RUNNER_DISCONNECTED'].includes(cause.code) ? 'unknown' : 'rejected', reason: cause.message });
      throw cause;
    }
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pendingSteers.length && !openTools.size && !state.settled && !cancelling) {
        try { await deliver(pendingSteers.shift()); } catch { /* The input event carries the refusal/unknown receipt. */ }
      }
    } finally { draining = false; }
  }
  const env = childEnv(binding), args = ['app-server', '--stdio'];
  const config = (key, value) => args.push('-c', `${key}=${JSON.stringify(value)}`);
  if (!binding.native) {
    config('model_provider', 'pigeon'); config('model_providers.pigeon.name', 'pigeon');
    config('model_providers.pigeon.base_url', binding.baseUrl);
    if (binding.authMode === 'none' || !binding.apiKey) {
      delete env.PIGEON_API_KEY;
      // A fresh provider name avoids inheriting a locally configured credential source.
      const provider = `pigeon_no_auth_${randomUUID().replaceAll('-', '')}`;
      config('model_provider', provider);
      config(`model_providers.${provider}.name`, 'pigeon');
      config(`model_providers.${provider}.base_url`, binding.baseUrl);
      config(`model_providers.${provider}.wire_api`, 'responses');
      config(`model_providers.${provider}.requires_openai_auth`, false);
    } else {
      config('model_providers.pigeon.env_key', 'PIGEON_API_KEY');
      env.PIGEON_API_KEY = binding.apiKey;
    }
    config('model_providers.pigeon.wire_api', 'responses');
  }
  if (binding.model) config('model', binding.model);
  if (binding.effort) config('model_reasoning_effort', binding.effort);
  const rpc = rpcChannel(message => io.send(message));
  const fail = e => { ready.reject(e); rejectQueued('runner_disconnected'); rpc.rejectAll(e); state.finish(null, e); };
  function notification(message) {
    if (state.settled) return;
    const { method, params: p = {} } = message;
    if (p.threadId !== runnerSessionId) return;
    if (!runnerExecutionId && starting) {
      earlyBytes += Buffer.byteLength(JSON.stringify(message));
      if (earlyBytes > 8 * 1024 * 1024) throw error('RUNNER_OUTPUT_LIMIT', 'Codex startup event buffer exceeded');
      early.push(message); return;
    }
    if ((p.turnId || p.turn?.id) !== runnerExecutionId) return;
    if (method === 'turn/started') {
      state.emit('progress', { type: method, ...p });
      ready.resolve();
    } else if (method === 'item/agentMessage/delta') {
      if (!messages.has(p.itemId) && messages.size >= 1024) throw error('RUNNER_OUTPUT_LIMIT', 'Too many assistant messages');
      assistantBytes += Buffer.byteLength(p.delta);
      if (assistantBytes > 8 * 1024 * 1024) throw error('RUNNER_OUTPUT_LIMIT', 'Codex assistant buffer exceeds 8 MiB');
      const content = boundedText((messages.get(p.itemId) || '') + p.delta);
      messages.set(p.itemId, content);
      state.emit('assistant', { id: p.itemId, text: content, delta: p.delta, status: 'streaming' });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = p.item || {}, completed = method === 'item/completed';
      if (item.type === 'agentMessage' && completed) {
        text = boundedText(item.text || messages.get(item.id) || '');
        assistantBytes -= Buffer.byteLength(messages.get(item.id) || '');
        messages.delete(item.id);
        state.emit('assistant', { id: item.id, text, status: 'completed' });
      } else if (item.type === 'userMessage' && steers.has(item.clientId)) {
        const steer = steers.get(item.clientId);
        steer.observed = true;
        if (steer.accepted) {
          state.emit('input', { id: item.clientId, text: steer.text, kind: 'steer', status: 'consumed', observed: 'user_message_echo' });
          steers.delete(item.clientId);
        }
      } else if (['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'webSearch'].includes(item.type)) {
        if (completed) {
          openTools.delete(item.id);
          state.emit('tool_end', { id: item.id, output: item.aggregatedOutput ?? item.result ?? item.changes ?? item.action, status: item.status || 'completed', exit_code: item.exitCode ?? null });
          queueMicrotask(() => drain().catch(fail));
        } else {
          if (openTools.size >= 1024) throw error('RUNNER_OUTPUT_LIMIT', 'Too many active tools');
          openTools.add(item.id);
          state.emit('tool_start', { id: item.id, name: item.tool || item.type, input: item.arguments ?? item.command ?? item.changes ?? item.action });
        }
      }
    } else if (method === 'turn/completed') {
      const turn = p.turn;
      ready.resolve();
      rejectQueued('turn_finished_before_tool_boundary');
      for (const id of openTools) state.emit('tool_end', { id, output: null, status: 'unknown', exit_code: null, observed: 'turn_terminal_without_tool_completion' });
      openTools.clear();
      if (turn.status === 'completed') state.finish({ text, runnerSessionId, runnerExecutionId });
      else state.finish(null, error(turn.status === 'interrupted' ? 'RUNNER_CANCELLED' : 'RUNNER_ERROR', turn.error?.message || `Codex turn ${turn.status}`));
    } else if (method === 'error' && !p.willRetry) {
      fail(error('RUNNER_ERROR', p.error?.message || 'Codex execution failed'));
    } else state.emit('progress', { type: method, ...p });
  }
  const io = transport(process.env.PIGEON_CODEX_BIN || 'codex', args, {
    cwd: binding.cwd, env, onFailure: fail,
    onMessage(message) {
      if (rpc.receive(message)) return;
      if (message.method && message.id != null) {
        // No implicit interactive approval or fake tool result.
        io.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Interactive requests are unsupported by this headless runner' } }).catch(fail);
        return;
      }
      notification(message);
    },
  });
  state.setCloser(async () => { rpc.rejectAll(error('RUNNER_DISCONNECTED', 'Codex connection closed')); await io.close(); });
  try {
    await io.ready;
    await rpc.request('initialize', { clientInfo: { name: 'pigeon', version: '1.0.0' } });
    await io.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    const params = { cwd: binding.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' };
    if (binding.model) params.model = binding.model;
    if (session.runner_session_id) params.threadId = session.runner_session_id;
    const result = await rpc.request(session.runner_session_id ? 'thread/resume' : 'thread/start', params);
    runnerSessionId = result.thread?.id;
    if (!runnerSessionId) throw error('RUNNER_PROTOCOL_ERROR', 'Codex omitted thread id');
    state.emit('session', { runnerSessionId });
    if (result.thread.turns?.some(turn => turn.status === 'inProgress')) throw error('EXECUTION_BUSY', 'Codex resumed thread already has an active turn');
    starting = true;
    const turn = await rpc.request('turn/start', { threadId: runnerSessionId, input: [{ type: 'text', text: taskText(task) }], ...(binding.effort ? { effort: binding.effort } : {}) });
    runnerExecutionId = turn.turn?.id;
    if (!runnerExecutionId) throw error('RUNNER_PROTOCOL_ERROR', 'Codex omitted turn id');
    state.emit('execution', { runnerExecutionId });
    starting = false;
    for (const message of early) notification(message);
    early.length = 0;
    await timed(ready.promise, 'Codex turn readiness');
  } catch (e) { fail(e); await state.close(); throw e; }
  return {
    done: state.done,
    async steer(text, { messageId = randomUUID() } = {}) {
      state.active(); taskText(text);
      if (cancelling) throw error('EXECUTION_CANCELLING', 'Execution cancellation is already pending');
      if (steers.size >= 256) throw error('RUNNER_INPUT_LIMIT', 'Too many pending steering messages');
      if (steers.has(messageId)) throw error('DUPLICATE_INPUT', 'Steering message id is already pending');
      const steer = { text, accepted: false, observed: false };
      steers.set(messageId, steer);
      if (openTools.size || draining || pendingSteers.length) {
        pendingSteers.push(messageId);
        state.emit('input', { id: messageId, text, kind: 'steer', status: 'queued', observed: 'awaiting_tool_boundary' });
        queueMicrotask(() => drain().catch(fail));
        return { status: 'queued', messageId, observed: 'awaiting_tool_boundary' };
      }
      return deliver(messageId);
    },
    cancel: () => confirmedCancel(state, () => {
      cancelling = true;
      rejectQueued('cancel_requested');
      return rpc.request('turn/interrupt', { threadId: runnerSessionId, turnId: runnerExecutionId });
    }),
    close: () => { rejectQueued('connection_closed'); return state.close(); },
  };
}
