// agentbus: MCP stdio (and optional loopback HTTP) JSON-RPC 2.0 server (§4)
// Zero third-party dependencies. Fifteen tools (nine bus tools + recover + dispatch/run/wait + message/inbox); stdout strictly JSON-RPC lines only.

import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PKG_VERSION = require('../package.json').version;

import { registerArtifact } from './store.js';
import {
  createTask,
  claimTask,
  heartbeatTask,
  readTaskRef,
  completeTask,
  failTask,
  recoverTask,
  reapExpiredLeases,
  listTasks,
  verifyTasks,
  addTaskMessage,
  listTaskMessages,
} from './tasks.js';
import { dispatchTask, dispatchEnabled, waitForTask, scheduleArchiveTask } from './dispatch.js';

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26']);
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const WORKER_TOOLS = new Set([
  'bus_register',
  'bus_task_claim',
  'bus_task_heartbeat',
  'bus_ref_read',
  'bus_task_complete',
  'bus_task_fail',
  'bus_task_recover',
  'bus_task_message',
  'bus_task_inbox',
]);

let warnedRole = false;
function currentRole() {
  const raw = String(process.env.AGENTBUS_ROLE || '').trim().toLowerCase();
  if (!raw || raw === 'all') return 'all';
  if (raw === 'worker') return 'worker';
  if (raw === 'conductor') return 'conductor';
  if (!warnedRole) {
    warnedRole = true;
    console.error(`[agentbus] 未知 AGENTBUS_ROLE=${raw}，按 worker（最小权限）处理`);
  }
  return 'worker';
}

function visibleTools() {
  if (currentRole() !== 'worker') return MCP_TOOLS;
  return MCP_TOOLS.filter((t) => WORKER_TOOLS.has(t.name));
}

