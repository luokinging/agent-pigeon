#!/usr/bin/env node
// pigeon entry point: subcommand dispatch.
//   work / continue / status / result / cancel / list / config-set / cleanup
//   __run-job (internal: spawned detached by work/continue, actually runs the client)
//
// Application layer. The protocol layer (resolve/config/registry/clients) is imported from
// fixed paths and assumed to already exist.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assessJob,
  createRunningJob,
  earlierActiveOnThread,
  executionStillLive,
  finalizeJob,
  generateJobId,
  nextSeq,
  heartbeat,
  HEARTBEAT_INTERVAL_MS,
  isActive,
  isTerminal,
  jobLogFile,
  listJobs,
  markRunning,
  patchIfActive,
  readJob,
  resolveJobRef,
  soleActiveSession,
  threadKey
} from "./lib/jobs.mjs";
import { acquireLock, threadLockName } from "./lib/lock.mjs";
import {
  binaryAvailable,
  procToken,
  spawnDetached,
  terminateProcessTree,
  terminateTreeIfOurs
} from "./lib/process.mjs";
import {
  renderCancel,
  renderModelList,
  renderNativeProviders,
  renderResult,
  renderStatusList,
  renderStatusOne,
  renderWorkAccepted
} from "./lib/render.mjs";

// ——— Protocol layer (adapter interface contract: see each client adapter) ———
import { loadConfig, patchConfig } from "./lib/config.mjs";
import {
  listModels as listModelNames,
  getModel,
  providerForModel,
  defaultClient,
  defaultEffortForClient,
  compatibleClients,
  isNativeProvider
} from "./lib/registry.mjs";
import { resolve as resolveExecContext, resolveForContinue, resolveBinary } from "./lib/resolve.mjs";
import { getClient, clientsForProtocol } from "./lib/clients/index.mjs";
import { nativeProviderNames, getNativeProvider } from "./lib/native.mjs";

// Augment resolve()'s execution context into the shape the runtime expects (add timeoutMs).
// There is NO default execution time limit — a delegated agent may legitimately run for hours.
// A cap is applied ONLY when explicitly opted into: the PIGEON_TIMEOUT_MS env var, or a per-model/
// provider `timeout_ms` in config. Otherwise timeoutMs is null = unlimited.
function resolveContext(opts) {
  const config = loadConfig();
  const ctx = resolveExecContext(config, opts);
  return { ...ctx, timeoutMs: optInTimeout(ctx.timeoutMs) };
}

// For /pigeon:continue only: rebuild context from the job's persisted original backend identity.
function resolveContinueContext(base) {
  const config = loadConfig();
  const ctx = resolveForContinue(config, base);
  return { ...ctx, timeoutMs: optInTimeout(ctx.timeoutMs) };
}

// Opt-in execution cap: PIGEON_TIMEOUT_MS env wins; else a configured per-model/provider timeout_ms;
// else null = no limit (the delegated agent runs until it finishes, is canceled, or the session ends).
function optInTimeout(configuredMs) {
  const envTimeout = Number(process.env.PIGEON_TIMEOUT_MS);
  if (Number.isFinite(envTimeout) && envTimeout > 0) return envTimeout;
  return Number.isFinite(configuredMs) && configuredMs > 0 ? configuredMs : null;
}

// For /pigeon:list rendering: project from config into the model view render.mjs expects.
function resolveModelView(modelName) {
  const config = loadConfig();
  const model = getModel(config, modelName);
  if (!model) {
    return { model: modelName, provider: "?", protocols: [], clients: [], effort: [] };
  }
  const prov = providerForModel(config, modelName);
  const dClient = defaultClient(model);
  return {
    model: modelName,
    modelId: model.model_id ?? "", // the real id sent to the client (distinct from the model name/alias)
    provider: model.provider, // native models show their native provider name (codex-native / claude-native)
    protocols: prov && Array.isArray(prov.protocols) ? prov.protocols : [],
    clients: Array.isArray(model.clients) ? model.clients : [],
    defaultClient: dClient,
    effort: Array.isArray(model.effort) ? model.effort : [],
    defaultEffort: dClient ? defaultEffortForClient(model, dClient) : null,
    compatibleClients: compatibleClients(config, modelName),
    native: isNativeProvider(prov)
  };
}

