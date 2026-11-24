// agentbus: Thread scoping, client-specific policies, step resolution, and rotation snapshots.
// Zero third-party dependencies.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendEvent, withImmediateTx } from './db.js';
import { conversationStepCount } from './agy.js';
import { readAgentConfig } from './agents.js';
import {
  contextLedgerDisabled,
  initContextLedger,
  loadContextLedger,
  saveAndRegisterContext,
} from './context.js';

const IS_WIN = process.platform === 'win32';
const ESTIMATED_STEPS_PER_USE = 8;
const MAX_CODEX_JSONL_BYTES = 10 * 1024 * 1024;

export const CLIENT_THREAD_POLICIES = {
  antigravity: { max_steps: 20, max_age_s: 3600, max_idle_s: 1800, max_uses: 3, allow_cross_task: false },
  codex:       { max_steps: 60, max_age_s: 7200, max_idle_s: 1800, max_uses: 6, allow_cross_task: true },
  claude:      { max_steps: 40, max_age_s: 5400, max_idle_s: 1800, max_uses: 6, allow_cross_task: true },
  gemini:      { max_steps: 20, max_age_s: 3600, max_idle_s: 1800, max_uses: 3, allow_cross_task: false },
  default:     { max_steps: 40, max_age_s: 7200, max_idle_s: 1800, max_uses: 10, allow_cross_task: true },
};

export function normalizeCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  let resolved = path.resolve(cwd);
  try {
    if (fs.existsSync(resolved)) resolved = fs.realpathSync(resolved);
  } catch {}
  return IS_WIN ? resolved.toLowerCase() : resolved;
}

function parseBoolEnv(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'no') return false;
  return undefined;
}

function mergePolicy(target, src) {
  if (!src || typeof src !== 'object') return;
  for (const k of ['max_steps', 'max_age_s', 'max_idle_s', 'max_uses']) {
    if (src[k] !== undefined && Number.isFinite(Number(src[k]))) {
      target[k] = Number(src[k]);
    }
  }
  if (src.allow_cross_task !== undefined) {
    const b = typeof src.allow_cross_task === 'boolean' ? src.allow_cross_task : parseBoolEnv(src.allow_cross_task);
    if (b !== undefined) target.allow_cross_task = b;
  }
}

export function resolveClientPolicy(agent, busRoot = null, env = process.env, configLimits = null) {
  const base = { ...(CLIENT_THREAD_POLICIES[agent] || CLIENT_THREAD_POLICIES.default) };

  // Legacy global env vars are the lowest-priority override: config files and
  // per-client env vars below take precedence.
  if (env.AGENTBUS_THREAD_MAX_AGE_S !== undefined && Number.isFinite(Number(env.AGENTBUS_THREAD_MAX_AGE_S))) {
    base.max_age_s = Number(env.AGENTBUS_THREAD_MAX_AGE_S);
  }
  if (env.AGENTBUS_THREAD_MAX_STEPS !== undefined && Number.isFinite(Number(env.AGENTBUS_THREAD_MAX_STEPS))) {
    base.max_steps = Number(env.AGENTBUS_THREAD_MAX_STEPS);
  }
  if (env.AGENTBUS_THREAD_MAX_USES !== undefined && Number.isFinite(Number(env.AGENTBUS_THREAD_MAX_USES))) {
    base.max_uses = Number(env.AGENTBUS_THREAD_MAX_USES);
  }

  if (configLimits && typeof configLimits === 'object') {
    mergePolicy(base, configLimits[agent]);
  }

  if (busRoot) {
    const agentCfg = readAgentConfig(busRoot);
    if (agentCfg.thread_limits && typeof agentCfg.thread_limits === 'object') {
      mergePolicy(base, agentCfg.thread_limits[agent]);
    }
  }

  const prefixes = agent === 'antigravity'
    ? ['AGY', 'ANTIGRAVITY']
    : [String(agent || 'default').toUpperCase().replace(/[^A-Z0-9]/g, '_')];

  for (const p of prefixes) {
    const s = env[`AGENTBUS_${p}_MAX_STEPS`];
    const a = env[`AGENTBUS_${p}_MAX_AGE_S`];
    const idl = env[`AGENTBUS_${p}_MAX_IDLE_S`];
    const u = env[`AGENTBUS_${p}_MAX_USES`];
    const cross = env[`AGENTBUS_${p}_ALLOW_CROSS_TASK`];
    if (s !== undefined && Number.isFinite(Number(s))) base.max_steps = Number(s);
    if (a !== undefined && Number.isFinite(Number(a))) base.max_age_s = Number(a);
    if (idl !== undefined && Number.isFinite(Number(idl))) base.max_idle_s = Number(idl);
    if (u !== undefined && Number.isFinite(Number(u))) base.max_uses = Number(u);
    const crossBool = parseBoolEnv(cross);
    if (crossBool !== undefined) base.allow_cross_task = crossBool;
  }

  if (env.AGENTBUS_THREAD_LIMITS_JSON) {
    try {
      const parsed = JSON.parse(env.AGENTBUS_THREAD_LIMITS_JSON);
      if (parsed && typeof parsed === 'object') {
        if (!CLIENT_THREAD_POLICIES[agent] && parsed.default) mergePolicy(base, parsed.default);
        if (parsed[agent]) mergePolicy(base, parsed[agent]);
      }
    } catch {}
  }

  return base;
}

