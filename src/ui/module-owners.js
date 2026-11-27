// Local module owner/model overrides stored strictly under the active bus root.
// Never mutates git-tracked src/ui/modules.json or writes personal preferences into source.
// Zero third-party dependencies.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KNOWN_MODELS, readAgentConfig } from '../agents.js';
import { listAdapters } from '../dispatch.js';
import { listClients } from '../setup.js';
import { detectClientSetup } from './client.js';

export const MODULE_OWNERS_SCHEMA = 'agentbus/module-owners@1';

const ALLOWED_UPDATE_TOP_KEYS = new Set([
  'updates',
  'module_id',
  'module_ids',
  'owner_agent',
  'owner_model',
]);

const ALLOWED_UPDATE_ITEM_KEYS = new Set([
  'module_id',
  'owner_agent',
  'owner_model',
]);

const ALLOWED_RESET_KEYS = new Set(['module_ids', 'all']);

function makeHttpError(status, code, message) {
  return Object.assign(new Error(message), { status, errorCode: code });
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupIfExists(file) {
  if (!fs.existsSync(file)) return null;
  const base = `${file}.bak-${stamp()}`;
  let bak = base;
  let seq = 1;
  while (fs.existsSync(bak)) {
    bak = `${base}-${seq++}`;
  }
  fs.copyFileSync(file, bak);
  return bak;
}

function writeAtomicJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw makeHttpError(500, 'write_failed', `写入模块负责人配置失败: ${err.message}`);
  }
}

export function moduleOwnersPath(rootDir) {
  return path.join(rootDir, 'module-owners.json');
}

export function readModuleOwners(rootDir) {
  if (!rootDir) {
    return {
      file: null,
      exists: false,
      broken: false,
      error: null,
      raw: {},
      overrides: {},
      updated_at: null,
    };
  }
  const file = moduleOwnersPath(rootDir);
  if (!fs.existsSync(file)) {
    return {
      file,
      exists: false,
      broken: false,
      error: null,
      raw: {},
      overrides: {},
      updated_at: null,
    };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return {
      file,
      exists: true,
      broken: true,
      error: `读取 module-owners.json 失败 (${err.code || 'READ_ERROR'}): ${err.message}`,
      raw: null,
      overrides: {},
      updated_at: null,
    };
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!isPlainObject(parsed)) {
      return {
        file,
        exists: true,
        broken: true,
        error: 'module-owners.json 顶层必须是 JSON 对象',
        raw: null,
        overrides: {},
        updated_at: null,
      };
    }
    if (parsed.overrides !== undefined && !isPlainObject(parsed.overrides)) {
      return {
        file,
        exists: true,
        broken: true,
        error: 'module-owners.json 的 overrides 字段必须是 JSON 对象',
        raw: null,
        overrides: {},
        updated_at: null,
      };
    }
    const cleanOverrides = {};
    for (const [modId, val] of Object.entries(parsed.overrides || {})) {
      if (!isPlainObject(val)) continue;
      const agent = typeof val.owner_agent === 'string' ? val.owner_agent.trim() : '';
      const model = typeof val.owner_model === 'string' ? val.owner_model.trim() : '';
      if (!agent && !model) continue;
      cleanOverrides[modId] = {
        owner_agent: agent,
        owner_model: model,
        updated_at: typeof val.updated_at === 'string' ? val.updated_at : null,
      };
    }
    return {
      file,
      exists: true,
      broken: false,
      error: null,
      raw: parsed,
      overrides: cleanOverrides,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
    };
  } catch (err) {
    return {
      file,
      exists: true,
      broken: true,
      error: `module-owners.json JSON 解析失败: ${err.message}`,
      raw: null,
      overrides: {},
      updated_at: null,
    };
  }
}

