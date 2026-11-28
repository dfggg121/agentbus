// Codex Desktop task visibility bridge.
//
// `codex exec` creates a thread in the Codex state database, but it marks the
// thread `source=exec` and leaves `project_id` empty. The Desktop app hides such
// threads from project chats, which is why an agentbus task could finish while
// the user saw an empty Codex project. After every Codex dispatch we attach the
// freshly-created thread to the matching local project and mark it as a normal
// desktop thread, so the task appears in the same place as a hand-started chat.
//
// This touches only the user's local Codex state DB. It is best-effort: if the
// app is absent or the DB is locked, dispatch still succeeds and the result says
// why the link was skipped.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function stripExtended(p) {
  return String(p || '').replace(/^\\\\\?\\/, '');
}

export function normalizeFsPath(p) {
  const abs = path.resolve(stripExtended(p));
  const trimmed = abs.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

export function codexStateDirs({ env = process.env, home = os.homedir() } = {}) {
  const dirs = [];
  if (env.AGENTBUS_CODEX_STATE_DIR) dirs.push(env.AGENTBUS_CODEX_STATE_DIR);
  if (env.CODEX_HOME) dirs.push(env.CODEX_HOME);
  dirs.push(path.join(home, '.codex'));
  const seen = new Set();
  return dirs
    .filter(Boolean)
    .map((d) => path.resolve(String(d)))
    .filter((d) => {
      const key = process.platform === 'win32' ? d.toLowerCase() : d;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function findCodexStateDb(opts = {}) {
  for (const dir of codexStateDirs(opts)) {
    const dbPath = path.join(dir, 'state_5.sqlite');
    if (fs.existsSync(dbPath)) return { dir, dbPath };
  }
  return null;
}

function pickProject(db, cwd) {
  const target = normalizeFsPath(cwd);
  const rows = db.prepare(`
    SELECT p.id AS project_id, p.name AS project_name, p.created_at_ms AS created_at_ms, r.path AS root_path
    FROM project_roots r
    JOIN projects p ON p.id = r.project_id
  `).all();

  const matches = [];
  for (const row of rows) {
    if (!row.root_path) continue;
    const root = normalizeFsPath(row.root_path);
    if (target === root || target.startsWith(root + path.sep)) {
      matches.push({ ...row, root_len: root.length });
    }
  }
  if (!matches.length) return null;
  matches.sort((a, b) => {
    if (b.root_len !== a.root_len) return b.root_len - a.root_len;
    return Number(b.created_at_ms || 0) - Number(a.created_at_ms || 0);
  });
  return matches[0];
}

/**
 * Attach a Codex exec thread to its Desktop project.
 * @returns {{linked:boolean, reason?:string, ...}}
 */
export function linkCodexThreadToApp({
  threadId,
  cwd,
  taskId = null,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (!threadId) return { linked: false, reason: 'missing_thread_id' };
  const found = findCodexStateDb({ env, home });
  if (!found) return { linked: false, reason: 'codex_state_db_not_found' };

  let db = null;
  try {
    db = new DatabaseSync(found.dbPath);
    try { db.exec('PRAGMA busy_timeout = 3000;'); } catch {}
    const row = db.prepare('SELECT id, source, project_id FROM threads WHERE id = ?').get(threadId);
    if (!row) return { linked: false, reason: 'thread_not_found', state_db: found.dbPath };

    const project = pickProject(db, cwd);
    if (!project) {
      return {
        linked: false,
        reason: 'project_not_found',
        state_db: found.dbPath,
        thread_id: threadId,
      };
    }

    const nowMs = Date.now();
    db.prepare(`
      UPDATE threads
         SET project_id = ?,
             source = CASE WHEN source = 'exec' THEN 'vscode' ELSE source END,
             thread_source = CASE
               WHEN thread_source IS NULL OR thread_source = '' OR thread_source = 'exec'
                 THEN 'user'
               ELSE thread_source
             END,
             updated_at_ms = ?
       WHERE id = ?
    `).run(project.project_id, nowMs, threadId);

    db.prepare(`
      UPDATE projects
         SET updated_at_ms = CASE WHEN updated_at_ms IS NULL OR updated_at_ms < ? THEN ? ELSE updated_at_ms END
       WHERE id = ?
    `).run(nowMs, nowMs, project.project_id);

    return {
      linked: true,
      state_db: found.dbPath,
      thread_id: threadId,
      project_id: project.project_id,
      project_name: project.project_name,
      task_id: taskId,
      source: row.source === 'exec' ? 'vscode' : row.source,
    };
  } catch (err) {
    return {
      linked: false,
      reason: 'codex_state_write_failed',
      error: String(err?.message || err),
      state_db: found?.dbPath || null,
      thread_id: threadId,
    };
  } finally {
    try { db?.close(); } catch {}
  }
}
