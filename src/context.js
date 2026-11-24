// agentbus/context@1: Bounded (<=8KB) cross-task thread ledger with proposer/verifier gate.
// Zero third-party dependencies. Never inlines raw payload into task envelopes.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { withImmediateTx, appendEvent } from './db.js';
import { registerArtifact, getArtifact } from './store.js';

export const CONTEXT_SCHEMA = 'agentbus/context@1';
export const CONTEXT_MAX_BYTES = 8192;
export const CONTEXT_REF_NAME = 'thread_context.json';

export function contextLedgerDisabled() {
  return process.env.AGENTBUS_DISABLE_CONTEXT_LEDGER === '1';
}

export function contextLedgerPath(busRoot, threadName) {
  const safe = String(threadName || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
  return path.join(busRoot, 'contexts', `${safe}.json`);
}

function atomicWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeEnvelopeMirrorFromRow(bus, row) {
  const refs = JSON.parse(row.refs_json || '[]').map((r) => {
    const clean = { name: r.name, uri: r.uri, sha256: r.sha256, bytes: r.bytes };
    if (r.note !== undefined && r.note !== '') clean.note = r.note;
    return clean;
  });
  const env = {
    schema: row.schema || 'agentbus/task@1',
    id: row.id,
    created_at: row.created_at,
    from: row.from_agent,
    to: row.to_agent,
    state: row.state,
    goal: row.goal,
    constraints: JSON.parse(row.constraints_json || '[]'),
    refs,
    acceptance: JSON.parse(row.acceptance_json || '{}'),
    claimed_by: row.claimed_by,
    lease_expires_at: row.lease_expires_at,
    attempt: row.attempt,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    finished_at: row.finished_at,
    history: JSON.parse(row.history_json || '[]'),
  };
  if (row.idempotency_key) env.idempotency_key = row.idempotency_key;
  atomicWriteJson(path.join(bus.config.tasksDir, `${row.id}.json`), env);
}

export function initContextLedger(threadName, { cwd = process.cwd(), model = null } = {}) {
  return {
    schema: CONTEXT_SCHEMA,
    thread: String(threadName).slice(0, 120),
    rev: 0,
    cwd: String(cwd || process.cwd()).slice(0, 300),
    model: model ? String(model).slice(0, 80) : null,
    updated_at: new Date().toISOString(),
    rotated_from: null,
    contract_refs: [],
    decisions: [],
    latest_artifacts: [],
    avoid: [],
  };
}

export function loadContextLedger(bus, threadName, defaults = {}) {
  const filePath = contextLedgerPath(bus.config.rootDir, threadName);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const doc = JSON.parse(raw);
  if (!doc || doc.schema !== CONTEXT_SCHEMA) {
    throw Object.assign(new Error(`非法 context@1 账本格式: ${path.basename(filePath)}`), { code: 1 });
  }
  if (defaults.cwd && !doc.cwd) doc.cwd = String(defaults.cwd).slice(0, 300);
  if (defaults.model !== undefined && doc.model === undefined) doc.model = defaults.model || null;
  doc.contract_refs = Array.isArray(doc.contract_refs) ? doc.contract_refs : [];
  doc.decisions = Array.isArray(doc.decisions) ? doc.decisions : [];
  doc.latest_artifacts = Array.isArray(doc.latest_artifacts) ? doc.latest_artifacts : [];
  doc.avoid = Array.isArray(doc.avoid) ? doc.avoid : [];
  return doc;
}

function dedupeByRoleKeepLatest(items) {
  const map = new Map();
  for (const item of items || []) {
    if (!item || !item.role) continue;
    if (map.has(item.role)) map.delete(item.role);
    map.set(item.role, item);
  }
  return Array.from(map.values());
}

function dedupeContractRefs(items) {
  const map = new Map();
  for (const item of items || []) {
    if (!item || !item.sha256) continue;
    const key = item.name || item.sha256;
    if (map.has(key)) map.delete(key);
    map.set(key, {
      name: String(item.name || '').slice(0, 120),
      uri: String(item.uri || '').slice(0, 300),
      sha256: String(item.sha256).toLowerCase(),
    });
  }
  return Array.from(map.values());
}

export function compactContextLedger(doc, maxBytes = CONTEXT_MAX_BYTES) {
  const out = {
    schema: CONTEXT_SCHEMA,
    thread: String(doc.thread || '').slice(0, 120),
    rev: Math.max(1, Number(doc.rev || 1)),
    cwd: String(doc.cwd || process.cwd()).slice(0, 300),
    model: doc.model ? String(doc.model).slice(0, 80) : null,
    updated_at: doc.updated_at || new Date().toISOString(),
    rotated_from: doc.rotated_from || null,
    contract_refs: dedupeContractRefs(doc.contract_refs).slice(-8),
    decisions: structuredClone(Array.isArray(doc.decisions) ? doc.decisions : []),
    latest_artifacts: dedupeByRoleKeepLatest(structuredClone(Array.isArray(doc.latest_artifacts) ? doc.latest_artifacts : [])).slice(-8),
    avoid: structuredClone(Array.isArray(doc.avoid) ? doc.avoid : []).slice(-5),
  };

  // A supersede only takes effect once the replacement is *confirmed*: an
  // unconfirmed worker proposal must never erase a confirmed decision.
  const supersededIds = new Set(
    out.decisions.filter((d) => d && d.status === 'confirmed').map((d) => d.supersedes).filter(Boolean)
  );
  out.decisions = out.decisions.filter((d) => d && !supersededIds.has(d.id) && d.status !== 'superseded');
  out.decisions = out.decisions.slice(-12);

  const size = () => Buffer.byteLength(JSON.stringify(out, null, 2) + '\n', 'utf8');
  while (size() > maxBytes && out.avoid.length > 1) out.avoid.shift();
  while (size() > maxBytes && out.latest_artifacts.length > 1) out.latest_artifacts.shift();
  if (size() > maxBytes) {
    for (const d of out.decisions) d.statement = String(d.statement || '').slice(0, 120);
    for (const a of out.latest_artifacts) if (a.summary) a.summary = String(a.summary).slice(0, 80);
    for (const v of out.avoid) v.reason = String(v.reason || '').slice(0, 100);
  }
  while (size() > maxBytes) {
    const idx = out.decisions.findIndex((d) => !d.pinned);
    if (idx < 0) break;
    out.decisions.splice(idx, 1);
  }
  while (size() > maxBytes && out.contract_refs.length > 1) out.contract_refs.shift();
  if (size() > maxBytes) {
    throw Object.assign(new Error('context@1 裁剪后仍超 8KB'), { code: 1 });
  }
  return out;
}

function validateDecisionIntegrity(bus, decision, existingDecisions) {
  if (decision.evidence_sha256) {
    if (!getArtifact(bus, decision.evidence_sha256)) {
      throw Object.assign(new Error(`决策证据 sha256 未在 artifacts 登记: ${decision.evidence_sha256}`), { code: 1 });
    }
  }
  if (decision.supersedes) {
    if (decision.supersedes === decision.id) {
      throw Object.assign(new Error(`决策 supersedes 不能指向自身: ${decision.id}`), { code: 1 });
    }
    const targetExists = existingDecisions.some((d) => d.id === decision.supersedes);
    if (!targetExists) {
      throw Object.assign(new Error(`决策 supersedes 目标不存在: ${decision.supersedes}`), { code: 1 });
    }
  }
}

export function saveAndRegisterContext(bus, threadName, doc) {
  const nextDoc = structuredClone(doc);
  nextDoc.schema = CONTEXT_SCHEMA;
  nextDoc.thread = String(threadName).slice(0, 120);
  nextDoc.rev = Math.max(1, Number(nextDoc.rev || 0) + 1);
  nextDoc.updated_at = new Date().toISOString();

  const compacted = compactContextLedger(nextDoc, CONTEXT_MAX_BYTES);
  const filePath = contextLedgerPath(bus.config.rootDir, threadName);
  atomicWriteJson(filePath, compacted);

  const art = registerArtifact(bus, { filePath, name: CONTEXT_REF_NAME, by: 'system' });
  return {
    name: CONTEXT_REF_NAME,
    uri: art.uri,
    sha256: art.sha256,
    bytes: art.bytes,
    rev: compacted.rev,
  };
}

export function getExistingContextRef(bus, threadName) {
  if (contextLedgerDisabled() || !threadName) return null;
  const doc = loadContextLedger(bus, threadName);
  if (!doc) return null;
  const filePath = contextLedgerPath(bus.config.rootDir, threadName);
  const art = registerArtifact(bus, { filePath, name: CONTEXT_REF_NAME, by: 'system' });
  return {
    name: CONTEXT_REF_NAME,
    uri: art.uri,
    sha256: art.sha256,
    bytes: art.bytes,
    rev: Number(doc.rev || 1),
  };
}

function extractProposedDecisions(resultPath) {
  if (!resultPath || !fs.existsSync(resultPath)) return [];
  try {
    const raw = fs.readFileSync(resultPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.proposed_decisions)) return [];
    return parsed.proposed_decisions;
  } catch {
    return [];
  }
}