const SELF = fileURLToPath(import.meta.url);
// Main session id: prefer PIGEON_SESSION_ID (injected by the SessionStart hook via $CLAUDE_ENV_FILE,
// per-session accurate, no cross-talk across sessions), then CLAUDE_SESSION_ID, finally fall back to the sole active session.
const PIGEON_SESSION_ID_ENV = "PIGEON_SESSION_ID";
const SESSION_ID_ENV = "CLAUDE_SESSION_ID";

function currentSessionId() {
  return process.env[PIGEON_SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? soleActiveSession() ?? null;
}

function fail(message, code = 1) {
  process.stderr.write(`pigeon: ${message}\n`);
  process.exit(code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ——— form C argument parsing: all flags, task body comes after `--` ———
// Returns { flags: {model,client,effort,...}, task: string|null }
// Contract (see agents/pigeon-runner.md): the caller passes the task as a **single shell-quoted argument**
// after `--`, so there's usually only one argv element after `--`, and join(" ") returns it verbatim
// (spaces/newlines/indentation preserved). Only when the caller mistakenly passes multiple bare tokens
// does it degrade to single-space joining — that's caused by shell word-splitting, which pigeon can no longer recover.
function parseFormC(argv) {
  const flags = {};
  const dashDashIdx = argv.indexOf("--");
  const flagArgs = dashDashIdx === -1 ? argv : argv.slice(0, dashDashIdx);
  const task = dashDashIdx === -1 ? null : argv.slice(dashDashIdx + 1).join(" ");

  for (let i = 0; i < flagArgs.length; i += 1) {
    const arg = flagArgs[i];
    if (!arg.startsWith("--")) {
      throw new Error(`unrecognized positional argument "${arg}" (task body must come after --)`);
    }
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = flagArgs[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`flag --${key} is missing a value`);
    }
    flags[key] = next;
    i += 1;
  }
  return { flags, task };
}

// Boolean flags (no value). --stdin: read the task body from stdin (paired with a quoted heredoc, immune to apostrophes/quotes/newlines).
const BOOLEAN_FLAGS = new Set(["stdin"]);
const KNOWN_WORK_FLAGS = new Set(["model", "client", "effort", "stdin"]);

// Read the task body from stdin (byte-safe: a quoted heredoc does no shell expansion). Strip the trailing newline from the heredoc.
function readStdinTask() {
  try {
    return fs.readFileSync(0, "utf8").replace(/\n$/, "");
  } catch {
    return "";
  }
}

function assertKnownFlags(flags, allowed) {
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      throw new Error(`unknown flag --${key}`);
    }
  }
}

// ——— work: validate → spawn background process → print job-id immediately (always non-blocking) ———
function cmdWork(argv) {
  let parsed;
  try {
    parsed = parseFormC(argv);
    assertKnownFlags(parsed.flags, KNOWN_WORK_FLAGS);
  } catch (error) {
    fail(error.message);
  }
  const { flags } = parsed;
  // --stdin: read the task from stdin (robust, avoids shell-quoting issues); otherwise take the body after `--`.
  const task = flags.stdin ? readStdinTask() : parsed.task;

  // §8 validation order is handled fail-fast by resolveContext (protocol layer); errors include the available options.
  let ctx;
  try {
    ctx = resolveContext({
      model: flags.model,
      client: flags.client,
      effort: flags.effort
    });
  } catch (error) {
    fail(error.message);
  }

  // §8.7 empty task body
  if (!task || !task.trim()) {
    fail("task body is empty (provide the work to delegate after --)");
  }

  const cwd = process.cwd();
  const tk = threadKey(cwd, ctx.model, ctx.client);
  const id = generateJobId(ctx.model);
  // Pin a deterministic session id for the new thread, for later continue/resume.
  const sessionId = randomUUID();

  startBackgroundJob({
    id,
    ctx,
    task,
    cwd,
    thread_key: tk,
    session_id: sessionId,
    resume: false
  });

  process.stdout.write(`${renderWorkAccepted(readJob(id))}\n`);
}

