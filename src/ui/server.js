// agentbus: Loopback-only HTTP UI server & module dashboard API.
// Zero third-party dependencies. GET endpoints are strictly read-only; only POST /api/requests writes to DB.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_MODELS, agentConfigPath, readAgentConfig } from '../agents.js';
import { PKG_ROOT, loadConfig, openBus, openBusReadOnly } from '../db.js';
import { dispatchTask, listAdapters } from '../dispatch.js';
import { createTask, listTasksReadOnly } from '../tasks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES_JSON_PATH = path.join(HERE, 'modules.json');
const INDEX_HTML_PATH = path.join(HERE, 'index.html');

export const MAX_REQUEST_BODY_BYTES = 32 * 1024;
export const MAX_NOTES_LENGTH = 2000;

export const UI_ACTIONS = {
  redo: '重做',
  optimize: '深度优化',
  adjust_model: '调整工作模型',
  inspect: '只检查',
};

const IPV4_LOOPBACK_RE = /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

export function normalizeBindHost(host = '127.0.0.1') {
  const raw = String(host ?? '127.0.0.1').trim();
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1);
  }
  return raw;
}

export function isLoopbackHost(host = '127.0.0.1') {
  const norm = normalizeBindHost(host).toLowerCase();
  if (!norm) return false;
  if (norm === '127.0.0.1' || norm === 'localhost' || norm === '::1') return true;
  return IPV4_LOOPBACK_RE.test(norm);
}

function readRawModulesCatalog() {
  const raw = fs.readFileSync(MODULES_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('modules.json 必须是数组');
  }
  return parsed;
}

function resolveConfiguredModel(cfg, agentId) {
  if (!agentId) return { model: '未配置', configured: false, source: 'unconfigured' };
  const fromCfg = cfg?.models && typeof cfg.models[agentId] === 'string' && cfg.models[agentId].trim()
    ? cfg.models[agentId].trim()
    : null;
  if (fromCfg) {
    return { model: fromCfg, configured: true, source: 'agents.json' };
  }
  if (agentId === 'antigravity' && process.env.AGENTBUS_AGY_MODEL && process.env.AGENTBUS_AGY_MODEL.trim()) {
    return { model: process.env.AGENTBUS_AGY_MODEL.trim(), configured: true, source: 'env' };
  }
  return { model: '未配置', configured: false, source: 'unconfigured' };
}

export function loadModulesCatalog({ rootDir, pkgRoot = PKG_ROOT } = {}) {
  const rawModules = readRawModulesCatalog();
  const cfg = rootDir ? readAgentConfig(rootDir) : { conductor: null, models: {} };
  const cfgFile = rootDir ? agentConfigPath(rootDir) : null;
  const cfgExists = cfgFile ? fs.existsSync(cfgFile) : false;

  const layerMap = new Map();
  const modules = rawModules.map((m) => {
    const ownerAgent = String(m.owner_agent || '').trim() || '未配置';
    const resolvedOwner = ownerAgent === 'conductor' && cfg.conductor ? cfg.conductor : ownerAgent;
    const modelInfo = resolveConfiguredModel(cfg, resolvedOwner);
    const paths = Array.isArray(m.paths) ? m.paths.map(String) : [];
    const existingFiles = paths.filter((p) => fs.existsSync(path.resolve(pkgRoot, p))).length;
    const layer = String(m.layer || 'other');
    const layerLabel = String(m.layer_label || layer);
    if (!layerMap.has(layer)) {
      layerMap.set(layer, { id: layer, label: layerLabel, count: 0 });
    }
    layerMap.get(layer).count += 1;

    return {
      id: String(m.id),
      label: String(m.label || m.id),
      layer,
      layer_label: layerLabel,
      paths,
      files_existing: existingFiles,
      owner_agent: ownerAgent,
      owner_model: modelInfo.model,
      model_configured: modelInfo.configured,
      model_source: modelInfo.source,
      summary: String(m.summary || ''),
      status: String(m.status || 'active'),
    };
  });

  return {
    ok: true,
    root: rootDir || null,
    conductor: cfg.conductor || null,
    conductor_configured: Boolean(cfg.conductor),
    agents_config_exists: cfgExists,
    agents_config_broken: Boolean(cfg.broken),
    module_count: modules.length,
    layers: Array.from(layerMap.values()),
    modules,
  };
}

