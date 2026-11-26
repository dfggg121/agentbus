#!/usr/bin/env node
// agentbus CLI entry point (§5)
// stdout outputs ONLY JSON; logs/errors go to stderr.
// Exit codes: 0 success | 1 argument/validation failure | 2 state/lease disallowed

import { openBus } from '../src/db.js';
import { registerArtifact } from '../src/store.js';
import {
  createTask,
  showTask,
  listTasks,
  claimTask,
  heartbeatTask,
  readTaskRef,
  completeTask,
  failTask,
  recoverTask,
  verifyTasks,
  addTaskMessage,
  listTaskMessages,
} from '../src/tasks.js';
import { startMcpStdio, startMcpHttp } from '../src/mcp.js';
import { setupClients, doctor, doctorFix, doctorBootstrap, listClients, describeClients, defaultRoot } from '../src/setup.js';
import { dispatchTask, dispatchEnabled, waitForTask, watchTask, maybeArchiveTask, spawnDetachedArchiveTask, checkArchiveGuard } from '../src/dispatch.js';
import { exportAgySession, defaultAgySessionPath, archiveConversation } from '../src/agy.js';
import { loadContextLedger, confirmDecision } from '../src/context.js';
import { detectAgents, readAgentConfig, writeAgentConfig } from '../src/agents.js';
import { startUiServer } from '../src/ui/server.js';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as rlPromises from 'node:readline/promises';

const require = createRequire(import.meta.url);
const VERSION = require('../package.json').version;

