import asyncio
import contextlib
import json
import os

CLIENTS = []
SCENARIO = os.environ.get('MOCK_SCENARIO', 'success')
SID = 'session-mock'
AID = 'admission-mock'


def log(method, params):
    with open(os.environ['MOCK_LOG'], 'a') as stream:
        stream.write(json.dumps({'method': method, 'params': params, 'home': os.environ.get('HERMES_HOME')}) + '\n')


def event(kind, payload=None, admission=AID):
    return {'params': {'type': kind, 'session_id': SID, 'admission_id': admission,
                      'execution_generation': 7, 'payload': payload or {}}}


async def later(kind):
    await asyncio.sleep(0.07)
    client = CLIENTS[0]
    if kind == 'disconnect':
        await client.events.put(ValueError('Gateway disconnected; outcome unknown'))
    elif kind == 'cancel':
        await client.events.put(event('message.complete', {'outcome': 'interrupted'}))
    elif kind == 'error':
        await client.events.put(event('message.complete', {'outcome': 'failed'}))
    else:
        await client.events.put(event('tool.complete', {'tool_call_id': 'tool-1', 'result': '{"output":"tool output","exit_code":0}', 'is_error': False}))
        await client.events.put(event('message.delta', {'text': 'final '}))
        await client.events.put(event('message.complete', {'text': 'final answer', 'outcome': 'completed'}))


class Client:
    def __init__(self):
        self.events = asyncio.Queue()
        CLIENTS.append(self)

    async def rpc(self, method, **params):
        params.pop('_timeout', None)
        log(method, params)
        if method == 'runtime.describe':
            print('third party stdout must not escape')
            os.write(1, b'native stdout must not escape\n')
            return {'session_create': {'sources': ['tool'], 'parameters': ['model', 'provider', 'base_url', 'api_key', 'reasoning', 'cwd', 'cwd_explicit']}}
        if method in ('session.create', 'session.resume'):
            return {'stored_session_id': SID, 'execution_generation': 6, 'info': {'launch_request': {'ignore_user_config': SCENARIO == 'managed'}}}
        if method == 'prompt.submit':
            await self.events.put(event('message.complete', {'outcome': 'completed', 'text': 'WRONG OLD RESULT'}, 'previous'))
            await self.events.put(event('message.start'))
            await self.events.put(event('tool.start', {'tool_call_id': 'tool-1', 'name': 'terminal', 'args': {'command': 'mock'}}))
            if SCENARIO in ('error', 'disconnect'):
                asyncio.create_task(later(SCENARIO))
            return {'admission_id': AID, 'status': 'queued', 'execution_generation': None}
        if method == 'session.steer':
            assert params['execution_generation'] == 7
            if SCENARIO == 'steer-error':
                raise ValueError('unsupported_control')
            if SCENARIO == 'success':
                asyncio.create_task(later('success'))
            return {'status': 'queued', 'execution_generation': 7}
        if method == 'session.interrupt':
            assert params['execution_generation'] == 7
            asyncio.create_task(later('cancel'))
            return {'execution_state': 'running'}
        raise ValueError('unexpected_rpc')


@contextlib.asynccontextmanager
async def connect_gateway():
    client = Client()
    try:
        yield client
    finally:
        log('connection.closed', {})
