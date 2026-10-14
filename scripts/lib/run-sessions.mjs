// Successful run sessions are separate from managed work jobs. No credentials are persisted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(process.env.PIGEON_HOME || path.join(os.homedir(), ".pigeon"), "run-sessions");
const ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function readRunSession(id) {
  if (!ID.test(id)) throw new Error(`invalid run session id "${id}"`);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(root, `${id}.json`), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`run session "${id}" not found`);
    throw new Error(`cannot read run session "${id}": ${error.message}`);
  }
  if (record.id !== id || record.version !== 1 || !record.session_id ||
      typeof record.cwd !== "string" || !path.isAbsolute(record.cwd) ||
      !["claude", "codex"].includes(record.client) || typeof record.native !== "boolean" ||
      typeof record.model !== "string" || typeof record.provider !== "string" ||
      typeof record.protocol !== "string") {
    throw new Error(`run session "${id}" is not resumable (invalid record)`);
  }
  return record;
}

// Caller holds the session lock throughout execution and this atomic replacement.
export function saveRunSession(record) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const destination = path.join(root, `${record.id}.json`);
  const temp = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, destination);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
