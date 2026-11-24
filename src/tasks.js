// agentbus: Task state machine, lease management, idempotency, acceptance verification, and ref reading
// Zero third-party dependencies. Compatible with proto/bus.mjs agentbus/task@1 envelopes.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { withImmediateTx, appendEvent } from './db.js';
import { getArtifact, resolveAndValidatePath, sha256File, verifyRefIntegrity, guessMime } from './store.js';

function nowIso() {
  return new Date().toISOString();
}

function atomicWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function rowToEnvelope(row) {
  const refs = JSON.parse(row.refs_json).map((r) => {
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

  return withImmediateTx(bus.db, () => {
    const freshExpired = bus.db.prepare(
      `SELECT * FROM tasks WHERE state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
    ).all(now);

    for (const row of freshExpired) {
      const nextAttempt = Number(row.attempt || 0) + 1;
      const exceeded = nextAttempt > bus.config.maxAttempts;
      const nextState = exceeded ? 'failed' : 'open';
      const history = JSON.parse(row.history_json || '[]');
      history.push({ at: now, state: nextState, by: 'system', reason: 'lease_expired' });

      bus.db.prepare(
        `UPDATE tasks
         SET state = ?, claimed_by = NULL, lease_token = NULL, lease_expires_at = NULL,
             attempt = ?, finished_at = ?, history_json = ?
         WHERE id = ? AND state = 'claimed'`
      ).run(
        nextState,
        nextAttempt,
        exceeded ? now : null,
        JSON.stringify(history),
        row.id
      );

      appendEvent(bus.db, row.id, 'lease_expired', {
        previous_claimed_by: row.claimed_by,
        attempt: nextAttempt,
        next_state: nextState,
      });

      const updated = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
      if (updated) writeEnvelopeMirror(bus, updated);
    }
    return freshExpired.length;
  });
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
  const resolvedRefs = normalizeRefInputs(bus, refs);
  const cleanConstraints = Array.isArray(constraints) ? constraints.map(String) : constraints ? [String(constraints)] : [];
  const cleanAcceptance = acceptance && typeof acceptance === 'object' ? acceptance : {};

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
        idempotency_key, created_at, finished_at, result_json, history_json
      ) VALUES (?, 'agentbus/task@1', ?, ?, 'open', ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, NULL, NULL, ?)`
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
      JSON.stringify(history)
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
    `SELECT id, to_agent, state, goal, refs_json, attempt, claimed_by, lease_expires_at, created_at, finished_at
     FROM tasks ${where}
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(...params);

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
      if (attempt > bus.config.maxAttempts) {
        history.push({ at: now, state: 'failed', by: 'system', reason: 'lease_expired' });
        bus.db.prepare(
          `UPDATE tasks SET state='failed', claimed_by=NULL, lease_token=NULL, lease_expires_at=NULL,
           attempt=?, finished_at=?, history_json=? WHERE id=?`
        ).run(attempt, now, JSON.stringify(history), row.id);
        appendEvent(bus.db, row.id, 'lease_expired', { attempt, next_state: 'failed' });
        const upd = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
        writeEnvelopeMirror(bus, upd);
        throw Object.assign(new Error(`任务已因租约过期超过最大重试次数进入 failed`), { code: 2 });
      }
      state = 'open';
      history.push({ at: now, state: 'open', by: 'system', reason: 'lease_expired' });
      appendEvent(bus.db, row.id, 'lease_expired', { attempt, next_state: 'open' });
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

    return {
      ok: true,
      id: row.id,
      state: 'claimed',
      claimed_by: agent,
      lease_token: leaseToken,
      expires_at: expiresAt,
      lease_expires_at: expiresAt,
      attempt,
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
export function readTaskRef(bus, { id, name, max_bytes = null, encoding = null }) {
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
  const RESERVED = new Set(['min_bytes', 'max_bytes', 'json', 'must_contain', 'must_not_contain', 'fields']);
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

export function completeTask(bus, { id, by, lease_token, result_path, fields = null }) {
  if (!by || !lease_token) {
    throw Object.assign(new Error('done/complete 需要 --by 与 --lease'), { code: 1 });
  }
  if (!result_path) {
    throw Object.assign(new Error('done/complete 需要 --result <path>'), { code: 1 });
  }

  syncLegacyTaskFiles(bus);
  reapExpiredLeases(bus);

  return withImmediateTx(bus.db, () => {
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

    // 2. Recompute SHA-256 of EVERY ref -> reject on any drift
    const refs = JSON.parse(row.refs_json || '[]');
    const drifted = [];
    for (const ref of refs) {
      const v = verifyRefIntegrity(ref, bus.config);
      if (!v.ok) drifted.push(`${ref.name}(${v.reason})`);
    }
    if (drifted.length > 0) {
      throw Object.assign(new Error(`引用已漂移 (drift)，拒绝收工: ${drifted.join(', ')}`), { code: 1 });
    }

    // 3. Result file must exist, be inside allowed_roots, and be a regular file
    const { fsPath: resPath, uri: resUri, stat: resStat } = resolveAndValidatePath(result_path, bus.config, { checkSize: true });

    // 4. Evaluate acceptance clauses (§6.3) — failure keeps task in 'claimed'
    const acceptance = JSON.parse(row.acceptance_json || '{}');
    runAcceptanceChecks(acceptance, resPath, resStat.size, fields);

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
       SET state = 'done', finished_at = ?, result_json = ?, history_json = ?, lease_token = NULL
       WHERE id = ?`
    ).run(now, JSON.stringify(resultObj), JSON.stringify(history), row.id);

    appendEvent(bus.db, row.id, 'complete', { by, result_sha256: resultSha, result_bytes: resStat.size });

    const updated = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    writeEnvelopeMirror(bus, updated);

    // 6. Exact return shape (§6.3)
    return {
      ok: true,
      id: row.id,
      state: 'done',
      result_sha256: resultSha,
      result_bytes: resStat.size,
      result: resultObj,
    };
  });
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

  return withImmediateTx(bus.db, () => {
    const row = findTaskRowByIdOrPrefix(bus, id);
    const now = nowIso();
    if (row.state !== 'claimed' || !row.lease_expires_at || row.lease_expires_at <= now) {
      throw Object.assign(new Error(`任务当前状态为 ${row.state}，不能 fail`), { code: 2 });
    }
    if (row.claimed_by !== by || row.lease_token !== lease_token) {
      throw Object.assign(new Error('租约 token 或领取者不匹配'), { code: 2 });
    }

    const history = JSON.parse(row.history_json || '[]');
    history.push({ at: now, state: 'failed', by, reason: String(reason).trim() });

    bus.db.prepare(
      `UPDATE tasks
       SET state = 'failed', finished_at = ?, lease_token = NULL, lease_expires_at = NULL, history_json = ?
       WHERE id = ?`
    ).run(now, JSON.stringify(history), row.id);

    appendEvent(bus.db, row.id, 'fail', { by, reason: String(reason).trim() });

    const updated = bus.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id);
    writeEnvelopeMirror(bus, updated);

    return {
      ok: true,
      id: row.id,
      state: 'failed',
      reason: String(reason).trim(),
    };
  });
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