export function getAgentsPayload({ rootDir } = {}) {
  const cfg = rootDir ? readAgentConfig(rootDir) : { conductor: null, models: {} };
  const cfgFile = rootDir ? agentConfigPath(rootDir) : null;
  const cfgExists = cfgFile ? fs.existsSync(cfgFile) : false;

  const idSet = new Set([
    ...Object.keys(KNOWN_MODELS),
    ...(cfg.conductor ? [cfg.conductor] : []),
    ...Object.keys(cfg.models || {}),
  ]);

  const agents = Array.from(idSet).map((id) => {
    const cfgModel = cfg.models && typeof cfg.models[id] === 'string' && cfg.models[id].trim()
      ? cfg.models[id].trim()
      : null;
    const known = Array.isArray(KNOWN_MODELS[id]) ? KNOWN_MODELS[id] : [];
    const selectableModels = Array.from(new Set([cfgModel, ...known].filter(Boolean)));
    const configured = Boolean(
      id === cfg.conductor ||
      (cfg.models && Object.prototype.hasOwnProperty.call(cfg.models, id))
    );
    return {
      id,
      configured,
      is_conductor: id === cfg.conductor,
      model: cfgModel || '未配置',
      model_configured: Boolean(cfgModel),
      known_models: known,
      selectable_models: selectableModels,
    };
  });

  return {
    ok: true,
    root: rootDir || null,
    conductor: cfg.conductor || null,
    conductor_configured: Boolean(cfg.conductor),
    agents_config_exists: cfgExists,
    agents_config_broken: Boolean(cfg.broken),
    agents,
    adapters: listAdapters(),
  };
}

function makeHttpError(status, code, message) {
  return Object.assign(new Error(message), { status, errorCode: code });
}