// ——— run: foreground/synchronous mode — no detach, no job file; runs the client inline, blocks until a result, prints it to stdout.
// The main agent can wrap this in Claude's run_in_background for "non-blocking + notify on completion", with no job file/polling. ———
async function cmdRun(argv) {
  let parsed;
  try {
    parsed = parseFormC(argv);
    assertKnownFlags(parsed.flags, KNOWN_WORK_FLAGS);
  } catch (error) {
    fail(error.message);
  }
  const { flags } = parsed;
  const task = flags.stdin ? readStdinTask() : parsed.task;

  let ctx;
  try {
    ctx = resolveContext({ model: flags.model, client: flags.client, effort: flags.effort });
  } catch (error) {
    fail(error.message);
  }
  if (!task || !task.trim()) {
    fail("task body is empty (provide the work to delegate after -- or via --stdin)");
  }

  const client = ctx.adapter;
  let invocation;
  try {
    invocation = client.buildInvocation({
      taskPrompt: task,
      modelId: ctx.modelId,
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      effort: ctx.effort,
      wireApi: ctx.wireApi ?? null,
      native: ctx.native ?? false,
      sessionId: randomUUID(),
      resume: false
    });
  } catch (error) {
    fail(`failed to build invocation: ${error.message}`);
  }

  for (const f of invocation.files ?? []) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.content, "utf8");
  }

  const childEnv = { ...process.env };
  for (const [k, v] of Object.entries(invocation.env ?? {})) {
    if (v === null) delete childEnv[k];
    else childEnv[k] = v;
  }

  // The client forms its own process group, so its whole tree can be cleaned up on timeout/kill. We (pigeon) stay foreground and await; no detach.
  const child = spawn(invocation.command, invocation.argv, {
    cwd: process.cwd(),
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  // When Claude (background task) or the user terminates pigeon, also kill the client subtree so no orphans are left.
  const onTerm = () => {
    terminateProcessTree(child.pid, { signal: "SIGKILL" });
    process.exit(130);
  };
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onTerm);

  let stdout = "";
  let stderr = "";
  const MAX_STDOUT = 4 * 1024 * 1024;
  const MAX_STDERR = 64 * 1024;
  const tail = (buf, chunk, max) => {
    const next = buf + chunk;
    return next.length > max ? next.slice(next.length - max) : next;
  };
  child.stdout.on("data", (d) => { stdout = tail(stdout, d.toString(), MAX_STDOUT); });
  child.stderr.on("data", (d) => { stderr = tail(stderr, d.toString(), MAX_STDERR); });

  // No execution time limit by default — only arm a wall-clock kill if a cap was explicitly opted into.
  let timedOut = false;
  const timer = ctx.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child.pid, { signal: "SIGKILL" });
      }, ctx.timeoutMs)
    : null;

  const exit = await new Promise((resolve) => {
    child.on("close", (code) => resolve({ code }));
    child.on("error", (err) => resolve({ spawnError: err }));
  });
  if (timer) clearTimeout(timer);

  if (timedOut) {
    fail(`wall-clock timeout (>${Math.round(ctx.timeoutMs / 1000)}s), terminated`);
  }
  if (exit.spawnError) {
    fail(mapClientError(exit.spawnError.message, stderr));
  }
  if (exit.code === 0) {
    let text = "";
    try {
      text = client.parseResult(stdout) ?? "";
    } catch {
      text = stdout;
    }
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
    process.exit(0);
  }
  fail(mapClientError(`client exit code ${exit.code}`, stderr));
}

