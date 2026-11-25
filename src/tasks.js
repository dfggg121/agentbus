// agentbus: Task state machine, lease management, idempotency, acceptance verification, and ref reading
// Zero third-party dependencies. Compatible with proto/bus.mjs agentbus/task@1 envelopes.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { withImmediateTx, appendEvent } from './db.js';
import { getArtifact, resolveAndValidatePath, sha256File, verifyRefIntegrity, guessMime } from './store.js';
import { clearTaskThreadByName } from './threads.js';
import { contextLedgerDisabled, getExistingContextRef, recordContextOutcome, CONTEXT_REF_NAME } from './context.js';

function nowIso() {
  return new Date().toISOString();
}

function atomicWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function cleanRefs(refsJson) {
  return JSON.parse(refsJson || '[]').map((r) => {
    const clean = { name: r.name, uri: r.uri, sha256: r.sha256, bytes: r.bytes };
    if (r.note !== undefined && r.note !== '') clean.note = r.note;
    return clean;
  });
}

function summarizeMessage(m) {
  if (!m) return null;
  const text = String(m.body || '');
  return {
    seq: Number(m.seq),
    from: m.from_agent,
    to: m.to_agent || null,
    kind: m.kind,
    body: text.length > 160 ? `${text.slice(0, 157)}...` : text,
    created_at: m.created_at,
  };
}

function rowToEnvelope(row) {
  const refs = cleanRefs(row.refs_json);
  const env = {
    schema: row.schema || 'agentbus/task@1',
    id: row.id,
    created_at: row.created_at,
    from: row.from_agent,
    to: row.to_agent,
    state: row.state,
    goal: row.goal,
    constraints: JSON.parse(row.constraints_json),
    refs,
    acceptance: JSON.parse(row.acceptance_json),
    claimed_by: row.claimed_by,
    lease_expires_at: row.lease_expires_at,
    attempt: row.attempt,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    finished_at: row.finished_at,
    history: JSON.parse(row.history_json),
  };
  if (row.idempotency_key) env.idempotency_key = row.idempotency_key;
  if (row.blocked_at) env.blocked_at = row.blocked_at;
  if (row.last_message_at) env.last_message_at = row.last_message_at;
  return env;
}

function writeEnvelopeMirror(bus, row) {
  const envPath = path.join(bus.config.tasksDir, `${row.id}.json`);
  // Never store lease_token or any file content in the task envelope JSON
  atomicWriteJson(envPath, rowToEnvelope(row));
  return envPath;
}

/**
 * Import any prototype agentbus/task@1 JSON files placed into <root>/tasks/ or <root>/
 * so legacy envelopes (e.g. proto/bus.mjs tasks/tmwszbfbh8d2f.json) work seamlessly.
 */