export function validateAndBuildConductorRequest({ rootDir, body, pkgRoot = PKG_ROOT }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw makeHttpError(400, 'invalid_body', '请求体必须是 JSON 对象');
  }

  const rawIds = body.module_ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw makeHttpError(400, 'missing_module_ids', 'module_ids 必须是非空数组');
  }
  if (rawIds.length > 50) {
    throw makeHttpError(400, 'too_many_modules', 'module_ids 最多选择 50 个模块');
  }

  const catalog = loadModulesCatalog({ rootDir, pkgRoot });
  const moduleById = new Map(catalog.modules.map((m) => [m.id, m]));
  const selectedModules = [];
  const seenIds = new Set();
  for (const rawId of rawIds) {
    if (typeof rawId !== 'string' || !rawId.trim()) {
      throw makeHttpError(400, 'invalid_module_id', 'module_ids 包含空或非字符串 id');
    }
    const id = rawId.trim();
    const mod = moduleById.get(id);
    if (!mod) {
      throw makeHttpError(400, 'invalid_module_id', `未知模块 id: ${id}`);
    }
    if (!seenIds.has(id)) {
      seenIds.add(id);
      selectedModules.push(mod);
    }
  }

  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!Object.prototype.hasOwnProperty.call(UI_ACTIONS, action)) {
    throw makeHttpError(400, 'invalid_action', `非法 action: ${action || '(空)'}；可选: ${Object.keys(UI_ACTIONS).join(', ')}`);
  }

  const notes = body.notes === undefined || body.notes === null ? '' : String(body.notes).trim();
  if (notes.length > MAX_NOTES_LENGTH) {
    throw makeHttpError(400, 'notes_too_long', `备注过长（超过 ${MAX_NOTES_LENGTH} 字符上限）`);
  }

  const cfg = readAgentConfig(rootDir);
  const cfgFile = agentConfigPath(rootDir);
  const hasExplicitCfg = fs.existsSync(cfgFile) && !cfg.broken && (Boolean(cfg.conductor) || Object.keys(cfg.models || {}).length > 0);

  const configuredAgents = new Set(
    [cfg.conductor, ...Object.keys(cfg.models || {})].filter((v) => typeof v === 'string' && v.trim())
  );
  const allowedAgents = hasExplicitCfg
    ? new Set([...configuredAgents, ...(cfg.conductor ? ['conductor'] : [])])
    : new Set(['conductor', ...Object.keys(KNOWN_MODELS)]);

  const rawTargetAgent = typeof body.target_agent === 'string' ? body.target_agent.trim() : '';
  const targetAgent = rawTargetAgent || (cfg.conductor || 'conductor');
  if (!allowedAgents.has(targetAgent)) {
    throw makeHttpError(400, 'invalid_agent', `目标 agent 不在当前允许配置中: ${targetAgent}`);
  }
  const effectiveTargetAgent = targetAgent === 'conductor' ? (cfg.conductor || 'conductor') : targetAgent;

  const rawTargetModel = typeof body.target_model === 'string' ? body.target_model.trim() : '';
  if (action === 'adjust_model' && !rawTargetModel) {
    throw makeHttpError(400, 'missing_target_model', '动作 adjust_model 必须指定目标模型 (target_model)');
  }

  if (rawTargetModel) {
    const allowedModels = new Set([
      ...(cfg.models?.[effectiveTargetAgent] ? [String(cfg.models[effectiveTargetAgent]).trim()] : []),
      ...(KNOWN_MODELS[effectiveTargetAgent] || []),
    ].filter(Boolean));
    if (!allowedModels.has(rawTargetModel)) {
      throw makeHttpError(
        400,
        'invalid_model',
        `目标模型 ${rawTargetModel} 不在 ${effectiveTargetAgent} 的允许模型列表中`
      );
    }
  }

  let idempotencyKey = null;
  if (body.idempotency_key !== undefined && body.idempotency_key !== null && String(body.idempotency_key).trim()) {
    idempotencyKey = String(body.idempotency_key).trim();
    if (idempotencyKey.length > 128) {
      throw makeHttpError(400, 'invalid_idempotency_key', 'idempotency_key 不得超过 128 字符');
    }
  }

  const conductorAgent = cfg.conductor || 'conductor';
  const actionLabel = UI_ACTIONS[action];
  const targetModelDisplay = rawTargetModel || '未指定（沿用当前配置）';
  const moduleLines = selectedModules.map((m) =>
    `- ${m.id} (${m.label}) | layer=${m.layer} | paths=${m.paths.join(', ')} | 当前负责人=${m.owner_agent} | 当前模型=${m.owner_model}`
  );

  const goal = [
    `# UI 模块调度请求：${actionLabel} (${action})`,
    '',
    '## 选中模块',
    ...moduleLines,
    '',
    '## 调整要求',
    `- 动作：${actionLabel} (${action})`,
    `- 目标 agent：${effectiveTargetAgent}`,
    `- 目标模型：${targetModelDisplay}`,
    `- 用户备注：${notes || '无'}`,
    '',
    '## 验收要求',
    '- 仅围绕上述选中模块及其路径开展检查/重构/优化/模型调整，不得篡改无关核心。',
    '- 保持零第三方运行时依赖，不修改真实客户端配置，不输出任何密钥/令牌。',
    '- 完成后运行 `node --check bin/bus.js` 与 `node test/accept.mjs` 验证全量通过并产出结果 JSON。',
  ].join('\n');

  return {
    selectedModules,
    action,
    actionLabel,
    targetAgent: effectiveTargetAgent,
    targetModel: rawTargetModel || null,
    notes,
    conductorAgent,
    taskInput: {
      to: conductorAgent,
      from: 'ui',
      goal,
      refs: [],
      constraints: [
        '仅修改或检查选中模块对应文件，不破坏既有测试与稳定性。',
        '保持零第三方运行时依赖，不修改真实客户端配置。',
        '不要在公开源码写入个人默认模型。',
      ],
      acceptance: { json: 'true' },
      idempotency_key: idempotencyKey,
    },
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declaredLen = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      req.resume();
      reject(makeHttpError(413, 'payload_too_large', `请求体过大（超过 ${maxBytes} 字节上限）`));
      return;
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.pause();
        reject(makeHttpError(413, 'payload_too_large', `请求体过大（超过 ${maxBytes} 字节上限）`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        fail(makeHttpError(400, 'empty_body', '请求体不能为空'));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        fail(makeHttpError(400, 'invalid_json', '请求体不是合法 JSON'));
      }
    });

    req.on('error', (err) => {
      fail(makeHttpError(400, 'request_error', String(err?.message || err)));
    });
  });
}

function readTasksSafely(config, limit = 25) {
  if (!fs.existsSync(config.dbPath)) {
    return { db_exists: false, tasks: [] };
  }
  const bus = openBusReadOnly({ config });
  try {
    return { db_exists: true, tasks: listTasksReadOnly(bus, { limit }) };
  } finally {
    bus.close();
  }
}