// ——— continue: reuse (thread_key, session_id) to start a new background job, serialized within the same thread ———
function cmdContinue(argv) {
  // Forms: continue <job-id> -- <follow-up instruction>  or  continue <job-id> --stdin (body via stdin)
  const dashDashIdx = argv.indexOf("--");
  const head = dashDashIdx === -1 ? argv : argv.slice(0, dashDashIdx);
  const useStdin = head.includes("--stdin");
  const reference = head.find((a) => !a.startsWith("--"));
  const task = useStdin
    ? readStdinTask()
    : dashDashIdx === -1
      ? null
      : argv.slice(dashDashIdx + 1).join(" ");

  if (!reference) {
    fail("usage: /pigeon:continue <job-id> -- <follow-up instruction>");
  }
  if (!task || !task.trim()) {
    fail("follow-up instruction is empty (provide it after --)");
  }

  let base;
  try {
    base = resolveJobRef(reference);
  } catch (error) {
    fail(error.message);
  }
  if (!base) {
    fail(`job "${reference}" not found. Use /pigeon:status to see known jobs.`);
  }

  // First do a liveness check — base may be "marked running on disk but the runner has hard-crashed";
  // assessJob converts it to crashed and persists. Otherwise we'd accept a continue based on stale
  // state and queue a follow-up that's doomed to fail resume.
  base = assessJob(base);

  // Resume capability is decided by the client adapter (codex may not support it).
  const client = getClient(base.client);
  if (!client) {
    fail(`client "${base.client}" for job ${base.id} is unavailable`);
  }
  if (client.supportsResume === false) {
    fail(`client "${base.client}" does not yet support continue/resume`);
  }
  // When continue is allowed (whether the session id is "stable before completion"):
  //  - any client: base is done → can continue (session already established).
  //  - claude (sessionIdStable): --session-id is pinned at work time, so an active base (queued/running)
  //    can also be continued — it queues behind via the same thread_key lock. But if base is already in a
  //    non-done terminal state (crashed/failed/killed/timeout), the session likely never actually got
  //    established, so reject and explain why.
  //  - codex (unstable): the real resume id is only known after parsing the completed output → can only continue done jobs.
  const stable = client.sessionIdStable === true;
  const okToContinue = base.status === "done" || (stable && isActive(base.status));
  if (!okToContinue) {
    fail(
      stable
        ? `job ${base.id} is currently "${base.status}" and cannot be continued (base a running or done job).`
        : `job ${base.id} is currently "${base.status}"; the session id for client "${base.client}" is only determined after the task completes, so wait until it's done before continuing.`
    );
  }
  if (!base.session_id) {
    fail(`job ${base.id} has no resumable session_id (the original job may not have established a session)`);
  }

  // Rebuild context from the original backend identity (persisted in the job), taking only the current
  // provider's key/base_url (allows credential rotation). It bypasses the model alias → even if the model
  // name is repointed to a different backend, the old thread still resumes the original backend.
  let ctx;
  try {
    ctx = resolveContinueContext(base);
  } catch (error) {
    fail(error.message);
  }

  const id = generateJobId(base.model);
  // Serialized within the same thread_key: a file lock (held briefly by the spawning process; the real serialization happens inside __run-job).
  startBackgroundJob({
    id,
    ctx,
    task,
    cwd: base.cwd,
    thread_key: base.thread_key,
    session_id: base.session_id,
    resume: true,
    resume_from: base.id
  });

  process.stdout.write(`${renderWorkAccepted(readJob(id))}\n`);
}

// Write the job record + spawn the detached __run-job process.
function startBackgroundJob({ id, ctx, task, cwd, thread_key, session_id, resume, resume_from = null }) {
  // Submission sequence number (globally monotonic): same-thread FIFO uses this to keep "first submitted, first executed".
  const seq = nextSeq();
  // The job record carries the execution parameters for __run-job to read (the child can't see the main conversation, so the body carries its own context).
  const record = createRunningJob({
    id,
    pid: 0, // placeholder; __run-job backfills its own pid after starting
    seq,
    model: ctx.model,
    client: ctx.client,
    effort: ctx.effort,
    provider: ctx.provider,
    model_id: ctx.modelId,
    protocol: ctx.protocol,
    wire_api: ctx.wireApi ?? null,
    native: ctx.native ?? false,
    thread_key,
    session_id,
    claude_session: currentSessionId(),
    cwd,
    timeout_ms: ctx.timeoutMs
  });
  // Attach fields the runner needs but that aren't part of the status contract (lock-guarded: if it was
  // just created and then cleared by SessionEnd, don't resurrect it). Note: api_key is **not written into
  // the job file** (to avoid a plaintext key landing in ~/.pigeon/jobs/*.json, and so nothing lingers after
  // SIGKILL) — instead it's passed via the runner process's env var PIGEON_JOB_API_KEY (in memory only).
  patchIfActive(id, {
    _exec: {
      modelId: ctx.modelId,
      baseUrl: ctx.baseUrl,
      effort: ctx.effort,
      wireApi: ctx.wireApi ?? null,
      native: ctx.native ?? false,
      task,
      resume,
      resume_from,
      session_id,
      thread_key,
      timeout_ms: ctx.timeoutMs
    }
  });

  let pid;
  try {
    pid = spawnDetached(process.execPath, [SELF, "__run-job", id], {
      cwd,
      // Native jobs have no key (auth is inherited by the client); only pass PIGEON_JOB_API_KEY for the proxy path.
      env: ctx.apiKey ? { ...process.env, PIGEON_JOB_API_KEY: ctx.apiKey } : { ...process.env },
      logFile: jobLogFile(id)
    });
  } catch (error) {
    // The background runner failed to start (e.g. cwd was deleted): finalize the queued record as failed, don't leave a pid:0 zombie record.
    finalizeJob(id, { status: "failed", error: `background runner failed to start: ${error.message}` });
    fail(`failed to start background task: ${error.message}`);
  }
  // Backfill the runner pid + identity token (lock-guarded: if the job was already canceled/cleaned up, don't let a stale snapshot resurrect it).
  patchIfActive(id, { pid, pid_token: procToken(pid) });
}

