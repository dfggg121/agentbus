// agentbus: SQLite database layer using Node built-in node:sqlite (DatabaseSync)
// Zero third-party dependencies. Never degrades silently to JSON storage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let DatabaseSync;
if (process.env.AGENTBUS_DISABLE_SQLITE === '1') {
  console.error('需要 Node >= 22.5（node:sqlite）');
  process.exit(1);
}
try {
  ({ DatabaseSync } = await import('node:sqlite'));
  if (typeof DatabaseSync !== 'function') throw new Error('DatabaseSync missing');
} catch {
  console.error('需要 Node >= 22.5（node:sqlite）');
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.resolve(HERE, '..');

export const DEFAULT_CONFIG = {
  root: 'var',
  allowed_roots: ['..', 'var'],
  lease_ttl_s: 900,
  max_attempts: 3,
  max_ref_bytes: 2147483648,
  ref_read_inline_max: 65536,
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS artifacts (
  sha256 TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  uri TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT,
  registered_by TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  mtime TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'agentbus/task@1',
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  state TEXT NOT NULL,
  goal TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  acceptance_json TEXT NOT NULL,
  claimed_by TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  result_json TEXT,
  history_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency
  ON tasks(from_agent, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_state_to
  ON tasks(state, to_agent);

CREATE INDEX IF NOT EXISTS idx_tasks_created
  ON tasks(created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  task_id TEXT,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_task
  ON events(task_id, seq);
`;

export function loadConfig({ rootOverride = null, configPath = null } = {}) {
  let cfg = { ...DEFAULT_CONFIG };
  const candidateFiles = [];
  if (configPath) candidateFiles.push(path.resolve(configPath));
  candidateFiles.push(path.join(PKG_ROOT, 'config.json'));

  const envRoot = process.env.AGENTBUS_ROOT || null;
  const effectiveRootRaw = rootOverride || envRoot || null;
  if (effectiveRootRaw) {
    candidateFiles.push(path.join(path.resolve(effectiveRootRaw), 'config.json'));
  }

  for (const cf of candidateFiles) {
    if (fs.existsSync(cf)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cf, 'utf8'));
        cfg = { ...cfg, ...parsed };
      } catch (err) {
        throw Object.assign(new Error(`配置文件解析失败 (${path.basename(cf)}): ${err.message}`), { code: 1 });
      }
    }
  }

  const rootDir = effectiveRootRaw
    ? path.resolve(effectiveRootRaw)
    : path.isAbsolute(cfg.root)
      ? cfg.root
      : path.resolve(PKG_ROOT, cfg.root);

  let rawAllowed = Array.isArray(cfg.allowed_roots) ? cfg.allowed_roots : DEFAULT_CONFIG.allowed_roots;
  if (process.env.AGENTBUS_ALLOWED_ROOTS) {
    rawAllowed = process.env.AGENTBUS_ALLOWED_ROOTS
      .split(path.delimiter)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const allowedRoots = rawAllowed.map((r) => (path.isAbsolute(r) ? path.resolve(r) : path.resolve(PKG_ROOT, r)));
  if (!allowedRoots.some((r) => r.toLowerCase() === rootDir.toLowerCase())) {
    allowedRoots.push(rootDir);
  }

  return {
    rootDir,
    dbPath: path.join(rootDir, 'agentbus.db'),
    tasksDir: path.join(rootDir, 'tasks'),
    allowedRoots,
    leaseTtlS: Number(cfg.lease_ttl_s || 900),
    maxAttempts: Number(cfg.max_attempts || 3),
    maxRefBytes: Number(cfg.max_ref_bytes || 2147483648),
    refReadInlineMax: Number(cfg.ref_read_inline_max || 65536),
  };
}

function isBusyError(err) {
  const msg = String(err?.message || err || '');
  return /SQLITE_BUSY|database is locked|busy/i.test(msg);
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

export function openBus(opts = {}) {
  const config = opts.config || loadConfig(opts);
  fs.mkdirSync(config.rootDir, { recursive: true });
  fs.mkdirSync(config.tasksDir, { recursive: true });

  const db = new DatabaseSync(config.dbPath);
  // Configure WAL & busy timeout with retry in case concurrent processes initialize simultaneously
  for (let i = 0; i < 20; i++) {
    try {
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
      db.exec(SCHEMA_SQL);
      break;
    } catch (err) {
      if (isBusyError(err) && i < 19) {
        sleepSync(20 + Math.floor(Math.random() * 35));
        continue;
      }
      db.close();
      throw err;
    }
  }

  const journalRow = db.prepare('PRAGMA journal_mode').get();
  const journalMode = String(journalRow?.journal_mode || '').toLowerCase();

  return {
    db,
    config,
    journalMode,
    close() {
      try { db.close(); } catch {}
    },
  };
}

/**
 * Execute a write transaction using BEGIN IMMEDIATE with deterministic busy retry.
 * Guarantees serialized contention for concurrent multi-process claims.
 */
export function withImmediateTx(db, fn) {
  const deadline = Date.now() + 8000;
  let attempt = 0;
  while (true) {
    let begun = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      begun = true;
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      if (begun) {
        try { db.exec('ROLLBACK'); } catch {}
      }
      if (isBusyError(err) && Date.now() < deadline) {
        attempt++;
        sleepSync(10 + Math.min(80, attempt * 5) + Math.floor(Math.random() * 25));
        continue;
      }
      throw err;
    }
  }
}

export function appendEvent(db, taskId, event, payload = {}) {
  db.prepare(
    'INSERT INTO events(at, task_id, event, payload_json) VALUES (?, ?, ?, ?)'
  ).run(new Date().toISOString(), taskId || null, String(event), JSON.stringify(payload));
}