export function buildSelectableModuleAgents({
  rootDir,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  const setup = detectClientSetup({ rootDir, home, platform, env });
  const cfg = rootDir ? readAgentConfig(rootDir) : { conductor: null, models: {} };
  const adapters = new Set(listAdapters());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const orderedIds = Array.from(new Set([
    ...(setup.clients || []).map((c) => c.id),
    ...Object.keys(KNOWN_MODELS),
    ...(cfg.conductor ? [cfg.conductor] : []),
    ...Object.keys(cfg.models || {}),
  ]));

  const agents = orderedIds.map((id) => {
    const info = clientById.get(id) || null;
    const cfgModel = cfg.models && typeof cfg.models[id] === 'string' && cfg.models[id].trim()
      ? cfg.models[id].trim()
      : '';
    const known = Array.isArray(KNOWN_MODELS[id]) ? KNOWN_MODELS[id] : [];
    const selectableModels = Array.from(new Set([
      ...(info?.selectable_models || []),
      cfgModel,
      ...known,
    ].filter(Boolean)));
    const envAdapterKey = `AGENTBUS_ADAPTER_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const dispatchable = adapters.has(id) || Boolean(env && env[envAdapterKey]);
    const installed = Boolean(info?.installed);
    const configured = Boolean(
      id === cfg.conductor ||
      (cfg.models && Object.prototype.hasOwnProperty.call(cfg.models, id))
    );
    return {
      id,
      label: info?.label || id,
      installed,
      configured,
      is_conductor: id === cfg.conductor,
      dispatchable,
      model: cfgModel || '未配置',
      model_value: cfgModel,
      model_configured: Boolean(cfgModel),
      selectable_models: selectableModels,
    };
  });

  return { agents, setup, cfg };
}

function normalizeUpdateItems(body) {
  if (!isPlainObject(body)) {
    throw makeHttpError(400, 'invalid_body', '请求体必须是 JSON 对象');
  }
  for (const k of Object.keys(body)) {
    if (!ALLOWED_UPDATE_TOP_KEYS.has(k)) {
      throw makeHttpError(400, 'invalid_field', `不允许的字段: ${k}`);
    }
  }

  if (body.updates !== undefined) {
    if (!Array.isArray(body.updates) || body.updates.length === 0) {
      throw makeHttpError(400, 'invalid_updates', 'updates 必须是非空数组');
    }
    if (body.updates.length > 50) {
      throw makeHttpError(400, 'too_many_updates', '单次最多更新 50 个模块');
    }
    return body.updates.map((item, idx) => {
      if (!isPlainObject(item)) {
        throw makeHttpError(400, 'invalid_updates', `updates[${idx}] 必须是 JSON 对象`);
      }
      for (const k of Object.keys(item)) {
        if (!ALLOWED_UPDATE_ITEM_KEYS.has(k)) {
          throw makeHttpError(400, 'invalid_field', `updates[${idx}] 包含不允许的字段: ${k}`);
        }
      }
      return item;
    });
  }

  if (body.module_ids !== undefined) {
    if (!Array.isArray(body.module_ids) || body.module_ids.length === 0) {
      throw makeHttpError(400, 'missing_module_ids', 'module_ids 必须是非空数组');
    }
    if (body.module_ids.length > 50) {
      throw makeHttpError(400, 'too_many_modules', '单次最多批量更新 50 个模块');
    }
    return body.module_ids.map((id) => ({
      module_id: id,
      ...(body.owner_agent !== undefined ? { owner_agent: body.owner_agent } : {}),
      ...(body.owner_model !== undefined ? { owner_model: body.owner_model } : {}),
    }));
  }

  if (body.module_id !== undefined) {
    return [{
      module_id: body.module_id,
      ...(body.owner_agent !== undefined ? { owner_agent: body.owner_agent } : {}),
      ...(body.owner_model !== undefined ? { owner_model: body.owner_model } : {}),
    }];
  }

  throw makeHttpError(400, 'missing_module_ids', '请提供 module_id、module_ids 或 updates');
}

export function updateModuleOwners({
  body,
  rootDir,
  rawModules,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  if (!rootDir) {
    throw makeHttpError(500, 'missing_root', '未指定总线根目录');
  }

  const existing = readModuleOwners(rootDir);
  if (existing.broken) {
    throw makeHttpError(
      422,
      'corrupted_module_owners_config',
      `模块负责人覆盖文件已损坏，已拒绝覆盖：${existing.error}（请手动检查 ${existing.file}）`,
    );
  }

  const items = normalizeUpdateItems(body);
  const moduleById = new Map((rawModules || []).map((m) => [String(m.id), m]));
  const { agents } = buildSelectableModuleAgents({ rootDir, home, platform, env });
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const knownClientIds = new Set([...listClients(), ...Object.keys(KNOWN_MODELS)]);

  const nextOverrides = { ...existing.overrides };
  const updatedIds = [];
  const now = new Date().toISOString();

  for (const item of items) {
    const modId = typeof item.module_id === 'string' ? item.module_id.trim() : '';
    if (!modId || !moduleById.has(modId)) {
      throw makeHttpError(400, 'invalid_module_id', `未知模块 id: ${modId || '(空)'}`);
    }

    const baseMod = moduleById.get(modId);
    const curOverride = nextOverrides[modId] || null;
    const rawAgent = item.owner_agent !== undefined
      ? item.owner_agent
      : (curOverride?.owner_agent || baseMod.owner_agent || '');

    if (typeof rawAgent !== 'string' || !rawAgent.trim()) {
      throw makeHttpError(400, 'invalid_agent', `模块 ${modId} 必须指定有效的负责 Agent`);
    }
    const ownerAgent = rawAgent.trim();
    if (!knownClientIds.has(ownerAgent) && !agentById.has(ownerAgent)) {
      throw makeHttpError(400, 'invalid_agent', `未知负责 Agent: ${ownerAgent}`);
    }
    const agentInfo = agentById.get(ownerAgent);
    if (!agentInfo || (!agentInfo.installed && !agentInfo.configured)) {
      throw makeHttpError(
        400,
        'agent_not_installed',
        `负责 Agent "${ownerAgent}" 当前未安装且未在本机配置，无法分配给模块 ${modId}`,
      );
    }

    let ownerModel = '';
    const agentChanged = item.owner_agent !== undefined &&
      ownerAgent !== (curOverride?.owner_agent || baseMod.owner_agent || '');

    if (item.owner_model !== undefined) {
      if (item.owner_model === null || item.owner_model === '') {
        ownerModel = '';
      } else if (typeof item.owner_model !== 'string') {
        throw makeHttpError(400, 'invalid_model', `模块 ${modId} 的模型必须是字符串或空值`);
      } else {
        ownerModel = item.owner_model.trim();
      }
    } else if (!agentChanged && curOverride?.owner_model) {
      ownerModel = curOverride.owner_model;
    }

    if (ownerModel) {
      if (/[\r\n\0]/.test(ownerModel)) {
        throw makeHttpError(400, 'invalid_model', `模块 ${modId} 的模型包含非法控制字符`);
      }
      const allowedModels = new Set(agentInfo.selectable_models || []);
      if (!allowedModels.has(ownerModel)) {
        throw makeHttpError(
          400,
          'invalid_model',
          `模型 "${ownerModel}" 不在 ${ownerAgent} 的允许模型列表中（可留空沿用默认配置）`,
        );
      }
    }

    nextOverrides[modId] = {
      owner_agent: ownerAgent,
      owner_model: ownerModel,
      updated_at: now,
    };
    if (!updatedIds.includes(modId)) updatedIds.push(modId);
  }

  const nextPayload = {
    ...(existing.raw && isPlainObject(existing.raw) ? existing.raw : {}),
    schema: MODULE_OWNERS_SCHEMA,
    overrides: nextOverrides,
    updated_at: now,
  };

  const backup = backupIfExists(existing.file);
  try {
    writeAtomicJson(existing.file, nextPayload);
  } catch (err) {
    if (backup && fs.existsSync(backup)) {
      try { fs.unlinkSync(backup); } catch {}
    }
    throw err;
  }

  return {
    ok: true,
    schema: MODULE_OWNERS_SCHEMA,
    file: existing.file,
    backup,
    updated_ids: updatedIds,
    overrides: nextOverrides,
    updated_at: now,
  };
}

export function resetModuleOwners({
  body = {},
  rootDir,
  rawModules,
}) {
  if (!isPlainObject(body)) {
    throw makeHttpError(400, 'invalid_body', '请求体必须是 JSON 对象');
  }
  for (const k of Object.keys(body)) {
    if (!ALLOWED_RESET_KEYS.has(k)) {
      throw makeHttpError(400, 'invalid_field', `不允许的字段: ${k}`);
    }
  }

  const existing = readModuleOwners(rootDir);
  if (existing.broken) {
    throw makeHttpError(
      422,
      'corrupted_module_owners_config',
      `模块负责人覆盖文件已损坏，已拒绝覆盖：${existing.error}`,
    );
  }

  const moduleIdsSet = new Set((rawModules || []).map((m) => String(m.id)));
  const nextOverrides = { ...existing.overrides };
  let resetIds = [];

  if (body.all === true) {
    resetIds = Object.keys(nextOverrides);
    for (const k of resetIds) delete nextOverrides[k];
  } else {
    if (!Array.isArray(body.module_ids) || body.module_ids.length === 0) {
      throw makeHttpError(400, 'missing_module_ids', '请指定要恢复默认的 module_ids 或传入 all: true');
    }
    for (const rawId of body.module_ids) {
      const id = typeof rawId === 'string' ? rawId.trim() : '';
      if (!id || !moduleIdsSet.has(id)) {
        throw makeHttpError(400, 'invalid_module_id', `未知模块 id: ${id || '(空)'}`);
      }
      if (Object.prototype.hasOwnProperty.call(nextOverrides, id)) {
        delete nextOverrides[id];
        resetIds.push(id);
      }
    }
  }

  const now = new Date().toISOString();
  const nextPayload = {
    ...(existing.raw && isPlainObject(existing.raw) ? existing.raw : {}),
    schema: MODULE_OWNERS_SCHEMA,
    overrides: nextOverrides,
    updated_at: now,
  };

  let backup = null;
  if (existing.exists || resetIds.length > 0) {
    backup = backupIfExists(existing.file);
    try {
      writeAtomicJson(existing.file, nextPayload);
    } catch (err) {
      if (backup && fs.existsSync(backup)) {
        try { fs.unlinkSync(backup); } catch {}
      }
      throw err;
    }
  }

  return {
    ok: true,
    schema: MODULE_OWNERS_SCHEMA,
    file: existing.file,
    backup,
    reset_ids: resetIds,
    overrides: nextOverrides,
    updated_at: now,
  };
}