// ——— __run-job (internal): detached child process that actually runs the client, heartbeats, and writes the terminal state ———
async function cmdRunJob(argv) {
  const id = argv[0];
  if (!id) {
    process.exit(2);
  }
  const job = readJob(id);
  if (!job || !job._exec) {
    process.exit(2);
  }
  // Backfill own pid + identity token (detached leader), lock-guarded: if it was set to a terminal state
  // by cancel/SessionEnd right after work returned, don't resurrect it, and the runner exits directly (no client started).
  const started = patchIfActive(id, { pid: process.pid, pid_token: procToken(process.pid) });
  if (!started || isTerminal(started.status)) {
    process.exit(0);
  }

  const exec = job._exec;
  const client = getClient(job.client);

  await runUnderThreadLock(id, job, exec, client);
}

// Execute the entire client run under the thread_key lock (with heartbeat + timeout fallback).
// Concurrent continues on the same thread_key queue here, preventing the thread history from being corrupted.
async function runUnderThreadLock(id, job, exec, client) {
  // A queued continue must wait out the preceding base however long it runs. With a configured cap,
  // wait that long + 1h buffer; with no cap (default), wait unbounded — the lock still has a
  // "preempt if the holder is dead" fallback, so a dead base never blocks forever.
  const lockWaitMs = (Number.isFinite(exec.timeout_ms) && exec.timeout_ms > 0)
    ? exec.timeout_ms + 3_600_000
    : Infinity;

  // ── FIFO + unified check after acquiring the lock ──
  // Repeatedly contend for the same-thread lock until: this job is still active, and no job on the same
  // thread was "submitted earlier (smaller seq) and not yet finished".
  // This way, even if multiple continues are dispatched almost simultaneously and grab the lock out of order,
  // they execute strictly in submission order (avoiding out-of-order thread history).
  let releaseThread;
  for (;;) {
    releaseThread = acquireLock(threadLockName(exec.thread_key), { timeoutMs: lockWaitMs });
    const cur = readJob(id);
    if (!cur || isTerminal(cur.status)) {
      // Set to a terminal state by cancel/cleanup while queued → never execute, exit directly (terminal-state-absorbing execution boundary guard).
      releaseThread();
      process.exit(0);
    }
    if (earlierActiveOnThread(exec.thread_key, job.seq, id)) {
      releaseThread();
      await sleep(150);
      continue;
    }
    break;
  }

  // This job's turn: queued → running (reset started_at to the actual start moment). If it's already terminal
  // now, don't execute — markRunning is terminal-state-absorbing, so a non-running return means cancel/cleanup
  // just got ahead; exit immediately, never buildInvocation/spawn.
  const started = markRunning(id);
  if (!started || started.status !== "running") {
    releaseThread();
    process.exit(0);
  }

  // resume: at this point the predecessor (FIFO-guaranteed) has finished. Require it to actually be done
  // (only now is the claude/codex session confirmed established), and use its **final** session_id (not the
  // placeholder copied at submission time). Predecessor not done → session not established, reject the continue.
  if (exec.resume && exec.resume_from) {
    const base = readJob(exec.resume_from);
    if (!base || base.status !== "done") {
      finalizeJob(id, {
        status: "failed",
        error: `original job ${exec.resume_from} ended as ${base ? base.status : "missing"}; the session was not established, cannot continue.`
      });
      releaseThread();
      process.exit(1);
    }
    if (base.session_id) exec.session_id = base.session_id;
  }

  let invocation;
  try {
    invocation = client.buildInvocation({
      taskPrompt: exec.task,
      modelId: exec.modelId,
      baseUrl: exec.baseUrl,
      apiKey: process.env.PIGEON_JOB_API_KEY ?? exec.apiKey, // key comes from env, not the job file
      effort: exec.effort,
      wireApi: exec.wireApi ?? null,
      native: exec.native ?? false,
      sessionId: exec.session_id,
      resume: exec.resume
    });
  } catch (error) {
    finalizeJob(id, { status: "failed", error: `failed to build invocation: ${error.message}` });
    releaseThread();
    process.exit(1);
  }

  // Write the temporary config files the client needs to disk
  for (const f of invocation.files ?? []) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.content, "utf8");
  }

  // An env value of null = must UNSET (claude forcibly unsets ANTHROPIC_AUTH_TOKEN).
  const childEnv = { ...process.env };
  for (const [k, v] of Object.entries(invocation.env ?? {})) {
    if (v === null) {
      delete childEnv[k];
    } else {
      childEnv[k] = v;
    }
  }
  // Install the SIGTERM handler first (referencing the mutable child), **then** spawn — so from the moment
  // the client is born, if the runner is killed by cancel/cleanup (SIGTERM hits the runner group), the handler
  // kills the client subtree, leaving no orphans; even if client_pid hasn't been persisted yet, there's no
  // window where "the client is up but no one can kill it".
  let child = null;
  const onTerm = () => {
    if (child) terminateProcessTree(child.pid, { signal: "SIGKILL" });
    process.exit(0);
  };
  process.on("SIGTERM", onTerm);

  // client detached: forms its own process group, so terminateProcessTree(child.pid) can hit its entire subtree.
  child = spawn(invocation.command, invocation.argv, {
    cwd: job.cwd,
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  // Persist the client process-group leader pid (lock-guarded). If the job was already canceled/cleaned up
  // (terminal) at the instant we spawned the client, immediately kill the just-started client and exit — don't resurrect the job, and leave no orphans.
  const pj = patchIfActive(id, { client_pid: child.pid, client_pid_token: procToken(child.pid) });
  if (!pj || isTerminal(pj.status)) {
    terminateProcessTree(child.pid, { signal: "SIGKILL" });
    releaseThread();
    process.exit(0);
  }

  let stdout = "";
  let stderr = "";
  // Bounded buffer: keep only the tail — the client's final result (claude's result JSON / codex's last
  // agent_message) is always at the tail of the output. This caps runner memory no matter how verbose the
  // client is (codex --json's massive JSONL, very long answers), so it won't OOM and lose the result.
  const MAX_STDOUT = 4 * 1024 * 1024;
  const MAX_STDERR = 64 * 1024;
  const tailAppend = (buf, chunk, max) => {
    const next = buf + chunk;
    return next.length > max ? next.slice(next.length - max) : next;
  };
  child.stdout.on("data", (d) => {
    stdout = tailAppend(stdout, d.toString(), MAX_STDOUT);
  });
  child.stderr.on("data", (d) => {
    stderr = tailAppend(stderr, d.toString(), MAX_STDERR);
  });

  // Heartbeat: update last_heartbeat every ≤5s
  const hb = setInterval(() => heartbeat(id), HEARTBEAT_INTERVAL_MS);

  // Timeout fallback: wall-clock limit → SIGKILL the process tree (SIGKILL can't be trapped, so the client
  // must die and close must fire) → status=timeout. Plus a hard-exit fallback: in case close still doesn't fire
  // (e.g. a stdio pipe stuck), after a grace period forcibly write the terminal state, release the thread lock,
  // and exit — never let the runner hold the lock forever / get stuck in running.
  // No execution time limit by default. A wall-clock kill is armed ONLY when a cap was opted into
  // (env/config); otherwise the agent runs until it finishes, is canceled, or the session ends.
  let timedOut = false;
  let hardExitTimer = null;
  const timeoutMs = exec.timeout_ms ?? job.timeout_ms;
  const timer = (Number.isFinite(timeoutMs) && timeoutMs > 0)
    ? setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child.pid, { signal: "SIGKILL" });
        hardExitTimer = setTimeout(() => {
          try {
            finalizeJob(id, {
              status: "timeout",
              error: `wall-clock timeout (>${Math.round(timeoutMs / 1000)}s); still not exited after SIGKILL, forcing finalization`
            });
          } catch {
            /* best effort */
          }
          releaseThread();
          process.exit(0);
        }, 5000);
        hardExitTimer.unref?.();
      }, timeoutMs)
    : null;

  const exit = await new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", (err) => resolve({ code: null, signal: null, spawnError: err }));
  });

  clearInterval(hb);
  if (timer) clearTimeout(timer);
  if (hardExitTimer) clearTimeout(hardExitTimer);

  // All terminal states go through finalizeJob (in-lock, terminal-state guarded, auto-strips _exec).

  if (timedOut) {
    finalizeJob(id, {
      status: "timeout",
      exit_code: exit.code,
      error: `wall-clock timeout (>${Math.round(timeoutMs / 1000)}s), killed the process tree`
    });
    releaseThread();
    process.exit(0);
  }

  if (exit.spawnError) {
    finalizeJob(id, { status: "failed", error: mapClientError(exit.spawnError.message, stderr) });
    releaseThread();
    process.exit(1);
  }

  if (exit.code === 0) {
    // Parse the result text + session id (for later continue)
    let resultText = "";
    try {
      resultText = client.parseResult(stdout) ?? "";
    } catch (error) {
      resultText = stdout;
    }
    let extracted = null;
    try {
      extracted = client.extractSessionId(stdout, { cwd: job.cwd }) ?? null;
    } catch {
      /* none */
    }
    // Stable client (claude): the session_id pinned at work time is itself resumable; if a more accurate one is parsed, use it.
    // Unstable client (codex): store **only** if a real id was actually parsed; otherwise set null, never leave a placeholder UUID,
    // or /pigeon:continue would use a fake id to resume a nonexistent thread.
    const sessionId =
      client.sessionIdStable === true ? extracted ?? job.session_id ?? null : extracted;
    finalizeJob(id, { status: "done", exit_code: 0, session_id: sessionId, result_text: resultText });
    releaseThread();
    process.exit(0);
  }

  // Non-zero exit → failed, map stderr to a friendly error
  finalizeJob(id, {
    status: "failed",
    exit_code: exit.code,
    error: mapClientError(`client exit code ${exit.code}`, stderr)
  });
  releaseThread();
  process.exit(1);
}