export function recordContextOutcome(bus, threadName, { task, status, result = null, resultPath = null, reason = '', actor = 'system', cwd = null, model = null }) {
  if (contextLedgerDisabled() || !threadName) return null;
  const doc = loadContextLedger(bus, threadName, { cwd: cwd || process.cwd(), model })
    || initContextLedger(threadName, { cwd: cwd || process.cwd(), model });

  const now = new Date().toISOString();
  if (cwd) doc.cwd = String(cwd).slice(0, 300);
  if (model !== undefined && model !== null) doc.model = String(model).slice(0, 80);

  if (status === 'failed') {
    const alreadyAvoided = doc.avoid.some((a) => a.task_id === task.id);
    if (alreadyAvoided) return getExistingContextRef(bus, threadName);
    doc.avoid.push({
      task_id: String(task.id).slice(0, 40),
      reason: String(reason || 'failed').slice(0, 200),
      at: now,
    });
    return saveAndRegisterContext(bus, threadName, doc);
  }

  if (status === 'done') {
    const resSha = result?.sha256 ? String(result.sha256).toLowerCase() : null;
    const alreadyRecorded = doc.latest_artifacts.some((a) => a.task_id === task.id && (!resSha || a.sha256 === resSha));
    if (alreadyRecorded) return getExistingContextRef(bus, threadName);

    const taskRefs = Array.isArray(task.refs) ? task.refs : [];
    for (const r of taskRefs) {
      if (r.name === CONTEXT_REF_NAME) continue;
      if (r.sha256 && r.uri) {
        doc.contract_refs.push({
          name: String(r.name || '').slice(0, 120),
          uri: String(r.uri || '').slice(0, 300),
          sha256: String(r.sha256).toLowerCase(),
        });
      }
    }

    if (result && resSha) {
      if (!getArtifact(bus, resSha)) {
        // Result files may not be in artifacts table yet; register if local path exists
        if (resultPath && fs.existsSync(resultPath)) {
          registerArtifact(bus, { filePath: resultPath, name: path.basename(resultPath), by: actor || 'system' });
        }
      }
      doc.latest_artifacts.push({
        role: 'result',
        uri: String(result.uri || '').slice(0, 300),
        sha256: resSha,
        task_id: String(task.id).slice(0, 40),
        summary: String(task.goal || '').slice(0, 160),
        at: now,
      });
    }

    const proposals = extractProposedDecisions(resultPath);
    const proposer = String(task.claimed_by || task.to || actor || 'worker').slice(0, 40);
    for (const prop of proposals) {
      if (!prop || typeof prop.statement !== 'string' || !prop.statement.trim()) continue;
      const decId = String(prop.id || `d${Date.now().toString(36)}${randomBytes(2).toString('hex')}`).slice(0, 32);
      const entry = {
        id: decId,
        statement: prop.statement.trim().slice(0, 240),
        supersedes: prop.supersedes ? String(prop.supersedes).slice(0, 32) : null,
        status: 'proposed',
        proposed_by: proposer,
        confirmed_by: null,
        confirmed_at: null,
        evidence_sha256: prop.evidence_sha256 ? String(prop.evidence_sha256).toLowerCase() : null,
        task_id: String(task.id).slice(0, 40),
        pinned: prop.pinned === true,
        at: now,
      };
      validateDecisionIntegrity(bus, entry, doc.decisions);
      doc.decisions.push(entry);
    }

    return saveAndRegisterContext(bus, threadName, doc);
  }

  return null;
}

