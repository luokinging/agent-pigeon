import { startClaude } from './claude.mjs';
import { startCodex } from './codex.mjs';
import { startHermes } from './hermes.mjs';
import { error, safeError, taskText } from './common.mjs';

export async function startRunner(options) {
  const binding = options?.binding;
  if (!binding) throw error('INVALID_BINDING', 'Runner binding is required');
  taskText(options.task);
  const runners = { claude: ['stream-json', startClaude], codex: ['app-server', startCodex], hermes: ['gateway', startHermes] };
  const runner = runners[binding.runner];
  if (!runner) throw error('UNSUPPORTED_RUNNER', `Unsupported runner: ${binding.runner}`);
  if (binding.mode && binding.mode !== runner[0]) throw error('UNSUPPORTED_RUNNER_MODE', `${binding.runner} requires ${runner[0]} for live steering`);
  try {
    const handle = await runner[1](options);
    for (const method of ['steer', 'cancel', 'close']) {
      const call = handle[method];
      handle[method] = async (...args) => {
        try { return await call(...args); } catch (cause) { throw safeError(cause, binding); }
      };
    }
    return handle;
  } catch (cause) { throw safeError(cause, binding); }
}