export function hasSandboxConstraint(constraints) {
  if (!Array.isArray(constraints)) return false;
  return constraints.some((c) => /\bsandbox\b|read[-_ ]?only|no[-_ ]?bypass/i.test(String(c)));
}

export function threadUsable(row, ctx = {}) {
  const ctxObj = typeof ctx === 'number' ? { now: ctx, agent: 'default', isAutoTask: true } : (ctx || {});
  const agent = ctxObj.agent || 'default';
  const policy = resolveClientPolicy(agent, ctxObj.busRoot || null, ctxObj.env || process.env, ctxObj.configLimits || null);
  const now = ctxObj.now ?? Date.now();

  if (!row || !row.session_id) return { ok: false, reason: 'missing', policy };
  if (Number(row.last_ok) === 0) return { ok: false, reason: 'last_not_ok', policy };

  const isAutoTask = ctxObj.isAutoTask === true;
  if (!isAutoTask && !policy.allow_cross_task && !ctxObj.explicitThreadOverride) {
    return { ok: false, reason: 'cross_task_disabled', policy };
  }

  if (agent === 'codex' && hasSandboxConstraint(ctxObj.constraints)) {
    return { ok: false, reason: 'sandbox_requires_fresh', policy };
  }

  if (ctxObj.cwd !== undefined) {
    if (!row.cwd || normalizeCwd(row.cwd) !== normalizeCwd(ctxObj.cwd)) {
      return { ok: false, reason: 'cwd_mismatch', policy };
    }
  }

  if (ctxObj.model !== undefined) {
    if ((row.model || '') !== (ctxObj.model || '')) {
      return { ok: false, reason: 'model_mismatch', policy };
    }
  }

  const ageS = row.created_at ? (now - Date.parse(row.created_at)) / 1000 : 0;
  const idleS = row.updated_at ? (now - Date.parse(row.updated_at)) / 1000 : ageS;
  if (Number.isFinite(ageS) && ageS > policy.max_age_s) return { ok: false, reason: 'max_age_exceeded', policy };
  if (Number.isFinite(idleS) && idleS > policy.max_idle_s) return { ok: false, reason: 'max_idle_exceeded', policy };
  if (Number(row.steps || 0) >= policy.max_steps) return { ok: false, reason: 'max_steps_exceeded', policy };
  if (Number(row.uses || 0) >= policy.max_uses) return { ok: false, reason: 'max_uses_exceeded', policy };

  return { ok: true, reason: null, policy };
}

export function getThreadRow(bus, agent, name) {
  return bus.db.prepare(
    'SELECT agent, name, session_id, created_at, updated_at, uses, steps, cwd, model, last_ok, step_source, rotated_from FROM threads WHERE agent = ? AND name = ?'
  ).get(agent, name) || null;
}

export function clearThread(bus, agent, name) {
  const res = bus.db.prepare('DELETE FROM threads WHERE agent = ? AND name = ?').run(agent, name);
  return Number(res?.changes || 0);
}

export function clearTaskThreadByName(db, name) {
  if (!name || !String(name).startsWith('task:')) return 0;
  const res = db.prepare('DELETE FROM threads WHERE name = ?').run(String(name));
  return Number(res?.changes || 0);
}

export function invalidateThread(bus, agent, name) {
  bus.db.prepare('UPDATE threads SET last_ok = 0, updated_at = ? WHERE agent = ? AND name = ?')
    .run(new Date().toISOString(), agent, name);
}

export function getThread(bus, agent, name, opts = {}) {
  const row = getThreadRow(bus, agent, name);
  const policy = resolveClientPolicy(agent, bus.config?.rootDir || null, process.env, bus.config?.threadLimits || null);
  if (!row) return { sessionId: null, rotatedReason: null, prevRow: null, policy };

  const isAutoTask = String(name).startsWith('task:');
  const verdict = threadUsable(row, {
    agent,
    cwd: opts.cwd,
    model: opts.model ?? null,
    constraints: opts.constraints || [],
    isAutoTask,
    explicitThreadOverride: opts.explicitThreadOverride === true,
    busRoot: bus.config?.rootDir || null,
    configLimits: bus.config?.threadLimits || null,
  });

  if (verdict.ok) {
    return { sessionId: row.session_id, rotatedReason: null, prevRow: row, policy: verdict.policy };
  }

  clearThread(bus, agent, name);
  return { sessionId: null, rotatedReason: verdict.reason, prevRow: row, policy: verdict.policy };
}

