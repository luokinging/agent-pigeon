import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { Store, compactValue, presentMessage } from '../packages/core/src/store.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pigeon-store-'));
  const home = join(directory, 'home');
  const store = new Store(home);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, home };
}

function session(store) { return store.createSession({ runner: 'test', model: 'test-model' }); }

test('private files, SQLite settings, persistent identities and secret filtering', t => {
  const { store, home } = fixture(t);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'state.db')).mode & 0o777, 0o600);
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 1);
  const binding = { runner: 'test', apiKey: 'NEVER_SAVE_ME', auth_ref: 'profile/default',
    nested: { authorization: 'NEVER_SAVE_ME', api_key: 'NEVER_SAVE_ME', public: true },
    profiles: [{ token: 'NEVER_SAVE_ME', name: 'default' }] };
  const created = store.createSession(binding, { host: 'test', password: 'NEVER_SAVE_ME' });
  assert.match(created.id, /^pgs_[0-9a-f-]{36}$/);
  assert.deepEqual(created.binding, { runner: 'test', auth_ref: 'profile/default', nested: { public: true }, profiles: [{ name: 'default' }] });
  assert.deepEqual(created.origin, { host: 'test' });
  assert.equal(binding.apiKey, 'NEVER_SAVE_ME');
  store.setRunnerSession(created.id, 'runner-thread');
  const execution = store.createExecution(created.id, 'task');
  assert.match(execution.id, /^pge_[0-9a-f-]{36}$/);
  store.patchExecution(execution.id, { pid: 123, socket: '/tmp/control.sock', token: 'NEVER_SAVE_ME',
    runner_execution_id: 'turn-1', error: { detail: 'retry' } });
  store.appendEvent(execution.id, 'metadata', { keep: true });
  store.finishExecution(execution.id, { status: 'completed', result: { text: 'done' } });
  const second = new Store(home);
  try {
    assert.equal(second.getSession(created.id).runner_session_id, 'runner-thread');
    assert.equal(second.getExecution(execution.id).runner_execution_id, 'turn-1');
    assert.equal(second.getExecution(execution.id).task, 'task');
    assert.deepEqual(second.getExecution(execution.id).result, { text: 'done' });
    assert.equal(second.getExecution(execution.id).token, undefined);
  } finally { second.close(); }
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal(readFileSync(join(home, 'state.db')).includes(Buffer.from('NEVER_SAVE_ME')), false);
  assert.throws(() => store.getSession('missing'), /Session not found/);
  assert.throws(() => store.getExecution('missing'), /Execution not found/);
});

test('generic event, tool, result and error data preserve business token and auth fields', t => {
  const { store, home } = fixture(t);
  const s = session(store);
  const execution = store.createExecution(s.id, 'parse source');
  const business = { token: { kind: 'identifier', text: 'foo' }, auth: false,
    nested: [{ token: 'syntax-token', secret: false }], source: 'foo' };
  const start = store.appendEvent(execution.id, 'tool_start', {
    id: 'parse', name: 'Parser', input: business,
  });
  assert.deepEqual(start.data.input, business);
  store.appendEvent(execution.id, 'tool_end', { id: 'parse', output: business, status: 'completed' });
  store.patchExecution(execution.id, { token: 'DO_NOT_STORE_CONTROL_TOKEN', error: business });
  assert.deepEqual(store.getExecution(execution.id).error, business);
  store.finishExecution(execution.id, { status: 'completed', result: business, error: business });

  const reopened = new Store(home);
  try {
    const tool = reopened.messages(s.id, { limit: 1 })[0];
    assert.deepEqual(tool.input, business);
    assert.deepEqual(tool.output, business);
    const events = reopened.listEvents(execution.id);
    assert.deepEqual(events.find(event => event.type === 'tool_start').data.input, business);
    assert.deepEqual(events.find(event => event.type === 'tool_end').data.output, business);
    assert.deepEqual(events.at(-1).data.result, business);
    assert.deepEqual(events.at(-1).data.error, business);
    assert.deepEqual(reopened.getExecution(execution.id).result, business);
    assert.deepEqual(reopened.getExecution(execution.id).error, business);
    const raw = reopened.db.prepare('SELECT input, output FROM messages WHERE id = ?').get('parse');
    assert.deepEqual(JSON.parse(raw.input), business);
    assert.deepEqual(JSON.parse(raw.output), business);
  } finally { reopened.close(); }
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal(readFileSync(join(home, 'state.db')).includes(Buffer.from('DO_NOT_STORE_CONTROL_TOKEN')), false);
});