// Errors only surfaced at run time (401/network) → friendly message.
function mapClientError(base, stderr) {
  const text = (stderr || "").trim();
  if (/401|unauthorized|invalid api key|authentication/i.test(text)) {
    return `${base}: authentication failed (check api_key, /pigeon:config)`;
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|getaddrinfo/i.test(text)) {
    return `${base}: network error (check base_url / connectivity)`;
  }
  // codex >=0.139 only speaks the Responses API. Pointed at a Chat-Completions-only OpenAI endpoint
  // (no /responses route, e.g. api.xiaomimimo.com/v1) it fails to load wire_api="chat" or to refresh
  // its model list. Surface the real cause + the working alternative instead of codex's cryptic output.
  if (/failed to refresh available models|missing field `models`|wire_api = "chat"/i.test(text) ||
      (/\b404\b/.test(text) && /\/responses\b/.test(text))) {
    return `${base}: codex could not drive this OpenAI endpoint — it appears to be Chat-Completions-only (no Responses API), but codex >=0.139 requires the Responses API. Use the provider's anthropic protocol via the "claude" client for this model.`;
  }
  const tail = text ? `: ${text.split("\n").slice(-3).join(" ").slice(0, 400)}` : "";
  return `${base}${tail}`;
}

// ——— status ———
const STATUS_PAGE_SIZE = 10;

