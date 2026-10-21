import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));

// This mock consumes the installed adapter's actual argv/env and contacts only
// the loopback HTTP fixture. No installed model client is ever executed.
async function mockRunner() {
  const fs = await import('node:fs');
  const readline = await import('node:readline');
  const env = process.env, args = process.argv.slice(2), config = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-c') continue;
    const value = args[++i], split = value.indexOf('=');
    config[value.slice(0, split)] = JSON.parse(value.slice(split + 1));
  }
  const provider = config.model_provider, prefix = `model_providers.${provider}.`;
  const envKey = config[`${prefix}env_key`];
  const log = value => fs.appendFileSync(env.MOCK_LOG, JSON.stringify(value) + '\n');
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const session = 'package-mock-session', turn = 'package-mock-turn';
  log({ args, config, provider, pigeonApiKeyPresent: Object.hasOwn(env, 'PIGEON_API_KEY') });
  readline.createInterface({ input: process.stdin }).on('line', async line => {
    const message = JSON.parse(line);
    if (env.MOCK_RUNNER === 'claude') {
      if (message.type !== 'user') return;
      send({ type: 'system', subtype: 'init', session_id: session });
      // Exercise JSON-sensitive secret redaction in both events and final results.
      const text = 'BEGIN\n' + '长'.repeat(5000) + '\n' + env.TEST_PROVIDER_KEY + '\nEND';
      send({ type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text }] } });
      process.stderr.write(env.TEST_PROVIDER_KEY);
      send({ type: 'result', subtype: 'success', result: text, session_id: session });
      return;
    }
    log(message);
    const reply = result => send({ id: message.id, result });
    if (message.method === 'initialize') reply({});
    else if (['thread/start', 'thread/resume'].includes(message.method)) reply({ thread: { id: session } });
    else if (message.method === 'turn/start') {
      reply({ turn: { id: turn, status: 'inProgress' } });
      try {
        const url = new URL(config[`${prefix}base_url`] + '/responses');
        if (url.hostname !== '127.0.0.1') throw new Error('External endpoints are forbidden in this test');
        const headers = { 'Content-Type': 'application/json' };
        if (envKey && env[envKey]) headers.Authorization = 'Bearer ' + env[envKey];
        const response = await fetch(url, {
          method: 'POST', headers,
          body: JSON.stringify({ model: config.model, input: message.params.input, effort: message.params.effort }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { text } = await response.json();
        send({ method: 'item/completed', params: { threadId: session, turnId: turn, item: { id: 'answer', type: 'agentMessage', text } } });
        send({ method: 'turn/completed', params: { threadId: session, turnId: turn, turn: { id: turn, status: 'completed' } } });
      } catch (error) {
        send({ method: 'turn/completed', params: { threadId: session, turnId: turn, turn: { id: turn, status: 'failed', error: { message: error.message } } } });
      }
    }
  });
}

function command(bin, args, { cwd, env, input = '', timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ args, code, signal, stdout, stderr }); });
  });
}

function success(result) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