test('simultaneous connections permit one active execution and one original message', async t => {
  const { store, home } = fixture(t);
  const s = session(store);
  const moduleUrl = new URL('../packages/core/src/store.mjs', import.meta.url).href;
  const barrier = new SharedArrayBuffer(4);
  const workers = Array.from({ length: 4 }, () => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { Store } = await import(workerData.moduleUrl);
      const store = new Store(workerData.home);
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      try { parentPort.postMessage({ id: store.createExecution(workerData.sessionId, 'racing task').id }); }
      catch (error) { parentPort.postMessage({ error: error.message }); }
      finally { store.close(); }
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { moduleUrl, home, sessionId: s.id, barrier } }));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  const ready = [];
  const results = workers.map(worker => new Promise((resolve, reject) => {
    ready.push(new Promise((done, fail) => {
      worker.once('error', fail);
      worker.on('message', message => message.ready && done());
    }));
    worker.once('error', reject);
    worker.on('message', message => !message.ready && resolve(message));
  }));
  await Promise.all(ready);
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0);
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter(item => item.id).length, 1);
  assert.equal(outcomes.filter(item => /active execution/.test(item.error)).length, 3);
  assert.equal(store.listExecutions({ sessionId: s.id }).length, 1);
  assert.equal(store.messages(s.id).length, 1);
  const winner = outcomes.find(item => item.id).id;
  for (const status of ['running', 'canceling']) {
    store.patchExecution(winner, { status });
    assert.throws(() => store.createExecution(s.id, 'duplicate'), /active execution/);
  }
  // The database invariant also protects callers using another write path.
  store.finishExecution(winner, { status: 'completed' });
  const next = store.createExecution(s.id, 'next');
  assert.throws(() => store.db.prepare('UPDATE executions SET status = ? WHERE id = ?').run('running', winner), /UNIQUE/);
  assert.equal(store.getExecution(next.id).status, 'starting');
});

test('terminal states are immutable and finishing is atomic and idempotent', t => {
  const { store } = fixture(t);
  const s = session(store);
  const execution = store.createExecution(s.id, 'finish');
  store.db.exec(`CREATE TRIGGER reject_finished BEFORE INSERT ON events WHEN NEW.type = 'finished'
    BEGIN SELECT RAISE(ABORT, 'simulate event failure'); END`);
  assert.throws(() => store.finishExecution(execution.id, { status: 'completed', result: 'lost' }), /simulate event failure/);
  assert.equal(store.getExecution(execution.id).status, 'starting');
  assert.equal(store.getExecution(execution.id).result, null);
  store.db.exec('DROP TRIGGER reject_finished');
  const finished = store.finishExecution(execution.id, { status: 'completed', result: { answer: 42 } });
  assert.deepEqual(store.finishExecution(execution.id, { status: 'failed', error: 'late failure' }), finished);
  assert.deepEqual(store.patchExecution(execution.id, { status: 'running', pid: 999 }), finished);
  assert.equal(store.listEvents(execution.id).filter(e => e.type === 'finished').length, 1);
  const next = store.createExecution(s.id, 'unknown');
  store.patchExecution(next.id, { error: { message: 'worker disappeared' } });
  assert.deepEqual(store.getExecution(next.id).error, { message: 'worker disappeared' });
  assert.equal(store.finishExecution(next.id, { status: 'unknown' }).status, 'unknown');
  assert.throws(() => store.finishExecution(next.id, { status: 'running' }), /terminal status/);
});

test('unresolved unknown blocks resume across connections and cannot be cleared by late finishes', t => {
  const { store, home } = fixture(t);
  const s = session(store);
  const older = store.createExecution(s.id, 'older task');
  store.finishExecution(older.id, { status: 'completed' });
  const uncertain = store.createExecution(s.id, 'uncertain task');
  store.finishExecution(uncertain.id, { status: 'unknown', error: 'worker disappeared' });
  const before = store.messages(s.id);
  const other = new Store(home);
  try {
    for (const connection of [store, other]) {
      assert.throws(() => connection.createExecution(s.id, 'unsafe resume'), /unresolved unknown.*reconciliation/);
    }
    // Late completion of either an older turn or the uncertain turn cannot
    // reconcile unknown implicitly or make the session resumable.
    store.finishExecution(older.id, { status: 'completed', result: 'late old result' });
    assert.equal(store.finishExecution(uncertain.id, { status: 'completed' }).status, 'unknown');
    assert.throws(() => other.createExecution(s.id, 'still unsafe'), /unresolved unknown/);
    assert.equal(other.listExecutions({ sessionId: s.id }).length, 2);
    assert.deepEqual(other.messages(s.id), before);
    assert.equal(other.listEvents(uncertain.id).filter(e => e.type === 'finished').length, 1);
    const independent = session(other);
    assert.equal(other.createExecution(independent.id, 'independent task').status, 'starting');
  } finally { other.close(); }
});

