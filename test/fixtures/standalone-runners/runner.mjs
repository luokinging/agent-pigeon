#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const runner = process.env.MOCK_RUNNER, scenario = process.env.MOCK_SCENARIO || 'success';
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
const log = x => { if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, JSON.stringify(x) + '\n'); };
log({ args: process.argv.slice(2), home: process.env[runner === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'], bareKey: Boolean(process.env.ANTHROPIC_API_KEY), authToken: Boolean(process.env.ANTHROPIC_AUTH_TOKEN) });
let first = true;
const sid = 'session-mock', tid = 'turn-mock';
const event = (method, params = {}) => send({ method, params: { threadId: sid, turnId: tid, ...params } });
function finish() {
  if (runner === 'claude') {
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'tool output' }] }, tool_use_result: { exit_code: 0 } });
    send({ type: 'assistant', message: { id: 'assistant-1', content: [{ type: 'text', text: 'final answer' }] } });
    send({ type: 'result', subtype: 'success', session_id: sid, result: 'final answer' });
    send({ type: 'result', subtype: 'success', result: 'WRONG SECOND RESULT' });
  } else {
    event('item/completed', { item: { id: 'tool-1', type: 'commandExecution', aggregatedOutput: 'tool output', status: 'completed', exitCode: 0 } });
    event('item/agentMessage/delta', { itemId: 'assistant-1', delta: 'final ' });
    event('item/completed', { item: { id: 'assistant-1', type: 'agentMessage', text: 'final answer' } });
    event('turn/completed', { turn: { id: tid, status: 'completed' } });
  }
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); log(m);
  if (runner === 'claude') {
    if (m.type === 'control_request') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
      setTimeout(() => send({ type: 'result', subtype: 'error_during_execution', is_error: true,
        terminal_reason: scenario === 'cancel-aborted' ? 'aborted_tools' : scenario === 'cancel-streaming' ? 'aborted_streaming' : undefined,
        errors: [scenario === 'cancel-streaming' ? '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null' : scenario === 'cancel-aborted' ? '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use' : scenario === 'cancel-failure' ? 'backend authentication failed' : 'Interrupted by user'] }), 70);
    } else if (first) {
      first = false;
      if (scenario === 'init-timeout') return;
      send({ type: 'system', subtype: 'init', session_id: sid });
      if (scenario !== 'cancel-streaming') send({ type: 'assistant', message: { id: 'a-tool', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'mock' } }] } });
      if (scenario === 'disconnect') setTimeout(() => process.exit(0), 40);
      if (scenario === 'error') setTimeout(() => send({ type: 'result', is_error: true, errors: ['failure mock-secret-key'] }), 40);
      if (scenario === 'overflow') setTimeout(() => process.stdout.write('x'.repeat(9 * 1024 * 1024)), 40);
    } else {
      send({ ...m });
      if (scenario === 'success') setTimeout(finish, 20);
    }
    return;
  }
  const response = result => send({ id: m.id, result });
  if (m.method === 'initialize') { if (scenario !== 'init-timeout') response({}); }
  else if (m.method === 'thread/start' || m.method === 'thread/resume') response({ thread: { id: sid } });
  else if (m.method === 'turn/start') {
    if (scenario === 'delayed-start') {
      response({ turn: { id: tid, status: 'inProgress' } });
      setTimeout(() => { log({ marker: 'turn-started' }); event('turn/started', { turn: { id: tid, status: 'inProgress' } }); }, 100);
      return;
    }
    // Notifications can arrive before the start response.
    event('turn/started', { turn: { id: tid, status: 'inProgress' } });
    event('turn/completed', { turnId: 'previous', turn: { id: 'previous', status: 'completed' } });
    if (!['steer-error', 'steer-timeout'].includes(scenario)) event('item/started', { item: { id: 'tool-1', type: 'commandExecution', command: 'mock' } });
    response({ turn: { id: tid, status: 'inProgress' } });
    if (scenario === 'success') setTimeout(() => {
      log({ marker: 'tool-completed' });
      event('item/completed', { item: { id: 'tool-1', type: 'commandExecution', aggregatedOutput: 'tool output', status: 'completed', exitCode: 0 } });
    }, 70);
    if (scenario === 'boundary-missed') setTimeout(() => event('turn/completed', { turn: { id: tid, status: 'completed' } }), 70);
    if (scenario === 'disconnect') setTimeout(() => process.exit(0), 40);
    if (scenario === 'error') setTimeout(() => event('turn/completed', { turn: { id: tid, status: 'failed', error: { message: 'failure mock-secret-key' } } }), 40);
  } else if (m.method === 'turn/steer') {
    if (scenario === 'steer-error') send({ id: m.id, error: { code: -32000, message: 'steering refused' } });
    else if (scenario !== 'steer-timeout') {
      event('item/started', { item: { type: 'userMessage', id: 'echo-1', clientId: m.params.clientUserMessageId, content: m.params.input } });
      response({ turnId: tid });
      if (scenario === 'success') setTimeout(finish, 20);
    }
  } else if (m.method === 'turn/interrupt') {
    response({});
    setTimeout(() => event('turn/completed', { turn: { id: tid, status: 'interrupted' } }), 70);
  }
});
