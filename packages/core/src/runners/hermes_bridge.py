"""Private JSONL bridge to the installed Hermes Gateway client; no gateway ownership."""
import asyncio
import contextlib
import json
import os
import sys
import uuid

MAX_BYTES = 8 * 1024 * 1024
# Preserve just our protocol descriptor. Imported libraries, native code and children cannot pollute it.
PROTOCOL = os.fdopen(os.dup(1), 'w', encoding='utf-8', buffering=1)
with open(os.devnull, 'w') as sink:
    os.dup2(sink.fileno(), 1)
    os.dup2(sink.fileno(), 2)
sys.dont_write_bytecode = True
SECRETS = []


def emit(value):
    text = json.dumps(value, ensure_ascii=False)
    for secret in SECRETS:
        if secret:
            text = text.replace(json.dumps(secret, ensure_ascii=False)[1:-1], '[REDACTED]')
    if len(text.encode()) > MAX_BYTES:
        raise ValueError('Runner output frame exceeds 8 MiB')
    PROTOCOL.write(text + '\n')
    PROTOCOL.flush()


def failure(exc):
    # No traceback, configuration or arbitrary exception diagnostics on stdout/stderr.
    reason = str(exc)
    if not (reason.replace('_', '').isalnum() and len(reason) <= 100):
        reason = type(exc).__name__ + ': Hermes request failed; execution outcome may be unknown'
    code = 'RUNNER_TIMEOUT' if isinstance(exc, (TimeoutError, asyncio.TimeoutError)) else 'RUNNER_DISCONNECTED' if 'disconnect' in str(exc).lower() else 'RUNNER_PROTOCOL_ERROR' if str(exc) in ('missing_admission_id', 'execution_generation_changed') else 'HERMES_ERROR'
    return {'code': code, 'message': reason}


def ensure_steerable(snapshot):
    info = snapshot.get('info') or {}
    launch = info.get('launch_request') or {}
    if (launch.get('ignore_user_config') or launch.get('safe_mode') or launch.get('kanban')
            or snapshot.get('managed_worker') or info.get('managed_worker')
            or (info.get('capabilities') or {}).get('steer') is False):
        raise ValueError('unsupported_control')


async def main():
    reader = asyncio.StreamReader(limit=MAX_BYTES)
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    async def read():
        raw = await reader.readline()
        if not raw:
            return None
        if len(raw) > MAX_BYTES:
            raise ValueError('input_limit')
        return json.loads(raw)

    bootstrap = await read()
    if not bootstrap or bootstrap.get('method') != 'bootstrap':
        raise ValueError('bootstrap_required')
    params = bootstrap['params']
    binding = params['binding']
    if binding.get('apiKey'):
        SECRETS.append(binding['apiKey'])
    root = params['root']
    sys.path.insert(0, root)
    from hermes_cli.gateway_client import connect_gateway
    timeout = params.get('timeoutMs', 30000) / 1000
    async with connect_gateway() as client, connect_gateway() as control:
        description = await client.rpc('runtime.describe', _timeout=timeout)
        contract = description.get('session_create', {})
        if 'tool' not in contract.get('sources', []):
            raise ValueError('unsupported_source_tool')
        sid = params.get('runnerSessionId')
        if sid:
            resume = {'session_id': sid}
            if binding.get('apiKey'):
                resume['api_key'] = binding['apiKey']
            snapshot = await client.rpc('session.resume', _timeout=timeout, **resume)
        else:
            policy = {}
            for source, target in [('model', 'model'), ('effort', 'reasoning'), ('cwd', 'cwd')]:
                if binding.get(source) is not None:
                    policy[target] = binding[source]
            if binding.get('cwd'):
                policy['cwd_explicit'] = True
            if not binding.get('native'):
                # Pigeon provider ids name Pigeon configuration, not Hermes profile provider entries.
                policy['provider'] = 'custom'
                for source, target in [('baseUrl', 'base_url'), ('apiKey', 'api_key')]:
                    if binding.get(source) is not None:
                        policy[target] = binding[source]
            if set(policy) - set(contract.get('parameters', [])):
                raise ValueError('unsupported_creation_parameters')
            snapshot = await client.rpc('session.create', _timeout=timeout,
                                        request_id=uuid.uuid4().hex, source='tool', **policy)
        ensure_steerable(snapshot)
        sid = snapshot.get('stored_session_id')
        if not sid:
            raise ValueError('missing_session_id')
        if snapshot.get('running') or snapshot.get('pending'):
            raise ValueError('execution_busy')
        emit({'method': 'session', 'params': {'runnerSessionId': sid}})
        receipt = await client.rpc('prompt.submit', _timeout=timeout, session_id=sid,
                                   input_id=uuid.uuid4().hex, text=params['task'], finite=True, unattended=True)
        admission = receipt.get('admission_id')
        if not admission:
            raise ValueError('missing_admission_id')
        generation = receipt.get('execution_generation')
        ready = False
        terminal = False
        emit({'method': 'execution', 'params': {'runnerExecutionId': admission}})

        def mark_ready():
            nonlocal ready
            if not ready:
                ready = True
                emit({'id': bootstrap['id'], 'result': {'runnerSessionId': sid,
                     'runnerExecutionId': admission, 'execution_generation': generation}})

        async def events():
            nonlocal generation, terminal
            while True:
                event = await client.events.get()
                if isinstance(event, Exception):
                    raise event
                p = event.get('params', {})
                if p.get('session_id') != sid:
                    continue
                payload = p.get('payload') or {}
                event_admission = p.get('admission_id', payload.get('admission_id'))
                if event_admission != admission:
                    continue
                if p.get('execution_generation') is not None:
                    if generation is not None and generation != p['execution_generation']:
                        raise ValueError('execution_generation_changed')
                    generation = p['execution_generation']
                if p.get('type') == 'message.start':
                    mark_ready()
                if p.get('type') == 'message.complete':
                    terminal = True
                    mark_ready()
                # Session inventories may contain entire prompts and environment metadata. Forward only task events.
                if p.get('type') in ('message.start', 'message.delta', 'message.complete', 'tool.start', 'tool.complete', 'error'):
                    emit({'method': 'event', 'params': p})
                else:
                    emit({'method': 'progress', 'params': {'type': p.get('type')}})

        async def commands():
            while True:
                request = await read()
                if request is None:
                    return
                try:
                    method = request.get('method')
                    if terminal:
                        raise ValueError('execution_finished')
                    if generation is None:
                        raise ValueError('execution_not_ready')
                    if method == 'steer':
                        result = await control.rpc('session.steer', _timeout=timeout, session_id=sid,
                                                   execution_generation=generation, text=request['params']['text'])
                    elif method == 'cancel':
                        result = await control.rpc('session.interrupt', _timeout=timeout, session_id=sid,
                                                   execution_generation=generation)
                    else:
                        raise ValueError('unsupported_method')
                    emit({'id': request['id'], 'result': result})
                except Exception as exc:
                    emit({'id': request['id'], 'error': failure(exc)})

        pump = asyncio.create_task(events())
        commands_task = asyncio.create_task(commands())
        try:
            ended, _ = await asyncio.wait([pump, commands_task], return_when=asyncio.FIRST_COMPLETED)
            for item in ended:
                await item
        finally:
            for item in (pump, commands_task):
                item.cancel()
            for item in (pump, commands_task):
                with contextlib.suppress(asyncio.CancelledError):
                    await item
            transport.close()


try:
    asyncio.run(main())
except Exception as exc:
    emit({'method': 'fatal', 'params': failure(exc)})
    sys.exit(1)