export function proposeDecision(bus, threadName, { id = null, statement, supersedes = null, proposedBy, evidenceSha256 = null, taskId = 'manual', pinned = false, cwd = null }) {
  if (!statement || !String(statement).trim()) {
    throw Object.assign(new Error('决策 statement 不能为空'), { code: 1 });
  }
  if (!proposedBy || !String(proposedBy).trim()) {
    throw Object.assign(new Error('缺少 proposedBy'), { code: 1 });
  }
  const doc = loadContextLedger(bus, threadName, { cwd: cwd || process.cwd() })
    || initContextLedger(threadName, { cwd: cwd || process.cwd() });
  const decId = String(id || `d${Date.now().toString(36)}${randomBytes(2).toString('hex')}`).slice(0, 32);
  const entry = {
    id: decId,
    statement: String(statement).trim().slice(0, 240),
    supersedes: supersedes ? String(supersedes).slice(0, 32) : null,
    status: 'proposed',
    proposed_by: String(proposedBy).trim().slice(0, 40),
    confirmed_by: null,
    confirmed_at: null,
    evidence_sha256: evidenceSha256 ? String(evidenceSha256).toLowerCase() : null,
    task_id: String(taskId).slice(0, 40),
    pinned: Boolean(pinned),
    at: new Date().toISOString(),
  };
  validateDecisionIntegrity(bus, entry, doc.decisions);
  doc.decisions.push(entry);
  const ref = saveAndRegisterContext(bus, threadName, doc);
  return { ...ref, decision_id: decId };
}