export function syncLegacyTaskFiles(bus) {
  const scanDirs = [bus.config.tasksDir, bus.config.rootDir];
  const seen = new Set();

  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'config.json');
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      if (seen.has(full)) continue;
      seen.add(full);
      let parsed;
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.size > 512 * 1024) continue;
        parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        continue;
      }
      if (!parsed || parsed.schema !== 'agentbus/task@1' || !parsed.id) continue;

      const existing = bus.db.prepare('SELECT id FROM tasks WHERE id = ?').get(parsed.id);
      if (existing) continue;

      withImmediateTx(bus.db, () => {
        const check = bus.db.prepare('SELECT id FROM tasks WHERE id = ?').get(parsed.id);
        if (check) return;
        const fromAgent = parsed.from || parsed.from_agent || 'unknown';
        const toAgent = parsed.to || parsed.to_agent || '*';
        const refs = Array.isArray(parsed.refs) ? parsed.refs.map((r) => {
          const item = { name: r.name, uri: r.uri, sha256: String(r.sha256 || '').toLowerCase(), bytes: Number(r.bytes || 0) };
          if (r.note !== undefined && r.note !== '') item.note = r.note;
          return item;
        }) : [];

        bus.db.prepare(
          `INSERT INTO tasks (
            id, schema, from_agent, to_agent, state, goal,
            constraints_json, refs_json, acceptance_json,
            claimed_by, lease_token, lease_expires_at, attempt,
            idempotency_key, created_at, finished_at, result_json, history_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          parsed.id,
          parsed.schema,
          fromAgent,
          toAgent,
          parsed.state || 'open',
          parsed.goal || '',
          JSON.stringify(Array.isArray(parsed.constraints) ? parsed.constraints : []),
          JSON.stringify(refs),
          JSON.stringify(parsed.acceptance && typeof parsed.acceptance === 'object' ? parsed.acceptance : {}),
          parsed.claimed_by || null,
          null,
          parsed.lease_expires_at || null,
          Number(parsed.attempt || 0),
          parsed.idempotency_key || null,
          parsed.created_at || nowIso(),
          parsed.finished_at || null,
          parsed.result ? JSON.stringify(parsed.result) : null,
          JSON.stringify(Array.isArray(parsed.history) ? parsed.history : [])
        );
        appendEvent(bus.db, parsed.id, 'import_legacy', { source: path.basename(full), state: parsed.state });
      });
    }
  }
}

/**
 * Expire all claimed tasks whose lease_expires_at <= now.
 * Increments attempt; if attempt > maxAttempts, transitions to failed (reason=lease_expired), else back to open.
 */
export function reapExpiredLeases(bus) {
  const now = nowIso();
  const expiredRows = bus.db.prepare(
    `SELECT * FROM tasks WHERE state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
  ).all(now);
  if (expiredRows.length === 0) return 0;

  const failedWithThreads = [];
  const count = withImmediateTx(bus.db, () => {
    const freshExpired = bus.db.prepare(
      `SELECT * FROM tasks WHERE state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
    ).all(now);

    for (const row of freshExpired) {
      const nextAttempt = Number(row.attempt || 0) + 1;
      const exceeded = nextAttempt > bus.config.maxAttempts;
      const nextState = exceeded ? 'failed' : 'open';
      const history = JSON.parse(row.history_json || '[]');
      history.push({ at: now, state: nextState, by: 'system', reason: 'lease_expired' });
      const msgBody = `lease_expired: previous_claimed_by=${row.claimed_by || 'unknown'} attempt=${nextAttempt} next_state=${nextState}`;

      bus.db.prepare(
        `UPDATE tasks
         SET state = ?, claimed_by = NULL, lease_token = NULL, lease_expires_at = NULL,
             blocked_at = NULL, last_message_at = ?, attempt = ?, finished_at = ?, history_json = ?
         WHERE id = ? AND state = 'claimed'`
      ).run(
        nextState,
        now,
        nextAttempt,
        exceeded ? now : null,
        JSON.stringify(history),
        row.id
      );

      const msgInfo = bus.db.prepare(
        'INSERT INTO task_messages (task_id, from_agent, to_agent, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(row.id, 'system', row.from_agent || null, 'error', msgBody, now);
      appendEvent(bus.db, row.id, 'message', {
        seq: Number(msgInfo.lastInsertRowid),
        from: 'system',
        to: row.from_agent || null,
        kind: 'error',
        body: msgBody.slice(0, 240),
      });

      appendEvent(bus.db, row.id, 'lease_expired', {
        previous_claimed_by: row.claimed_by,
        attempt: nextAttempt,
        next_state: nextState,
      });

      if (exceeded) {
        clearTaskThreadByName(bus.db, `task:${row.id}`);
      }

      const updated = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
      if (updated) {
        writeEnvelopeMirror(bus, updated);
        if (exceeded && updated.thread_name) {
          failedWithThreads.push({ threadName: updated.thread_name, envelope: rowToEnvelope(updated) });
        }
      }
    }
    return freshExpired.length;
  });

  if (!contextLedgerDisabled()) {
    for (const item of failedWithThreads) {
      try {
        recordContextOutcome(bus, item.threadName, {
          task: item.envelope,
          status: 'failed',
          reason: 'lease_expired',
          actor: 'system',
        });
      } catch {}
    }
  }
  return count;
}

function findTaskRowByIdOrPrefix(bus, idOrPrefix) {
  if (!idOrPrefix || typeof idOrPrefix !== 'string') {
    throw Object.assign(new Error('缺少任务 id'), { code: 1 });
  }
  const exact = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(idOrPrefix);
  if (exact) return exact;

  const hits = bus.db.prepare('SELECT * FROM tasks WHERE id LIKE ? LIMIT 5').all(`${idOrPrefix}%`);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw Object.assign(new Error(`task id 前缀不唯一: ${idOrPrefix} -> ${hits.map((h) => h.id).join(', ')}`), { code: 1 });
  }
  throw Object.assign(new Error(`找不到任务: ${idOrPrefix}`), { code: 1 });
}

function normalizeRefInputs(bus, refsInput) {
  if (!Array.isArray(refsInput)) {
    throw Object.assign(new Error('refs 必须是数组'), { code: 1 });
  }
  const out = [];
  for (const item of refsInput) {
    let rawSha;
    let note;
    if (typeof item === 'string') {
      // Check if user passed an absolute/URI path directly (must enforce allowed_roots or require sha256)
      const isShaWithOptionalNote = /^[0-9a-f]{64}(?::[\s\S]*)?$/i.test(item);
      if (!isShaWithOptionalNote) {
        // Reject paths outside allowed_roots or non-sha refs with exit code 1
        if (path.isAbsolute(item) || /^file:\/\//i.test(item) || /^https?:\/\//i.test(item) || /^(\\\\|\/\/)/.test(item)) {
          resolveAndValidatePath(item, bus.config, { checkSize: true });
        }
        throw Object.assign(new Error(`--ref 必须是已登记的 64 位 sha256（先用 put 登记）: ${item.slice(0, 80)}`), { code: 1 });
      }
      const colonIdx = item.indexOf(':');
      rawSha = colonIdx >= 0 ? item.slice(0, colonIdx) : item;
      note = colonIdx >= 0 ? item.slice(colonIdx + 1) : undefined;
    } else if (item && typeof item === 'object') {
      rawSha = String(item.sha256 || '');
      note = item.note;
    } else {
      throw Object.assign(new Error('无效的 ref 项'), { code: 1 });
    }

    if (!/^[0-9a-f]{64}$/i.test(rawSha)) {
      throw Object.assign(new Error(`--ref 必须是合法 64 位 sha256: ${rawSha.slice(0, 64)}`), { code: 1 });
    }
    const art = getArtifact(bus, rawSha.toLowerCase());
    if (!art) {
      throw Object.assign(new Error(`未登记的 sha256，请先 put 登记: ${rawSha.slice(0, 16)}...`), { code: 1 });
    }
    // Re-validate artifact path still sits inside allowed_roots
    resolveAndValidatePath(art.uri, bus.config, { checkSize: true });

    const entry = {
      name: art.name,
      uri: art.uri,
      sha256: art.sha256,
      bytes: art.bytes,
    };
    if (note !== undefined && note !== '') entry.note = String(note);
    out.push(entry);
  }
  return out;
}

export function createTask(bus, {
  to,
  goal,
  refs = [],
  constraints = [],
  acceptance = {},
  from = 'unknown',
  idempotency_key = null,
  thread = null,
}) {
  if (!to || typeof to !== 'string' || !to.trim()) {
    throw Object.assign(new Error('缺少必填参数 --to <agent>'), { code: 1 });
  }
  if (!goal || typeof goal !== 'string' || !goal.trim()) {
    throw Object.assign(new Error('缺少必填参数 --goal "..."'), { code: 1 });
  }

  const fromAgent = String(from || 'unknown').trim();
  const toAgent = to.trim();
  const idemKey = idempotency_key ? String(idempotency_key).trim() : null;
  const threadName = thread && String(thread).trim() ? String(thread).trim() : null;
  const resolvedRefs = normalizeRefInputs(bus, refs);
  const cleanConstraints = Array.isArray(constraints) ? constraints.map(String) : constraints ? [String(constraints)] : [];
  const cleanAcceptance = acceptance && typeof acceptance === 'object' ? acceptance : {};

  if (threadName && !contextLedgerDisabled() && !resolvedRefs.some((r) => r.name === CONTEXT_REF_NAME)) {
    const ctxRef = getExistingContextRef(bus, threadName);
    if (ctxRef) {
      resolvedRefs.push({
        name: CONTEXT_REF_NAME,
        uri: ctxRef.uri,
        sha256: ctxRef.sha256,
        bytes: ctxRef.bytes,
        note: `context@1 rev=${ctxRef.rev}`,
      });
    }
  }

  return withImmediateTx(bus.db, () => {
    if (idemKey) {
      const dup = bus.db.prepare(
        'SELECT * FROM tasks WHERE from_agent = ? AND idempotency_key = ?'
      ).get(fromAgent, idemKey);
      if (dup) {
        const envPath = path.join(bus.config.tasksDir, `${dup.id}.json`);
        if (!fs.existsSync(envPath)) writeEnvelopeMirror(bus, dup);
        return {
          id: dup.id,
          uri: pathToFileURL(envPath).href,
          state: dup.state,
          dedup: true,
        };
      }
    }

    const id = `t${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    const createdAt = nowIso();
    const history = [{ at: createdAt, state: 'open', by: fromAgent }];

    bus.db.prepare(
      `INSERT INTO tasks (
        id, schema, from_agent, to_agent, state, goal,
        constraints_json, refs_json, acceptance_json,
        claimed_by, lease_token, lease_expires_at, attempt,
        idempotency_key, created_at, finished_at, result_json, history_json, thread_name
      ) VALUES (?, 'agentbus/task@1', ?, ?, 'open', ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, NULL, NULL, ?, ?)`
    ).run(
      id,
      fromAgent,
      toAgent,
      goal.trim(),
      JSON.stringify(cleanConstraints),
      JSON.stringify(resolvedRefs),
      JSON.stringify(cleanAcceptance),
      idemKey,
      createdAt,
      JSON.stringify(history),
      threadName
    );

    appendEvent(bus.db, id, 'task_create', { from: fromAgent, to: toAgent, refs_count: resolvedRefs.length, idempotency_key: idemKey });

    const row = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    const envPath = writeEnvelopeMirror(bus, row);

    return {
      id,
      uri: pathToFileURL(envPath).href,
      state: 'open',
      dedup: false,
    };
  });
}

export function showTask(bus, idOrPrefix) {
  syncLegacyTaskFiles(bus);
  reapExpiredLeases(bus);
  const row = findTaskRowByIdOrPrefix(bus, idOrPrefix);
  const env = rowToEnvelope(row);
  const lastRow = bus.db.prepare(
    'SELECT seq, task_id, from_agent, to_agent, kind, body, created_at FROM task_messages WHERE task_id = ? ORDER BY seq DESC LIMIT 1'
  ).get(row.id);
  env.blocked = Boolean(row.blocked_at);
  env.blocked_at = row.blocked_at || null;
  env.last_message_at = row.last_message_at || null;
  env.last_message = summarizeMessage(lastRow);
  // Guarantee no `content` field and refs have only name/uri/sha256/bytes(+optional note)
  return env;
}

export function listTasks(bus, { state = null, to = null, limit = 50 } = {}) {
  syncLegacyTaskFiles(bus);
  reapExpiredLeases(bus);
  const effLimit = Math.max(1, Math.min(500, Number(limit) || 50));

  const conds = [];
  const params = [];
  if (state) {
    conds.push('state = ?');
    params.push(String(state));
  }
  if (to) {
    conds.push('(to_agent = ? OR to_agent = \'*\')');
    params.push(String(to));
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(effLimit);

  const rows = bus.db.prepare(
    `SELECT id, to_agent, state, goal, refs_json, attempt, claimed_by, lease_expires_at, created_at, finished_at, blocked_at, last_message_at
     FROM tasks ${where}
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(...params);

  const msgIds = rows.filter((r) => r.last_message_at).map((r) => r.id);
  const lastMsgByTask = new Map();
  if (msgIds.length > 0) {
    const placeholders = msgIds.map(() => '?').join(',');
    const latestMsgs = bus.db.prepare(
      `SELECT tm.seq, tm.task_id, tm.from_agent, tm.to_agent, tm.kind, tm.body, tm.created_at
       FROM task_messages tm
       JOIN (
         SELECT task_id, MAX(seq) AS max_seq
         FROM task_messages
         WHERE task_id IN (${placeholders})
         GROUP BY task_id
       ) latest ON tm.task_id = latest.task_id AND tm.seq = latest.max_seq`
    ).all(...msgIds);
    for (const m of latestMsgs) {
      lastMsgByTask.set(m.task_id, summarizeMessage(m));
    }
  }

  return rows.map((r) => ({
    id: r.id,
    to: r.to_agent,
    state: r.state,
    goal: r.goal,
    refs_count: JSON.parse(r.refs_json || '[]').length,
    attempt: r.attempt,
    claimed_by: r.claimed_by,
    lease_expires_at: r.lease_expires_at,
    created_at: r.created_at,
    blocked: Boolean(r.blocked_at),
    blocked_at: r.blocked_at || null,
    last_message_at: r.last_message_at || null,
    last_message: lastMsgByTask.get(r.id) || null,
  }));
}

export function claimTask(bus, { id, by, ttl_s = null }) {
  if (!by || typeof by !== 'string' || !by.trim()) {
    throw Object.assign(new Error('缺少必填参数 --by <agent>'), { code: 1 });
  }
  const agent = by.trim();
  const ttl = Number(ttl_s ?? bus.config.leaseTtlS);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw Object.assign(new Error('ttl_s 必须是正数'), { code: 1 });
  }

  syncLegacyTaskFiles(bus);
  reapExpiredLeases(bus);

  return withImmediateTx(bus.db, () => {
    const row = findTaskRowByIdOrPrefix(bus, id);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    // Re-check lease expiration inside same IMMEDIATE transaction
    let state = row.state;
    let attempt = Number(row.attempt || 0);
    const history = JSON.parse(row.history_json || '[]');

    if (state === 'claimed' && row.lease_expires_at && row.lease_expires_at <= now) {
      attempt += 1;
      const prevClaimedBy = row.claimed_by || 'unknown';
      if (attempt > bus.config.maxAttempts) {
        history.push({ at: now, state: 'failed', by: 'system', reason: 'lease_expired' });
        const msgBody = `lease_expired: previous_claimed_by=${prevClaimedBy} attempt=${attempt} next_state=failed`;
        bus.db.prepare(
          `UPDATE tasks SET state='failed', claimed_by=NULL, lease_token=NULL, lease_expires_at=NULL,
           blocked_at=NULL, last_message_at=?, attempt=?, finished_at=?, history_json=? WHERE id=?`
        ).run(now, attempt, now, JSON.stringify(history), row.id);
        const msgInfo = bus.db.prepare(
          'INSERT INTO task_messages (task_id, from_agent, to_agent, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(row.id, 'system', row.from_agent || null, 'error', msgBody, now);
        appendEvent(bus.db, row.id, 'message', {
          seq: Number(msgInfo.lastInsertRowid),
          from: 'system',
          to: row.from_agent || null,
          kind: 'error',
          body: msgBody.slice(0, 240),
        });
        appendEvent(bus.db, row.id, 'lease_expired', { previous_claimed_by: prevClaimedBy, attempt, next_state: 'failed' });
        clearTaskThreadByName(bus.db, `task:${row.id}`);
        const upd = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
        writeEnvelopeMirror(bus, upd);
        throw Object.assign(new Error(`任务已因租约过期超过最大重试次数进入 failed`), { code: 2 });
      }
      state = 'open';
      const msgBody = `lease_expired: previous_claimed_by=${prevClaimedBy} attempt=${attempt} next_state=open`;
      history.push({ at: now, state: 'open', by: 'system', reason: 'lease_expired' });
      bus.db.prepare(
        `UPDATE tasks SET state='open', claimed_by=NULL, lease_token=NULL, lease_expires_at=NULL,
         blocked_at=NULL, last_message_at=?, attempt=?, history_json=? WHERE id=?`
      ).run(now, attempt, JSON.stringify(history), row.id);
      const msgInfo = bus.db.prepare(
        'INSERT INTO task_messages (task_id, from_agent, to_agent, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(row.id, 'system', row.from_agent || null, 'error', msgBody, now);
      appendEvent(bus.db, row.id, 'message', {
        seq: Number(msgInfo.lastInsertRowid),
        from: 'system',
        to: row.from_agent || null,
        kind: 'error',
        body: msgBody.slice(0, 240),
      });
      appendEvent(bus.db, row.id, 'lease_expired', { previous_claimed_by: prevClaimedBy, attempt, next_state: 'open' });
    }

    if (state !== 'open') {
      throw Object.assign(new Error(`状态为 ${state}，不能 claim`), { code: 2 });
    }
    if (row.to_agent !== agent && row.to_agent !== '*') {
      throw Object.assign(new Error(`任务指定给 ${row.to_agent}，${agent} 不能 claim`), { code: 2 });
    }

    const leaseToken = randomBytes(16).toString('hex');
    const expiresAt = new Date(nowMs + ttl * 1000).toISOString();
    history.push({ at: now, state: 'claimed', by: agent });

    bus.db.prepare(
      `UPDATE tasks
       SET state = 'claimed', claimed_by = ?, lease_token = ?, lease_expires_at = ?,
           attempt = ?, history_json = ?
       WHERE id = ?`
    ).run(agent, leaseToken, expiresAt, attempt, JSON.stringify(history), row.id);

    appendEvent(bus.db, row.id, 'claim', { by: agent, ttl_s: ttl, expires_at: expiresAt, attempt });

    const updated = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    writeEnvelopeMirror(bus, updated);

    const heartbeatIntervalS = Math.max(60, Math.min(300, Math.floor(ttl / 3)));
    return {
      ok: true,
      id: row.id,
      state: 'claimed',
      claimed_by: agent,
      lease_token: leaseToken,
      expires_at: expiresAt,
      lease_expires_at: expiresAt,
      heartbeat_hint: `每 ${heartbeatIntervalS} 秒调用一次 bus_task_heartbeat（当前租约 TTL=${ttl}s），否则租约过期会被回收`,
      attempt,
      from: row.from_agent,
      to: row.to_agent,
      created_at: row.created_at,
      goal: row.goal,
      constraints: JSON.parse(row.constraints_json || '[]'),
      refs: cleanRefs(row.refs_json),
      acceptance: JSON.parse(row.acceptance_json || '{}'),
      blocked_at: updated?.blocked_at || row.blocked_at || null,
      ...(row.thread_name ? { thread: row.thread_name } : {}),
    };
  });
}

export function heartbeatTask(bus, { id, by, lease_token, ttl_s = null }) {
  if (!by || !lease_token) {
    throw Object.assign(new Error('heartbeat 需要 --by 与 --lease'), { code: 1 });
  }
  const ttl = Number(ttl_s ?? bus.config.leaseTtlS);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw Object.assign(new Error('ttl_s 必须是正数'), { code: 1 });
  }

  reapExpiredLeases(bus);

  return withImmediateTx(bus.db, () => {
    const row = findTaskRowByIdOrPrefix(bus, id);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    if (row.state !== 'claimed' || !row.lease_expires_at || row.lease_expires_at <= now) {
      throw Object.assign(new Error(`任务未处于有效租约中 (state=${row.state})`), { code: 2 });
    }
    if (row.claimed_by !== by || row.lease_token !== lease_token) {
      throw Object.assign(new Error('租约 token 或领取者不匹配'), { code: 2 });
    }

    // Strictly extend lease_expires_at (never swap lease_token, always advance forward)
    const curExpMs = Date.parse(row.lease_expires_at);
    const nextExpMs = Math.max(nowMs + ttl * 1000, curExpMs + 1000);
    const expiresAt = new Date(nextExpMs).toISOString();

    bus.db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE id = ?').run(expiresAt, row.id);
    appendEvent(bus.db, row.id, 'heartbeat', { by, expires_at: expiresAt });

    const updated = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    writeEnvelopeMirror(bus, updated);

    return {
      ok: true,
      id: row.id,
      expires_at: expiresAt,
      lease_expires_at: expiresAt,
    };
  });
}

/**
 * Read a task reference with strict SHA-256 verification and 64KB pointer/resource_link semantics (§4.2).
 */
export function readTaskRef(bus, { id, name, max_bytes = null, encoding = null, by = null }) {
  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('缺少 --name <名>'), { code: 1 });
  }
  syncLegacyTaskFiles(bus);
  const row = findTaskRowByIdOrPrefix(bus, id);
  const refs = JSON.parse(row.refs_json || '[]');
  const ref = refs.find((r) => r.name === name);
  if (!ref) {
    throw Object.assign(new Error(`任务 ${row.id} 中找不到引用: ${name}`), { code: 1 });
  }

  const maxBytes = Number(max_bytes ?? bus.config.refReadInlineMax);
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw Object.assign(new Error('max_bytes 必须是非负整数'), { code: 1 });
  }

  // Validate path inside allowed_roots & recompute SHA-256 BEFORE returning anything (§4.2)
  const { fsPath, uri, stat } = resolveAndValidatePath(ref.uri, bus.config, { checkSize: false });
  const actualSha = sha256File(fsPath);
  if (actualSha !== ref.sha256) {
    throw Object.assign(
      new Error(`引用已漂移 (drift): ${ref.name} expected=${ref.sha256.slice(0, 12)} actual=${actualSha.slice(0, 12)}`),
      { code: 1 }
    );
  }

  const mimeType = guessMime(fsPath);
  const auditMode = stat.size > maxBytes ? 'resource_link' : 'inline_text';
  withImmediateTx(bus.db, () => {
    appendEvent(bus.db, row.id, 'ref_read', {
      name: ref.name,
      sha256: ref.sha256,
      bytes: stat.size,
      mode: auditMode,
      attempt: Number(row.attempt || 0),
      by: by || null,
    });
  });

  // Over inline threshold -> return ONLY resource_link, ZERO content bytes (§4.2)
  if (stat.size > maxBytes) {
    const noticeText = `文件 ${stat.size.toLocaleString('en-US')} B 超过内联上限，请按 uri 自取，校验 sha256=${ref.sha256}`;
    return {
      type: 'resource_link',
      uri,
      name: ref.name,
      mimeType,
      sha256: ref.sha256,
      bytes: stat.size,
      message: noticeText,
      content: [
        {
          type: 'resource_link',
          uri,
          name: ref.name,
          mimeType,
          size: stat.size,
          annotations: { priority: 0.3, audience: ['assistant'] },
        },
        {
          type: 'text',
          text: noticeText,
        },
      ],
      structuredContent: {
        type: 'resource_link',
        uri,
        sha256: ref.sha256,
        bytes: stat.size,
      },
    };
  }

  // Within inline limit -> read safely
  const buf = fs.readFileSync(fsPath);
  let outText;
  let outEnc = 'utf8';

  if (encoding === 'base64') {
    outText = buf.toString('base64');
    outEnc = 'base64';
  } else {
    try {
      const dec = new TextDecoder('utf-8', { fatal: true });
      outText = dec.decode(buf);
      outEnc = 'utf8';
    } catch {
      outText = buf.toString('base64');
      outEnc = 'base64';
    }
  }

  return {
    type: 'text',
    name: ref.name,
    uri,
    mimeType,
    sha256: ref.sha256,
    bytes: stat.size,
    encoding: outEnc,
    text: outText,
    content: [{ type: 'text', text: outText }],
    structuredContent: {
      type: 'text',
      name: ref.name,
      uri,
      sha256: ref.sha256,
      bytes: stat.size,
      encoding: outEnc,
      text: outText,
    },
  };
}

function parseFieldExpectedValue(v) {
  if (typeof v !== 'string') return v;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  return v;
}

function runAcceptanceChecks(acceptance, resultPath, resultBytes, extraFields = null) {
  const acc = acceptance && typeof acceptance === 'object' ? acceptance : {};
  // `--accept k=v` 落成扁平键；`fields` 是嵌套写法。两种都要当字段断言，
  // 否则用 --accept 建的任务会“零校验”直接 done。
  const RESERVED = new Set([
    'min_bytes',
    'max_bytes',
    'json',
    'must_contain',
    'must_not_contain',
    'fields',
    'require_ref_read',
    'allow_ref_drift',
  ]);
  const flatFields = {};
  for (const [k, v] of Object.entries(acc)) {
    if (!RESERVED.has(k)) flatFields[k] = v;
  }
  const mergedFields = {
    ...flatFields,
    ...(acc.fields && typeof acc.fields === 'object' ? acc.fields : {}),
    ...(extraFields && typeof extraFields === 'object' ? extraFields : {}),
  };

  if (acc.min_bytes !== undefined && resultBytes < Number(acc.min_bytes)) {
    throw Object.assign(
      new Error(`验收失败：结果文件 ${path.basename(resultPath)} 过小 (${resultBytes} B < min_bytes ${acc.min_bytes})`),
      { code: 1 }
    );
  }
  if (acc.max_bytes !== undefined && resultBytes > Number(acc.max_bytes)) {
    throw Object.assign(
      new Error(`验收失败：结果文件 ${path.basename(resultPath)} 过大 (${resultBytes} B > max_bytes ${acc.max_bytes})`),
      { code: 1 }
    );
  }

  const needText = Boolean(
    acc.json === 'true' || acc.json === true ||
    acc.must_contain !== undefined ||
    acc.must_not_contain !== undefined ||
    Object.keys(mergedFields).length > 0
  );

  if (!needText) return;

  const text = fs.readFileSync(resultPath, 'utf8');

  if (acc.must_contain !== undefined) {
    const needles = Array.isArray(acc.must_contain) ? acc.must_contain : [acc.must_contain];
    for (const needle of needles) {
      if (!text.includes(String(needle))) {
        throw Object.assign(new Error(`验收失败：结果缺少必需关键字 (${String(needle).slice(0, 40)})`), { code: 1 });
      }
    }
  }

  if (acc.must_not_contain !== undefined) {
    const forb = Array.isArray(acc.must_not_contain) ? acc.must_not_contain : [acc.must_not_contain];
    for (const bad of forb) {
      if (text.includes(String(bad))) {
        throw Object.assign(new Error(`验收失败：结果包含禁止片段`), { code: 1 });
      }
    }
  }

  let parsedJson = null;
  if (acc.json === 'true' || acc.json === true || Object.keys(mergedFields).length > 0) {
    try {
      parsedJson = JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`验收失败：结果文件 ${path.basename(resultPath)} 不是合法 JSON`), { code: 1 });
    }
  }

  for (const [k, rawExp] of Object.entries(mergedFields)) {
    if (!parsedJson || typeof parsedJson !== 'object' || !(k in parsedJson)) {
      throw Object.assign(new Error(`验收失败：结果 JSON 缺少顶层字段 ${k}`), { code: 1 });
    }
    const actual = parsedJson[k];
    const expected = parseFieldExpectedValue(rawExp);
    const match = typeof expected === 'number'
      ? typeof actual === 'number' && actual === expected
      : actual === expected;
    if (!match) {
      throw Object.assign(new Error(`验收失败：字段 ${k} 不匹配 (expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)})`), { code: 1 });
    }
  }
}

function isTaskResumed(bus, taskId) {
  if (!bus || !taskId) return false;
  const rows = bus.db.prepare(
    "SELECT payload_json FROM events WHERE task_id = ? AND event = 'dispatch'"
  ).all(taskId);
  return rows.some((r) => {
    try {
      return JSON.parse(r.payload_json || '{}').resumed === true;
    } catch {
      return false;
    }
  });
}

export function resolveAuditMode(acceptance, config, taskRow, bus = null) {
  const acc = acceptance && typeof acceptance === 'object' ? acceptance : {};
  if (acc.require_ref_read === true || acc.require_ref_read === 'true') return 'strict';
  if (acc.require_ref_read === false || acc.require_ref_read === 'false') return 'off';

  const envRaw = process.env.AGENTBUS_STRICT_REF_AUDIT;
  if (envRaw !== undefined && String(envRaw).trim() !== '') {
    const envVal = String(envRaw).trim().toLowerCase();
    if (envVal === 'strict' || envVal === '1') return 'strict';
    if (envVal === 'warn') return 'warn';
    if (envVal === 'off' || envVal === '0') return 'off';
    if (envVal === 'resumed') {
      return bus && taskRow && isTaskResumed(bus, taskRow.id) ? 'strict' : 'warn';
    }
  }

  const cfgMode = String(config?.refAuditMode || 'warn').trim().toLowerCase();
  if (cfgMode === 'off' || cfgMode === 'warn' || cfgMode === 'strict') return cfgMode;
  return 'warn';
}

export function evaluateRefReadAudit(bus, row, by) {
  const refs = JSON.parse(row.refs_json || '[]');
  if (refs.length === 0) return { ok: true, missing: [], mode: 'off', resumed: false };
  const acc = JSON.parse(row.acceptance_json || '{}');
  const mode = resolveAuditMode(acc, bus.config, row, bus);
  const resumed = isTaskResumed(bus, row.id);
  if (mode === 'off') return { ok: true, missing: [], mode, resumed };

  const reads = bus.db.prepare(
    "SELECT payload_json FROM events WHERE task_id = ? AND event = 'ref_read'"
  ).all(row.id);
  const readSet = new Set(reads.map((r) => {
    try {
      const p = JSON.parse(r.payload_json || '{}');
      return `${p.name}:${p.sha256}`;
    } catch {
      return '';
    }
  }));
  const missing = refs.filter((r) => !readSet.has(`${r.name}:${r.sha256}`)).map((r) => r.name);
  if (missing.length === 0) return { ok: true, missing: [], mode, resumed };
  return { ok: false, missing, mode, resumed, by };
}

export function completeTask(bus, { id, by, lease_token, result_path, fields = null }) {
  if (!by || !lease_token) {
    throw Object.assign(new Error('done/complete 需要 --by 与 --lease'), { code: 1 });
  }
  if (!result_path) {
    throw Object.assign(new Error('done/complete 需要 --result <path>'), { code: 1 });
  }

  syncLegacyTaskFiles(bus);
  reapExpiredLeases(bus);

  const txOut = withImmediateTx(bus.db, () => {
    const row = findTaskRowByIdOrPrefix(bus, id);
    const now = nowIso();

    // 1. Verify lease & token
    if (row.state !== 'claimed') {
      throw Object.assign(new Error(`任务当前状态为 ${row.state}，不能 complete`), { code: 2 });
    }
    if (!row.lease_expires_at || row.lease_expires_at <= now) {
      throw Object.assign(new Error('任务租约已过期'), { code: 2 });
    }
    if (row.claimed_by !== by || row.lease_token !== lease_token) {
      throw Object.assign(new Error('租约 token 或领取者不匹配'), { code: 2 });
    }

    const acceptance = JSON.parse(row.acceptance_json || '{}');
    const allowRefDrift = acceptance.allow_ref_drift === true || acceptance.allow_ref_drift === 'true';

    // 2. Recompute SHA-256 of EVERY ref -> reject on any drift unless allow_ref_drift
    const refs = JSON.parse(row.refs_json || '[]');
    const drifted = [];
    for (const ref of refs) {
      const v = verifyRefIntegrity(ref, bus.config);
      if (!v.ok) drifted.push(`${ref.name}(${v.reason})`);
    }
    const persistReject = (err, eventName, eventPayload) => {
      const errMsg = String(err?.message || err || 'complete failed');
      if (eventName) {
        appendEvent(bus.db, row.id, eventName, eventPayload || {});
      }
      const info = bus.db.prepare(
        'INSERT INTO task_messages (task_id, from_agent, to_agent, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(row.id, by, row.from_agent || null, 'error', errMsg.slice(0, 16000), now);
      bus.db.prepare(
        'UPDATE tasks SET last_message_at = ?, blocked_at = COALESCE(blocked_at, ?) WHERE id = ?'
      ).run(now, now, row.id);
      appendEvent(bus.db, row.id, 'message', {
        seq: Number(info.lastInsertRowid),
        from: by,
        to: row.from_agent || null,
        kind: 'error',
        body: errMsg.slice(0, 240),
      });
      const updated = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
      if (updated) writeEnvelopeMirror(bus, updated);
      return { __rejectedError: err };
    };

    if (drifted.length > 0 && !allowRefDrift) {
      return persistReject(
        Object.assign(new Error(`引用已漂移 (drift)，拒绝收工: ${drifted.join(', ')}`), { code: 1 }),
        'complete_drift_rejected',
        { by, attempt: Number(row.attempt || 0), drifted },
      );
    }

    // 3 & 4. Result file validation & acceptance clauses (§6.3) — failure persists error message + blocked_at and keeps task in 'claimed'
    let resPath;
    let resUri;
    let resStat;
    try {
      const resolvedRes = resolveAndValidatePath(result_path, bus.config, { checkSize: true });
      resPath = resolvedRes.fsPath;
      resUri = resolvedRes.uri;
      resStat = resolvedRes.stat;
      runAcceptanceChecks(acceptance, resPath, resStat.size, fields);
    } catch (err) {
      return persistReject(
        err,
        'complete_acceptance_rejected',
        { by, attempt: Number(row.attempt || 0), reason: String(err?.message || err) },
      );
    }

    // 4.5 ref_read audit gate (warn vs strict)
    const audit = evaluateRefReadAudit(bus, row, by);
    if (!audit.ok && audit.mode === 'strict') {
      return persistReject(
        Object.assign(
          new Error(`ref_read 审计拦截：交工前必须通过 bus_ref_read 读取全部引用 (${audit.missing.join(', ')})`),
          { code: 1 }
        ),
        'complete_audit_rejected',
        {
          by,
          attempt: Number(row.attempt || 0),
          missing_refs: audit.missing,
          resumed: audit.resumed,
          mode: 'strict',
        },
      );
    }

    // 5. Hash result file, commit state=done, record events & mirror envelope
    const resultSha = sha256File(resPath);
    const resultObj = {
      uri: resUri,
      sha256: resultSha,
      bytes: resStat.size,
      by,
      at: now,
    };
    const history = JSON.parse(row.history_json || '[]');
    history.push({ at: now, state: 'done', by });

    bus.db.prepare(
      `UPDATE tasks
       SET state = 'done', finished_at = ?, result_json = ?, history_json = ?, lease_token = NULL, blocked_at = NULL
       WHERE id = ?`
    ).run(now, JSON.stringify(resultObj), JSON.stringify(history), row.id);

    if (drifted.length > 0 && allowRefDrift) {
      appendEvent(bus.db, row.id, 'complete_with_ref_drift', {
        by,
        attempt: Number(row.attempt || 0),
        drifted,
      });
    }

    if (!audit.ok && audit.mode === 'warn') {
      appendEvent(bus.db, row.id, 'complete_audit_warning', {
        by,
        attempt: Number(row.attempt || 0),
        missing_refs: audit.missing,
        resumed: audit.resumed,
        mode: 'warn',
      });
    }

    appendEvent(bus.db, row.id, 'complete', { by, result_sha256: resultSha, result_bytes: resStat.size });
    clearTaskThreadByName(bus.db, `task:${row.id}`);

    const updated = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    writeEnvelopeMirror(bus, updated);

    // 6. Exact return shape (§6.3)
    const doneResult = {
      ok: true,
      id: row.id,
      state: 'done',
      result_sha256: resultSha,
      result_bytes: resStat.size,
      result: resultObj,
    };
    const warnings = [];
    if (drifted.length > 0 && allowRefDrift) {
      warnings.push('completed_with_ref_drift');
      doneResult.drifted_refs = drifted;
    }
    if (!audit.ok && audit.mode === 'warn') {
      warnings.push('completed_without_bus_ref_read');
      doneResult.missing_refs = audit.missing;
    }
    if (warnings.length > 0) {
      doneResult.warnings = warnings;
    }

    return {
      doneResult,
      threadName: updated?.thread_name || null,
      updatedEnvelope: rowToEnvelope(updated),
      resPath,
      resultObj,
    };
  });

  if (txOut && txOut.__rejectedError) {
    throw txOut.__rejectedError;
  }

  if (txOut.threadName && !contextLedgerDisabled()) {
    try {
      recordContextOutcome(bus, txOut.threadName, {
        task: txOut.updatedEnvelope,
        status: 'done',
        result: txOut.resultObj,
        resultPath: txOut.resPath,
        actor: by,
      });
    } catch {}
  }

  return txOut.doneResult;
}

export const RECOVER_ACTIONS = new Set(['retry', 'release', 'fail', 'reassign', 'adopt']);

export function recoverTask(bus, {
  id,
  by,
  action,
  reason = null,
  to = null,
  result_path = null,
  allow_ref_drift = false,
  role = 'all',
  fields = null,
}) {
  if (!by || typeof by !== 'string' || !by.trim()) {
    throw Object.assign(new Error('recover 需要 --by <agent>'), { code: 1 });
  }
  const agent = by.trim();
  const act = String(action || '').trim().toLowerCase();
  if (!RECOVER_ACTIONS.has(act)) {
    throw Object.assign(new Error(`未知 recover action: ${action || ''}；可选: ${[...RECOVER_ACTIONS].join(', ')}`), { code: 1 });
  }
  const reasonText = reason !== null && reason !== undefined && String(reason).trim() ? String(reason).trim() : null;

  if (act === 'reassign' && (!to || typeof to !== 'string' || !to.trim())) {
    throw Object.assign(new Error('recover reassign 需要 --to <agent>'), { code: 1 });
  }
  if (act === 'adopt' && (!result_path || typeof result_path !== 'string' || !result_path.trim())) {
    throw Object.assign(new Error('recover adopt 需要 --result <path>'), { code: 1 });
  }

  syncLegacyTaskFiles(bus);

  const txOut = withImmediateTx(bus.db, () => {
    const row = findTaskRowByIdOrPrefix(bus, id);
    const now = nowIso();

    if (role === 'worker') {
      const envAgent = process.env.AGENTBUS_AGENT && String(process.env.AGENTBUS_AGENT).trim();
      if (envAgent && agent !== envAgent) {
        throw Object.assign(new Error(`worker 角色无权冒用其他 agent 身份 ${agent} (expected=${envAgent})`), { code: 2 });
      }
      const allowedByParticipant =
        agent === row.from_agent ||
        agent === row.to_agent ||
        (row.to_agent === '*' && row.claimed_by === agent);
      if (!allowedByParticipant) {
        throw Object.assign(new Error(`worker 角色无权以 ${agent} 身份恢复无关任务 ${row.id}`), { code: 2 });
      }
      if (row.state === 'claimed' && row.claimed_by && row.claimed_by !== agent && agent !== row.from_agent) {
        throw Object.assign(new Error(`worker 角色无权恢复由 ${row.claimed_by} 持有的任务 ${row.id}`), { code: 2 });
      }
    }

    if (row.state !== 'open' && row.state !== 'claimed') {
      throw Object.assign(new Error(`任务当前状态为 ${row.state}，不能执行 recover ${act}`), { code: 2 });
    }

    const history = JSON.parse(row.history_json || '[]');
    const msgKind = act === 'fail' ? 'error' : 'note';
    const baseMsg = `recovered_by=${agent} action=${act} reason=${reasonText || 'none'}`;
    let msgBody = baseMsg;
    let outcomeStatus = null;
    let resPath = null;
    let resultObj = null;
    let drifted = [];
    let allowDrift = false;

    const assertUpdated = (info) => {
      if (!info || info.changes !== 1) {
        throw Object.assign(new Error(`任务 ${row.id} 状态已变更，无法重复执行 recover ${act}`), { code: 2 });
      }
    };

    if (act === 'retry' || act === 'release') {
      const nextAttempt = act === 'retry' ? Number(row.attempt || 0) + 1 : Number(row.attempt || 0);
      history.push({
        at: now,
        state: 'open',
        by: agent,
        action: act,
        ...(reasonText ? { reason: reasonText } : {}),
      });
      assertUpdated(bus.db.prepare(
        `UPDATE tasks
         SET state = 'open', claimed_by = NULL, lease_token = NULL, lease_expires_at = NULL,
             blocked_at = NULL, finished_at = NULL, last_message_at = ?, attempt = ?, history_json = ?
         WHERE id = ? AND state IN ('open', 'claimed')`
      ).run(now, nextAttempt, JSON.stringify(history), row.id));
      appendEvent(bus.db, row.id, `recover_${act}`, {
        action: act,
        by: agent,
        recovered_by: agent,
        reason: reasonText,
        previous_state: row.state,
        previous_claimed_by: row.claimed_by,
        attempt: nextAttempt,
      });
    } else if (act === 'fail') {
      outcomeStatus = 'failed';
      history.push({
        at: now,
        state: 'failed',
        by: agent,
        action: 'fail',
        ...(reasonText ? { reason: reasonText } : {}),
      });
      assertUpdated(bus.db.prepare(
        `UPDATE tasks
         SET state = 'failed', claimed_by = NULL, lease_token = NULL, lease_expires_at = NULL,
             blocked_at = NULL, finished_at = ?, last_message_at = ?, history_json = ?
         WHERE id = ? AND state IN ('open', 'claimed')`
      ).run(now, now, JSON.stringify(history), row.id));
      appendEvent(bus.db, row.id, 'recover_fail', {
        action: 'fail',
        by: agent,
        recovered_by: agent,
        reason: reasonText,
        previous_state: row.state,
        previous_claimed_by: row.claimed_by,
      });
      clearTaskThreadByName(bus.db, `task:${row.id}`);
    } else if (act === 'reassign') {
      const newTo = to.trim();
      msgBody = `${baseMsg} to=${newTo}`;
      history.push({
        at: now,
        state: 'open',
        by: agent,
        action: 'reassign',
        to: newTo,
        ...(reasonText ? { reason: reasonText } : {}),
      });
      assertUpdated(bus.db.prepare(
        `UPDATE tasks
         SET to_agent = ?, state = 'open', claimed_by = NULL, lease_token = NULL, lease_expires_at = NULL,
             blocked_at = NULL, finished_at = NULL, last_message_at = ?, history_json = ?
         WHERE id = ? AND state IN ('open', 'claimed')`
      ).run(newTo, now, JSON.stringify(history), row.id));
      appendEvent(bus.db, row.id, 'recover_reassign', {
        action: 'reassign',
        by: agent,
        recovered_by: agent,
        previous_to: row.to_agent,
        to: newTo,
        reason: reasonText,
        previous_state: row.state,
        previous_claimed_by: row.claimed_by,
      });
      clearTaskThreadByName(bus.db, `task:${row.id}`);
    } else if (act === 'adopt') {
      outcomeStatus = 'done';
      const acceptance = JSON.parse(row.acceptance_json || '{}');
      const taskAllowsDrift = acceptance.allow_ref_drift === true || acceptance.allow_ref_drift === 'true';
      if (role === 'worker' && allow_ref_drift === true && !taskAllowsDrift) {
        throw Object.assign(new Error('worker 角色无权绕过引用漂移校验 (allow_ref_drift)'), { code: 2 });
      }
      allowDrift = Boolean(allow_ref_drift) || taskAllowsDrift;

      const resolved = resolveAndValidatePath(result_path, bus.config, { checkSize: true });
      resPath = resolved.fsPath;
      const resUri = resolved.uri;
      const resStat = resolved.stat;

      const refs = JSON.parse(row.refs_json || '[]');
      for (const ref of refs) {
        const v = verifyRefIntegrity(ref, bus.config);
        if (!v.ok) drifted.push(`${ref.name}(${v.reason})`);
      }
      if (drifted.length > 0 && !allowDrift) {
        throw Object.assign(new Error(`引用已漂移 (drift)，拒绝 adopt: ${drifted.join(', ')}`), { code: 1 });
      }

      runAcceptanceChecks(acceptance, resPath, resStat.size, fields);

      const resultSha = sha256File(resPath);
      resultObj = {
        uri: resUri,
        sha256: resultSha,
        bytes: resStat.size,
        by: agent,
        at: now,
      };
      msgBody = `${baseMsg} result_uri=${resUri}${drifted.length > 0 ? ` allow_ref_drift=true drifted=${drifted.join(',')}` : ''}`;
      history.push({
        at: now,
        state: 'done',
        by: agent,
        action: 'adopt',
        ...(reasonText ? { reason: reasonText } : {}),
      });
      assertUpdated(bus.db.prepare(
        `UPDATE tasks
         SET state = 'done', finished_at = ?, result_json = ?, history_json = ?,
             lease_token = NULL, lease_expires_at = NULL, blocked_at = NULL, last_message_at = ?
         WHERE id = ? AND state IN ('open', 'claimed')`
      ).run(now, JSON.stringify(resultObj), JSON.stringify(history), now, row.id));

      if (drifted.length > 0 && allowDrift) {
        appendEvent(bus.db, row.id, 'complete_with_ref_drift', {
          by: agent,
          via: 'recover_adopt',
          attempt: Number(row.attempt || 0),
          drifted,
        });
      }
      appendEvent(bus.db, row.id, 'recover_adopt', {
        action: 'adopt',
        by: agent,
        recovered_by: agent,
        reason: reasonText,
        allow_ref_drift: allowDrift,
        drifted,
        previous_state: row.state,
        result_sha256: resultSha,
        result_bytes: resStat.size,
      });
      clearTaskThreadByName(bus.db, `task:${row.id}`);
    }

    const msgInfo = bus.db.prepare(
      'INSERT INTO task_messages (task_id, from_agent, to_agent, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(row.id, agent, null, msgKind, msgBody.slice(0, 16000), now);
    const msgSeq = Number(msgInfo.lastInsertRowid);
    appendEvent(bus.db, row.id, 'message', {
      seq: msgSeq,
      from: agent,
      to: null,
      kind: msgKind,
      body: msgBody.slice(0, 240),
    });

    const updated = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    writeEnvelopeMirror(bus, updated);

    const out = {
      ok: true,
      id: row.id,
      action: act,
      previous_state: row.state,
      state: updated.state,
      to: updated.to_agent,
      attempt: updated.attempt,
      blocked: Boolean(updated.blocked_at),
      blocked_at: updated.blocked_at || null,
      recovered_by: agent,
      reason: reasonText,
      message_seq: msgSeq,
    };
    if (act === 'adopt' && resultObj) {
      out.result_sha256 = resultObj.sha256;
      out.result_bytes = resultObj.bytes;
      out.result = resultObj;
      if (drifted.length > 0 && allowDrift) {
        out.warnings = ['adopted_with_ref_drift'];
        out.drifted_refs = drifted;
      }
    }

    return {
      out,
      outcomeStatus,
      threadName: updated?.thread_name || null,
      updatedEnvelope: rowToEnvelope(updated),
      resPath,
      resultObj,
    };
  });

  if (txOut.outcomeStatus && txOut.threadName && !contextLedgerDisabled()) {
    try {
      recordContextOutcome(bus, txOut.threadName, {
        task: txOut.updatedEnvelope,
        status: txOut.outcomeStatus,
        ...(txOut.outcomeStatus === 'done'
          ? { result: txOut.resultObj, resultPath: txOut.resPath }
          : { reason: reasonText || 'recover_fail' }),
        actor: agent,
      });
    } catch {}
  }

  return txOut.out;
}

export function failTask(bus, { id, by, lease_token, reason }) {
  if (!by || !lease_token) {
    throw Object.assign(new Error('fail 需要 --by 与 --lease'), { code: 1 });
  }
  if (!reason || !String(reason).trim()) {
    throw Object.assign(new Error('fail 需要 --reason "..."'), { code: 1 });
  }

  syncLegacyTaskFiles(bus);
  reapExpiredLeases(bus);

  const txOut = withImmediateTx(bus.db, () => {
    const row = findTaskRowByIdOrPrefix(bus, id);
    const now = nowIso();
    if (row.state !== 'claimed' || !row.lease_expires_at || row.lease_expires_at <= now) {
      throw Object.assign(new Error(`任务当前状态为 ${row.state}，不能 fail`), { code: 2 });
    }
    if (row.claimed_by !== by || row.lease_token !== lease_token) {
      throw Object.assign(new Error('租约 token 或领取者不匹配'), { code: 2 });
    }

    const reasonText = String(reason).trim();
    const history = JSON.parse(row.history_json || '[]');
    history.push({ at: now, state: 'failed', by, reason: reasonText });

    bus.db.prepare(
      `UPDATE tasks
       SET state = 'failed', finished_at = ?, lease_token = NULL, lease_expires_at = NULL, history_json = ?,
           last_message_at = ?, blocked_at = COALESCE(blocked_at, ?)
       WHERE id = ?`
    ).run(now, JSON.stringify(history), now, now, row.id);

    appendEvent(bus.db, row.id, 'fail', { by, reason: reasonText });
    bus.db.prepare(
      'INSERT INTO task_messages (task_id, from_agent, to_agent, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(row.id, by, row.from_agent || null, 'error', reasonText.slice(0, 16000), now);
    clearTaskThreadByName(bus.db, `task:${row.id}`);

    const updated = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    writeEnvelopeMirror(bus, updated);

    return {
      result: {
        ok: true,
        id: row.id,
        state: 'failed',
        reason: reasonText,
      },
      threadName: updated?.thread_name || null,
      updatedEnvelope: rowToEnvelope(updated),
    };
  });

  if (txOut.threadName && !contextLedgerDisabled()) {
    try {
      recordContextOutcome(bus, txOut.threadName, {
        task: txOut.updatedEnvelope,
        status: 'failed',
        reason: txOut.result.reason,
        actor: by,
      });
    } catch {}
  }

  return txOut.result;
}

export const MESSAGE_KINDS = new Set(['note', 'progress', 'question', 'blocked', 'answer', 'error']);
export const ATTENTION_MESSAGE_KINDS = new Set(['question', 'blocked', 'error']);

export function addTaskMessage(bus, { id, from, to = null, kind = 'note', body, lease_token = null, role = 'all' }) {
  if (!from || !String(from).trim()) {
    throw Object.assign(new Error('message 需要 --by <agent>'), { code: 1 });
  }
  const rawText = String(body ?? '');
  if (!rawText.trim()) {
    throw Object.assign(new Error('message 需要 --body "..."'), { code: 1 });
  }
  const k = String(kind || 'note').trim().toLowerCase();
  if (!MESSAGE_KINDS.has(k)) {
    throw Object.assign(new Error(`未知消息类型 ${k}；可选: ${[...MESSAGE_KINDS].join(', ')}`), { code: 1 });
  }
  const agent = String(from).trim();
  const storedBody = rawText.slice(0, 16000);

  syncLegacyTaskFiles(bus);
  reapExpiredLeases(bus);

  return withImmediateTx(bus.db, () => {
    const row = findTaskRowByIdOrPrefix(bus, id);
    const now = nowIso();
    if (row.claimed_by === agent && role !== 'conductor') {
      if (row.state !== 'claimed' || !lease_token || row.lease_token !== lease_token || (row.lease_expires_at && row.lease_expires_at <= now)) {
        throw Object.assign(new Error('发送消息需要有效 lease_token（领取者本人）'), { code: 2 });
      }
    } else if (role === 'worker' && row.to_agent !== agent && row.to_agent !== '*') {
      throw Object.assign(new Error(`worker 无权以 ${agent} 身份向此任务发消息`), { code: 2 });
    }

    const toAgent = to && String(to).trim()
      ? String(to).trim()
      : (row.claimed_by === agent ? row.from_agent : (row.claimed_by || (row.to_agent !== '*' ? row.to_agent : null)));
    const info = bus.db.prepare(
      'INSERT INTO task_messages (task_id, from_agent, to_agent, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(row.id, agent, toAgent || null, k, storedBody, now);
    const seq = Number(info.lastInsertRowid);

    if (ATTENTION_MESSAGE_KINDS.has(k)) {
      bus.db.prepare('UPDATE tasks SET last_message_at = ?, blocked_at = COALESCE(blocked_at, ?) WHERE id = ?').run(now, now, row.id);
    } else if (k === 'answer') {
      bus.db.prepare('UPDATE tasks SET last_message_at = ?, blocked_at = NULL WHERE id = ?').run(now, row.id);
    } else {
      bus.db.prepare('UPDATE tasks SET last_message_at = ? WHERE id = ?').run(now, row.id);
    }

    appendEvent(bus.db, row.id, 'message', { seq, from: agent, to: toAgent || null, kind: k, body: storedBody.slice(0, 240) });
    const updated = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    writeEnvelopeMirror(bus, updated);

    return {
      ok: true,
      id: row.id,
      seq,
      from: agent,
      to: toAgent || null,
      kind: k,
      body: storedBody,
      state: updated.state,
      blocked: Boolean(updated.blocked_at),
      blocked_at: updated.blocked_at || null,
      last_message_at: updated.last_message_at || now,
      created_at: now,
    };
  });
}

export function listTaskMessages(bus, { id, for_agent = null, since_id = 0, mark_read = false, limit = 100, role = 'all' } = {}) {
  syncLegacyTaskFiles(bus);
  const row = findTaskRowByIdOrPrefix(bus, id);
  const since = Math.max(0, Number(since_id) || 0);
  const cap = Math.min(500, Math.max(1, Number(limit) || 100));
  const explicitFor = for_agent && String(for_agent).trim() ? String(for_agent).trim() : null;
  const effectiveFor = explicitFor || (
    role === 'worker'
      ? (process.env.AGENTBUS_AGENT || row.claimed_by || (row.to_agent !== '*' ? row.to_agent : null))
      : null
  );

  const params = [row.id, since];
  let sql = 'SELECT seq, task_id, from_agent, to_agent, kind, body, created_at, read_at FROM task_messages WHERE task_id = ? AND seq > ?';
  if (effectiveFor) {
    sql += ' AND (to_agent IS NULL OR to_agent = ?) AND from_agent <> ?';
    params.push(effectiveFor, effectiveFor);
  }
  sql += ' ORDER BY seq ASC LIMIT ?';
  params.push(cap);

  const rawMessages = bus.db.prepare(sql).all(...params);
  let readStamp = null;
  if (mark_read && rawMessages.some((m) => !m.read_at)) {
    readStamp = nowIso();
    const unreadSeqs = rawMessages.filter((m) => !m.read_at).map((m) => Number(m.seq));
    withImmediateTx(bus.db, () => {
      const upd = bus.db.prepare('UPDATE task_messages SET read_at = ? WHERE seq = ? AND read_at IS NULL');
      for (const seq of unreadSeqs) upd.run(readStamp, seq);
    });
  }

  const messages = rawMessages.map((m) => ({
    seq: Number(m.seq),
    task_id: m.task_id,
    from: m.from_agent,
    to: m.to_agent || null,
    from_agent: m.from_agent,
    to_agent: m.to_agent || null,
    kind: m.kind,
    body: m.body,
    created_at: m.created_at,
    read_at: m.read_at || readStamp || null,
  }));

  const updated = bus.db.prepare('SELECT state, blocked_at, last_message_at FROM tasks WHERE id = ?').get(row.id);
  return {
    ok: true,
    id: row.id,
    state: updated.state,
    blocked: Boolean(updated.blocked_at),
    blocked_at: updated.blocked_at || null,
    last_message_at: updated.last_message_at || null,
    messages,
    last_seq: messages.length ? Number(messages[messages.length - 1].seq) : since,
  };
}

export function latestTaskMessageSeq(bus, id) {
  const row = findTaskRowByIdOrPrefix(bus, id);
  const r = bus.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM task_messages WHERE task_id = ?').get(row.id);
  return Number(r?.seq || 0);
}

export function verifyTasks(bus, { id = null } = {}) {
  syncLegacyTaskFiles(bus);
  reapExpiredLeases(bus);

  let rows;
  if (id) {
    rows = [findTaskRowByIdOrPrefix(bus, id)];
  } else {
    rows = bus.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
  }

  const report = [];
  for (const row of rows) {
    const refs = JSON.parse(row.refs_json || '[]').map((r) => verifyRefIntegrity(r, bus.config));
    const refsOk = refs.every((r) => r.ok);

    let resultReport = null;
    if (row.result_json) {
      const res = JSON.parse(row.result_json);
      const check = verifyRefIntegrity({ name: 'result', uri: res.uri, sha256: res.sha256 }, bus.config);
      resultReport = { ok: check.ok, uri: res.uri, reason: check.reason };
    }

    report.push({
      id: row.id,
      state: row.state,
      to: row.to_agent,
      refs_ok: refsOk,
      refs,
      result: resultReport,
    });
  }

  const badCount = report.filter((r) => !r.refs_ok || (r.result && !r.result.ok)).length;
  return {
    tasks: report.length,
    bad: badCount,
    report,
  };
}
