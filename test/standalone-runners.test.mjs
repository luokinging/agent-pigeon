import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startRunner } from '../packages/core/src/runners/index.mjs';
import { discoverHermes } from '../packages/core/src/runners/hermes-discovery.mjs';
import { lifecycle } from '../packages/core/src/runners/common.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/standalone-runners');
const executable = join(fixtures, 'runner.mjs');
await chmod(executable, 0o755);
const python = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
const modes = { claude: 'stream-json', codex: 'app-server', hermes: 'gateway' };
async function setup(t, runner, scenario = 'success', extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pigeon-runners-'));
  const log = join(dir, 'requests.jsonl'), old = { ...process.env };
  Object.assign(process.env, {
    MOCK_RUNNER: runner, MOCK_SCENARIO: scenario, MOCK_LOG: log,
    PIGEON_CLAUDE_BIN: executable, PIGEON_CODEX_BIN: executable,
    PIGEON_HERMES_ROOT: join(fixtures, 'hermes'), PIGEON_HERMES_PYTHON: python,
    PIGEON_RUNNER_RPC_TIMEOUT_MS: '1000',
  });
  const handles = [];
  t.after(async () => {
    await Promise.all(handles.map(handle => handle.close()));
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
    await rm(dir, { recursive: true, force: true });
  });
  const events = [];
  const binding = { runner, mode: modes[runner], native: true, cwd: dir, scope: join(dir, 'scope'), ...extra };
  return { events, binding, log,
    async start(session = {}) {
      const handle = await startRunner({ binding, session, task: 'mock task', onEvent: (type, data) => events.push({ type, ...data }) });
      handles.push(handle);
      return handle;
    },
    async requests() { return (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse); },
  };
}
for (const runner of Object.keys(modes)) {
  test(`${runner}: ready steer, events, first finite result and automatic close`, async t => {
    const ctx = await setup(t, runner), handle = await ctx.start();
    const ack = await handle.steer('extra requirement', { messageId: 'input-1' });
    assert.equal(ack.status, runner === 'codex' ? 'queued' : 'accepted');
    assert.notEqual(ack.status, 'consumed');
    const result = await handle.done;
    assert.equal(result.text, 'final answer'); assert.equal(result.runnerSessionId, 'session-mock');
    assert(ctx.events.some(e => e.type === 'tool_start' && e.id === 'tool-1'));
    assert(ctx.events.some(e => e.type === 'tool_end' && e.exit_code === 0));
    assert(ctx.events.some(e => e.type === 'assistant' && e.text === 'final answer'));
    assert(ctx.events.some(e => e.type === 'input' && e.id === 'input-1' && e.status === 'accepted'));
    await assert.rejects(handle.steer('too late'), { code: 'EXECUTION_FINISHED' });
    await handle.close();
    const requests = await ctx.requests();
    assert.equal(requests[0].home, ctx.binding.scope);
    if (runner === 'claude') {
      assert(!requests[0].args.includes('--bare'));
      assert(!requests[0].args.includes('--setting-sources'));
      assert(requests[0].args.includes('--replay-user-messages'));
      const users = requests.filter(x => x.type === 'user');
      assert.equal(users.length, 2); assert.notEqual(users[0].uuid, users[1].uuid);
      assert(ctx.events.some(e => e.type === 'input' && e.observed === 'user_echo'));
    }
    if (runner === 'codex') {
      assert(requests.findIndex(x => x.marker === 'tool-completed') < requests.findIndex(x => x.method === 'turn/steer'));
      assert(ctx.events.some(e => e.type === 'input' && e.observed === 'user_message_echo'));
    }
    if (runner === 'hermes') {
      assert(!requests.some(x => ['session.close', 'session.interrupt'].includes(x.method)));
      const create = requests.find(x => x.method === 'session.create');
      assert.equal(create.params.source, 'tool'); assert.equal(create.params.ignore_user_config, undefined);
      assert.equal(create.params.provider, undefined);
    }
  });
  test(`${runner}: cancel waits for terminal confirmation`, async t => {
    const ctx = await setup(t, runner, 'hold'), handle = await ctx.start();
    const started = Date.now();
    const ack = await handle.cancel();
    assert.equal(ack.status, 'cancelled'); assert.equal(ack.confirmed, true);
    assert(Date.now() - started >= 50);
    await assert.rejects(handle.done, { code: 'RUNNER_CANCELLED' });
  });
  test(`${runner}: disconnect rejects with unknown outcome`, async t => {
    const ctx = await setup(t, runner, 'disconnect'), handle = await ctx.start();
    await assert.rejects(handle.done, { code: 'RUNNER_DISCONNECTED' });
  });
  test(`${runner}: backend failure rejects and redacts credentials`, async t => {
    const ctx = await setup(t, runner, 'error', { apiKey: 'mock-secret-key' }), handle = await ctx.start();
    await assert.rejects(handle.done, e => e.code === 'RUNNER_ERROR' && !e.message.includes('mock-secret-key'));
  });
  test(`${runner}: close disconnects without claiming cancellation`, async t => {
    const ctx = await setup(t, runner, 'hold'), handle = await ctx.start();
    await handle.close(); await handle.close();
    await assert.rejects(handle.done, { code: 'RUNNER_DISCONNECTED' });
    assert(!(await ctx.requests()).some(x => ['turn/interrupt', 'session.interrupt'].includes(x.method) || x.type === 'control_request'));
  });
  test(`${runner}: resumes saved underlying session`, async t => {
    const ctx = await setup(t, runner, 'hold'), handle = await ctx.start({ runner_session_id: 'saved-session' });
    await handle.close();
    const requests = await ctx.requests();
    if (runner === 'claude') assert.equal(requests[0].args[requests[0].args.indexOf('--resume') + 1], 'saved-session');
    if (runner === 'codex') assert.equal(requests.find(x => x.method === 'thread/resume').params.threadId, 'saved-session');
    if (runner === 'hermes') assert.deepEqual(requests.find(x => x.method === 'session.resume').params, { session_id: 'saved-session' });
  });
}
test('Hermes custom session overrides are scoped; resume freezes route', async t => {
  const ctx = await setup(t, 'hermes', 'hold', { native: false, provider: 'custom', baseUrl: 'https://example.invalid/v1', apiKey: 'mock-secret-key', model: 'mock-model', effort: 'ultra' });
  let handle = await ctx.start(); await handle.close();
  const create = (await ctx.requests()).find(x => x.method === 'session.create');
  assert.equal(create.params.api_key, 'mock-secret-key'); assert.equal(create.params.reasoning, 'ultra');
  handle = await ctx.start({ runner_session_id: 'saved-session' }); await handle.close();
  const resume = (await ctx.requests()).find(x => x.method === 'session.resume');
  assert.deepEqual(resume.params, { session_id: 'saved-session', api_key: 'mock-secret-key' });
});
test('Hermes rejects managed worker before submitting work', async t => {
  const ctx = await setup(t, 'hermes', 'managed');
  await assert.rejects(ctx.start(), /unsupported_control/);
  assert(!(await ctx.requests()).some(x => x.method === 'prompt.submit'));
});
test('Hermes discovery fails clearly without a reliable runtime', async () => {
  await assert.rejects(discoverHermes({ PATH: '', PIGEON_HERMES_ROOT: '/missing' }), { code: 'HERMES_RUNTIME_NOT_FOUND' });
});
for (const runner of ['codex', 'hermes']) test(`${runner}: steer refusal is not accepted`, async t => {
  const ctx = await setup(t, runner, 'steer-error'), handle = await ctx.start();
  await assert.rejects(handle.steer('extra'));
  assert(!ctx.events.some(x => x.type === 'input' && x.status === 'accepted'));
});
for (const runner of ['claude', 'codex']) test(`${runner}: startup timeout is bounded`, async t => {
  const ctx = await setup(t, runner, 'init-timeout');
  process.env.PIGEON_RUNNER_RPC_TIMEOUT_MS = '100';
  await assert.rejects(ctx.start(), { code: 'RUNNER_TIMEOUT' });
});
test('Codex steer response timeout does not fabricate an ack', async t => {
  const ctx = await setup(t, 'codex', 'steer-timeout'), handle = await ctx.start();
  process.env.PIGEON_RUNNER_RPC_TIMEOUT_MS = '100';
  await assert.rejects(handle.steer('extra'), { code: 'RUNNER_TIMEOUT' });
});
test('Codex rejects queued steer if turn ends before tool boundary', async t => {
  const ctx = await setup(t, 'codex', 'boundary-missed'), handle = await ctx.start();
  assert.equal((await handle.steer('extra', { messageId: 'queued' })).status, 'queued');
  await handle.done;
  assert(!(await ctx.requests()).some(x => x.method === 'turn/steer'));
  assert(ctx.events.some(x => x.type === 'input' && x.id === 'queued' && x.status === 'rejected' && x.delivered === false));
  assert(ctx.events.some(x => x.type === 'tool_end' && x.status === 'unknown' && x.exit_code === null));
});
test('Codex waits for turn/started before exposing immediate controls', async t => {
  const ctx = await setup(t, 'codex', 'delayed-start');
  const handle = await ctx.start();
  assert((await ctx.requests()).some(event => event.marker === 'turn-started'));
  assert.equal((await handle.cancel()).status, 'cancelled');
  await assert.rejects(handle.done, { code: 'RUNNER_CANCELLED' });
});
test('Claude classifies acknowledged aborted_tools as cancellation', async t => {
  const ctx = await setup(t, 'claude', 'cancel-aborted'), handle = await ctx.start();
  assert.equal((await handle.cancel()).status, 'cancelled');
  await assert.rejects(handle.done, { code: 'RUNNER_CANCELLED' });
});
test('Claude classifies acknowledged aborted_streaming before tools as cancellation', async t => {
  const ctx = await setup(t, 'claude', 'cancel-streaming'), handle = await ctx.start();
  assert.equal((await handle.cancel()).status, 'cancelled');
  await assert.rejects(handle.done, { code: 'RUNNER_CANCELLED' });
  assert(!ctx.events.some(event => event.type === 'tool_start'));
});
test('Claude does not hide real failures after an interrupt request', async t => {
  const ctx = await setup(t, 'claude', 'cancel-failure'), handle = await ctx.start();
  await assert.rejects(handle.cancel(), { code: 'RUNNER_ERROR' });
  await assert.rejects(handle.done, { code: 'RUNNER_ERROR' });
});
for (const runner of ['claude', 'hermes']) test(`${runner} custom auth:none rejects before launching`, async t => {
  const ctx = await setup(t, runner, 'hold', { native: false, authMode: 'none', apiKey: null });
  await assert.rejects(ctx.start(), { code: 'UNSUPPORTED_AUTH_MODE' });
});
test('redaction preserves JSON string structure and handles escaped credentials', async () => {
  const secret = 'key"with\\slashes', events = [];
  const state = lifecycle((type, data) => events.push(data), [secret]);
  state.emit('assistant', { id: 'a', text: `token=example ${secret}`, input: { nested: ['Bearer test-token'] } });
  assert.equal(events[0].id, 'a');
  assert.equal(events[0].text, 'token=[REDACTED] [REDACTED]');
  assert.equal(events[0].input.nested[0], 'Bearer [REDACTED]');
  state.finish({ text: `Bearer secret ${secret}` });
  assert.equal((await state.done).text, 'Bearer [REDACTED] [REDACTED]');
});
test('Claude bounds incomplete stdout frames', async t => {
  const ctx = await setup(t, 'claude', 'overflow'), handle = await ctx.start();
  await assert.rejects(handle.done, { code: 'RUNNER_OUTPUT_LIMIT' });
});
