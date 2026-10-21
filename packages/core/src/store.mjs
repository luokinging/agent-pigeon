import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ACTIVE = new Set(['starting', 'running', 'canceling']);
const TERMINAL = new Set(['completed', 'failed', 'canceled', 'unknown']);
const VERSION = 1;
const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|authorization|proxy[_-]?authorization|credentials?|private[_-]?key|cookie|set[_-]?cookie|auth)$/i;

// Bindings/origins contain public identity information and auth references only.
// Generic event/message/result payloads retain business fields verbatim; actual
// credential values must be redacted by the runtime/adapter before storage.
function publicValue(value) {
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, item]) => [key, publicValue(item)]));
  }
  return value;
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function limitValue(value, name = 'limit') {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

/** Deterministic UTF-8 head/tail clipping, including the marker in maxBytes. */
export function compactValue(value, { maxBytes = 4000 } = {}) {
  limitValue(maxBytes, 'maxBytes');
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const bytes = Buffer.from(text);
  const original_bytes = bytes.length;
  if (original_bytes <= maxBytes) {
    return { text, truncated: false, original_bytes, returned_bytes: original_bytes };
  }
  const marker = maxBytes >= 5 ? '\n…\n' : maxBytes >= 3 ? '…' : '.'.repeat(maxBytes);
  const remaining = maxBytes - Buffer.byteLength(marker);
  let headEnd = Math.ceil(remaining / 2);
  let tailStart = bytes.length - Math.floor(remaining / 2);
  // Move both boundaries inward, never decoding partial UTF-8 characters.
  while (headEnd > 0 && (bytes[headEnd] & 0xc0) === 0x80) headEnd--;
  while (tailStart < bytes.length && (bytes[tailStart] & 0xc0) === 0x80) tailStart++;
  const clipped = bytes.subarray(0, headEnd).toString() + marker + bytes.subarray(tailStart).toString();
  return { text: clipped, truncated: true, original_bytes, returned_bytes: Buffer.byteLength(clipped) };
}

// Small values retain their types. Oversized values become text and have an
// explicit per-field descriptor in `truncation`; IDs/status are never clipped.
function presentFields(record, fields, options) {
  const result = { ...record };
  for (const field of fields) {
    if (result[field] === null || result[field] === undefined) continue;
    const compact = compactValue(result[field], options);
    if (!compact.truncated) continue;
    const { text, ...metadata } = compact;
    result[field] = text;
    result.truncation = { ...result.truncation, [field]: metadata };
  }
  return result;
}

export function presentMessage(message, { maxBytes = 4000 } = {}) {
  return presentFields(message, ['text', 'input', 'output'], { maxBytes });
}

function decode(row, fields) {
  const result = { ...row };
  for (const field of fields) result[field] = JSON.parse(result[field]);
  return result;
}

export class Store {
  constructor(homePath) {
    this.homePath = resolve(homePath);
    mkdirSync(this.homePath, { recursive: true, mode: 0o700 });
    chmodSync(this.homePath, 0o700);
    this.dbPath = join(this.homePath, 'state.db');
    closeSync(openSync(this.dbPath, 'a', 0o600));
    chmodSync(this.dbPath, 0o600);
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get().user_version;
        if (version > VERSION) throw new Error(`Unsupported database version: ${version}`);
        if (version === 0) {
          this.db.exec(`
            CREATE TABLE sessions (
              id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
              binding TEXT NOT NULL, origin TEXT NOT NULL,
              runner_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE executions (
              id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
              task TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN
                ('starting','running','canceling','completed','failed','canceled','unknown')),
              runner_execution_id TEXT, pid INTEGER, socket TEXT,
              result TEXT NOT NULL DEFAULT 'null', error TEXT NOT NULL DEFAULT 'null',
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              started_at TEXT, finished_at TEXT
            );
            CREATE UNIQUE INDEX one_active_execution ON executions(session_id)
              WHERE status IN ('starting','running','canceling');
            CREATE INDEX executions_session ON executions(session_id, created_at);
            CREATE TABLE events (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              session_id TEXT NOT NULL REFERENCES sessions(id),
              execution_id TEXT NOT NULL REFERENCES executions(id),
              type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE INDEX events_execution ON events(execution_id, seq);
            CREATE INDEX events_session ON events(session_id, seq);
            CREATE TABLE messages (
              id TEXT NOT NULL, seq INTEGER NOT NULL REFERENCES events(seq),
              session_id TEXT NOT NULL REFERENCES sessions(id),
              execution_id TEXT NOT NULL REFERENCES executions(id), role TEXT NOT NULL,
              text TEXT, tool_name TEXT, input TEXT NOT NULL DEFAULT 'null',
              output TEXT NOT NULL DEFAULT 'null', status TEXT, kind TEXT,
              exit_code INTEGER, created_at TEXT NOT NULL,
              PRIMARY KEY (execution_id, role, id)
            );
            CREATE INDEX messages_session ON messages(session_id, seq);
            CREATE INDEX messages_execution ON messages(execution_id, seq);
            PRAGMA user_version = 1;
          `);
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  sessionRecord(id) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!row) throw new Error(`Session not found: ${id}`);
    return decode(row, ['binding', 'origin']);
  }

  executionRecord(id) {
    const row = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id);
    if (!row) throw new Error(`Execution not found: ${id}`);
    return decode(row, ['task', 'result', 'error']);
  }

  createSession(binding, origin = null) {
    const id = `pgs_${randomUUID()}`;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO sessions (id, binding, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(id, json(publicValue(binding)), json(publicValue(origin)), now, now);
    return this.getSession(id);
  }

  // Operational getters retain full values (in particular the task dispatched
  // to a runner). Listing/message/event APIs apply presentation limits.
  getSession(id) {
    return this.sessionRecord(id);
  }

  getExecution(id) {
    return this.executionRecord(id);
  }

  listSessions({ limit = 20 } = {}) {
    return this.db.prepare('SELECT * FROM sessions ORDER BY rowid DESC LIMIT ?')
      .all(limitValue(limit)).map(row => presentFields(decode(row, ['binding', 'origin']), ['binding', 'origin']));
  }

  listExecutions({ sessionId, limit = 20 } = {}) {
    limitValue(limit);
    const rows = sessionId === undefined
      ? this.db.prepare('SELECT * FROM executions ORDER BY rowid DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM executions WHERE session_id = ? ORDER BY rowid DESC LIMIT ?').all(sessionId, limit);
    return rows.map(row => presentFields(decode(row, ['task', 'result', 'error']), ['task', 'result', 'error']));
  }

  setRunnerSession(sessionId, runnerSessionId) {
    return this.transaction(() => {
      this.sessionRecord(sessionId);
      this.db.prepare('UPDATE sessions SET runner_session_id = ?, updated_at = ? WHERE id = ?')
        .run(runnerSessionId, new Date().toISOString(), sessionId);
      return this.getSession(sessionId);
    });
  }

  createExecution(sessionId, task) {
    if (typeof task !== 'string') throw new TypeError('task must be a string');
    return this.transaction(() => {
      this.sessionRecord(sessionId);
      // An unknown result may still be running upstream. Until reconciliation
      // is supported, any unknown execution blocks further turns in its session.
      const unknown = this.db.prepare("SELECT id FROM executions WHERE session_id = ? AND status = 'unknown' LIMIT 1").get(sessionId);
      if (unknown) throw new Error(`Session ${sessionId} has an unresolved unknown execution: ${unknown.id}; reconciliation is required before resume`);
      const active = this.db.prepare("SELECT id FROM executions WHERE session_id = ? AND status IN ('starting','running','canceling')").get(sessionId);
      if (active) throw new Error(`Session ${sessionId} already has an active execution: ${active.id}`);
      const id = `pge_${randomUUID()}`;
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO executions (id, session_id, task, status, created_at, updated_at)
        VALUES (?, ?, ?, 'starting', ?, ?)`).run(id, sessionId, json(task), now, now);
      this.recordEvent(this.executionRecord(id), 'input', { id: `pgm_${randomUUID()}`, text: task, status: 'accepted', kind: 'task' }, now);
      return this.getExecution(id);
    });
  }

  patchExecution(id, patch) {
    const allowed = new Set(['pid', 'socket', 'runner_execution_id', 'status', 'started_at', 'error']);
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key) && !SECRET_KEY.test(key)) throw new Error(`Unsupported execution patch field: ${key}`);
    }
    if (patch.status !== undefined && !ACTIVE.has(patch.status) && !TERMINAL.has(patch.status)) {
      throw new Error(`Invalid execution status: ${patch.status}`);
    }
    if (TERMINAL.has(patch.status)) return this.finishExecution(id, { status: patch.status, error: patch.error });
    return this.transaction(() => {
      const current = this.executionRecord(id);
      if (TERMINAL.has(current.status)) return this.getExecution(id);
      const updates = Object.entries(patch).filter(([key, value]) => allowed.has(key) && value !== undefined);
      if (updates.length) {
        updates.push(['updated_at', new Date().toISOString()]);
        this.db.prepare(`UPDATE executions SET ${updates.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
          .run(...updates.map(([key, value]) => key === 'error' ? json(value) : value), id);
      }
      return this.getExecution(id);
    });
  }

  finishExecution(id, { status, result = null, error = null }) {
    if (!TERMINAL.has(status)) throw new Error(`Invalid terminal status: ${status}`);
    return this.transaction(() => {
      const current = this.executionRecord(id);
      if (TERMINAL.has(current.status)) return this.getExecution(id);
      const now = new Date().toISOString();
      this.db.prepare('UPDATE executions SET status = ?, result = ?, error = ?, updated_at = ?, finished_at = ? WHERE id = ?')
        .run(status, json(result), json(error), now, now, id);
      this.recordEvent(current, 'finished', { status, result, error }, now);
      return this.getExecution(id);
    });
  }

  appendEvent(executionId, type, data) {
    if (typeof type !== 'string' || !type) throw new TypeError('event type must be a non-empty string');
    return this.transaction(() => {
      const event = this.recordEvent(this.executionRecord(executionId), type, data);
      return presentFields(event, ['data']);
    });
  }

  recordEvent(execution, type, data, now = new Date().toISOString()) {
    const id = `pgev_${randomUUID()}`;
    const encoded = json(data);
    const { lastInsertRowid } = this.db.prepare(`INSERT INTO events (id, session_id, execution_id, type, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, execution.session_id, execution.id, type, encoded, now);
    const event = { seq: Number(lastInsertRowid), id, session_id: execution.session_id,
      execution_id: execution.id, type, data: JSON.parse(encoded), created_at: now };
    this.normalizeMessage(event);
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, execution.session_id);
    return event;
  }

  normalizeMessage(event) {
    const { type, data } = event;
    if (!['assistant', 'tool_start', 'tool_end', 'input'].includes(type)) return;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError(`${type} data must be an object`);
    const role = type === 'assistant' ? 'assistant' : type === 'input' ? 'user' : 'tool';
    const id = data.id ?? `pgm_${randomUUID()}`;
    const previous = this.db.prepare('SELECT * FROM messages WHERE execution_id = ? AND role = ? AND id = ?')
      .get(event.execution_id, role, id);
    const message = previous ? decode(previous, ['input', 'output']) : {
      id, seq: event.seq, session_id: event.session_id, execution_id: event.execution_id,
      role, text: null, tool_name: null, input: null, output: null,
      status: null, kind: null, exit_code: null, created_at: event.created_at,
    };
    if (type === 'assistant') {
      const isDelta = data.delta === true || typeof data.delta === 'string';
      const text = typeof data.delta === 'string' ? data.delta : data.text;
      if (typeof text === 'string') message.text = isDelta ? (message.text ?? '') + text : text;
      message.status = data.status ?? (isDelta ? 'streaming' : 'completed');
    } else if (type === 'input') {
      if (data.text !== undefined) message.text = data.text;
      // Runner echoes may confirm consumption before the delivery ACK arrives.
      if (!(message.status === 'consumed' && ['accepted', 'queued'].includes(data.status))) {
        message.status = data.status ?? message.status ?? 'accepted';
      }
      message.kind = message.kind ?? data.kind ?? 'steer';
    } else {
      if (data.name !== undefined) message.tool_name = data.name;
      if (data.input !== undefined) message.input = data.input;
      if (data.output !== undefined) message.output = data.output;
      if (data.exit_code !== undefined) message.exit_code = data.exit_code;
      message.status = data.status ?? (type === 'tool_start' ? 'running' : 'completed');
    }
    this.db.prepare(`INSERT INTO messages
      (id, seq, session_id, execution_id, role, text, tool_name, input, output, status, kind, exit_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id, role, id) DO UPDATE SET
        text = excluded.text, tool_name = excluded.tool_name, input = excluded.input,
        output = excluded.output, status = excluded.status, kind = excluded.kind, exit_code = excluded.exit_code`)
      .run(message.id, message.seq, message.session_id, message.execution_id, message.role,
        message.text, message.tool_name, json(message.input), json(message.output),
        message.status, message.kind, message.exit_code, message.created_at);
  }

  listEvents(executionId, { after = 0, limit = 100 } = {}) {
    this.executionRecord(executionId);
    return this.db.prepare('SELECT * FROM events WHERE execution_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(executionId, limitValue(after, 'after'), limitValue(limit))
      .map(row => presentFields(decode(row, ['data']), ['data']));
  }

  messages(sessionId, { executionId, limit = 10 } = {}) {
    this.sessionRecord(sessionId);
    limitValue(limit);
    if (executionId !== undefined && this.executionRecord(executionId).session_id !== sessionId) {
      throw new Error(`Execution ${executionId} does not belong to session ${sessionId}`);
    }
    const rows = executionId === undefined
      ? this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?').all(sessionId, limit)
      : this.db.prepare('SELECT * FROM messages WHERE session_id = ? AND execution_id = ? ORDER BY seq DESC LIMIT ?').all(sessionId, executionId, limit);
    return rows.reverse().map(row => presentMessage(decode(row, ['input', 'output'])));
  }
}
