// Shared test helpers: isolated PIGEON home, PATH-injected mock binaries,
// and a thin wrapper for invoking `pigeon.mjs` as a subprocess.
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MOCK_BIN = path.join(HERE, "mock-bin");
export const SCRIPTS = path.resolve(HERE, "..", "scripts");
export const PIGEON = path.join(SCRIPTS, "pigeon.mjs");
export const CLEANUP = path.join(SCRIPTS, "cleanup-session.mjs");

// A sample, fully-valid config.
export function sampleConfig() {
  return {
    version: 1,
    providers: {
      zhipu: {
        protocols: ["anthropic", "openai"],
        base_url: {
          anthropic: "https://open.bigmodel.cn/api/anthropic",
          openai: "https://open.bigmodel.cn/api/paas/v4",
        },
        api_key: "zhipu-key",
      },
      openai: {
        protocols: ["openai"],
        base_url: { openai: "https://api.openai.com/v1" },
        api_key: "openai-key",
      },
    },
    models: {
      "glm-5.2": {
        provider: "zhipu",
        model_id: "GLM-5.2",
        clients: ["claude", "codex"],
        effort: ["high", "medium", "low"],
      },
      "gpt-5-codex": {
        provider: "openai",
        model_id: "gpt-5-codex",
        clients: ["codex"],
        effort: ["high", "medium", "low"],
      },
    },
  };
}

// Create an isolated HOME (=> ~/.pigeon lives there). Returns { home, pigeonHome, cleanup }.
export function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pigeon-test-"));
  const pigeonHome = path.join(home, ".pigeon");
  fs.mkdirSync(pigeonHome, { recursive: true });
  return {
    home,
    pigeonHome,
    cleanup() {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export function writeConfigFile(pigeonHome, config) {
  fs.writeFileSync(
    path.join(pigeonHome, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf8"
  );
}

// Build a child env: isolated HOME, mock-bin prepended to PATH, no PIGEON_HOME
// (so config.mjs and jobs.mjs/lock.mjs all agree on $HOME/.pigeon).
export function childEnv(home, extra = {}) {
  const env = { ...process.env };
  delete env.PIGEON_HOME;
  // Hermetic: strip session env that an active pigeon plugin (its SessionStart hook) may have injected
  // into the ambient environment, so session-ownership tests aren't polluted by the real session.
  // Tests set these explicitly via `extra` when a case needs them.
  delete env.PIGEON_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_ENV_FILE;
  env.HOME = home;
  env.PATH = `${MOCK_BIN}${path.delimiter}${process.env.PATH || ""}`;
  return { ...env, ...extra };
}

// Run pigeon.mjs synchronously, capturing stdout/stderr/status.
export function runPigeon(args, { home, env = {}, input } = {}) {
  const res = spawnSync(process.execPath, [PIGEON, ...args], {
    cwd: home,
    env: childEnv(home, env),
    encoding: "utf8",
    input,
  });
  return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status, res };
}

// Run cleanup-session.mjs synchronously, feeding JSON on stdin.
export function runCleanup(args, { home, env = {}, input } = {}) {
  const res = spawnSync(process.execPath, [CLEANUP, ...args], {
    cwd: home,
    env: childEnv(home, env),
    encoding: "utf8",
    input,
  });
  return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status };
}

export function jobsDir(pigeonHome) {
  return path.join(pigeonHome, "jobs");
}

export function readJobFile(pigeonHome, id) {
  const p = path.join(jobsDir(pigeonHome), `${id}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function listJobIds(pigeonHome) {
  const dir = jobsDir(pigeonHome);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -5));
}

// Extract a printed job-id from work/continue stdout (e.g. "dispatched job <id> ...").
export function parseJobId(stdout) {
  const m = stdout.match(/job\s+([^\s(]+)/);
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a job file until predicate(job) is true or timeout. Returns job or null.
export async function waitForJob(pigeonHome, id, predicate, { timeoutMs = 8000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = readJobFile(pigeonHome, id);
    if (job && predicate(job)) return job;
    if (Date.now() > deadline) return job;
    await sleep(pollMs);
  }
}

export { spawn, sleep };
