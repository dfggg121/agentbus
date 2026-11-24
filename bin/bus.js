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
  verifyTasks,
} from '../src/tasks.js';
import { startMcpStdio, startMcpHttp } from '../src/mcp.js';
import { setupClients, doctor, listClients, defaultRoot } from '../src/setup.js';
import { dispatchTask, dispatchEnabled, waitForTask } from '../src/dispatch.js';
import { exportAgySession, defaultAgySessionPath } from '../src/agy.js';
import { detectAgents, readAgentConfig, writeAgentConfig } from '../src/agents.js';
import os from 'node:os';
import path from 'node:path';
import * as rlPromises from 'node:readline/promises';

const VERSION = '0.1.0';

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

function printHelp() {
  const help = {
    name: 'agentbus',
    version: VERSION,
    commands: [
      'setup [--client <id>]... [--root <dir>] [--allow <dir>]... [--bin node|npx] [--home <dir>] [--dry-run]',
      'doctor [--root <dir>]',
      'version',
      'init [--root <dir>]',
      'put <path> [--as <name>] [--by <agent>] [--root <dir>]',
      'new --to <agent> --goal "..." --ref <sha>[:note]... [--accept k=v]... [--constraint "..."] [--from <agent>] [--key <idempotency_key>]',
      'show <id|prefix>',
      'claim <id> --by <agent> [--ttl <seconds>]',
      'heartbeat <id> --by <agent> --lease <token> [--ttl <seconds>]',
      'ref <id> --name <name> [--max <bytes>] [--encoding utf8|base64]',
      'done <id> --by <agent> --lease <token> --result <path> [--field k=v]...',
      'fail <id> --by <agent> --lease <token> --reason "..."',
      'verify [--task <id>]',
      'list [--state <state>] [--to <agent>] [--limit <n>]',
      'dispatch <id> [--cwd <dir>] [--wait <seconds>] [--thread <name>] [--allow-dispatch]',
      'wait <id> [--timeout <seconds>]   # 等异步 agent 把任务做完',
      'onboard [--conductor <agent>] [--model <agent>=<id>]... [--yes] [--dry-run]   # 探测本机 agent 并写好通信配置',
      'agy-session [--out <file>]   # 在 Antigravity 集成终端里运行，导出会话地址与令牌',
      'mcp [--root <dir>] [--http 127.0.0.1:<port>]',
    ],
    exit_codes: { '0': 'success', '1': 'validation/arg/drift error', '2': 'state/lease disallowed' },
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

  const rootOverride = typeof args.root === 'string' ? args.root : null;

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
    const report = doctor({ root: rootOverride, home: typeof args.home === 'string' ? args.home : undefined });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(0);
  }

  if (cmd === 'setup') {
    try {
      const result = setupClients({
        clients: args.client,
        root: rootOverride,
        allowed: args.allow,
        bin: typeof args.bin === 'string' ? args.bin : 'node',
        home: typeof args.home === 'string' ? args.home : undefined,
        dryRun: !!args['dry-run'],
      });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(result.ok ? 0 : 1);
    } catch (e) {
      process.stderr.write(JSON.stringify({ error: String(e.message || e), code: 1 }) + '\n');
      process.exit(1);
    }
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
        });
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

      case 'onboard': {
        const home = typeof args.home === 'string' ? args.home : os.homedir();
        const detected = detectAgents(home).filter((a) => a.installed);
        if (!detected.length) {
          throw Object.assign(new Error('没有探测到任何已安装的 agent'), { code: 1 });
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

        const models = { ...readAgentConfig(bus.config.rootDir).models, ...provided };
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
        for (const a of detected) {
          if (!knownClients.includes(a.id)) continue;
          const env = { AGENTBUS_ROLE: a.id === conductorId ? 'conductor' : 'worker' };
          if (a.id === conductorId) env.AGENTBUS_ENABLE_DISPATCH = '1';
          const r = setupClients({
            clients: [a.id],
            root: bus.config.rootDir,
            allowed: (args.allow && args.allow.length ? args.allow : [process.cwd()]),
            env,
            dryRun: args['dry-run'] === true,
          });
          configured.push({ agent: a.id, role: env.AGENTBUS_ROLE, ok: r.ok, files: r.results.map((x) => x.file || x.client) });
        }

        const cfg = args['dry-run'] === true
          ? { conductor: conductorId, models, dry_run: true }
          : writeAgentConfig(bus.config.rootDir, { conductor: conductorId, models });

        result = {
          conductor: conductorId,
          detected: detected.map((a) => ({ id: a.id, bin: a.bin, config: a.config })),
          models,
          configured,
          config_file: path.join(bus.config.rootDir, 'agents.json'),
          notes,
          dry_run: args['dry-run'] === true || undefined,
          next: `重启 ${conductorId} 后它就有派活权限；worker 只有 claim/read/complete`,
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

      case 'dispatch': {
        if (!dispatchEnabled(args['allow-dispatch'] === true)) {
          throw Object.assign(new Error('dispatch 未启用：加 --allow-dispatch 或设置 AGENTBUS_ENABLE_DISPATCH=1'), { code: 1 });
        }
        result = await dispatchTask(bus, {
          id: args._[1],
          cwd: typeof args.cwd === 'string' ? args.cwd : null,
          wait_s: args.wait !== undefined ? Number(args.wait) : 600,
          thread: typeof args.thread === 'string' ? args.thread : null,
          force: args.force === true,
        });
        if (result.state !== 'done') exitCode = 1;
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
    bus.close();
    process.exit(exitCode);
  } catch (err) {
    bus.close();
    const code = err?.code === 2 ? 2 : 1;
    process.stderr.write(JSON.stringify({ error: String(err?.message || err), code }) + '\n');
    process.exit(code);
  }
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({ error: String(err?.message || err), code: 1 }) + '\n');
  process.exit(1);
});