export const MCP_TOOLS = [
  {
    name: 'bus_register',
    description: '登记本地文件指针（只写地址与 sha256，不复制正文）。同一文件重复登记返回同一行。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: '本地绝对路径或 file:// URI（必须在 allowed_roots 内）' },
        name: { type: 'string', description: '展示名，默认取文件名' },
        by: { type: 'string', description: '登记方 agent 名' },
      },
    },
  },
  {
    name: 'bus_task_create',
    description: '创建指针式任务信封（仅引用已登记 sha256，支持幂等键）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['to', 'goal', 'refs'],
      properties: {
        to: { type: 'string', description: '目标 agent 名，或 "*" 表示任意 agent 可领' },
        goal: { type: 'string', description: '任务目标说明' },
        refs: {
          type: 'array',
          description: '已登记资料引用列表（元素为 {sha256, note?} 或 "<sha256>" 字符串）',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                required: ['sha256'],
                properties: {
                  sha256: { type: 'string' },
                  note: { type: 'string' },
                },
              },
            ],
          },
        },
        constraints: { type: 'array', items: { type: 'string' }, description: '约束列表' },
        acceptance: { type: 'object', description: '验收条款：json / must_contain / must_not_contain / min_bytes / max_bytes / fields / require_ref_read / allow_ref_drift' },
        from: { type: 'string', description: '发起方 agent 名' },
        idempotency_key: { type: 'string', description: '幂等键，同 from 重复提交返回同一任务 id' },
        thread: { type: 'string', description: '关联跨任务线程名（若已有 context@1 账本则自动挂载指针）' },
      },
    },
  },
  {
    name: 'bus_task_claim',
    description: '原子领取 open 任务并获得租约令牌 lease_token。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'by'],
      properties: {
        id: { type: 'string', description: '任务 id 或唯一前缀' },
        by: { type: 'string', description: '领取方 agent 名' },
        ttl_s: { type: 'number', description: '租约 TTL（秒），默认 900' },
      },
    },
  },
  {
    name: 'bus_task_heartbeat',
    description: '凭有效 lease_token 延展任务租约有效期。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'by', 'lease_token'],
      properties: {
        id: { type: 'string', description: '任务 id 或唯一前缀' },
        by: { type: 'string', description: '领取方 agent 名' },
        lease_token: { type: 'string', description: 'claim 返回的租约令牌' },
        ttl_s: { type: 'number', description: '延展 TTL（秒），默认 900' },
      },
    },
  },
  {
    name: 'bus_ref_read',
    description: '校验引用 sha256 后读取资料；超过 max_bytes（默认 64KB）只返回 resource_link 指针，不返回正文。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name'],
      properties: {
        id: { type: 'string', description: '任务 id 或唯一前缀' },
        name: { type: 'string', description: '引用展示名' },
        max_bytes: { type: 'number', description: '内联上限字节数，默认 65536' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: '期望返回编码' },
        by: { type: 'string', description: '读取方 agent 名（用于 ref_read 审计记录）' },
      },
    },
  },
  {
    name: 'bus_task_complete',
    description: '核验租约、全部引用哈希与验收条款后交付任务结果，置状态为 done。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'by', 'lease_token', 'result_path'],
      properties: {
        id: { type: 'string', description: '任务 id 或唯一前缀' },
        by: { type: 'string', description: '领取方 agent 名' },
        lease_token: { type: 'string', description: 'claim 返回的租约令牌' },
        result_path: { type: 'string', description: '结果文件绝对路径或 file:// URI' },
        fields: { type: 'object', description: '额外顶层 JSON 字段严格等值校验' },
      },
    },
  },
  {
    name: 'bus_task_fail',
    description: '凭有效租约将任务标记为终态 failed 并记录原因。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'by', 'lease_token', 'reason'],
      properties: {
        id: { type: 'string', description: '任务 id 或唯一前缀' },
        by: { type: 'string', description: '领取方 agent 名' },
        lease_token: { type: 'string', description: 'claim 返回的租约令牌' },
        reason: { type: 'string', description: '失败原因' },
      },
    },
  },
  {
    name: 'bus_task_recover',
    description: '恢复卡住的任务：retry / release / fail / reassign / adopt（conductor 可恢复任意任务；worker 仅限自己是 from/to 的任务）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'by', 'action'],
      properties: {
        id: { type: 'string', description: '任务 id 或唯一前缀' },
        by: { type: 'string', description: '操作方 agent 名' },
        action: { type: 'string', enum: ['retry', 'release', 'fail', 'reassign', 'adopt'], description: '恢复动作' },
        reason: { type: 'string', description: '恢复原因说明' },
        to: { type: 'string', description: 'reassign 时的目标 agent 名' },
        result_path: { type: 'string', description: 'adopt 时的结果文件绝对路径或 file:// URI' },
        allow_ref_drift: { type: 'boolean', description: 'adopt 时是否允许引用漂移' },
        fields: { type: 'object', description: 'adopt 时可选的额外顶层 JSON 字段严格等值校验' },
      },
    },
  },
  {
    name: 'bus_task_list',
    description: '列出任务摘要列表（自动回收已过期租约）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        state: { type: 'string', enum: ['open', 'claimed', 'done', 'failed'], description: '按状态过滤' },
        to: { type: 'string', description: '按目标 agent 过滤' },
        limit: { type: 'number', description: '返回条数上限，默认 50，最大 500' },
      },
    },
  },
  {
    name: 'bus_verify',
    description: '校验单条或全量任务的引用与结果文件完整性；发现漂移或缺失时 isError=true。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '任务 id 或前缀；省略则全量校验' },
      },
    },
  },
  {
    name: 'bus_task_dispatch',
    description: '主动唤起另一个 agent 完成指定任务，并等待其交回结果（需服务端启用 AGENTBUS_ENABLE_DISPATCH=1）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '要交办的任务 id（单个）' },
        ids: { type: 'array', items: { type: 'string' }, description: '多个任务 id：一次并发派发，墙钟时间取最慢的那个' },
        cwd: { type: 'string', description: '被唤起 agent 的工作目录，默认当前进程 cwd' },
        wait_s: { type: 'number', description: '最长等待秒数，MCP 默认 3（其余用 bus_task_wait 等）' },
        thread: { type: 'string', description: '会话名：同名线程复用同一 agent 会话（会话亲和）' },
        force: { type: 'boolean', description: '忽略该 agent 的健康冷却，强制重试' },
      },
    },
  },
  {
    name: 'bus_task_run',
    description: '一步到位：建任务并立刻派给目标 agent（省掉 create→dispatch 两次往返）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', description: '目标 agent' },
        goal: { type: 'string', description: '任务目标' },
        refs: { type: 'array', items: {}, description: '引用（sha256 或 {sha256,note}）' },
        constraints: { type: 'array', items: { type: 'string' } },
        acceptance: { type: 'object', description: '验收键，如 {"json":"true"}' },
        cwd: { type: 'string', description: '工作目录' },
        wait_s: { type: 'number', description: '最多等待秒数，默认 3' },
        thread: { type: 'string', description: '会话名（会话亲和）' },
        idempotency_key: { type: 'string' },
      },
      required: ['to', 'goal'],
    },
  },
  {
    name: 'bus_task_wait',
    description: '等一个任务在总线上变成 done/failed，或出现新的 question/blocked/error 消息时提前返回。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '任务 id' },
        timeout_s: { type: 'number', description: '最长等待秒数，默认 300' },
        since_id: { type: 'number', description: '可选：仅把 seq > since_id 的消息视为新消息' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bus_task_message',
    description: '在任务上下文中发送双向消息（提问/报阻塞/报进度/回复/报错）。领取者本人需传 lease_token；conductor 回复可省略。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'by', 'body'],
      properties: {
        id: { type: 'string', description: '任务 id 或唯一前缀' },
        by: { type: 'string', description: '发送方 agent 名' },
        body: { type: 'string', description: '消息正文（超过 16KB 会被截断）' },
        kind: { type: 'string', enum: ['note', 'progress', 'question', 'blocked', 'answer', 'error'], description: '消息类型，默认 note' },
        to: { type: 'string', description: '接收方 agent 名（省略则自动路由给任务发起方或领取方）' },
        lease_token: { type: 'string', description: '领取者本人发送消息时必须提供有效 lease_token' },
      },
    },
  },
  {
    name: 'bus_task_inbox',
    description: '读取任务消息收件箱（返回 messages、state、blocked、blocked_at、last_seq）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '任务 id 或唯一前缀' },
        for_agent: { type: 'string', description: '接收方 agent 名（worker 传自己，只看发给自己的广播/定向消息且不重复看自己发的）' },
        since_id: { type: 'number', description: '仅返回 seq > since_id 的消息，默认 0' },
        mark_read: { type: 'boolean', description: '是否将本次读到的未读消息标记为已读' },
        limit: { type: 'number', description: '返回条数上限，默认 100，最大 500' },
      },
    },
  },
];

