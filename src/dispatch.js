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
import { showTask } from './tasks.js';
import { defaultAgySessionPath, readAgySession, detectAgentApi, discoverAgySession } from './agy.js';
import { modelFor, KNOWN_MODELS } from './agents.js';

export function dispatchEnabled(flag) {
  return !!flag || process.env.AGENTBUS_ENABLE_DISPATCH === '1';
}

// Session affinity, borrowed from magpie's Claude bridge: a conversation's
// turns must find the same underlying session, not start cold each time.
function getThread(bus, agent, name) {
  const row = bus.db.prepare('SELECT session_id FROM threads WHERE agent = ? AND name = ?').get(agent, name);
  return row ? row.session_id : null;
}

function setThread(bus, agent, name, sessionId) {
  bus.db.prepare(
    'INSERT INTO threads (agent, name, session_id, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(agent, name) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at',
  ).run(agent, name, sessionId, new Date().toISOString());
}

function extractSession(stdout) {
  const m = stdout.match(/"thread_id"\s*:\s*"([^"]+)"/) || stdout.match(/"session_id"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

const BUILTIN = {
  codex: ({ prompt, cwd, session, model }) => {
    const bin = process.env.AGENTBUS_CODEX_BIN || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
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
    command: 'claude',
    args: [...(model ? ['--model', model] : []), '-p', prompt, '--permission-mode', 'acceptEdits'],
  }),
  gemini: ({ prompt, model }) => ({
    command: 'gemini',
    args: [...(model ? ['-m', model] : []), '-p', prompt, '--yolo'],
  }),
  antigravity: ({ prompt, busRoot, id, model }) => {
    const bin = detectAgentApi();
    if (!bin) {
      throw Object.assign(new Error(
        '找不到 Antigravity 的 agentapi（预期 ~/.gemini/antigravity/bin/agentapi.bat）；可用 AGENTBUS_ANTIGRAVITY_BIN 指定',
      ), { code: 1 });
    }
    const sessionFile = defaultAgySessionPath(busRoot);
    let sess;
    try {
      sess = readAgySession(sessionFile);
    } catch (err) {
      // No exported file: fall back to the daemon hub, which the running app
      // rewrites on every start. If both are missing, surface the export hint.
      const found = discoverAgySession();
      if (!found) throw err;
      sess = found;
    }
    // agentapi takes the prompt as one positional argument; newlines would break
    // the Windows command line, so collapse them into separators.
    const oneLine = String(prompt).replace(/\s*\n+\s*/g, '；');
    const isWrapper = /\.(bat|cmd)$/i.test(bin);
    const base = isWrapper ? [] : ['agentapi'];
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
    return {
      command: bin,
      args: [
        ...base,
        'new-conversation',
        // The default tier can be out of capacity (503 "No capacity available
        // for model gemini-4-hydrogen-tiered-high"); AGENTBUS_AGY_MODEL=flash
        // pins a cheaper tier that answers instead of retrying forever.
        ...(model || process.env.AGENTBUS_AGY_MODEL ? [`--model=${model || process.env.AGENTBUS_AGY_MODEL}`] : []),
        `--title=agentbus ${id || ''}`.trim(),
        oneLine,
      ],
      env,
      sessionFile,
      followUp,
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

function buildPrompt(id, goal, to, cwd) {
  return [
    `你是被主动调用的执行方。任务 id=${id}。`,
    `目标：${goal}`,
    cwd ? `工作目录：${cwd}（所有产出必须写在这个目录下，不要到别的盘或用户目录里探索）` : null,
    `步骤：1) bus_task_claim 领取，by 必须写 "${to}"；`,
    '2) bus_ref_read 逐个读 refs，返回 resource_link 的按 uri 自己读文件；',
    '3) 按需求产出结果文件；',
    '4) bus_task_complete 交回，fields 用你实际算出的值。',
    '注意：如果产出不是 JSON，就不要传 fields——传了会强制按 JSON 校验结果文件。',
    '不要跳过 complete；完不成用 bus_task_fail 说明原因。',
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
      command = process.env.ComSpec || 'cmd.exe';
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
    const timer = setTimeout(() => {
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
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e), code: 'spawn_failed' }); });
    child.on('exit', async (code) => {
      clearTimeout(timer);
      const base = { ok: code === 0, exit: code, seconds: Math.round((Date.now() - started) / 100) / 10, stdout: out, stderr: err };
      if (code !== 0 || typeof spec.followUp !== 'function') { resolve(base); return; }
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

// Async agents (Antigravity) may start the conversation minutes after the CLI
// returns. This lets the caller wait on the bus instead of on the child process.
export async function waitForTask(bus, id, timeout_s = 900, poll_ms = 1000) {
  const started = Date.now();
  const deadline = started + Math.max(1, timeout_s) * 1000;
  let latest = showTask(bus, id);
  if (!latest) throw Object.assign(new Error(`找不到任务: ${id}`), { code: 1 });
  while (latest.state !== 'done' && latest.state !== 'failed' && Date.now() < deadline) {
    await sleep(poll_ms);
    latest = showTask(bus, id);
    if (!latest) break;
  }
  return {
    id,
    state: latest ? latest.state : 'missing',
    ok: latest ? latest.state === 'done' : false,
    result: latest ? latest.result || null : null,
    waited_s: Math.round((Date.now() - started) / 100) / 10,
  };
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

export async function dispatchTask(bus, { id, cwd, wait_s = 600, poll_ms = 700, env = {}, thread = null, force = false }) {
  const task = showTask(bus, id);
  if (!task) throw Object.assign(new Error(`找不到任务: ${id}`), { code: 1 });
  if (task.state === 'done' || task.state === 'failed') {
    return { id: task.id, state: task.state, dispatched: false, reason: 'already_terminal', result: task.result || null };
  }
  const workdir = cwd || process.cwd();
  if (!existsSync(workdir)) throw Object.assign(new Error(`cwd 不存在: ${workdir}`), { code: 1 });

  const health = force ? null : agentHealth(bus, task.to);
  if (health) {
    return {
      id: task.id,
      to: task.to,
      state: task.state,
      ok: false,
      dispatched: false,
      skipped: true,
      reason: 'cooldown',
      cooldown_until: health.cooldown_until,
      detail: health.reason,
      hint: `该 agent 冷却中（${health.reason}，到 ${health.cooldown_until}）；确认要重试就加 --force`,
    };
  }

  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const session = thread ? getThread(bus, task.to, thread) : null;
  const candidates = modelCandidates(bus.config.rootDir, task.to);
  const multi = candidates.length > 1;
  const totalDeadline = Date.now() + Math.max(5, wait_s) * 1000;

  let latest = task;
  let lastSpec = null;
  let lastRun = null;
  let usedModel = null;
  let sessionId = session;
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
      prompt: buildPrompt(task.id, task.goal, task.to, workdir),
      cwd: workdir,
      busRoot: bus.config.rootDir,
      session: sessionId,
      id: task.id,
      model,
    });

    const run = runAdapter(spec, { cwd: workdir, timeout_s: budgetS });

    // Poll the bus while the adapter runs; the adapter's own exit is not proof of work.
    const deadline = Date.now() + budgetS * 1000;
    let abortWait = false;
    const watcher = (async () => {
      while (Date.now() < deadline && !abortWait) {
        await sleep(poll_ms);
        const t = showTask(bus, id);
        if (!t) break;
        latest = t;
        if (t.state === 'done' || t.state === 'failed') break;
      }
    })();

    const adapterResult = await run;

    // A model/selection error will never resolve by waiting out the budget.
    if (latest.state !== 'done' && latest.state !== 'failed' &&
        looksLikeModelFailure(`${adapterResult.stdout || ''}${adapterResult.stderr || ''}`)) {
      abortWait = true;
    }
    await watcher;

    lastSpec = spec;
    lastRun = adapterResult;
    usedModel = model;

    if (thread && !sessionId) {
      const found = extractSession(adapterResult.stdout || '');
      if (found) {
        setThread(bus, task.to, thread, found);
        sessionId = found;
      }
    }

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

  const healthAfter = markAgentHealth(bus, task.to, {
    ok: latest.state === 'done',
    text: `${lastRun?.stdout || ''}${lastRun?.stderr || ''}`,
  });

  return {
    id: task.id,
    to: task.to,
    state: latest.state,
    ok: latest.state === 'done',
    dispatched: true,
    model: usedModel || undefined,
    attempts: attempts.length > 1 ? attempts : undefined,
    health: healthAfter || undefined,
    thread: thread ? { name: thread, session: sessionId, resumed: !!session } : undefined,
    adapter: lastSpec
      ? { command: lastSpec.command, exit: lastRun?.exit ?? null, seconds: lastRun?.seconds ?? null }
      : undefined,
    result: latest.result || null,
    hint: latest.state === 'open' || latest.state === 'claimed'
      ? `任务还在进行；用 agentbus wait ${task.id} --timeout 900 继续等`
      : undefined,
    stdout_tail: (lastRun?.stdout || '').slice(-1500),
    stderr_tail: (lastRun?.stderr || '').slice(-800),
    error: lastRun && lastRun.ok === false ? lastRun.error || `adapter exit ${lastRun.exit}` : undefined,
  };
}