function cmdStatus(argv) {
  const reference = (argv[0] ?? "").trim();
  // Bare (no arg) or a plain page number → paginated list, newest first, 10 per page.
  // A bare integer is unambiguous: job ids always carry a model prefix (e.g. glm-5.1-ab12cd34).
  if (!reference || /^\d+$/.test(reference)) {
    const page = reference ? Math.max(1, parseInt(reference, 10)) : 1;
    const all = listJobs(); // already sorted newest-first
    const start = (page - 1) * STATUS_PAGE_SIZE;
    const slice = all.slice(start, start + STATUS_PAGE_SIZE).map((j) => assessJob(j));
    const meta = { page, pageSize: STATUS_PAGE_SIZE, total: all.length };
    process.stdout.write(`${renderStatusList(slice, meta)}\n`);
    return;
  }
  let job;
  try {
    job = resolveJobRef(reference);
  } catch (error) {
    fail(error.message);
  }
  if (!job) {
    fail(`job "${reference}" not found`);
  }
  process.stdout.write(`${renderStatusOne(assessJob(job))}\n`);
}

// ——— result ———
function cmdResult(argv) {
  const reference = argv[0];
  if (!reference) {
    fail("usage: /pigeon:result <job-id>");
  }
  let job;
  try {
    job = resolveJobRef(reference);
  } catch (error) {
    fail(error.message);
  }
  if (!job) {
    fail(`job "${reference}" not found`);
  }
  const assessed = assessJob(job);
  process.stdout.write(`${renderResult(assessed, assessed.result_text)}\n`);
}