// Run separately with node --test test/standalone-package.test.mjs when desired.
// Set PIGEON_PACKAGE_TEST_KEEP=1 to retain archives, subprocess transcripts and DBs.
test('packed CLI runs independently with safe authentication and complete results', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pigeon-package-test-'));
  t.diagnostic(`Package evidence: ${root}`);
  t.after(() => {
    if (process.env.PIGEON_PACKAGE_TEST_KEEP !== '1') fs.rmSync(root, { recursive: true, force: true });
  });
  const env = {
    PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
    HOME: path.join(root, 'home'),
    PIGEON_RUNNER_RPC_TIMEOUT_MS: '3000',
  };
  fs.mkdirSync(env.HOME);
  const prefix = path.join(root, 'prefix');
  fs.mkdirSync(prefix);
  const archives = await Promise.all(['core', 'cli'].map(async workspace => {
    const destination = path.join(root, workspace);
    fs.mkdirSync(destination);
    const packageName = workspace === 'core' ? '@agent-pigeon/core' : 'agent-pigeon';
    const packed = await command('npm', ['pack', '--workspace', packageName, '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: repo, env });
    fs.writeFileSync(path.join(root, `pack-${workspace}.json`), JSON.stringify(packed, null, 2));
    const metadata = success(packed)[0];
    assert.equal(metadata.name, packageName);
    assert.equal(metadata.filename, `${packageName.replace('@', '').replace('/', '-')}-${metadata.version}.tgz`);
    return path.join(destination, metadata.filename);
  }));
  const installed = await command('npm', ['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...archives], { cwd: root, env });
  fs.writeFileSync(path.join(root, 'install.json'), JSON.stringify(installed, null, 2));
  assert.equal(installed.code, 0, installed.stdout + installed.stderr);
  const cli = path.join(prefix, 'node_modules', '.bin', 'pigeon');
  const core = path.join(prefix, 'node_modules', '@agent-pigeon', 'core');
  assert.equal(fs.lstatSync(core).isSymbolicLink(), false);
  for (const resource of ['src/worker.mjs', 'src/runners/hermes_bridge.py']) assert.ok(fs.existsSync(path.join(core, resource)));
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  const mock = path.join(scripts, 'runner.mjs');
  fs.writeFileSync(mock, `#!${process.execPath}\n(${mockRunner.toString()})();\n`, { mode: 0o755 });
  env.PIGEON_CLAUDE_BIN = mock;
  env.PIGEON_CODEX_BIN = mock;
  // Also prevent Hermes discovery from ever reaching a real installation.
  env.PIGEON_HERMES_ROOT = path.join(scripts, 'hermes');
  env.PIGEON_HERMES_PYTHON = path.join(scripts, 'no-python');

  function fixture(name, config, overrides = {}) {
    const directory = path.join(root, name), home = path.join(directory, 'state');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    let index = 0;
    const localEnv = {
      ...env, PIGEON_HOME: home,
      CLAUDE_CONFIG_DIR: path.join(directory, 'claude'), CODEX_HOME: path.join(directory, 'codex'), HERMES_HOME: path.join(directory, 'hermes'),
      MOCK_LOG: path.join(directory, 'mock.jsonl'), ...overrides,
    };
    return {
      directory, home, localEnv,
      logs: () => fs.existsSync(localEnv.MOCK_LOG) ? fs.readFileSync(localEnv.MOCK_LOG, 'utf8').trim().split('\n').map(JSON.parse) : [],
      async run(args, input) {
        const result = await command(cli, args, { cwd: directory, env: localEnv, input });
        fs.writeFileSync(path.join(directory, `${++index}-command.json`), JSON.stringify(result, null, 2));
        return result;
      },
    };
  }

  await t.test('both installed bins resolve core and expose capabilities outside checkout', async () => {
    const f = fixture('entrypoint', {});
    for (const name of ['pigeon', 'agent-pigeon']) {
      const bin = path.join(prefix, 'node_modules', '.bin', name);
      assert.equal(fs.realpathSync(bin), fs.realpathSync(path.join(prefix, 'node_modules', 'agent-pigeon', 'src', 'index.mjs')));
      const help = await command(bin, ['--help'], { cwd: f.directory, env: f.localEnv });
      assert.equal(help.code, 0, help.stderr);
      assert.match(help.stdout, /^agent-pigeon — independent agent sessions/);
      assert.match(help.stdout, /pigeon run/);
      const capabilities = success(await command(bin, ['capabilities', '--json'], { cwd: f.directory, env: f.localEnv }));
      assert.deepEqual(Object.keys(capabilities.runners), ['claude', 'codex', 'hermes']);
    }
  });

  await t.test('auth:none rejects Claude before spawning or falling back to ambient keys', async () => {
    const f = fixture('claude-none', { providers: { local: { protocols: ['anthropic-messages'], base_url: 'http://127.0.0.1:9', auth: { type: 'none' } } } }, {
      MOCK_RUNNER: 'claude', ANTHROPIC_API_KEY: 'ambient-fake-key', ANTHROPIC_AUTH_TOKEN: 'ambient-fake-token',
    });
    const result = await f.run(['run', '--provider', 'local', '--runner', 'claude', '--model', 'mock-model', '--json', '--', 'task']);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, 'UNSUPPORTED_AUTH_MODE');
    assert.deepEqual(f.logs(), []);
  });

  await t.test('Codex auth:none selects an isolated provider and sends no HTTP credentials', async () => {
    const requests = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', data => { body += data; });
      request.on('end', () => {
        requests.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ text: 'local HTTP success' }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const f = fixture('codex-none', { providers: { local: { protocols: ['openai-responses'], base_url: `http://127.0.0.1:${server.address().port}/v1`, auth: { type: 'none' } } } }, {
        MOCK_RUNNER: 'codex', PIGEON_API_KEY: 'ambient-pigeon-key', OPENAI_API_KEY: 'ambient-openai-key',
      });
      const first = success(await f.run(['run', '--provider', 'local', '--client', 'codex', '--model', 'http-model', '--effort', 'high', '--stdin', '--json'], 'first line\n第二行\n'));
      assert.equal(first.result, 'local HTTP success');
      success(await f.run(['resume', first.session_id, '--json', '--', 'follow up']));
      const spawns = f.logs().filter(value => value.config);
      assert.equal(spawns.length, 2);
      assert.notEqual(spawns[0].provider, spawns[1].provider);
      for (const entry of spawns) {
        assert.match(entry.provider, /^pigeon_no_auth_[a-f0-9]+$/);
        const p = `model_providers.${entry.provider}.`;
        assert.equal(entry.config[`${p}requires_openai_auth`], false);
        assert.equal(entry.config[`${p}wire_api`], 'responses');
        assert.equal(entry.config[`${p}env_key`], undefined);
        assert.equal(entry.pigeonApiKeyPresent, false);
      }
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.equal(request.url, '/v1/responses');
        assert.equal(request.headers.authorization, undefined);
        assert.equal(request.headers['x-api-key'], undefined);
        assert.equal(request.body.model, 'http-model');
        assert.equal(request.body.effort, 'high');
      }
      assert.equal(requests[0].body.input[0].text, 'first line\n第二行');
      fs.writeFileSync(path.join(f.directory, 'http-requests.json'), JSON.stringify(requests, null, 2));
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });

  await t.test('JSON-sensitive keys are redacted without corrupting JSON and final results remain complete', async () => {
    const secret = 'package-secret-"quoted"-\\backslash-\n-newline';
    const f = fixture('long-result', { providers: { local: { protocols: ['anthropic-messages'], base_url: 'http://127.0.0.1:9', api_key_env: 'TEST_PROVIDER_KEY' } } }, {
      MOCK_RUNNER: 'claude', TEST_PROVIDER_KEY: secret,
    });
    const first = success(await f.run(['run', '--provider', 'local', '--model', 'long-model', '--json', '--', 'long result']));
    const expected = 'BEGIN\n' + '长'.repeat(5000) + '\n[REDACTED]\nEND';
    assert.equal(first.result, expected);
    for (const command of ['result', 'wait']) {
      const result = success(await f.run([command, first.id, '--json']));
      assert.equal(result.result, expected);
      assert.equal(result.truncation?.result, undefined);
    }
    const status = success(await f.run(['status', first.id, '--json']));
    assert.ok(status.result.length < expected.length);
    assert.ok(status.truncation.result.truncated);
    const events = await f.run(['events', first.id, '--json']);
    assert.equal(events.code, 0, events.stderr);
    for (const line of events.stdout.trim().split('\n')) JSON.parse(line);
    success(await f.run(['messages', first.session_id, '--raw']));
    const needles = [secret, JSON.stringify(secret).slice(1, -1), 'package-secret-'];
    for (const relative of fs.readdirSync(f.directory, { recursive: true })) {
      const file = path.join(f.directory, relative);
      if (!fs.statSync(file).isFile()) continue;
      const bytes = fs.readFileSync(file);
      for (const needle of needles) assert.equal(bytes.includes(Buffer.from(needle)), false, `Secret leaked to ${file}`);
    }
  });

  const pythonProbe = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], { env, encoding: 'utf8' });
  await t.test('installed Hermes bridge executes from its packaged location', { skip: pythonProbe.status !== 0 ? 'Python 3 is unavailable' : false }, async () => {
    const gatewayDirectory = path.join(env.PIGEON_HERMES_ROOT, 'hermes_cli');
    fs.mkdirSync(gatewayDirectory, { recursive: true });
    const original = fs.readFileSync(path.join(repo, 'test/fixtures/standalone-runners/hermes/hermes_cli/gateway_client.py'), 'utf8');
    // The existing runner fixture completes after steer; this package smoke test
    // requests completion immediately after prompt.submit instead.
    const fixtureSource = original.replace("if SCENARIO in ('error', 'disconnect'):", "if SCENARIO in ('success', 'error', 'disconnect'):");
    assert.notEqual(fixtureSource, original);
    fs.writeFileSync(path.join(gatewayDirectory, 'gateway_client.py'), fixtureSource);
    const f = fixture('hermes-bridge', {}, { PIGEON_HERMES_PYTHON: pythonProbe.stdout.trim() });
    const result = success(await f.run(['run', '--runner', 'hermes', '--json', '--', 'bridge task']));
    assert.equal(result.result, 'final answer');
    assert.ok(f.logs().some(entry => entry.method === 'prompt.submit'));
  });
});