export function confirmDecision(bus, threadName, decisionId, { confirmedBy, evidenceSha256 = null }) {
  const doc = loadContextLedger(bus, threadName);
  if (!doc) {
    throw Object.assign(new Error(`找不到线程账本: ${threadName}`), { code: 1 });
  }
  const target = doc.decisions.find((d) => d.id === decisionId);
  if (!target) {
    throw Object.assign(new Error(`未找到决策 ${decisionId}`), { code: 1 });
  }
  if (!confirmedBy || String(confirmedBy).trim() === target.proposed_by) {
    throw Object.assign(new Error('双人确认失败：confirmed_by 不能与 proposed_by 相同'), { code: 1 });
  }
  if (evidenceSha256 && !getArtifact(bus, evidenceSha256)) {
    throw Object.assign(new Error(`证据 sha256 未在 artifacts 登记: ${evidenceSha256}`), { code: 1 });
  }
  target.status = 'confirmed';
  target.confirmed_by = String(confirmedBy).trim().slice(0, 40);
  target.confirmed_at = new Date().toISOString();
  if (evidenceSha256) target.evidence_sha256 = String(evidenceSha256).toLowerCase();
  if (target.supersedes) {
    const old = doc.decisions.find((d) => d.id === target.supersedes);
    if (old) old.status = 'superseded';
  }
  return saveAndRegisterContext(bus, threadName, doc);
}

export function attachContextRefIfOpen(bus, taskId, ctxRef) {
  if (contextLedgerDisabled() || !ctxRef || !ctxRef.sha256) return false;
  return withImmediateTx(bus.db, () => {
    const row = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!row || row.state !== 'open') return false;
    const refs = JSON.parse(row.refs_json || '[]');
    const note = `context@1 rev=${ctxRef.rev || 1}`;
    const idx = refs.findIndex((r) => r.name === CONTEXT_REF_NAME);
    if (idx >= 0) {
      if (refs[idx].sha256 === ctxRef.sha256) return false;
      refs[idx] = { name: CONTEXT_REF_NAME, uri: ctxRef.uri, sha256: ctxRef.sha256, bytes: ctxRef.bytes, note };
    } else {
      refs.push({ name: CONTEXT_REF_NAME, uri: ctxRef.uri, sha256: ctxRef.sha256, bytes: ctxRef.bytes, note });
    }
    bus.db.prepare('UPDATE tasks SET refs_json = ? WHERE id = ?').run(JSON.stringify(refs), row.id);
    const updated = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    if (updated) writeEnvelopeMirrorFromRow(bus, updated);
    return true;
  });
}