test('assistant deltas, tools and steer updates each retain one logical message', t => {
  const { store } = fixture(t);
  const s = session(store);
  const execution = store.createExecution(s.id, 'original');
  const append = (type, data) => store.appendEvent(execution.id, type, data);
  const first = append('assistant', { id: 'answer', text: '你', delta: true });
  append('assistant', { id: 'answer', text: '好', delta: true });
  append('assistant', { id: 'answer', delta: '！' });
  append('assistant', { id: 'answer', delta: '' });
  assert.equal(store.messages(s.id).at(-1).text, '你好！');
  assert.equal(store.messages(s.id).at(-1).status, 'streaming');
  append('assistant', { id: 'answer', text: '你好！', status: 'completed' });
  append('tool_start', { id: 'tool-1', name: 'Bash', input: { command: 'pwd' } });
  append('tool_end', { id: 'tool-1', output: '/workspace', status: 'completed', exit_code: 0 });
  append('input', { id: 'steer-1', text: 'focus tests', status: 'accepted', kind: 'steer' });
  append('input', { id: 'steer-1', status: 'consumed', kind: 'steer' });
  append('heartbeat', { alive: true });
  const messages = store.messages(s.id);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(messages[1].seq, first.seq);
  assert.equal(messages[1].text, '你好！');
  assert.equal(messages[1].status, 'completed');
  assert.deepEqual(messages[2].input, { command: 'pwd' });
  assert.equal(messages[2].output, '/workspace');
  assert.equal(messages[2].exit_code, 0);
  assert.equal(messages[2].tool_name, 'Bash');
  assert.equal(messages[3].text, 'focus tests');
  assert.equal(messages[3].status, 'consumed');
  const events = store.listEvents(execution.id, { after: first.seq, limit: 2 });
  assert.equal(events.length, 2);
  assert.ok(events.every(e => e.seq > first.seq && e.execution_id === execution.id));
});

test('initial input is accepted and delayed ACKs preserve consumption and original kind', t => {
  const { store } = fixture(t);
  const s = session(store);
  const execution = store.createExecution(s.id, 'original task');
  const original = store.messages(s.id)[0];
  assert.equal(original.status, 'accepted');
  assert.equal(original.kind, 'task');
  assert.equal(store.listEvents(execution.id)[0].data.status, 'accepted');

  store.appendEvent(execution.id, 'input', {
    id: original.id, text: 'original task', status: 'consumed', kind: 'steer',
  });
  assert.equal(store.messages(s.id).length, 1);
  assert.equal(store.messages(s.id)[0].kind, 'task');
  assert.equal(store.messages(s.id)[0].status, 'consumed');

  store.appendEvent(execution.id, 'input', {
    id: 'early-echo', text: 'focus tests', status: 'consumed', kind: 'steer',
  });
  const steer = store.messages(s.id).at(-1);
  for (const status of ['accepted', 'queued']) {
    for (const id of [original.id, steer.id]) {
      store.appendEvent(execution.id, 'input', { id, status, kind: 'task' });
    }
    const messages = store.messages(s.id);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map(message => message.status), ['consumed', 'consumed']);
    assert.deepEqual(messages.map(message => message.kind), ['task', 'steer']);
    assert.equal(messages[0].seq, original.seq);
    assert.equal(messages[1].seq, steer.seq);
    assert.equal(messages[1].text, 'focus tests');
  }
  // Keep the actual ACK events in history even when their logical projection
  // must not regress the message's confirmed consumption state.
  assert.equal(store.listEvents(execution.id).at(-1).data.status, 'queued');
});

