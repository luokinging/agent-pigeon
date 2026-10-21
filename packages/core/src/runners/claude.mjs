import { randomUUID } from 'node:crypto';
import { childEnv, confirmedCancel, deferred, error, lifecycle, taskText, timed, transport, boundedText } from './common.mjs';

export async function startClaude({ binding, session = {}, task, onEvent }) {
  const state = lifecycle(onEvent, [binding.apiKey]), ready = deferred();
  let runnerSessionId = session.runner_session_id || randomUUID(), text = '', cancelRequested = false, cancelAcknowledged = false;
  const steers = new Map(), controls = new Map();
  const env = childEnv(binding);
  delete env.CLAUDECODE;
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--dangerously-skip-permissions'];
  if (!binding.native) {
    if (binding.authMode === 'none' || !binding.apiKey) throw error('UNSUPPORTED_AUTH_MODE', 'Claude custom --bare requires an explicit API key; auth:none is unsupported');
    args.push('--bare');
    for (const [key, value] of Object.entries({ ANTHROPIC_BASE_URL: binding.baseUrl, ANTHROPIC_API_KEY: binding.apiKey, ANTHROPIC_MODEL: binding.model })) {
      if (value != null) env[key] = value;
    }
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  args.push(session.runner_session_id ? '--resume' : '--session-id', runnerSessionId);
  if (binding.model) args.push('--model', binding.model);
  if (binding.effort) args.push('--effort', binding.effort);
  function fail(e) {
    ready.reject(e);
    for (const wait of controls.values()) wait.reject(e);
    state.finish(null, e);
  }
  const io = transport(process.env.PIGEON_CLAUDE_BIN || 'claude', args, {
    cwd: binding.cwd, env, onFailure: fail,
    onMessage(message) {
      if (message.type === 'control_response') {
        const response = message.response || {};
        const wait = controls.get(response.request_id);
        if (response.subtype === 'error') wait?.reject(error('RUNNER_RPC_ERROR', response.error || 'Claude interrupt failed'));
        else if (wait) { cancelAcknowledged = true; wait.resolve(response); }
        return;
      }
      if (state.settled) return;
      if (message.session_id && message.session_id !== runnerSessionId) runnerSessionId = message.session_id;
      if (message.type === 'system' && message.subtype === 'init') {
        state.emit('session', { runnerSessionId }); ready.resolve();
      } else if (message.type === 'assistant') {
        const blocks = message.message?.content || [];
        for (const block of blocks) {
          if (block.type === 'tool_use') state.emit('tool_start', { id: block.id, name: block.name, input: block.input });
        }
        const content = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
        if (content) {
          text = boundedText(content);
          state.emit('assistant', { id: message.message?.id || message.uuid, text, status: 'completed' });
        }
        if (message.error) fail(error('RUNNER_ERROR', String(message.error)));
      } else if (message.type === 'user') {
        const sent = steers.get(message.uuid);
        if (sent) {
          sent.observed = true;
          if (sent.accepted) {
            state.emit('input', { id: sent.id, text: sent.text, status: 'consumed', kind: 'steer', observed: 'user_echo' });
            steers.delete(message.uuid);
          }
        }
        for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
          if (block.type === 'tool_result') state.emit('tool_end', {
            id: block.tool_use_id, output: block.content, status: block.is_error ? 'failed' : 'completed',
            exit_code: message.tool_use_result?.exit_code ?? message.tool_use_result?.exitCode ?? null,
          });
        }
      } else if (message.type === 'result') {
        ready.resolve();
        if (message.is_error || (message.subtype && message.subtype !== 'success')) {
          const reason = (message.errors || []).join('; ') || message.result || message.subtype;
          // CLI cancellation can end a tool or an active/starting model stream.
          // Correlate those terminal reasons with our acknowledged interrupt.
          const cancelled = cancelRequested && (cancelAcknowledged && ['aborted_tools', 'aborted_streaming'].includes(message.terminal_reason)
            || /interrupt(?:ed|ion)?|cancel(?:led|ed)/i.test(reason));
          state.finish(null, error(cancelled ? 'RUNNER_CANCELLED' : 'RUNNER_ERROR', reason));
        } else state.finish({ text: typeof message.result === 'string' ? message.result : text, runnerSessionId });
      } else state.emit('progress', { type: message.type, subtype: message.subtype, status: message.status });
    },
  });
  state.setCloser(() => io.close());
  function user(text, uuid) { return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid, session_id: runnerSessionId }; }
  try {
    await io.ready;
    await io.send(user(taskText(task), randomUUID()));
    await timed(ready.promise, 'Claude initialization');
  } catch (e) { fail(e); await state.close(); throw e; }
  return {
    done: state.done,
    async steer(text, { messageId = randomUUID() } = {}) {
      state.active(); taskText(text);
      if (steers.size >= 256) throw error('RUNNER_INPUT_LIMIT', 'Too many pending steering messages');
      const uuid = randomUUID();
      const sent = { id: messageId, text, accepted: false, observed: false };
      steers.set(uuid, sent);
      try { await io.send(user(text, uuid)); }
      catch (e) { steers.delete(uuid); throw e; }
      sent.accepted = true;
      state.emit('input', { id: messageId, text, status: 'accepted', kind: 'steer' });
      if (sent.observed) {
        state.emit('input', { id: messageId, text, status: 'consumed', kind: 'steer', observed: 'user_echo' });
        steers.delete(uuid);
      }
      return { status: 'accepted', messageId, observed: 'stdin_written' };
    },
    cancel() {
      return confirmedCancel(state, async () => {
        const request_id = randomUUID(), wait = deferred();
        controls.set(request_id, wait);
        cancelRequested = true;
        try {
          await io.send({ type: 'control_request', request_id, request: { subtype: 'interrupt' } });
          await timed(wait.promise, 'Claude interrupt');
          // The control response confirms the CLI processed the interrupt. It does not prove tool shutdown.
          state.emit('progress', { type: 'interrupt', status: 'acknowledged' });
        } finally { controls.delete(request_id); }
      });
    },
    close: () => state.close(),
  };
}