export function createUiRequestHandler({
  config,
  dispatch = false,
  dispatchFn = dispatchTask,
  pkgRoot = PKG_ROOT,
} = {}) {
  return async (req, res) => {
    try {
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = urlObj.pathname;
      const method = String(req.method || 'GET').toUpperCase();

      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }

      if (method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          root: config.rootDir,
          db_exists: fs.existsSync(config.dbPath),
          dispatch_default: Boolean(dispatch),
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/modules') {
        const catalog = loadModulesCatalog({ rootDir: config.rootDir, pkgRoot });
        sendJson(res, 200, {
          ...catalog,
          db_exists: fs.existsSync(config.dbPath),
          dispatch_default: Boolean(dispatch),
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/agents') {
        const payload = getAgentsPayload({ rootDir: config.rootDir });
        sendJson(res, 200, payload);
        return;
      }

      if (method === 'GET' && pathname === '/api/tasks') {
        const rawLim = urlObj.searchParams.get('limit');
        const lim = rawLim ? Math.max(1, Math.min(200, Number(rawLim) || 25)) : 25;
        const data = readTasksSafely(config, lim);
        sendJson(res, 200, { ok: true, root: config.rootDir, ...data });
        return;
      }

      if (pathname === '/api/requests') {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'method_not_allowed', error: '仅支持 POST /api/requests' });
          return;
        }
        const body = await readJsonBody(req, MAX_REQUEST_BODY_BYTES);
        const built = validateAndBuildConductorRequest({ rootDir: config.rootDir, body, pkgRoot });

        const bus = openBus({ config });
        let created;
        let dispatchResult = null;
        let dispatchError = null;
        const shouldDispatch = body.dispatch === true || (dispatch === true && body.dispatch !== false);
        try {
          created = createTask(bus, built.taskInput);
          if (shouldDispatch) {
            try {
              dispatchResult = await dispatchFn(bus, {
                id: created.id,
                cwd: pkgRoot,
                wait_s: Number.isFinite(Number(body.wait_s)) ? Math.max(1, Math.min(30, Number(body.wait_s))) : 3,
              });
            } catch (err) {
              dispatchError = String(err?.message || err);
            }
          }
        } finally {
          bus.close();
        }

        const cmdLine = `node bin/bus.js dispatch ${created.id} --allow-dispatch --root "${config.rootDir}"`;
        sendJson(res, 201, {
          ok: true,
          task_id: created.id,
          state: dispatchResult?.state || created.state,
          to: built.conductorAgent,
          uri: created.uri,
          dedup: created.dedup,
          module_ids: built.selectedModules.map((m) => m.id),
          action: built.action,
          target_agent: built.targetAgent,
          target_model: built.targetModel,
          dispatched: Boolean(dispatchResult && !dispatchError),
          dispatch_requested: shouldDispatch,
          dispatch_command: cmdLine,
          ...(dispatchResult ? { dispatch_result: dispatchResult } : {}),
          ...(dispatchError ? { dispatch_error: dispatchError } : {}),
        });
        return;
      }

      if (pathname === '/api/modules' || pathname === '/api/agents' || pathname === '/api/tasks' || pathname === '/api/health') {
        sendJson(res, 405, { ok: false, code: 'method_not_allowed', error: `不允许的方法 ${method}` });
        return;
      }

      sendJson(res, 404, { ok: false, code: 'not_found', error: `未找到路由: ${pathname}` });
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      const code = err?.errorCode || (status === 500 ? 'internal_error' : 'bad_request');
      sendJson(res, status, {
        ok: false,
        code,
        error: String(err?.message || err || '未知错误'),
      });
    }
  };
}

export async function startUiServer({
  rootOverride = null,
  host = '127.0.0.1',
  port = 0,
  dispatch = false,
  dispatchFn = dispatchTask,
  pkgRoot = PKG_ROOT,
} = {}) {
  const bindHost = normalizeBindHost(host);
  if (!isLoopbackHost(bindHost)) {
    throw Object.assign(
      new Error(`安全拒绝：agentbus ui 仅允许绑定 loopback 地址 (127.0.0.1 / localhost / ::1)，禁止绑定 ${host}`),
      { code: 1 }
    );
  }
  const numPort = Number(port);
  if (!Number.isInteger(numPort) || numPort < 0 || numPort > 65535) {
    throw Object.assign(new Error(`非法 --port 参数: ${port}（须为 0-65535 整数）`), { code: 1 });
  }

  const config = loadConfig({ rootOverride });
  const handler = createUiRequestHandler({ config, dispatch, dispatchFn, pkgRoot });
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, code: 'internal_error', error: String(err?.message || err) });
      } else {
        try { res.end(); } catch {}
      }
    });
  });

  await new Promise((resolve, reject) => {
    const onErr = (err) => reject(Object.assign(new Error(`启动 UI HTTP 服务失败: ${err.message}`), { code: 1 }));
    server.once('error', onErr);
    server.listen(numPort, bindHost, () => {
      server.removeListener('error', onErr);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : numPort;
  const hostForUrl = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
  const url = `http://${hostForUrl}:${actualPort}`;

  let closed = false;
  const close = () => new Promise((resolve) => {
    if (closed) {
      resolve();
      return;
    }
    closed = true;
    try { server.closeAllConnections?.(); } catch {}
    server.close(() => resolve());
  });

  return {
    server,
    url,
    host: bindHost,
    port: actualPort,
    root: config.rootDir,
    dispatch: Boolean(dispatch),
    close,
  };
}