export function setThread(bus, agent, name, sessionId, meta) {
  const now = new Date().toISOString();
  const cwdNorm = normalizeCwd(meta.cwd);
  const modelVal = meta.model || null;
  const stepsVal = Math.max(0, Number(meta.steps || 0));
  const stepSourceVal = String(meta.stepSource || 'unknown');
  const lastOkVal = meta.lastOk === 0 ? 0 : 1;

  if (meta.resumed) {
    bus.db.prepare(
      `UPDATE threads SET session_id = ?, cwd = ?, model = ?, steps = ?, step_source = ?,
       last_ok = ?, updated_at = ? WHERE agent = ? AND name = ?`
    ).run(sessionId, cwdNorm, modelVal, stepsVal, stepSourceVal, lastOkVal, now, agent, name);
    return;
  }

  bus.db.prepare(
    `INSERT INTO threads (agent, name, session_id, created_at, uses, steps, updated_at,
     cwd, model, last_ok, step_source, rotated_from)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent, name) DO UPDATE SET
       session_id = excluded.session_id,
       created_at = excluded.created_at,
       uses = 1,
       steps = excluded.steps,
       updated_at = excluded.updated_at,
       cwd = excluded.cwd,
       model = excluded.model,
       last_ok = excluded.last_ok,
       step_source = excluded.step_source,
       rotated_from = excluded.rotated_from`
  ).run(
    agent,
    name,
    sessionId,
    now,
    stepsVal,
    now,
    cwdNorm,
    modelVal,
    lastOkVal,
    stepSourceVal,
    meta.rotatedFrom || null
  );
}

export function touchThread(bus, agent, name) {
  bus.db.prepare('UPDATE threads SET uses = uses + 1, updated_at = ? WHERE agent = ? AND name = ?')
    .run(new Date().toISOString(), agent, name);
}

export function countCodexStdoutSteps(stdout = '') {
  if (!stdout) return 0;
  let count = 0;
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && (obj.type === 'item.completed' || obj.type === 'turn.completed')) count++;
    } catch {}
  }
  return count;
}

function findRolloutJsonl(dir, sessionId, depth = 0) {
  if (depth > 5 || !fs.existsSync(dir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const hit = findRolloutJsonl(full, sessionId, depth + 1);
      if (hit) return hit;
    } else if (ent.isFile()) {
      if (ent.name.endsWith('.jsonl') && !ent.name.endsWith('.jsonl.zst') && ent.name.includes(sessionId)) {
        return full;
      }
    }
  }
  return null;
}

export function countCodexJsonlSteps(sessionId, home = os.homedir()) {
  if (!sessionId) return null;
  const sessionsDir = path.join(home, '.codex', 'sessions');
  const file = findRolloutJsonl(sessionsDir, sessionId);
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_CODEX_JSONL_BYTES) return null;
    const raw = fs.readFileSync(file, 'utf8');
    let lines = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim()) lines++;
    }
    return lines;
  } catch {
    return null;
  }
}

export function resolveThreadSteps({ agent, sessionId, stdout = '', prevRow = null, home = os.homedir() }) {
  if (agent === 'antigravity') {
    const c = conversationStepCount(sessionId, home);
    if (c !== null) return { steps: c, stepSource: 'agy_db' };
  }
  if (agent === 'codex') {
    const jsonSteps = countCodexStdoutSteps(stdout);
    if (jsonSteps > 0) {
      return { steps: Number(prevRow?.steps || 0) + jsonSteps, stepSource: 'codex_stdout' };
    }
    const fileSteps = countCodexJsonlSteps(sessionId, home);
    if (fileSteps !== null) return { steps: fileSteps, stepSource: 'codex_jsonl' };
  }
  const base = Number(prevRow?.steps || 0);
  return { steps: base + ESTIMATED_STEPS_PER_USE, stepSource: 'fallback_uses' };
}

export function rotateThreadWithSnapshot(bus, { threadName, taskId, agent, cwd, model = null, reason, prevRow = null }) {
  const oldSession = prevRow?.session_id || null;
  let ref = null;
  if (!contextLedgerDisabled()) {
    const doc = loadContextLedger(bus, threadName, { cwd, model })
      || initContextLedger(threadName, { cwd, model });
    doc.cwd = String(cwd || doc.cwd || process.cwd()).slice(0, 300);
    if (model !== undefined) doc.model = model ? String(model).slice(0, 80) : null;
    if (oldSession) {
      doc.rotated_from = {
        session_id: String(oldSession).slice(0, 128),
        reason: String(reason || 'rotated').slice(0, 64),
        at: new Date().toISOString(),
      };
    }
    ref = saveAndRegisterContext(bus, threadName, doc);
  }
  withImmediateTx(bus.db, () => {
    appendEvent(bus.db, taskId || null, 'thread_rotated', {
      agent,
      thread: threadName,
      reason,
      old_session: oldSession,
    });
  });
  return ref;
}