function toolSuccess(structuredContent) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function toolError(err) {
  const msg = String(err?.message || err || 'unknown error');
  return {
    content: [{ type: 'text', text: msg }],
    isError: true,
    structuredContent: { error: msg },
  };
}

async function invokeTool(bus, name, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  try {
    switch (name) {
      case 'bus_register': {
        const res = registerArtifact(bus, {
          filePath: a.path,
          name: a.name || null,
          by: a.by || 'mcp',
        });
        return toolSuccess({
          sha256: res.sha256,
          uri: res.uri,
          bytes: res.bytes,
          name: res.name,
          reused: res.reused,
        });
      }

      case 'bus_task_create': {
        const res = createTask(bus, {
          to: a.to,
          goal: a.goal,
          refs: a.refs,
          constraints: a.constraints || [],
          acceptance: a.acceptance || {},
          from: a.from || 'mcp',
          idempotency_key: a.idempotency_key || null,
          thread: a.thread || null,
        });
        return toolSuccess(res);
      }

      case 'bus_task_claim': {
        const res = claimTask(bus, {
          id: a.id,
          by: a.by,
          ttl_s: a.ttl_s !== undefined ? Number(a.ttl_s) : null,
        });
        return toolSuccess({
          id: res.id,
          state: res.state,
          claimed_by: res.claimed_by,
          lease_token: res.lease_token,
          expires_at: res.expires_at,
          lease_expires_at: res.lease_expires_at,
          heartbeat_hint: res.heartbeat_hint,
          attempt: res.attempt,
          from: res.from,
          to: res.to,
          created_at: res.created_at,
          goal: res.goal,
          constraints: res.constraints,
          refs: res.refs,
          acceptance: res.acceptance,
          blocked_at: res.blocked_at,
          ...(res.thread ? { thread: res.thread } : {}),
        });
      }

      case 'bus_task_heartbeat': {
        const res = heartbeatTask(bus, {
          id: a.id,
          by: a.by,
          lease_token: a.lease_token,
          ttl_s: a.ttl_s !== undefined ? Number(a.ttl_s) : null,
        });
        return toolSuccess({ expires_at: res.expires_at, lease_expires_at: res.lease_expires_at });
      }

      case 'bus_ref_read': {
        const res = readTaskRef(bus, {
          id: a.id,
          name: a.name,
          max_bytes: a.max_bytes !== undefined ? Number(a.max_bytes) : null,
          encoding: a.encoding || null,
          by: a.by || process.env.AGENTBUS_AGENT || null,
        });
        return {
          content: res.content,
          structuredContent: res.structuredContent,
        };
      }

      case 'bus_task_complete': {
        const res = completeTask(bus, {
          id: a.id,
          by: a.by,
          lease_token: a.lease_token,
          result_path: a.result_path,
          fields: a.fields || null,
        });
        scheduleArchiveTask(bus, res.doneResult?.id || res.id);
        return toolSuccess(res);
      }

      case 'bus_task_fail': {
        const res = failTask(bus, {
          id: a.id,
          by: a.by,
          lease_token: a.lease_token,
          reason: a.reason,
        });
        return toolSuccess({ state: res.state, id: res.id, reason: res.reason });
      }

      case 'bus_task_recover': {
        const res = recoverTask(bus, {
          id: a.id,
          by: a.by,
          action: a.action,
          reason: a.reason ?? null,
          to: a.to ?? null,
          result_path: a.result_path ?? a.result ?? null,
          allow_ref_drift: a.allow_ref_drift === true || a.allow_drift === true,
          role: currentRole(),
          fields: a.fields || null,
        });
        if (res.state === 'done') {
          scheduleArchiveTask(bus, res.id);
        }
        return toolSuccess(res);
      }

      case 'bus_task_list': {
        const rows = listTasks(bus, {
          state: a.state || null,
          to: a.to || null,
          limit: a.limit !== undefined ? Number(a.limit) : 50,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(rows) }],
          structuredContent: rows,
        };
      }

      case 'bus_verify': {
        const res = verifyTasks(bus, { id: a.id || null });
        return {
          content: [{ type: 'text', text: JSON.stringify(res) }],
          isError: res.bad > 0 ? true : undefined,
          structuredContent: res,
        };
      }

      case 'bus_task_dispatch': {
        if (!dispatchEnabled()) {
          return toolError(new Error('dispatch 未启用：服务端需设置 AGENTBUS_ENABLE_DISPATCH=1'));
        }
        const ids = Array.isArray(a.ids) && a.ids.length ? a.ids.map(String) : (a.id ? [String(a.id)] : []);
        if (!ids.length) return toolError(new Error('需要 id 或 ids'));
        const wait_s = Math.min(Number(a.wait_s) || 3, 20);
        const runOne = (id) => dispatchTask(bus, { id, cwd: a.cwd, wait_s, thread: a.thread || null, force: a.force === true });
        if (ids.length === 1) {
          return runOne(ids[0])
            .then((res) => toolSuccess(res.state === 'done' ? res : { ...res, hint: `任务在总线上等 ${res.to} 完成；接着调 bus_task_wait {id:"${res.id}", timeout_s:300}，不要在这一步阻塞` }))
            .catch((err) => toolError(err));
        }
        // Fan-out: one call starts several agents in parallel; wall time is the slowest, not the sum.
        return Promise.all(ids.map(runOne))
          .then((results) => toolSuccess({
            count: results.length,
            done: results.filter((r) => r.state === 'done').length,
            results,
            hint: '并发派发；未 done 的用 bus_task_wait 逐个等',
          }))
          .catch((err) => toolError(err));
      }

      case 'bus_task_run': {
        if (!dispatchEnabled()) {
          return toolError(new Error('dispatch 未启用：服务端需设置 AGENTBUS_ENABLE_DISPATCH=1'));
        }
        const created = createTask(bus, {
          to: a.to,
          goal: a.goal,
          refs: a.refs || [],
          constraints: a.constraints || [],
          acceptance: a.acceptance || {},
          from: a.from || 'mcp',
          idempotency_key: a.idempotency_key || null,
          thread: a.thread || null,
        });
        return dispatchTask(bus, { id: created.id, cwd: a.cwd, wait_s: Math.min(Number(a.wait_s) || 3, 20), thread: a.thread || null })
          .then((res) => toolSuccess({ task: created.id, ...res, hint: res.state === 'done' ? undefined : `任务已建并派出；用 bus_task_wait {id:"${created.id}", timeout_s:300} 等结果` }))
          .catch((err) => toolError(err));
      }

      case 'bus_task_wait': {
        return waitForTask(bus, a.id, Number(a.timeout_s) || 300, 250, {
          since_id: a.since_id !== undefined ? Number(a.since_id) : undefined,
        })
          .then((res) => toolSuccess(res))
          .catch((err) => toolError(err));
      }

      case 'bus_task_message': {
        const res = addTaskMessage(bus, {
          id: a.id,
          from: a.by,
          to: a.to || null,
          kind: a.kind || 'note',
          body: a.body,
          lease_token: a.lease_token || null,
          role: currentRole(),
        });
        return toolSuccess(res);
      }

      case 'bus_task_inbox': {
        const role = currentRole();
        const res = listTaskMessages(bus, {
          id: a.id,
          for_agent: a.for_agent || null,
          since_id: a.since_id !== undefined ? Number(a.since_id) : 0,
          mark_read: a.mark_read === true,
          limit: a.limit !== undefined ? Number(a.limit) : 100,
          role,
        });
        return toolSuccess(res);
      }

      default:
        return toolError(new Error(`未知工具: ${name}`));
    }
  } catch (err) {
    return toolError(err);
  }
}

