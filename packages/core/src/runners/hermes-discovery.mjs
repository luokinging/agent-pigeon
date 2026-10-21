import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, delimiter, isAbsolute } from 'node:path';
import { error } from './common.mjs';

async function exists(path, executable = false) {
  try { await access(path, executable ? constants.X_OK : constants.R_OK); return true; } catch { return false; }
}
// Read launcher paths only. Never execute a wrapper: installed launchers may repair/update their installation.
export async function discoverHermes(env = process.env) {
  const roots = new Set(), interpreters = new Set(), queue = [];
  if (env.PIGEON_HERMES_ROOT) roots.add(env.PIGEON_HERMES_ROOT);
  if (env.PIGEON_HERMES_PYTHON) interpreters.add(env.PIGEON_HERMES_PYTHON);
  if (!env.PIGEON_HERMES_ROOT || !env.PIGEON_HERMES_PYTHON) {
    for (const part of (env.PATH || '').split(delimiter)) {
      if (!isAbsolute(part)) continue;
      const path = join(part, 'hermes');
      if (await exists(path, true)) { queue.push(path); break; }
    }
  }
  const seen = new Set();
  while (queue.length && seen.size < 8) {
    const path = await realpath(queue.shift()).catch(() => null);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    for (let parent = dirname(path), i = 0; i < 5; i++, parent = dirname(parent)) {
      if (await exists(join(parent, 'hermes_cli', 'gateway_client.py'))) roots.add(parent);
    }
    if ((await stat(path)).size > 256 * 1024) continue;
    const source = (await readFile(path, 'utf8')).replaceAll("'\"'\"'", "'");
    for (const match of source.matchAll(/(?:exec\s+|#!)(?:["']?)(\/[^\s"']+)/g)) {
      const target = match[1];
      if (/\/python[\d.]*$/.test(target)) interpreters.add(target);
      else if (/\/hermes$/.test(target) && await exists(target)) queue.push(target);
    }
    for (const match of source.matchAll(/sys\.path\.insert\(0,\s*['"]([^'"]+)['"]\)/g)) {
      if (isAbsolute(match[1])) roots.add(match[1]);
    }
  }
  for (const root of roots) {
    if (env.PIGEON_HERMES_ROOT && root !== env.PIGEON_HERMES_ROOT) continue;
    if (!isAbsolute(root) || !await exists(join(root, 'hermes_cli', 'gateway_client.py'))) continue;
    const candidates = env.PIGEON_HERMES_PYTHON ? [env.PIGEON_HERMES_PYTHON] : [join(root, 'venv', 'bin', 'python'), join(root, '.venv', 'bin', 'python'), ...interpreters];
    for (const python of candidates) if (isAbsolute(python) && await exists(python, true)) return { root, python };
  }
  throw error('HERMES_RUNTIME_NOT_FOUND', 'Cannot reliably discover Hermes Python runtime. Set PIGEON_HERMES_ROOT to the installed checkout and PIGEON_HERMES_PYTHON to its Python interpreter.');
}
