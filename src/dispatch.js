// Active dispatch: hand a task to another agent CLI and wait for the result.
//
// This is the "call another agent" path, as opposed to a task board where a human
// tells the other agent to pick work up. It is OFF by default: enabling it means
// the bus can start processes, so it must be opted in explicitly.
//
// Enable with: AGENTBUS_ENABLE_DISPATCH=1 (or the CLI flag --dispatch).
// Adapters: built-ins for codex / claude / gemini / antigravity, plus a custom
// one via AGENTBUS_ADAPTER_<NAME> (JSON: {"command": "...", "args": ["...", "{prompt}"]}).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { showTask, listTaskMessages, latestTaskMessageSeq, ATTENTION_MESSAGE_KINDS } from './tasks.js';
import { defaultAgySessionPath, detectAgentApi, resolveAgySession, archiveTaskConversations } from './agy.js';
import { modelFor, KNOWN_MODELS, readAgentConfig, resolveAgentBin } from './agents.js';
import { linkCodexThreadToApp } from './codex-app.js';
import { appendEvent, openBus, openBusReadOnly, withImmediateTx, PKG_ROOT } from './db.js';
import {
  threadUsable,
  getThread,
  setThread,
  touchThread,
  clearThread,
  invalidateThread,
  resolveClientPolicy,
  resolveThreadSteps,
  rotateThreadWithSnapshot,
} from './threads.js';
import {
  contextLedgerDisabled,
  getExistingContextRef,
  attachContextRefIfOpen,
  recordContextOutcome,
} from './context.js';

export { threadUsable };

export function dispatchEnabled(flag) {
  return !!flag || process.env.AGENTBUS_ENABLE_DISPATCH === '1';
}

function extractSession(stdout) {
  const m = stdout.match(/"thread_id"\s*:\s*"([^"]+)"/)
    || stdout.match(/"session_id"\s*:\s*"([^"]+)"/)
    || stdout.match(/"conversationId"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function requireResolvedBin(agentId) {
  const res = resolveAgentBin(agentId, { home: os.homedir(), env: process.env, platform: process.platform });
  if (res.bin) return res.bin;
  const detail = res.next ? `${res.message}。下一步：${res.next}` : res.message;
  throw Object.assign(new Error(detail), { code: 1 });
}

const BUILTIN = {
  codex: ({ prompt, cwd, session, model }) => {
    const bin = requireResolvedBin('codex');
    const modelArgs = model ? ['-m', model] : [];
    const base = ['exec'];
    if (session) {
      // Session affinity (the magpie idea): a thread's next task resumes the
      // same Codex conversation instead of starting cold and re-reading context.
      return {
        command: bin,
        // `resume` has no --approve-for-me; MCP calls need approvals bypassed.
        // Documented in SECURITY.md: resume runs unsandboxed by Codex's own rules.
        args: [...base, 'resume', session, ...modelArgs, '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-'],
        stdinPrompt: prompt,
        keepsSession: true,
      };
    }
    return {
      // The prompt goes over stdin ("-"): no quoting problems on any platform.
      command: bin,
      args: [...base, ...modelArgs, '--json', '--approve-for-me', '--skip-git-repo-check', '-C', cwd, '-'],
      stdinPrompt: prompt,
    };
  },
  claude: ({ prompt, model }) => ({
    command: requireResolvedBin('claude'),
    args: [...(model ? ['--model', model] : []), '-p', prompt, '--permission-mode', 'acceptEdits'],
  }),
  gemini: ({ prompt, model }) => ({
    command: requireResolvedBin('gemini'),
    args: [...(model ? ['-m', model] : []), '-p', prompt, '--yolo'],
  }),
  antigravity: ({ prompt, busRoot, id, model, session }) => {
    const bin = detectAgentApi();
    if (!bin) {
      const res = resolveAgentBin('antigravity', { home: os.homedir(), env: process.env, platform: process.platform });
      throw Object.assign(new Error(res.next ? `${res.message}。下一步：${res.next}` : res.message), { code: 1 });
    }
    const sessionFile = defaultAgySessionPath(busRoot);
    const sess = resolveAgySession({ busRoot, sessionFile });
    // agentapi takes the prompt as one positional argument; newlines would break
    // the Windows command line, so collapse them into separators.
    const oneLine = String(prompt).replace(/\s*\n+\s*/g, '；');
    const baseName = path.basename(bin).replace(/\.(bat|cmd|exe)$/i, '').toLowerCase();
    const base = baseName === 'antigravity' ? ['agentapi'] : [];
    const env = {
      ANTIGRAVITY_LS_ADDRESS: sess.ls_address,
      ANTIGRAVITY_CSRF_TOKEN: sess.csrf_token,
    };
    // `new-conversation` only CREATES the conversation: the app shows it in the
    // sidebar and leaves it idle until a message arrives. A second send-message
    // is what actually starts the agent (verified 2026-11-23: task stayed `open`
    // for 3+ minutes after new-conversation alone, claimed within 30s of the kick).
    const followUp = (stdout) => {
      const m = String(stdout || '').match(/"conversationId"\s*:\s*"([^"]+)"/);
      if (!m) return null;
      return {
        command: bin,
        args: [...base, 'send-message', m[1], '开始执行：立即执行上述 agentbus 任务。'],
        env,
      };
    };
    // Resuming: send the new task into the SAME conversation. A 503 retry or a
    // same-task retry then costs one sidebar entry instead of one per attempt.
    const title = `agentbus ${new Date().toISOString().slice(5, 10)} ${id || ''}`.trim();
    if (session) {
      return {
        command: bin,
        args: [...base, 'send-message', `--title=${title}`, session, oneLine],
        env,
        sessionFile,
        conversationTitle: title,
      };
    }
    return {
      command: bin,
      args: [
        ...base,
        'new-conversation',
        // The default tier can be out of capacity (503 "No capacity available
        // for model gemini-4-hydrogen-tiered-high"); AGENTBUS_AGY_MODEL=flash
        // pins a cheaper tier that answers instead of retrying forever.
        ...(model || process.env.AGENTBUS_AGY_MODEL ? [`--model=${model || process.env.AGENTBUS_AGY_MODEL}`] : []),
        `--title=${title}`,
        oneLine,
      ],
      env,
      sessionFile,
      followUp,
      conversationTitle: title,
    };
  },
};

