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
import { defaultAgySessionPath, readAgySession, detectAgentApi } from './agy.js';

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
  codex: ({ prompt, cwd, session }) => {
    const bin = process.env.AGENTBUS_CODEX_BIN || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
    const base = ['exec'];
    if (session) {
      // Session affinity (the magpie idea): a thread's next task resumes the
      // same Codex conversation instead of starting cold and re-reading context.
      return {
        command: bin,
        // `resume` has no --approve-for-me; MCP calls need approvals bypassed.
        // Documented in SECURITY.md: resume runs unsandboxed by Codex's own rules.
        args: [...base, 'resume', session, '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-'],
        stdinPrompt: prompt,
        keepsSession: true,
      };
    }
    return {
      // The prompt goes over stdin ("-"): no quoting problems on any platform.
      command: bin,
      args: [...base, '--json', '--approve-for-me', '--skip-git-repo-check', '-C', cwd, '-'],
      stdinPrompt: prompt,
    };
  },
  claude: ({ prompt }) => ({
    command: 'claude',
    args: ['-p', prompt, '--permission-mode', 'acceptEdits'],
  }),
  gemini: ({ prompt }) => ({
    command: 'gemini',
    args: ['-p', prompt, '--yolo'],
  }),
  antigravity: ({ prompt, busRoot, id }) => {
    const bin = detectAgentApi();
    if (!bin) {
      throw Object.assign(new Error(
        '找不到 Antigravity 的 agentapi（预期 ~/.gemini/antigravity/bin/agentapi.bat）；可用 AGENTBUS_ANTIGRAVITY_BIN 指定',
      ), { code: 1 });
    }
    const sessionFile = defaultAgySessionPath(busRoot);
    const sess = readAgySession(sessionFile);
    // agentapi takes the prompt as one positional argument; newlines would break
    // the Windows command line, so collapse them into separators.
    const oneLine = String(prompt).replace(/\s*\n+\s*/g, '；');
    const isWrapper = /\.(bat|cmd)$/i.test(bin);
    const args = [
      ...(isWrapper ? [] : ['agentapi']),
      'new-conversation',
      `--title=agentbus ${id || ''}`.trim(),
      oneLine,
    ];
    return {
      command: bin,
      args,
      env: {
        ANTIGRAVITY_LS_ADDRESS: sess.ls_address,
        ANTIGRAVITY_CSRF_TOKEN: sess.csrf_token,
      },
      sessionFile,
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

function buildPrompt(id, goal) {
  return [
    `你是被主动调用的执行方。任务 id=${id}。`,
    `目标：${goal}`,
    '步骤：1) bus_task_claim 领取（by 用你自己的 agent 名）；',
    '2) bus_ref_read 逐个读 refs，返回 resource_link 的按 uri 自己读文件；',
    '3) 按需求产出结果文件；',
    '4) bus_task_complete 交回，fields 用你实际算出的值。',
    '不要跳过 complete；完不成用 bus_task_fail 说明原因。',
  ].join('\n');
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
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exit: code, seconds: Math.round((Date.now() - started) / 100) / 10, stdout: out, stderr: err });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function dispatchTask(bus, { id, cwd, wait_s = 600, poll_ms = 700, env = {}, thread = null }) {
  const task = showTask(bus, id);
  if (!task) throw Object.assign(new Error(`找不到任务: ${id}`), { code: 1 });
  if (task.state === 'done' || task.state === 'failed') {
    return { id: task.id, state: task.state, dispatched: false, reason: 'already_terminal', result: task.result || null };
  }
  const workdir = cwd || process.cwd();
  if (!existsSync(workdir)) throw Object.assign(new Error(`cwd 不存在: ${workdir}`), { code: 1 });

  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const session = thread ? getThread(bus, task.to, thread) : null;
  const spec = resolveAdapter(task.to, {
    prompt: buildPrompt(task.id, task.goal),
    cwd: workdir,
    busRoot: bus.config.rootDir,
    session,
    id: task.id,
  });

  const run = runAdapter(spec, { cwd: workdir, timeout_s: Math.max(5, wait_s) });

  // Poll the bus while the adapter runs; the adapter's own exit is not proof of work.
  const deadline = Date.now() + Math.max(5, wait_s) * 1000;
  let latest = task;
  let finished = false;
  const watcher = (async () => {
    while (Date.now() < deadline) {
      await sleep(poll_ms);
      const t = showTask(bus, id);
      if (!t) break;
      latest = t;
      if (t.state === 'done' || t.state === 'failed') { finished = true; break; }
    }
  })();

  const adapterResult = await run;
  await watcher;

  let sessionId = session;
  if (thread && !sessionId) {
    const found = extractSession(adapterResult.stdout || '');
    if (found) {
      setThread(bus, task.to, thread, found);
      sessionId = found;
    }
  }

  return {
    id: task.id,
    to: task.to,
    state: latest.state,
    ok: latest.state === 'done',
    dispatched: true,
    thread: thread ? { name: thread, session: sessionId, resumed: !!session } : undefined,
    adapter: { command: spec.command, exit: adapterResult.exit ?? null, seconds: adapterResult.seconds ?? null },
    result: latest.result || null,
    stdout_tail: (adapterResult.stdout || '').slice(-1500),
    stderr_tail: (adapterResult.stderr || '').slice(-800),
    error: adapterResult.ok === false ? adapterResult.error || `adapter exit ${adapterResult.exit}` : undefined,
  };
}