test('messages N selects newest logical rows, in chronological order across executions', t => {
  const { store } = fixture(t);
  const s = session(store);
  const first = store.createExecution(s.id, 'first task');
  for (let i = 0; i < 15; i++) store.appendEvent(first.id, 'assistant', { id: `a-${i}`, text: String(i) });
  assert.equal(store.messages(s.id).length, 10);
  assert.deepEqual(store.messages(s.id, { limit: 3 }).map(m => m.text), ['12', '13', '14']);
  store.finishExecution(first.id, { status: 'completed' });
  const second = store.createExecution(s.id, 'second task');
  store.appendEvent(second.id, 'assistant', { id: 'a-14', text: 'second answer' });
  assert.deepEqual(store.messages(s.id, { limit: 3 }).map(m => m.text), ['14', 'second task', 'second answer']);
  assert.deepEqual(store.messages(s.id, { executionId: first.id, limit: 2 }).map(m => m.text), ['13', '14']);
  assert.equal(store.messages(s.id, { limit: 0 }).length, 0);
  assert.equal(store.listExecutions({ sessionId: s.id, limit: 1 })[0].id, second.id);
  const other = session(store);
  assert.equal(store.listSessions({ limit: 1 })[0].id, other.id);
  assert.throws(() => store.messages(other.id, { executionId: second.id }), /does not belong/);
  for (const limit of [-1, 1.5, Infinity, '10']) assert.throws(() => store.messages(s.id, { limit }), /non-negative/);
});

test('compaction obeys UTF-8 byte limits, retains head/tail and reports exact metadata', () => {
  const text = 'HEAD🙂你好'.repeat(1000) + 'TAIL终';
  for (const maxBytes of [0, 1, 2, 3, 4, 5, 6, 7, 12, 32, 4000]) {
    const compact = compactValue(text, { maxBytes });
    assert.equal(compact.truncated, true);
    assert.equal(compact.original_bytes, Buffer.byteLength(text));
    assert.equal(compact.returned_bytes, Buffer.byteLength(compact.text));
    assert.ok(compact.returned_bytes <= maxBytes);
    assert.equal(compact.text.includes('�'), false);
  }
  const compact = compactValue(text, { maxBytes: 64 });
  assert.ok(compact.text.startsWith('HEAD'));
  assert.ok(compact.text.endsWith('TAIL终'));
  assert.deepEqual(compactValue('你好', { maxBytes: 6 }), {
    text: '你好', truncated: false, original_bytes: 6, returned_bytes: 6,
  });
  assert.deepEqual(compactValue({ command: 'pwd' }), {
    text: '{"command":"pwd"}', truncated: false, original_bytes: 17, returned_bytes: 17,
  });
  assert.throws(() => compactValue(text, { maxBytes: -1 }), /maxBytes/);
});

test('raw message and event presentation is bounded while stored content and task remain complete', t => {
  const { store } = fixture(t);
  const s = session(store);
  const huge = 'HEAD' + '🙂中文'.repeat(3000) + 'TAIL';
  const execution = store.createExecution(s.id, huge);
  assert.equal(store.getExecution(execution.id).task, huge);
  store.appendEvent(execution.id, 'tool_start', { id: 'big-tool', name: 'Bash', input: { command: huge } });
  store.appendEvent(execution.id, 'tool_end', { id: 'big-tool', output: huge, status: 'failed', exit_code: 2 });
  const tool = store.messages(s.id).at(-1);
  assert.equal(tool.id, 'big-tool');
  assert.equal(tool.status, 'failed');
  assert.equal(tool.exit_code, 2);
  assert.equal(tool.truncation.input.truncated, true);
  assert.equal(tool.truncation.output.original_bytes, Buffer.byteLength(huge));
  assert.ok(Buffer.byteLength(tool.input) <= 4000);
  assert.ok(Buffer.byteLength(tool.output) <= 4000);
  const raw = JSON.parse(JSON.stringify(tool));
  assert.ok(Buffer.byteLength(raw.output) <= 4000);
  const persisted = store.db.prepare('SELECT input, output FROM messages WHERE id = ?').get('big-tool');
  assert.equal(JSON.parse(persisted.input).command, huge);
  assert.equal(JSON.parse(persisted.output), huge);
  assert.ok(store.listEvents(execution.id).every(e => Buffer.byteLength(typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) <= 4000));
  assert.equal(store.listExecutions()[0].truncation.task.truncated, true);
  const message = { id: 'stable', status: 'completed', text: huge, input: { short: true }, output: huge };
  const presented = presentMessage(message, { maxBytes: 32 });
  assert.equal(presented.id, message.id);
  assert.equal(presented.status, message.status);
  assert.deepEqual(presented.input, { short: true });
  assert.ok(Buffer.byteLength(presented.text) <= 32);
  assert.ok(Buffer.byteLength(presented.output) <= 32);
  assert.equal(message.text, huge);
});