export function listAdapters() {
  return Object.keys(BUILTIN);
}

function resolveAdapter(to, ctx) {
  const custom = process.env[`AGENTBUS_ADAPTER_${to.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  if (custom) {
    let spec;
    try {
      spec = JSON.parse(custom);
    } catch (e) {
      throw Object.assign(new Error(`AGENTBUS_ADAPTER_${to} 不是合法 JSON: ${e.message}`), { code: 1 });
    }
    return {
      command: spec.command,
      args: (spec.args || []).map((a) => String(a).replace('{prompt}', ctx.prompt)),
    };
  }
  const build = BUILTIN[to];
  if (!build) {
    throw Object.assign(new Error(`没有 ${to} 的调用适配器。已内置: ${listAdapters().join(', ')}；可用 AGENTBUS_ADAPTER_${to.toUpperCase()} 自定义`), { code: 1 });
  }
  return build(ctx);
}

export function buildPrompt(id, to, cwd, ctxRef = null) {
  const ctxLine = ctxRef
    ? `线程账本指针：先用 bus_ref_read 读取 ref ${ctxRef.name}（rev=${ctxRef.rev}, sha256=${ctxRef.sha256.slice(0, 12)}），仅遵守 confirmed 决策与最新 refs。`
    : null;
  return [
    `你是被主动调用的执行方。任务 id=${id}，领取者 by=${to}。`,
    '任务正文以 bus_task_claim 返回的 goal / constraints / refs / acceptance 为准（本消息不含完整正文）。',
    cwd ? `工作目录：${cwd}（所有产出写在此目录下，勿跨盘探索）` : null,
    ctxLine,
    '步骤：0) 长任务每 3-5 分钟调用 bus_task_heartbeat 续租，否则租约过期会被回收；',
    `1) 调用 bus_task_claim（id=${id}, by=${to}）领取并获取完整 goal 与 refs；`,
    '2) 用 bus_ref_read 逐个读 refs（resource_link 按 uri 自取）；',
    '3) 需要向主控提问/报阻塞/报进度用 bus_task_message，步骤间可用 bus_task_inbox 查主控回复；',
    '4) 产出结果后调用 bus_task_complete（非 JSON 产物勿传 fields）；完不成用 bus_task_fail 说明原因。',
  ].filter(Boolean).join('\n');
}

function winQuote(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

export function __runAdapter(spec, opts) {
  return runAdapter(spec, opts);
}

function runAdapter(spec, { cwd, timeout_s }) {
  return new Promise((resolve) => {
    const missing = (spec.requires || []).filter((k) => !process.env[k]);
    if (missing.length) {
      resolve({ ok: false, error: `缺少环境变量: ${missing.join(', ')}`, code: 'missing_env' });
      return;
    }
    const started = Date.now();
    let out = '';
    let err = '';
    let child;

    // Windows .cmd/.bat cannot be spawned directly; go through cmd.exe with an
    // explicitly quoted command line (no `shell: true`, which is deprecated for args).
    let command = spec.command;
    let args = spec.args;
    let extra = {};
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(spec.command)) {
      // cmd /s /c needs the whole command wrapped in one extra pair of quotes.
      const exe = String(spec.command).replace(/\//g, '\\');
      const inner = [exe, ...spec.args].map(winQuote).join(' ');
      const line = `"${inner}"`;
      const comspec = process.env.ComSpec && String(process.env.ComSpec).trim();
      const sysRootCmd = path.win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'cmd.exe');
      command = (comspec && existsSync(comspec))
        ? comspec
        : (existsSync(sysRootCmd) ? sysRootCmd : (existsSync('C:\\Windows\\System32\\cmd.exe') ? 'C:\\Windows\\System32\\cmd.exe' : 'cmd.exe'));
      args = ['/d', '/s', '/c', line];
      extra = { windowsVerbatimArguments: true };
    }

    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...(spec.env || {}) },
        stdio: [spec.stdinPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...extra,
      });
      if (spec.stdinPrompt) {
        child.stdin.write(spec.stdinPrompt);
        child.stdin.end();
      }
    } catch (e) {
      resolve({ ok: false, error: `启动失败: ${e.message}`, code: 'spawn_failed' });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch {}
    }, Math.max(1000, timeout_s * 1000));

    child.stdout.on('data', (d) => { out += d.toString('utf8'); if (out.length > 200000) out = out.slice(-200000); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); if (err.length > 200000) err = err.slice(-200000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e), code: 'spawn_failed', timed_out: timedOut }); });
    child.on('exit', async (code) => {
      clearTimeout(timer);
      const ok = !timedOut && code === 0;
      const base = {
        ok,
        exit: code,
        timed_out: timedOut,
        ...(timedOut ? { error: `adapter timeout after ${timeout_s}s` } : {}),
        seconds: Math.round((Date.now() - started) / 100) / 10,
        stdout: out,
        stderr: err,
      };
      if (!ok || typeof spec.followUp !== 'function') { resolve(base); return; }
      // Some CLIs (Antigravity) only stage the work on the first call; a second
      // call against the returned handle is what actually starts the run.
      let next = null;
      try { next = spec.followUp(out); } catch (e) { base.follow_up = { ok: false, error: String(e.message || e) }; resolve(base); return; }
      if (!next) { base.follow_up = { ok: false, error: 'followUp 未从输出里解析到句柄' }; resolve(base); return; }
      const fu = await runAdapter(next, { cwd, timeout_s });
      base.follow_up = { ok: fu.ok, exit: fu.exit, error: fu.error, seconds: fu.seconds, stderr: (fu.stderr || '').slice(-400) };
      resolve(base);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Guard CLI archive against hiding active or unverified conversations.
// By default only `--title-contains <task-id>` for a `done` task is allowed;
// `--title-prefix`, `<conversation-id>`, and unknown titles require `--force`.
export function checkArchiveGuard(bus, {
  conversationId = null,
  titlePrefix = null,
  titleContains = null,
  force = false,
} = {}) {
  if (!conversationId && !titlePrefix && !titleContains) {
    throw Object.assign(new Error('archive 需要 <conversation-id>、--title-prefix 或 --title-contains'), { code: 1 });
  }

  let task = null;
  let lookupErr = null;
  if (titleContains) {
    try {
      task = showTask(bus, titleContains);
    } catch (err) {
      lookupErr = err;
    }
  }

  const taskId = task?.id || null;
  const taskState = task?.state || null;

  if (force) {
    return {
      allowed: true,
      reason: null,
      code: 0,
      task_id: taskId,
      task_state: taskState,
      forced: true,
    };
  }

  if (titlePrefix) {
    return {
      allowed: false,
      reason: 'title_prefix_requires_force',
      code: 1,
      task_id: taskId,
      task_state: taskState,
    };
  }

  if (conversationId) {
    return {
      allowed: false,
      reason: 'conversation_id_requires_force',
      code: 1,
      task_id: taskId,
      task_state: taskState,
    };
  }

  if (lookupErr) {
    const msg = String(lookupErr?.message || lookupErr);
    const isAmbiguous = /前缀不唯一/.test(msg);
    return {
      allowed: false,
      reason: isAmbiguous ? 'ambiguous_task_id' : 'not_a_task',
      code: 1,
      task_id: null,
      task_state: null,
      ...(isAmbiguous ? { error: msg } : {}),
    };
  }

  if (task.state !== 'done') {
    return {
      allowed: false,
      reason: 'task_not_done',
      code: 2,
      task_id: task.id,
      task_state: task.state,
    };
  }

  return {
    allowed: true,
    reason: null,
    code: 0,
    task_id: task.id,
    task_state: task.state,
    forced: false,
  };
}

function resolveTaskConversationId(db, taskId) {
  if (!db || !taskId) return null;
  try {
    const th = db.prepare(
      "SELECT session_id FROM threads WHERE agent = 'antigravity' AND name = ?"
    ).get(`task:${taskId}`);
    if (th?.session_id) return String(th.session_id);
  } catch {}
  try {
    const evt = db.prepare(
      "SELECT payload_json FROM events WHERE task_id = ? AND event IN ('complete', 'recover_adopt') ORDER BY seq DESC LIMIT 1"
    ).get(taskId);
    if (evt?.payload_json) {
      const parsed = JSON.parse(evt.payload_json);
      if (parsed?.conversation_id) return String(parsed.conversation_id);
    }
  } catch {}
  return null;
}

export function shouldAutoArchiveTask(bus, taskId, opts = {}) {
  if (!bus || !taskId) return { eligible: false, row: null, conversationId: null };
  const row = bus.db.prepare('SELECT id, to_agent, state FROM tasks WHERE id = ?').get(taskId);
  if (!row || row.state !== 'done' || row.to_agent !== 'antigravity') {
    return { eligible: false, row: row || null, conversationId: null };
  }
  const cfg = readAgentConfig(bus.config.rootDir);
  const enabled = opts.forceEnable === true || process.env.AGENTBUS_ARCHIVE_ON_DONE === '1' || cfg.archive_on_done === true;
  if (!enabled) return { eligible: false, row, conversationId: null };
  const conversationId = opts.conversationId ?? resolveTaskConversationId(bus.db, row.id);
  return { eligible: true, row, conversationId };
}

function appendArchiveEventSafely(bus, rootDir, taskId, payload) {
  try {
    withImmediateTx(bus.db, () => appendEvent(bus.db, taskId, 'archive_on_done', payload));
    return;
  } catch {
    // Caller may have closed bus.db while a background archive retry was in flight.
  }
  if (!rootDir) return;
  let tmpBus = null;
  try {
    tmpBus = openBus({ rootOverride: rootDir });
    withImmediateTx(tmpBus.db, () => appendEvent(tmpBus.db, taskId, 'archive_on_done', payload));
  } catch (err) {
    process.stderr.write(`[agentbus] archive_on_done event write failed (${taskId}): ${err?.message || err}\n`);
  } finally {
    if (tmpBus) tmpBus.close();
  }
}

// Auto-archive must run after the task transitions to done, never on open/claimed
// tasks. Polls until the Antigravity sidebar row finishes its turn ("停止执行" ->
// "归档对话") or the bounded retry window expires, and records real attempts.
export async function maybeArchiveTask(bus, taskId, opts = {}) {
  const check = shouldAutoArchiveTask(bus, taskId, opts);
  if (!check.eligible) return null;
  const { row, conversationId } = check;
  const rootDir = bus.config?.rootDir || null;

  let payload;
  try {
    const res = await archiveTaskConversations({
      taskId: row.id,
      conversationId,
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.lagMs !== undefined ? { lagMs: opts.lagMs } : {}),
      ...(opts.retryIntervalMs !== undefined ? { retryIntervalMs: opts.retryIntervalMs } : {}),
      ...(opts.maxWaitMs !== undefined ? { maxWaitMs: opts.maxWaitMs } : {}),
      ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
      ...(opts.cdpMaxAttempts !== undefined ? { cdpMaxAttempts: opts.cdpMaxAttempts } : {}),
    });
    const archivedCount = Number(res?.archived_count ?? 0);
    const ok = Boolean(res?.ok && archivedCount > 0);
    payload = {
      archived_count: archivedCount,
      ok,
      attempts: Number(res?.attempts ?? 0),
      ...(res?.max_attempts !== undefined ? { max_attempts: res.max_attempts } : {}),
      ...(res?.elapsed_ms !== undefined ? { elapsed_ms: res.elapsed_ms } : {}),
      ...(res?.timed_out ? { timed_out: true } : {}),
      ...(conversationId ? { conversation_id: conversationId } : {}),
      reason: ok ? null : (res?.reason || res?.error || 'archive_failed'),
      ...(res?.error ? { error: res.error } : {}),
      ...(res?.last_reason ? { last_reason: res.last_reason } : {}),
      ...(Array.isArray(res?.archived_rows) && res.archived_rows.length ? { archived_rows: res.archived_rows } : {}),
    };
  } catch (err) {
    payload = {
      archived_count: 0,
      ok: false,
      attempts: 1,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      reason: 'archive_error',
      error: String(err?.message || err),
    };
  }
  appendArchiveEventSafely(bus, rootDir, row.id, payload);
  return payload;
}

const PENDING_ARCHIVES = new Set();

// Non-blocking background scheduler for long-lived processes (MCP server).
// Returning from bus_task_complete immediately lets Antigravity finish its turn
// and replace "停止执行" with "归档对话", after which the retry loop succeeds.
export function scheduleArchiveTask(bus, taskId, opts = {}) {
  const check = shouldAutoArchiveTask(bus, taskId, opts);
  if (!check.eligible) return null;
  const { row, conversationId } = check;
  const job = Promise.resolve()
    .then(() => maybeArchiveTask(bus, row.id, { ...opts, conversationId }))
    .catch((err) => {
      process.stderr.write(`[agentbus] background archive error (${row.id}): ${err?.message || err}\n`);
      return null;
    });
  PENDING_ARCHIVES.add(job);
  job.finally(() => {
    PENDING_ARCHIVES.delete(job);
  });
  return { scheduled: true, task_id: row.id, conversation_id: conversationId, promise: job };
}

export async function waitForPendingArchives(timeoutMs = 15000) {
  if (PENDING_ARCHIVES.size === 0) return;
  const all = Promise.allSettled(Array.from(PENDING_ARCHIVES));
  if (!timeoutMs || timeoutMs <= 0) {
    await all;
    return;
  }
  await Promise.race([all, sleep(timeoutMs)]);
}

// Non-blocking detached handoff for short-lived CLI commands (`agentbus done` / `recover`).
export async function spawnDetachedArchiveTask(bus, taskId, opts = {}) {
  const check = shouldAutoArchiveTask(bus, taskId, opts);
  if (!check.eligible) return null;
  if (process.env.AGENTBUS_ARCHIVE_SYNC === '1') {
    return maybeArchiveTask(bus, check.row.id, { ...opts, conversationId: check.conversationId });
  }
  try {
    const busBin = path.join(PKG_ROOT, 'bin', 'bus.js');
    const child = spawn(
      process.execPath,
      [busBin, 'archive-done', check.row.id, '--root', bus.config.rootDir],
      {
        cwd: PKG_ROOT,
        env: process.env,
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      }
    );
    child.unref();
    return { scheduled: true, detached: true, pid: child.pid || null, task_id: check.row.id };
  } catch {
    return maybeArchiveTask(bus, check.row.id, { ...opts, conversationId: check.conversationId });
  }
}

function isLeaseExpiredStalled(task) {
  if (!task || task.state !== 'open' || Number(task.attempt || 0) <= 0) return false;
  const hist = Array.isArray(task.history) ? task.history : [];
  const last = hist[hist.length - 1];
  return last?.by === 'system' && last?.reason === 'lease_expired';
}

// Async agents (Antigravity) may start the conversation minutes after the CLI
// returns. This lets the caller wait on the bus instead of on the child process.
export async function waitForTask(bus, id, timeout_s = 900, poll_ms = 250, opts = {}) {
  const started = Date.now();
  const deadline = started + Math.max(1, timeout_s) * 1000;
  let latest = showTask(bus, id);
  if (!latest) throw Object.assign(new Error(`找不到任务: ${id}`), { code: 1 });

  const hasSince = opts?.since_id !== undefined && Number.isFinite(Number(opts.since_id));
  const baselineSeq = hasSince ? Math.max(0, Number(opts.since_id)) : latestTaskMessageSeq(bus, latest.id);
  let attentionTriggered = false;
  let stalled = false;
  let stalledReason = null;
  let recoverHint = null;

  const markStalledIfExpired = (task) => {
    if (!isLeaseExpiredStalled(task)) return false;
    attentionTriggered = true;
    stalled = true;
    stalledReason = 'lease_expired';
    recoverHint = `任务 ${task.id} 租约已过期回到 open (attempt=${task.attempt})，建议调用 bus_task_recover / agentbus recover ${task.id} --action retry 或 reassign`;
    return true;
  };

  if (latest.state !== 'done' && latest.state !== 'failed') {
    if (markStalledIfExpired(latest)) {
      // stalled
    } else if (latest.blocked) {
      attentionTriggered = true;
    } else if (hasSince) {
      const initialDelta = listTaskMessages(bus, { id: latest.id, since_id: baselineSeq, limit: 50 });
      if (initialDelta.messages.some((m) => ATTENTION_MESSAGE_KINDS.has(m.kind))) {
        attentionTriggered = true;
      }
    }
  }

  const interval = Math.max(50, Math.min(Number(poll_ms) || 250, 30000));
  while (!attentionTriggered && latest && latest.state !== 'done' && latest.state !== 'failed' && Date.now() < deadline) {
    await sleep(interval);
    latest = showTask(bus, id);
    if (!latest || latest.state === 'done' || latest.state === 'failed') break;
    if (markStalledIfExpired(latest)) break;
    const delta = listTaskMessages(bus, { id: latest.id, since_id: baselineSeq, limit: 50 });
    if (latest.blocked || delta.messages.some((m) => ATTENTION_MESSAGE_KINDS.has(m.kind))) {
      attentionTriggered = true;
      break;
    }
  }

  const finalId = latest ? latest.id : id;
  const inbox = latest
    ? listTaskMessages(bus, { id: finalId, limit: 50 })
    : { messages: [], last_seq: baselineSeq, blocked: false, blocked_at: null };

  return {
    id: finalId,
    state: latest ? latest.state : 'missing',
    ok: latest ? latest.state === 'done' : false,
    blocked: latest ? Boolean(latest.blocked_at) : false,
    blocked_at: latest ? latest.blocked_at || null : null,
    needs_attention: attentionTriggered,
    stalled,
    reason: stalledReason,
    recover_hint: recoverHint,
    messages: inbox.messages,
    last_seq: inbox.last_seq,
    result: latest ? latest.result || null : null,
    waited_s: Math.round((Date.now() - started) / 100) / 10,
  };
}

function safeJsonParse(raw, fallback) {
  if (!raw || typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function normalizeWatchInterval(val, fallback = 5) {
  if (val === undefined || val === null) return fallback;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 2 || n > 30) {
    throw Object.assign(new Error(`--interval 必须在 2 到 30 秒之间: ${val}`), { code: 1 });
  }
  return n;
}

export function normalizeWatchTimeout(val, fallback = 3600) {
  if (val === undefined || val === null) return fallback;
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error(`--timeout 必须是正数: ${val}`), { code: 1 });
  }
  return n;
}

function inspectWatchRow(row, nowIsoStr) {
  const state = row.state;
  const blockedAt = row.blocked_at || null;
  const blocked = Boolean(blockedAt);
  const finishedAt = row.finished_at || null;
  const result = safeJsonParse(row.result_json, null);
  const history = safeJsonParse(row.history_json, []);
  const reapedStalled = isLeaseExpiredStalled({ state, attempt: row.attempt, history });
  const unreapedExpired = state === 'claimed' && Boolean(row.lease_expires_at) && String(row.lease_expires_at) <= nowIsoStr;
  const stalled = reapedStalled || unreapedExpired;

  let done = false;
  let reason = null;
  if (state === 'done') {
    done = true;
  } else if (state === 'failed') {
    done = true;
    reason = 'failed';
  } else if (stalled) {
    done = true;
    reason = 'lease_expired';
  } else if (blocked) {
    done = true;
    reason = 'blocked';
  }

  return {
    done,
    state,
    ok: state === 'done',
    blocked,
    blocked_at: blockedAt,
    finished_at: finishedAt,
    result,
    stalled,
    reason,
  };
}

// Low-overhead, read-only, TTY-free single-task watcher for background polling.
export async function watchTask({
  rootOverride = null,
  dbPath = null,
  id,
  interval_s = 5,
  timeout_s = 3600,
} = {}) {
  if (!id || typeof id !== 'string' || !id.trim()) {
    throw Object.assign(new Error('缺少任务 id: agentbus watch <task-id>'), { code: 1 });
  }
  const intervalS = normalizeWatchInterval(interval_s, 5);
  const timeoutS = normalizeWatchTimeout(timeout_s, 3600);
  const started = Date.now();
  const deadline = started + timeoutS * 1000;
  const intervalMs = intervalS * 1000;

  let busHandle = null;
  let db;
  if (dbPath) {
    if (!existsSync(dbPath)) {
      throw Object.assign(new Error(`找不到总线数据库: ${dbPath}`), { code: 1 });
    }
    db = new DatabaseSync(dbPath, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 5000;'); } catch {}
  } else {
    busHandle = openBusReadOnly({ rootOverride });
    db = busHandle.db;
  }

  try {
    const exact = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
    let resolvedId = exact?.id || null;
    if (!resolvedId) {
      const hits = db.prepare('SELECT id FROM tasks WHERE id LIKE ? LIMIT 5').all(`${id}%`);
      if (hits.length === 1) resolvedId = hits[0].id;
      else if (hits.length > 1) {
        throw Object.assign(new Error(`task id 前缀不唯一: ${id} -> ${hits.map((h) => h.id).join(', ')}`), { code: 1 });
      } else {
        throw Object.assign(new Error(`找不到任务: ${id}`), { code: 1 });
      }
    }

    const cols = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((r) => r.name));
    const wantedCols = ['id', 'state', 'attempt', 'lease_expires_at', 'blocked_at', 'finished_at', 'result_json', 'history_json']
      .filter((c) => cols.has(c));
    const rowStmt = db.prepare(`SELECT ${wantedCols.join(', ')} FROM tasks WHERE id = ?`);

    const buildOut = (snap, timedOut = false) => ({
      id: resolvedId,
      state: snap.state,
      ok: snap.ok,
      blocked: snap.blocked,
      blocked_at: snap.blocked_at,
      finished_at: snap.finished_at,
      result: snap.result,
      stalled: snap.stalled,
      timed_out: timedOut,
      reason: timedOut ? 'timeout' : snap.reason,
      waited_s: Math.round((Date.now() - started) / 100) / 10,
    });

    let row = rowStmt.get(resolvedId);
    if (!row) {
      throw Object.assign(new Error(`找不到任务: ${resolvedId}`), { code: 1 });
    }
    let snap = inspectWatchRow(row, new Date().toISOString());
    if (snap.done) {
      return buildOut(snap, false);
    }

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(intervalMs, Math.max(50, remaining)));
      row = rowStmt.get(resolvedId);
      if (!row) {
        return {
          id: resolvedId,
          state: 'missing',
          ok: false,
          blocked: false,
          blocked_at: null,
          finished_at: null,
          result: null,
          stalled: false,
          timed_out: false,
          reason: 'missing',
          waited_s: Math.round((Date.now() - started) / 100) / 10,
        };
      }
      snap = inspectWatchRow(row, new Date().toISOString());
      if (snap.done) {
        return buildOut(snap, false);
      }
    }

    return buildOut(snap, true);
  } finally {
    if (busHandle) busHandle.close();
    else { try { db.close(); } catch {} }
  }
}

function agentHealth(bus, agent) {
  const row = bus.db.prepare('SELECT cooldown_until, reason FROM agent_health WHERE agent = ?').get(agent);
  if (!row || !row.cooldown_until) return null;
  return new Date(row.cooldown_until).getTime() > Date.now() ? row : null;
}

function markAgentHealth(bus, agent, { ok, text = '' }) {
  const at = new Date().toISOString();
  if (ok) {
    bus.db.prepare(
      'INSERT INTO agent_health (agent, cooldown_until, reason, fails, updated_at) VALUES (?, NULL, NULL, 0, ?) ' +
      'ON CONFLICT(agent) DO UPDATE SET cooldown_until = NULL, reason = NULL, fails = 0, updated_at = excluded.updated_at',
    ).run(agent, at);
    return null;
  }
  const capacity = /503|No capacity|UNAVAILABLE|overloaded|capacity/i.test(text);
  const cooldownS = Number(process.env.AGENTBUS_COOLDOWN_S || (capacity ? 900 : 120));
  const until = new Date(Date.now() + cooldownS * 1000).toISOString();
  bus.db.prepare(
    'INSERT INTO agent_health (agent, cooldown_until, reason, fails, updated_at) VALUES (?, ?, ?, 1, ?) ' +
    'ON CONFLICT(agent) DO UPDATE SET cooldown_until = excluded.cooldown_until, reason = excluded.reason, fails = fails + 1, updated_at = excluded.updated_at',
  ).run(agent, until, capacity ? 'capacity/503' : 'adapter failure', at);
  return { cooldown_until: until, reason: capacity ? 'capacity/503' : 'adapter failure' };
}

function modelCandidates(root, agent) {
  const first = modelFor(root, agent);
  const extra = String(process.env.AGENTBUS_FALLBACK_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const list = [first, ...extra, ...(KNOWN_MODELS[agent] || []), null];
  const seen = new Set();
  const out = [];
  for (const m of list) {
    const key = m || '(default)';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

function looksLikeModelFailure(text) {
  return /model_not_found|not supported|invalid model|unknown model|No capacity|UNAVAILABLE|503|capacity/i.test(text || '');
}

function shouldPersistThread({ latest, adapterResult, effectiveSession, steps, resumed }) {
  if (!effectiveSession) return { action: 'skip', reason: 'no_session' };
  if (latest.state === 'failed') return { action: 'invalidate', reason: 'task_failed' };
  const text = `${adapterResult?.stdout || ''}${adapterResult?.stderr || ''}`;
  const modelErr = looksLikeModelFailure(text);
  const fastFail = adapterResult?.ok === false && (adapterResult?.seconds ?? 0) < 10;
  if (latest.state !== 'done' && (modelErr || fastFail)) {
    return { action: resumed ? 'invalidate' : 'skip', reason: modelErr ? 'model_failure' : 'fast_fail' };
  }
  const emptyNew = !resumed && latest.state === 'open' && adapterResult?.ok === false && (steps ?? 0) === 0;
  if (emptyNew) return { action: 'skip', reason: 'empty_conversation' };
  return { action: 'save', lastOk: 1 };
}

export async function dispatchTask(bus, {
  id,
  cwd,
  wait_s = 600,
  poll_ms = 150,
  env = {},
  thread = null,
  force = false,
  watch = false,
  watch_interval_s = 5,
  watch_timeout_s = 3600,
}) {
  const t0 = Date.now();
  const watchIntervalS = watch ? normalizeWatchInterval(watch_interval_s, 5) : 5;
  const watchTimeoutS = watch ? normalizeWatchTimeout(watch_timeout_s, 3600) : 3600;
  const task = showTask(bus, id);
  if (!task) throw Object.assign(new Error(`找不到任务: ${id}`), { code: 1 });
  if (task.state === 'done' || task.state === 'failed') {
    const inbox = listTaskMessages(bus, { id: task.id, limit: 20 });
    return {
      id: task.id,
      state: task.state,
      dispatched: false,
      reason: 'already_terminal',
      result: task.result || null,
      blocked: inbox.blocked,
      blocked_at: inbox.blocked_at,
      messages: inbox.messages,
    };
  }
  const workdir = cwd || process.cwd();
  if (!existsSync(workdir)) throw Object.assign(new Error(`cwd 不存在: ${workdir}`), { code: 1 });

  const health = force ? null : agentHealth(bus, task.to);
  if (health) {
    const inbox = listTaskMessages(bus, { id: task.id, limit: 20 });
    return {
      id: task.id,
      to: task.to,
      state: task.state,
      ok: false,
      dispatched: false,
      skipped: true,
      reason: 'cooldown',
      elapsed_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
      cooldown_until: health.cooldown_until,
      detail: health.reason,
      blocked: inbox.blocked,
      blocked_at: inbox.blocked_at,
      messages: inbox.messages,
      hint: `该 agent 冷却中（${health.reason}，到 ${health.cooldown_until}）；确认要重试就加 --force`,
    };
  }

  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const candidates = modelCandidates(bus.config.rootDir, task.to);
  const initialModel = candidates[0] ?? null;

  // Retries of the same task reuse one conversation (`task:<id>`); explicit
  // --thread shares context across tasks (and reuses sessions only when allowed by client policy).
  const threadName = thread || `task:${task.id}`;
  if (thread) {
    withImmediateTx(bus.db, () => {
      bus.db.prepare("UPDATE tasks SET thread_name = ? WHERE id = ? AND (thread_name IS NULL OR thread_name = '')")
        .run(threadName, task.id);
    });
  }

  const policy = resolveClientPolicy(task.to, bus.config.rootDir, process.env, bus.config.threadLimits);
  const th = getThread(bus, task.to, threadName, {
    cwd: workdir,
    model: initialModel,
    constraints: task.constraints,
    explicitThreadOverride: policy.allow_cross_task === true,
  });

  let rotatedFrom = null;
  let ctxRef = null;
  if (th.rotatedReason && thread) {
    rotatedFrom = th.prevRow?.session_id || null;
    ctxRef = rotateThreadWithSnapshot(bus, {
      threadName,
      taskId: task.id,
      agent: task.to,
      cwd: workdir,
      model: initialModel,
      reason: th.rotatedReason,
      prevRow: th.prevRow,
    });
  } else if (thread && !contextLedgerDisabled()) {
    ctxRef = getExistingContextRef(bus, threadName);
  }
  if (ctxRef && task.state === 'open') {
    attachContextRefIfOpen(bus, task.id, ctxRef);
  }

  withImmediateTx(bus.db, () => {
    appendEvent(bus.db, task.id, 'dispatch', {
      agent: task.to,
      thread: threadName,
      resumed: Boolean(th.sessionId),
      rotated_reason: th.rotatedReason || null,
    });
  });

  const multi = candidates.length > 1;
  const totalDeadline = Date.now() + Math.max(5, wait_s) * 1000;

  let latest = task;
  let lastSpec = null;
  let lastRun = null;
  let usedModel = null;
  let finalAttemptIndex = 0;
  let finalAttemptCaptured = null;
  const attempts = [];

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    const remainingMs = totalDeadline - Date.now();
    if (i > 0 && remainingMs < 15000) break;

    // With fallbacks available, do not burn the whole budget on the first model.
    const budgetS = i === 0
      ? Math.max(5, Math.min(wait_s, multi ? 120 : wait_s))
      : Math.max(15, Math.min(120, Math.floor(remainingMs / 1000)));

    const spec = resolveAdapter(task.to, {
      prompt: buildPrompt(task.id, task.to, workdir, ctxRef),
      cwd: workdir,
      busRoot: bus.config.rootDir,
      session: i === 0 ? th.sessionId : null,
      id: task.id,
      model,
    });

    const run = runAdapter(spec, { cwd: workdir, timeout_s: budgetS });

    // Poll the bus while the adapter runs; the adapter's own exit is not proof of work.
    const deadline = Date.now() + budgetS * 1000;
    let abortWait = false;
    const watchStart = Date.now();
    const watcher = (async () => {
      while (Date.now() < deadline && !abortWait) {
        // Tight polling for the first seconds (most agents claim/complain fast),
        // then back off so long waits stay cheap.
        const interval = Date.now() - watchStart < 8000 ? Math.min(poll_ms, 150) : Math.max(poll_ms, 400);
        await sleep(interval);
        const t = showTask(bus, id);
        if (!t) break;
        latest = t;
        if (t.state === 'done' || t.state === 'failed') break;
      }
    })();

    const adapterResult = await run;

    // A model/selection error or fast-crashing open adapter will never resolve by waiting out the budget.
    if (latest.state !== 'done' && latest.state !== 'failed' &&
        (looksLikeModelFailure(`${adapterResult.stdout || ''}${adapterResult.stderr || ''}`) ||
         (adapterResult.ok === false && latest.state === 'open'))) {
      abortWait = true;
    }
    await watcher;

    lastSpec = spec;
    lastRun = adapterResult;
    usedModel = model;
    finalAttemptIndex = i;
    finalAttemptCaptured = extractSession(`${adapterResult.stdout || ''}${adapterResult.stderr || ''}`);

    attempts.push({
      model: model || '(default)',
      state: latest.state,
      exit: adapterResult.exit ?? null,
      seconds: adapterResult.seconds ?? null,
    });

    if (latest.state === 'done') break;

    const text = `${adapterResult.stdout || ''}${adapterResult.stderr || ''}`;
    const modelIssue = looksLikeModelFailure(text);
    const asyncUnpicked = latest.state === 'open' && task.to === 'antigravity';
    if (!modelIssue && !asyncUnpicked) break;
    if (i + 1 >= candidates.length) break;
  }

  // Fallback loop isolation: if i > 0 ran fresh, NEVER inherit i=0's failed sessionId.
  const effectiveResumed = Boolean(finalAttemptIndex === 0 && th.sessionId);
  const effectiveSession = finalAttemptIndex === 0
    ? (finalAttemptCaptured || th.sessionId || null)
    : (finalAttemptCaptured || null);

  const stepInfo = effectiveSession
    ? resolveThreadSteps({
        agent: task.to,
        sessionId: effectiveSession,
        stdout: lastRun?.stdout || '',
        prevRow: effectiveResumed ? th.prevRow : null,
      })
    : { steps: 0, stepSource: 'unknown' };

  // Codex exec threads are invisible in the Desktop project until they are
  // attached to a project and re-labelled. Do it after the CLI has written the
  // thread, before returning the dispatch result. Best-effort and non-fatal.
  let codexAppLink = null;
  if (task.to === 'codex' && effectiveSession) {
    codexAppLink = linkCodexThreadToApp({
      threadId: effectiveSession,
      cwd: workdir,
      taskId: task.id,
    });
  }

  const persist = shouldPersistThread({
    latest,
    adapterResult: lastRun,
    effectiveSession,
    steps: stepInfo.steps,
    resumed: effectiveResumed,
  });

  if (!thread && (latest.state === 'done' || latest.state === 'failed')) {
    clearThread(bus, task.to, threadName);
  } else if (persist.action === 'save') {
    if (effectiveResumed) touchThread(bus, task.to, threadName);
    setThread(bus, task.to, threadName, effectiveSession, {
      cwd: workdir,
      model: usedModel ?? null,
      steps: stepInfo.steps,
      stepSource: stepInfo.stepSource,
      lastOk: persist.lastOk,
      resumed: effectiveResumed,
      rotatedFrom,
    });
  } else if (persist.action === 'invalidate') {
    if (!thread) clearThread(bus, task.to, threadName);
    else if (effectiveResumed) invalidateThread(bus, task.to, threadName);
  }

  if (thread && !contextLedgerDisabled()) {
    try {
      if (latest.state === 'done') {
        recordContextOutcome(bus, threadName, {
          task: latest,
          status: 'done',
          result: latest.result,
          actor: 'conductor',
          cwd: workdir,
          model: usedModel ?? null,
        });
      } else if (latest.state === 'failed' || persist.action === 'invalidate' || persist.reason === 'model_failure') {
        recordContextOutcome(bus, threadName, {
          task: latest,
          status: 'failed',
          reason: persist.reason || 'task_failed',
          actor: 'system',
          cwd: workdir,
          model: usedModel ?? null,
        });
      }
    } catch {}
  }

  const healthAfter = markAgentHealth(bus, task.to, {
    ok: latest.state === 'done',
    text: `${lastRun?.stdout || ''}${lastRun?.stderr || ''}`,
  });

  const stdoutTail = (lastRun?.stdout || '').slice(-1500);
  const stderrTail = (lastRun?.stderr || '').slice(-800);
  const runText = `${lastRun?.stdout || ''}\n${lastRun?.stderr || ''}`;
  const dispatchFailed = Boolean(lastRun && (lastRun.ok === false || lastRun.timed_out || looksLikeModelFailure(runText)));

  if (dispatchFailed && latest.state !== 'done' && latest.state !== 'failed') {
    const reason = lastRun.timed_out
      ? (lastRun.error || 'dispatch 超时')
      : looksLikeModelFailure(runText)
        ? `模型不可用或容量不足: ${lastRun.error || `adapter exit ${lastRun.exit}`}`
        : (lastRun.error || `adapter 非零退出 (exit=${lastRun.exit})`);
    const parts = [reason];
    if (stderrTail.trim()) parts.push(`stderr_tail:\n${stderrTail.trim()}`);
    if (stdoutTail.trim()) parts.push(`stdout_tail:\n${stdoutTail.trim()}`);
    const errBody = parts.join('\n').slice(0, 16000);
    const now = new Date().toISOString();
    withImmediateTx(bus.db, () => {
      const info = bus.db.prepare(
        'INSERT INTO task_messages (task_id, from_agent, to_agent, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(task.id, task.to, task.from || null, 'error', errBody, now);
      bus.db.prepare(
        'UPDATE tasks SET last_message_at = ?, blocked_at = COALESCE(blocked_at, ?) WHERE id = ?'
      ).run(now, now, task.id);
      appendEvent(bus.db, task.id, 'message', {
        seq: Number(info.lastInsertRowid),
        from: task.to,
        to: task.from || null,
        kind: 'error',
        body: errBody.slice(0, 240),
      });
    });
  }

  const inbox = listTaskMessages(bus, { id: task.id, limit: 20 });

  const out = {
    id: task.id,
    to: task.to,
    state: latest.state,
    ok: latest.state === 'done',
    dispatched: true,
    model: usedModel || undefined,
    attempts: attempts.length > 1 ? attempts : undefined,
    elapsed_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
    health: healthAfter || undefined,
    blocked: inbox.blocked,
    blocked_at: inbox.blocked_at,
    messages: inbox.messages,
    thread: {
      name: threadName,
      session: effectiveSession,
      resumed: effectiveResumed,
      auto: !thread,
      ...(th.rotatedReason ? { rotated_reason: th.rotatedReason } : {}),
      steps: stepInfo.steps,
      step_source: stepInfo.stepSource,
    },
    codex_app: codexAppLink || undefined,
    adapter: lastSpec
      ? { command: lastSpec.command, exit: lastRun?.exit ?? null, seconds: lastRun?.seconds ?? null }
      : undefined,
    result: latest.result || null,
    hint: inbox.blocked
      ? `任务已阻塞/等待回复；查看 messages 后用 bus_task_message(kind="answer") 回复`
      : latest.state === 'open' || latest.state === 'claimed'
        ? `任务还在进行；用 agentbus wait ${task.id} --timeout 900 继续等`
        : undefined,
    stdout_tail: stdoutTail,
    stderr_tail: stderrTail,
    error: lastRun && lastRun.ok === false ? lastRun.error || `adapter exit ${lastRun.exit}` : undefined,
  };

  if (!watch) return out;

  if ((out.state === 'open' || out.state === 'claimed') && !out.blocked && !isLeaseExpiredStalled(latest)) {
    const w = await watchTask({
      dbPath: bus.config.dbPath,
      id: out.id,
      interval_s: watchIntervalS,
      timeout_s: watchTimeoutS,
    });
    out.state = w.state;
    out.ok = w.ok;
    out.blocked = w.blocked;
    out.blocked_at = w.blocked_at;
    out.finished_at = w.finished_at;
    out.result = w.result;
    out.stalled = w.stalled;
    out.timed_out = w.timed_out;
    out.waited_s = w.waited_s;
    out.elapsed_s = Number(((Date.now() - t0) / 1000).toFixed(1));
    out.watch = w;
    if (w.state === 'done') {
      markAgentHealth(bus, task.to, { ok: true });
      delete out.health;
    }
    if (w.state === 'done' || w.state === 'failed' || w.blocked || w.stalled) {
      delete out.hint;
    }
  } else {
    out.finished_at = latest.finished_at || null;
    out.stalled = isLeaseExpiredStalled(latest);
    out.timed_out = false;
  }
  return out;
}