function parseArgs(argv) {
  const out = { _: [], ref: [], accept: [], constraint: [], field: [], client: [], allow: [], model: [] };
  const multi = new Set(['ref', 'accept', 'constraint', 'field', 'client', 'allow', 'model']);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
      continue;
    }
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    let k;
    let v;
    if (eq > 2) {
      k = a.slice(2, eq);
      v = a.slice(eq + 1);
    } else {
      k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        v = true;
      } else {
        v = next;
        i++;
      }
    }
    if (multi.has(k)) {
      out[k].push(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function parseKvList(list, flagName) {
  const obj = {};
  for (const kv of list) {
    const idx = String(kv).indexOf('=');
    if (idx < 1) {
      throw Object.assign(new Error(`${flagName} 需要 key=value 格式: ${kv}`), { code: 1 });
    }
    const k = kv.slice(0, idx);
    const v = kv.slice(idx + 1);
    if (k === 'must_contain' || k === 'must_not_contain') {
      if (obj[k] === undefined) obj[k] = v;
      else if (Array.isArray(obj[k])) obj[k].push(v);
      else obj[k] = [obj[k], v];
    } else {
      obj[k] = v;
    }
  }
  return obj;
}

function resolveCliRole() {
  const raw = String(process.env.AGENTBUS_ROLE || '').trim().toLowerCase();
  if (!raw || raw === 'all') return 'all';
  if (raw === 'conductor') return 'conductor';
  return 'worker';
}

function printHelp() {
  const help = {
    name: 'agentbus',
    version: VERSION,
    commands: [
      'setup [--client <id>]... [--root <dir>] [--allow <dir>]... [--bin node|npx] [--home <dir>] [--role conductor|worker] [--allow-dispatch] [--repair] [--list] [--require-config-dir] [--dry-run]',
      'doctor [--root <dir>] [--home <dir>] [--fix] [--bootstrap [--check-archive] [--port <port>] [--cwd <dir>]] [--allow <dir>]... [--role conductor|worker] [--allow-dispatch] [--json]',
      'version',
      'init [--root <dir>]',
      'put <path> [--as <name>] [--by <agent>] [--root <dir>]',
      'new --to <agent> --goal "..." --ref <sha>[:note]... [--accept k=v]... [--constraint "..."] [--from <agent>] [--key <idempotency_key>] [--thread <name>]',
      'show <id|prefix>',
      'claim <id> --by <agent> [--ttl <seconds>]',
      'heartbeat <id> --by <agent> --lease <token> [--ttl <seconds>]',
      'ref <id> --name <name> [--max <bytes>] [--encoding utf8|base64] [--by <agent>]',
      'done <id> --by <agent> --lease <token> --result <path> [--field k=v]...',
      'fail <id> --by <agent> --lease <token> --reason "..."',
      'recover <id> --by <agent> --action retry|release|fail|reassign|adopt [--reason "..."] [--to <agent>] [--result <path>] [--allow-drift] [--field k=v]...',
      'message <id> --by <agent> --body "..." [--kind note|progress|question|blocked|answer|error] [--to <agent>] [--lease <token>]',
      'inbox <id> [--for <agent>] [--since <seq>] [--mark-read] [--limit <n>]',
      'verify [--task <id>]',
      'list [--state <state>] [--to <agent>] [--limit <n>]',
      'dispatch <id> [--cwd <dir>] [--wait <seconds>] [--thread <name>] [--allow-dispatch] [--watch [--interval <seconds>] [--timeout <seconds>]]',
      'wait <id> [--timeout <seconds>]   # 等异步 agent 把任务做完',
      'watch <id> [--root <dir>] [--interval 5] [--timeout 3600] [--json]   # 只读低开销单任务监视（无 TTY 依赖）',
      'context <thread> | context confirm <thread> <decision-id> --by <agent> [--evidence <sha256>]',
      'archive [<conversation-id>] [--port <port>] [--title-prefix <prefix>] [--title-contains <text>] [--dry-run] [--force]',
      'onboard [--conductor <agent>] [--model <agent>=<id>]... [--archive-on-done] [--yes] [--dry-run] [--root <dir>] [--home <dir>] [--allow <dir>]...   # 探测本机 agent 并写好通信配置',
      'agy-session [--out <file>]   # 在 Antigravity 集成终端里运行，导出会话地址与令牌',
      'ui [--port <n>] [--host 127.0.0.1] [--no-open] [--root <dir>] [--dispatch]   # 启动 loopback 只读模块看板与调度面板',
      'mcp [--root <dir>] [--http 127.0.0.1:<port>]',
    ],
    exit_codes: { '0': 'success', '1': 'validation/arg/drift or watch failed/blocked/stalled', '2': 'state/lease disallowed or bootstrap command error', '3': 'watch timeout' },
  };
  process.stdout.write(JSON.stringify(help, null, 2) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || args.help) {
    printHelp();
    process.exit(0);
  }

  const isBootstrap = cmd === 'doctor' && args.bootstrap === true;
  if (args.root === true || (typeof args.root === 'string' && !args.root.trim())) {
    throw Object.assign(new Error('缺少 --root <dir> 参数值'), { code: isBootstrap ? 2 : 1 });
  }
  if (args.home === true || (typeof args.home === 'string' && !args.home.trim())) {
    throw Object.assign(new Error('缺少 --home <dir> 参数值'), { code: isBootstrap ? 2 : 1 });
  }

  const rootOverride = typeof args.root === 'string' ? args.root : null;
  const homeOverride = typeof args.home === 'string' ? path.resolve(args.home) : undefined;

  // Commands that must not open a database
  if (cmd === 'version' || args.version) {
    process.stdout.write(JSON.stringify({ name: 'agentbus', version: VERSION, node: process.version }) + '\n');
    process.exit(0);
  }

  if (cmd === 'clients') {
    process.stdout.write(JSON.stringify({ clients: listClients() }) + '\n');
    process.exit(0);
  }

  if (cmd === 'doctor') {
    if (args.bootstrap === true) {
      try {
        if (args.port !== undefined && (args.port === true || !Number.isInteger(Number(args.port)) || Number(args.port) <= 0 || Number(args.port) > 65535)) {
          throw Object.assign(new Error(`非法 --port 参数: ${args.port}`), { code: 2 });
        }
        if (args.cwd === true) {
          throw Object.assign(new Error('缺少 --cwd <dir> 参数值'), { code: 2 });
        }
        const report = await doctorBootstrap({
          root: rootOverride,
          home: homeOverride,
          cwd: typeof args.cwd === 'string' ? args.cwd : process.cwd(),
          checkArchive: args['check-archive'] === true,
          cdpPort: args.port !== undefined ? Number(args.port) : null,
        });
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        process.exit(report.ok ? 0 : 1);
      } catch (err) {
        process.stderr.write(JSON.stringify({ error: String(err?.message || err), code: 2 }) + '\n');
        process.exit(2);
      }
    }
    if (args.fix === true) {
      const rawRole = typeof args.role === 'string' ? args.role.trim().toLowerCase() : null;
      const role = rawRole ? (rawRole === 'conductor' ? 'conductor' : 'worker') : null;
      const allowDispatch = args['allow-dispatch'] === true ? true : undefined;
      const report = doctorFix({
        root: rootOverride,
        home: homeOverride,
        allowed: args.allow,
        bin: typeof args.bin === 'string' ? args.bin : 'node',
        role,
        allowDispatch,
        clients: args.client,
        dryRun: !!args['dry-run'],
      });
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exit(0);
    }
    const report = doctor({ root: rootOverride, home: homeOverride });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(0);
  }

  if (cmd === 'watch') {
    if (args.interval === true) {
      throw Object.assign(new Error('缺少 --interval <seconds> 参数值'), { code: 1 });
    }
    if (args.timeout === true) {
      throw Object.assign(new Error('缺少 --timeout <seconds> 参数值'), { code: 1 });
    }
    const res = await watchTask({
      rootOverride,
      id: args._[1],
      interval_s: args.interval !== undefined ? Number(args.interval) : 5,
      timeout_s: args.timeout !== undefined ? Number(args.timeout) : 3600,
    });
    process.stdout.write(JSON.stringify(res) + '\n');
    const code = res.state === 'done' ? 0 : (res.timed_out ? 3 : 1);
    process.exit(code);
  }

  if (cmd === 'setup') {
    if (args.list) {
      process.stdout.write(JSON.stringify({ ok: true, clients: describeClients({ home: homeOverride }) }, null, 2) + '\n');
      process.exit(0);
    }
    if (args.repair === true) {
      const rawRole = typeof args.role === 'string' ? args.role.trim().toLowerCase() : null;
      const role = rawRole ? (rawRole === 'conductor' ? 'conductor' : 'worker') : null;
      const allowDispatch = args['allow-dispatch'] === true ? true : undefined;
      const report = doctorFix({
        root: rootOverride,
        home: homeOverride,
        allowed: args.allow,
        bin: typeof args.bin === 'string' ? args.bin : 'node',
        role,
        allowDispatch,
        clients: args.client,
        dryRun: !!args['dry-run'],
      });
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exit(0);
    }
    try {
      const rawRole = typeof args.role === 'string' ? args.role.trim().toLowerCase() : 'worker';
      const role = rawRole === 'conductor' ? 'conductor' : 'worker';
      const allowDispatch = args['allow-dispatch'] === true;
      const result = setupClients({
        clients: args.client,
        root: rootOverride,
        allowed: args.allow,
        bin: typeof args.bin === 'string' ? args.bin : 'node',
        home: homeOverride,
        role,
        allowDispatch,
        requireConfigDir: !!args['require-config-dir'],
        dryRun: !!args['dry-run'],
      });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (!result.ok) {
        const firstErr = result.results.find((r) => !r.ok);
        process.stderr.write(JSON.stringify({
          error: firstErr?.error || 'setup failed',
          error_code: firstErr?.error_code || 'setup_failed',
          next: firstErr?.next || null,
          code: 1,
        }) + '\n');
      }
      process.exit(result.ok ? 0 : 1);
    } catch (e) {
      process.stderr.write(JSON.stringify({ error: String(e.message || e), code: 1 }) + '\n');
      process.exit(1);
    }
  }

  if (cmd === 'ui') {
    if (args.port === true) {
      throw Object.assign(new Error('缺少 --port <n> 参数值'), { code: 1 });
    }
    if (args.host === true || (typeof args.host === 'string' && !args.host.trim())) {
      throw Object.assign(new Error('缺少 --host <addr> 参数值'), { code: 1 });
    }
    const port = args.port !== undefined ? Number(args.port) : 0;
    const host = typeof args.host === 'string' ? args.host : '127.0.0.1';
    const noOpen = args['no-open'] === true || process.env.AGENTBUS_NO_OPEN === '1';
    const dispatch = args.dispatch === true;

    const ui = await startUiServer({
      rootOverride,
      host,
      port,
      dispatch,
    });

    process.stdout.write(JSON.stringify({
      ok: true,
      url: ui.url,
      host: ui.host,
      port: ui.port,
      root: ui.root,
      dispatch: ui.dispatch,
      hint: 'Ctrl+C 退出；GET 严格只读，提交请求才创建任务',
    }) + '\n');

    if (!noOpen && process.stdout.isTTY) {
      try {
        if (process.platform === 'win32') {
          const child = spawn('cmd.exe', ['/d', '/c', 'start', '', ui.url], {
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
          });
          child.unref();
        } else if (process.platform === 'darwin') {
          const child = spawn('open', [ui.url], { stdio: 'ignore', detached: true });
          child.unref();
        } else {
          const child = spawn('xdg-open', [ui.url], { stdio: 'ignore', detached: true });
          child.unref();
        }
      } catch (err) {
        process.stderr.write(`[agentbus ui] 无法自动打开浏览器: ${err?.message || err}\n`);
      }
    }

    await new Promise((resolve) => {
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        try { await ui.close(); } catch {}
        resolve();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
    return;
  }

  if (cmd === 'mcp') {
    const bus = openBus({ rootOverride });
    if (typeof args.http === 'string') {
      await startMcpHttp(bus, args.http);
    } else {
      await startMcpStdio(bus);
    }
    return;
  }

  const bus = openBus({ rootOverride });
  try {
    let result;
    let exitCode = 0;

    switch (cmd) {
      case 'init': {
        result = {
          ok: true,
          root: bus.config.rootDir,
          db: bus.config.dbPath,
          journal_mode: bus.journalMode,
        };
        break;
      }

      case 'put': {
        const filePath = args._[1];
        if (!filePath) throw Object.assign(new Error('缺少文件路径: bus put <path>'), { code: 1 });
        result = registerArtifact(bus, {
          filePath,
          name: typeof args.as === 'string' ? args.as : null,
          by: typeof args.by === 'string' ? args.by : (process.env.AGENTBUS_AGENT || 'unknown'),
        });
        break;
      }

      case 'new': {
        const acceptance = parseKvList(args.accept, '--accept');
        if (args.field.length > 0) {
          acceptance.fields = parseKvList(args.field, '--field');
        }
        result = createTask(bus, {
          to: typeof args.to === 'string' ? args.to : '',
          goal: typeof args.goal === 'string' ? args.goal : '',
          refs: args.ref,
          constraints: args.constraint,
          acceptance,
          from: typeof args.from === 'string' ? args.from : (process.env.AGENTBUS_AGENT || 'unknown'),
          idempotency_key: typeof args.key === 'string' ? args.key : null,
          thread: typeof args.thread === 'string' ? args.thread : null,
        });
        break;
      }

      case 'show': {
        result = showTask(bus, args._[1]);
        break;
      }

      case 'claim': {
        result = claimTask(bus, {
          id: args._[1],
          by: typeof args.by === 'string' ? args.by : process.env.AGENTBUS_AGENT,
          ttl_s: args.ttl !== undefined ? Number(args.ttl) : null,
        });
        break;
      }

      case 'heartbeat': {
        result = heartbeatTask(bus, {
          id: args._[1],
          by: typeof args.by === 'string' ? args.by : process.env.AGENTBUS_AGENT,
          lease_token: typeof args.lease === 'string' ? args.lease : null,
          ttl_s: args.ttl !== undefined ? Number(args.ttl) : null,
        });
        break;
      }

      case 'ref': {
        result = readTaskRef(bus, {
          id: args._[1],
          name: typeof args.name === 'string' ? args.name : null,
          max_bytes: args.max !== undefined ? Number(args.max) : null,
          encoding: typeof args.encoding === 'string' ? args.encoding : null,
          by: typeof args.by === 'string' ? args.by : (process.env.AGENTBUS_AGENT || null),
        });
        break;
      }

      case 'context': {
        const sub = args._[1];
        if (sub === 'confirm') {
          const threadName = args._[2];
          const decisionId = args._[3];
          if (!threadName || !decisionId) {
            throw Object.assign(new Error('用法: agentbus context confirm <thread> <decision-id> --by <agent>'), { code: 1 });
          }
          result = confirmDecision(bus, threadName, decisionId, {
            confirmedBy: typeof args.by === 'string' ? args.by : process.env.AGENTBUS_AGENT,
            evidenceSha256: typeof args.evidence === 'string' ? args.evidence : null,
          });
        } else {
          const threadName = sub === 'show' ? args._[2] : sub;
          if (!threadName) {
            throw Object.assign(new Error('用法: agentbus context <thread>'), { code: 1 });
          }
          result = loadContextLedger(bus, threadName) || { exists: false, thread: threadName };
        }
        break;
      }

      case 'done': {
        const extraFields = args.field.length > 0 ? parseKvList(args.field, '--field') : null;
        result = completeTask(bus, {
          id: args._[1],
          by: typeof args.by === 'string' ? args.by : process.env.AGENTBUS_AGENT,
          lease_token: typeof args.lease === 'string' ? args.lease : null,
          result_path: typeof args.result === 'string' ? args.result : null,
          fields: extraFields,
        });
        await spawnDetachedArchiveTask(bus, result.doneResult?.id || result.id);
        break;
      }

      case 'fail': {
        result = failTask(bus, {
          id: args._[1],
          by: typeof args.by === 'string' ? args.by : process.env.AGENTBUS_AGENT,
          lease_token: typeof args.lease === 'string' ? args.lease : null,
          reason: typeof args.reason === 'string' ? args.reason : null,
        });
        break;
      }

      case 'recover': {
        const extraFields = args.field.length > 0 ? parseKvList(args.field, '--field') : null;
        result = recoverTask(bus, {
          id: args._[1],
          by: typeof args.by === 'string' ? args.by : '',
          action: typeof args.action === 'string' ? args.action : '',
          reason: typeof args.reason === 'string' ? args.reason : null,
          to: typeof args.to === 'string' ? args.to : null,
          result_path: typeof args.result === 'string' ? args.result : null,
          allow_ref_drift: args['allow-drift'] === true || args['allow-drift'] === 'true',
          role: resolveCliRole(),
          fields: extraFields,
        });
        if (result.state === 'done') {
          await spawnDetachedArchiveTask(bus, result.id);
        }
        break;
      }

      case 'message': {
        result = addTaskMessage(bus, {
          id: args._[1],
          from: typeof args.by === 'string' ? args.by : process.env.AGENTBUS_AGENT,
          to: typeof args.to === 'string' ? args.to : null,
          kind: typeof args.kind === 'string' ? args.kind : 'note',
          body: typeof args.body === 'string' ? args.body : '',
          lease_token: typeof args.lease === 'string' ? args.lease : null,
          role: resolveCliRole(),
        });
        break;
      }

      case 'inbox': {
        result = listTaskMessages(bus, {
          id: args._[1],
          for_agent: typeof args.for === 'string' ? args.for : null,
          since_id: args.since !== undefined && args.since !== true ? Number(args.since) : 0,
          mark_read: args['mark-read'] === true || args['mark-read'] === 'true',
          limit: args.limit !== undefined && args.limit !== true ? Number(args.limit) : 100,
          role: resolveCliRole(),
        });
        break;
      }

      case 'onboard': {
        const explicitHome = homeOverride !== undefined;
        const home = homeOverride || os.homedir();
        const allAgents = detectAgents(home, { explicitHome });
        const detected = allAgents.filter((a) => a.installed);
        if (!detected.length) {
          const hints = allAgents
            .filter((a) => a.diagnostic?.next)
            .map((a) => `${a.id}: ${a.diagnostic.next}`)
            .join('；');
          throw Object.assign(new Error(`没有探测到任何已安装的 agent（已检查: ${allAgents.map((a) => a.id).join(', ')}）。下一步：${hints}`), { code: 1 });
        }

        const provided = {};
        for (const spec of [].concat(args.model || [])) {
          const [agent, id] = String(spec).split('=');
          if (agent && id) provided[agent] = id;
        }

        let conductorId = typeof args.conductor === 'string' ? args.conductor : null;
        if (!conductorId) {
          conductorId = (detected.find((a) => a.capabilities.includes('conductor')) || detected[0]).id;
        }
        if (!detected.some((a) => a.id === conductorId)) {
          throw Object.assign(new Error(`--conductor ${conductorId} 不在已探测列表里: ${detected.map((a) => a.id).join(', ')}`), { code: 1 });
        }

        const prevCfg = readAgentConfig(bus.config.rootDir);
        const models = { ...prevCfg.models, ...provided };
        const archiveOnDone = args['archive-on-done'] === true
          ? true
          : (args['no-archive-on-done'] === true ? false : prevCfg.archive_on_done === true);
        const notes = [];

        if (process.stdin.isTTY && !args.yes) {
          const rl = rlPromises.createInterface({ input: process.stdin, output: process.stderr });
          try {
            for (const a of detected) {
              if (provided[a.id]) continue;
              const options = a.models.length ? `（例: ${a.models.join(' / ')}）` : '';
              const answer = await rl.question(`${a.id} 主要用哪个模型？${options} [回车=默认] `);
              if (answer.trim()) models[a.id] = answer.trim();
            }
          } finally {
            rl.close();
          }
        } else if (!args.yes) {
          notes.push('非交互环境：模型用 --model <agent>=<id> 指定，未指定则留空');
        }

        const knownClients = listClients();
        const configured = [];
        const warnings = [];
        for (const a of detected) {
          if (!a.bin && a.diagnostic) {
            warnings.push({ agent: a.id, ...a.diagnostic });
          }
          if (!knownClients.includes(a.id)) continue;
          const env = { AGENTBUS_ROLE: a.id === conductorId ? 'conductor' : 'worker' };
          if (a.id === conductorId) env.AGENTBUS_ENABLE_DISPATCH = '1';
          const r = setupClients({
            clients: [a.id],
            root: bus.config.rootDir,
            allowed: (args.allow && args.allow.length ? args.allow : [process.cwd()]),
            home,
            env,
            dryRun: args['dry-run'] === true,
          });
          const first = r.results[0] || {};
          configured.push({
            agent: a.id,
            role: env.AGENTBUS_ROLE,
            ok: r.ok,
            files: r.results.map((x) => x.file || x.client),
            ...(first.error ? { error_code: first.error_code, error: first.error, next: first.next } : {}),
          });
          if (!r.ok) exitCode = 1;
        }

        const allSetupOk = configured.every((c) => c.ok);
        if (args['dry-run'] !== true && allSetupOk) {
          writeAgentConfig(bus.config.rootDir, { conductor: conductorId, models, archive_on_done: archiveOnDone });
        }

        result = {
          ok: allSetupOk,
          home,
          conductor: conductorId,
          detected: detected.map((a) => ({ id: a.id, bin: a.bin, bin_source: a.bin_source || null, config: a.config })),
          models,
          archive_on_done: archiveOnDone,
          configured,
          ...(warnings.length ? { warnings } : {}),
          config_file: path.join(bus.config.rootDir, 'agents.json'),
          notes,
          dry_run: args['dry-run'] === true || undefined,
          next: allSetupOk
            ? `重启 ${conductorId} 后它就有派活权限；worker 只有 claim/read/complete`
            : (configured.find((c) => !c.ok)?.next || '部分客户端配置失败，请检查 configured[].error 与 next'),
        };
        break;
      }

      case 'wait': {
        result = await waitForTask(bus, args._[1], args.timeout !== undefined ? Number(args.timeout) : 900);
        if (result.state !== 'done') exitCode = 1;
        break;
      }

      case 'agy-session': {
        const out = typeof args.out === 'string' ? args.out : defaultAgySessionPath(bus.config.rootDir);
        result = exportAgySession(out);
        break;
      }

      case 'archive-done': {
        const taskId = args._[1];
        if (!taskId) throw Object.assign(new Error('缺少任务 id: agentbus archive-done <task-id>'), { code: 1 });
        const port = args.port !== undefined && args.port !== true ? args.port : null;
        const payload = await maybeArchiveTask(bus, taskId, port !== null ? { port } : {});
        result = payload || { ok: false, archived_count: 0, skipped: true, reason: 'ineligible_or_disabled' };
        break;
      }

      case 'archive': {
        if (args['title-prefix'] === true) {
          throw Object.assign(new Error('缺少 --title-prefix <prefix> 参数值'), { code: 1 });
        }
        if (args['title-contains'] === true) {
          throw Object.assign(new Error('缺少 --title-contains <text> 参数值'), { code: 1 });
        }
        let conversationId = args._[1] || null;
        let force = args.force === true || args.force === 'true';
        if (typeof args.force === 'string' && args.force !== 'true' && args.force !== 'false' && !conversationId) {
          conversationId = args.force;
          force = true;
        }
        let dryRun = args['dry-run'] === true || args['dry-run'] === 'true';
        if (typeof args['dry-run'] === 'string' && args['dry-run'] !== 'true' && args['dry-run'] !== 'false' && !conversationId) {
          conversationId = args['dry-run'];
          dryRun = true;
        }
        const port = args.port !== undefined && args.port !== true ? args.port : null;
        const titlePrefix = typeof args['title-prefix'] === 'string' ? args['title-prefix'] : null;
        const titleContains = typeof args['title-contains'] === 'string' ? args['title-contains'] : null;

        const guard = checkArchiveGuard(bus, { conversationId, titlePrefix, titleContains, force });

        if (dryRun) {
          if (!guard.allowed) {
            let preview = null;
            if (port !== null) {
              preview = await archiveConversation({ conversationId, port, titlePrefix, titleContains, dryRun: true }).catch(() => null);
            }
            result = {
              ...(preview && typeof preview === 'object' ? preview : {}),
              ok: true,
              archived: false,
              dry_run: true,
              task_id: guard.task_id,
              task_state: guard.task_state,
              would_archive: false,
              reason: guard.reason,
              ...(guard.error ? { error: guard.error } : {}),
            };
          } else {
            const cdpRes = await archiveConversation({ conversationId, port, titlePrefix, titleContains, dryRun: true });
            result = {
              ...cdpRes,
              task_id: guard.task_id,
              task_state: guard.task_state,
              would_archive: Boolean(cdpRes.ok),
              ...(force ? { forced: true } : {}),
            };
            if (!cdpRes.ok) exitCode = 1;
          }
          break;
        }

        if (!guard.allowed) {
          result = {
            ok: false,
            archived: false,
            reason: guard.reason,
            ...(guard.task_id ? { task_id: guard.task_id } : {}),
            ...(guard.task_state ? { state: guard.task_state, task_state: guard.task_state } : {}),
            ...(guard.error ? { error: guard.error } : {}),
          };
          exitCode = guard.code;
          process.stderr.write(JSON.stringify({
            error: `archive 拒绝 (${guard.reason})`,
            reason: guard.reason,
            ...(guard.task_id ? { task_id: guard.task_id, state: guard.task_state } : {}),
            code: exitCode,
          }) + '\n');
          break;
        }

        const cdpRes = await archiveConversation({ conversationId, port, titlePrefix, titleContains, dryRun: false });
        result = {
          ...cdpRes,
          ...(guard.task_id ? { task_id: guard.task_id, task_state: guard.task_state } : {}),
          ...(force ? { forced: true } : {}),
        };
        if (!cdpRes.ok) exitCode = 1;
        break;
      }

      case 'dispatch': {
        if (!dispatchEnabled(args['allow-dispatch'] === true)) {
          throw Object.assign(new Error('dispatch 未启用：加 --allow-dispatch 或设置 AGENTBUS_ENABLE_DISPATCH=1'), { code: 1 });
        }
        if (args.interval === true) {
          throw Object.assign(new Error('缺少 --interval <seconds> 参数值'), { code: 1 });
        }
        if (args.timeout === true) {
          throw Object.assign(new Error('缺少 --timeout <seconds> 参数值'), { code: 1 });
        }
        const ids = args._.slice(1);
        const watchMode = args.watch === true || args.watch === 'true';
        const opts = {
          cwd: typeof args.cwd === 'string' ? args.cwd : null,
          wait_s: args.wait !== undefined ? Number(args.wait) : 600,
          thread: typeof args.thread === 'string' ? args.thread : null,
          force: args.force === true,
          ...(watchMode ? {
            watch: true,
            watch_interval_s: args.interval !== undefined ? Number(args.interval) : 5,
            watch_timeout_s: args.timeout !== undefined ? Number(args.timeout) : 3600,
          } : {}),
        };
        if (ids.length > 1) {
          // Fan-out: wall time is the slowest agent, not the sum.
          const results = await Promise.all(ids.map((id) => dispatchTask(bus, { id, ...opts })));
          result = {
            count: results.length,
            done: results.filter((r) => r.state === 'done').length,
            results,
          };
          if (watchMode) {
            if (result.done !== results.length) {
              const onlyTimeouts = results.every((r) => r.state === 'done' || r.timed_out);
              exitCode = onlyTimeouts ? 3 : 1;
            }
          } else if (result.done !== results.length) {
            exitCode = 1;
          }
          break;
        }
        result = await dispatchTask(bus, { id: ids[0], ...opts });
        if (watchMode) {
          exitCode = result.state === 'done' ? 0 : (result.timed_out ? 3 : 1);
        } else if (result.state !== 'done') {
          exitCode = 1;
        }
        break;
      }

      case 'verify': {
        result = verifyTasks(bus, {
          id: typeof args.task === 'string' ? args.task : (args._[1] || null),
        });
        if (result.bad > 0) exitCode = 1;
        break;
      }

      case 'list': {
        result = listTasks(bus, {
          state: typeof args.state === 'string' ? args.state : null,
          to: typeof args.to === 'string' ? args.to : null,
          limit: args.limit !== undefined ? Number(args.limit) : 50,
        });
        break;
      }

      default:
        throw Object.assign(new Error(`未知命令: ${cmd}`), { code: 1 });
    }

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = exitCode;
    bus.close();
    return;
  } catch (err) {
    bus.close();
    const code = err?.code === 2 ? 2 : 1;
    process.stderr.write(JSON.stringify({ error: String(err?.message || err), code }) + '\n');
    process.exitCode = code;
  }
}

main().catch((err) => {
  const code = err?.code === 2 ? 2 : 1;
  process.stderr.write(JSON.stringify({ error: String(err?.message || err), code }) + '\n');
  process.exitCode = code;
});