// ——— cancel: kill the process tree → status=killed ———
function cmdCancel(argv) {
  const reference = argv[0];
  if (!reference) {
    fail("usage: /pigeon:cancel <job-id>");
  }
  let job;
  try {
    job = resolveJobRef(reference);
  } catch (error) {
    fail(error.message);
  }
  if (!job) {
    fail(`job "${reference}" not found`);
  }
  if (isTerminal(job.status)) {
    fail(`job ${job.id} is already terminal (${job.status}), nothing to cancel`);
  }
  // If the client has already exited (the task finished and the runner is finalizing with the real result) →
  // don't preempt, otherwise killed would absorb the just-completed done/failed and lose the result. Let the runner finalize normally.
  if (!executionStillLive(job)) {
    fail(`job ${job.id} has finished executing and is finalizing, cannot cancel; use /pigeon:result ${job.id} shortly to get the result.`);
  }
  // Still running: claim the terminal state (killed) first — terminal-state absorption guarantees it wins
  // (even if killing the client triggers the runner's close finalization). Then verify identity before killing the process (skip on PID reuse, never kill the wrong one).
  finalizeJob(job.id, { status: "killed", error: "canceled by user" });
  terminateTreeIfOurs(job.client_pid, job.client_pid_token, { signal: "SIGKILL" });
  const result = terminateTreeIfOurs(job.pid, job.pid_token);
  process.stdout.write(`${renderCancel(job, result)}\n`);
}

// ——— list ———
function cmdList() {
  let models;
  try {
    const config = loadConfig();
    models = listModelNames(config)
      .map((name) => resolveModelView(name))
      // Native models only show when their client is actually installed (e.g. codex appears only if `codex` is on PATH).
      .filter((m) => !m.native || (m.defaultClient && resolveBinary(m.defaultClient)));
  } catch (error) {
    fail(error.message);
  }
  process.stdout.write(`${renderModelList(models)}\n`);

  // Discovery table: built-in native providers detected on this machine (their client is installed)
  // that you HAVEN'T configured a model on yet. Once a model references one, that model shows in the
  // table above and the provider drops out of here — so a fully-used setup shows no discovery table.
  const usedNative = new Set(models.filter((m) => m.native).map((m) => m.provider));
  const detected = nativeProviderNames()
    .filter((name) => !usedNative.has(name))
    .map((name) => {
      // Show a native provider if ANY client that speaks one of its protocols is installed.
      for (const proto of getNativeProvider(name).protocols || []) {
        for (const client of clientsForProtocol(proto)) {
          if (resolveBinary(client)) return { provider: name, protocol: proto, client };
        }
      }
      return null;
    })
    .filter(Boolean);
  const nativeTable = renderNativeProviders(detected);
  if (nativeTable) {
    process.stdout.write(`\n${nativeTable}\n`);
  }
}

// ——— config-set (validate + atomic write only, no NL parsing) ———
function cmdConfigSet(argv) {
  const parsed = parseFormC(argv);
  const jsonStr = parsed.flags.json;
  if (!jsonStr) {
    fail("usage: config-set --json '<structured JSON>'");
  }
  let payload;
  try {
    payload = JSON.parse(jsonStr);
  } catch (error) {
    fail(`--json is not valid JSON: ${error.message}`);
  }
  try {
    // patchConfig: deep-merge a **partial** patch into the existing config (without deleting untouched
    // providers/models), then validate (§6.1) + atomic write + write lock; config.mjs guarantees bad JSON won't overwrite.
    patchConfig(payload);
  } catch (error) {
    fail(error.message);
  }
  process.stdout.write("config written to ~/.pigeon/config.json. Use /pigeon:list to view.\n");
}

// ——— cleanup (SessionEnd can also go through cleanup-session.mjs) ———
async function cmdCleanup() {
  const { cleanupSession } = await import("./cleanup-session.mjs");
  const sessionId = currentSessionId();
  const killed = cleanupSession(sessionId);
  process.stdout.write(`cleanup: killed ${killed.length} running job(s)\n`);
}

// ——— Dispatch ———
async function main() {
  const [, , sub, ...rest] = process.argv;
  switch (sub) {
    case "work":
      return cmdWork(rest);
    case "run":
      return cmdRun(rest);
    case "continue":
      return cmdContinue(rest);
    case "status":
      return cmdStatus(rest);
    case "result":
      return cmdResult(rest);
    case "cancel":
      return cmdCancel(rest);
    case "list":
      return cmdList();
    case "config-set":
      return cmdConfigSet(rest);
    case "cleanup":
      return cmdCleanup();
    case "__run-job":
      return cmdRunJob(rest);
    default:
      fail(
        `unknown subcommand "${sub ?? ""}". Available: work run continue status result cancel list config-set cleanup`,
        2
      );
  }
}

main().catch((error) => {
  fail(error?.stack || error?.message || String(error));
});