export async function handleJsonRpcMessage(bus, msg) {
  if (!msg || typeof msg !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }

  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
  const method = msg.method;

  // Notifications (no id) -> no response
  if (!hasId) {
    return null;
  }

  switch (method) {
    case 'initialize': {
      const clientVer = msg.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(clientVer)
        ? clientVer
        : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion,
          serverInfo: { name: 'agentbus', version: PKG_VERSION },
          capabilities: { tools: { listChanged: false } },
        },
      };
    }

    case 'ping':
      return { jsonrpc: '2.0', id: msg.id, result: {} };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: visibleTools() },
      };

    case 'tools/call': {
      const toolName = msg.params?.name;
      const toolArgs = msg.params?.arguments || {};
      if (!toolName || !MCP_TOOLS.some((t) => t.name === toolName)) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: toolError(new Error(`未知工具: ${toolName || ''}`)),
        };
      }
      if (currentRole() === 'worker' && !WORKER_TOOLS.has(toolName)) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: toolError(new Error(`角色 worker 不允许调用 ${toolName}（只有 conductor 能建任务/派活/验收）`)),
        };
      }
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: await invokeTool(bus, toolName, toolArgs),
      };
    }

    default:
      return {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      };
  }
}

function verifyMcpBusWritable(bus) {
  const rootDir = bus?.config?.rootDir;
  const dbPath = bus?.config?.dbPath;
  if (rootDir) {
    try {
      fs.accessSync(rootDir, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
      throw Object.assign(
        new Error(`MCP 启动自检失败：agentbus 根目录不可写 ${rootDir} (${err.code || 'EACCES'})；请检查权限或运行 agentbus doctor --fix`),
        { code: 1 }
      );
    }
  }
  if (dbPath && fs.existsSync(dbPath)) {
    try {
      fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
      throw Object.assign(
        new Error(`MCP 启动自检失败：agentbus 数据库不可写 ${dbPath} (${err.code || 'EACCES'})；请检查权限或运行 agentbus doctor --fix`),
        { code: 1 }
      );
    }
  }
}

function startLeaseReaper(bus) {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      reapExpiredLeases(bus);
    } catch (err) {
      process.stderr.write(`[agentbus] reapExpiredLeases error: ${err?.message || err}\n`);
    }
  }, 30000);
  if (typeof timer.unref === 'function') timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function startMcpStdio(bus) {
  verifyMcpBusWritable(bus);
  const stopReaper = startLeaseReaper(bus);
  return new Promise((resolve) => {
    let closed = false;
    const shutdown = () => {
      if (closed) return;
      closed = true;
      stopReaper();
      bus.close();
      resolve();
    };

    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        process.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'
        );
        return;
      }
      const resp = handleJsonRpcMessage(bus, msg);
      Promise.resolve(resp).then((r) => {
        if (r !== null && r !== undefined) process.stdout.write(JSON.stringify(r) + '\n');
      }).catch((err) => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: String(err?.message || err) } }) + '\n');
      });
    });

    rl.on('close', shutdown);
    process.on('SIGINT', () => { shutdown(); process.exit(0); });
    process.on('SIGTERM', () => { shutdown(); process.exit(0); });
  });
}

/**
 * Optional explicit loopback-only HTTP JSON-RPC endpoint (--http 127.0.0.1:<port>).
 * Never started by default (§1).
 */
export function startMcpHttp(bus, bindSpec) {
  verifyMcpBusWritable(bus);
  const m = /^127\.0\.0\.1:(\d+)$/.exec(String(bindSpec || '').trim());
  if (!m) {
    throw Object.assign(new Error('--http 仅允许绑定 127.0.0.1:<port>'), { code: 1 });
  }
  const stopReaper = startLeaseReaper(bus);
  const port = Number(m[1]);
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const resp = handleJsonRpcMessage(bus, msg);
      Promise.resolve(resp).then((r) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(r ? JSON.stringify(r) : '');
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: String(err?.message || err) } }));
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', (e) => { stopReaper(); bus.close(); reject(e); });
    server.listen(port, '127.0.0.1', () => {
      process.stderr.write(`agentbus MCP HTTP listening on http://127.0.0.1:${port}\n`);
    });
    const stop = () => {
      stopReaper();
      server.close(() => { bus.close(); resolve(); process.exit(0); });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
