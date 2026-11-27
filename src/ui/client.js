// Local companion client detection, master/worker role & model preview/apply.
// Reuses src/agents.js and src/setup.js. Zero third-party dependencies, no secrets/tokens, no network calls.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KNOWN_MODELS, agentConfigPath, detectAgents } from '../agents.js';
import { describeClients, doctor, listClients, setupClients } from '../setup.js';

const ALLOWED_POST_KEYS = new Set([
  'conductor',
  'roles',
  'models',
  'clients',
  'enable_dispatch',
  'archive_on_done',
  'require_config_dir',
]);

const VALID_ROLES = new Set(['conductor', 'worker']);

function makeHttpError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, errorCode: code, ...extra });
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

function isPermError(err) {
  return Boolean(err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS'));
}

function checkDirWritableLocal(dirPath) {
  if (fs.existsSync(dirPath)) {
    try {
      const st = fs.statSync(dirPath);
      if (!st.isDirectory()) return { ok: false, code: 'missing_config_dir', reason: 'ENOTDIR', path: dirPath };
      fs.accessSync(dirPath, fs.constants.W_OK);
      return { ok: true };
    } catch (e) {
      return { ok: false, code: isPermError(e) ? 'permission_denied' : 'missing_config_dir', reason: e.code || 'EACCES', path: dirPath };
    }
  }
  let cur = path.dirname(dirPath);
  while (cur && cur !== path.dirname(cur)) {
    if (fs.existsSync(cur)) {
      try {
        const st = fs.statSync(cur);
        if (!st.isDirectory()) return { ok: false, code: 'missing_config_dir', reason: 'ENOTDIR', path: cur };
        fs.accessSync(cur, fs.constants.W_OK);
        return { ok: true };
      } catch (e) {
        return { ok: false, code: isPermError(e) ? 'permission_denied' : 'missing_config_dir', reason: e.code || 'EACCES', path: cur };
      }
    }
    cur = path.dirname(cur);
  }
  return { ok: false, code: 'missing_config_dir', reason: 'ENOENT', path: dirPath };
}

function checkFileWritableLocal(file) {
  if (fs.existsSync(file)) {
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return { ok: false, code: 'invalid_config_path', reason: 'not_a_file', path: file };
      fs.accessSync(file, fs.constants.W_OK);
    } catch (e) {
      return { ok: false, code: isPermError(e) ? 'permission_denied' : 'invalid_config_path', reason: e.code || 'EACCES', path: file };
    }
  }
  return checkDirWritableLocal(path.dirname(file));
}

function writeAtomicLocal(file, text) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (isPermError(e)) {
      throw makeHttpError(403, 'permission_denied', `权限不足，无法创建目录 ${dir} (${e.code})`);
    }
    throw makeHttpError(400, 'missing_config_dir', `无法创建目录 ${dir}: ${e.message}`);
  }
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    if (isPermError(e)) {
      throw makeHttpError(403, 'permission_denied', `权限不足，无法写入文件 ${file} (${e.code})`);
    }
    throw makeHttpError(500, 'write_failed', `写入文件失败 ${file}: ${e.message}`);
  }
}

export function resolveAgentsJsonPath(rootDir, env = process.env) {
  if (env && env !== process.env) {
    if (typeof env.AGENTBUS_AGENTS_CONFIG === 'string' && env.AGENTBUS_AGENTS_CONFIG.trim()) {
      return path.resolve(env.AGENTBUS_AGENTS_CONFIG.trim());
    }
    return path.join(rootDir, 'agents.json');
  }
  return agentConfigPath(rootDir);
}

export function readRawAgentsJson(rootDir, env = process.env) {
  const file = resolveAgentsJsonPath(rootDir, env);
  if (!fs.existsSync(file)) {
    return {
      file,
      exists: false,
      broken: false,
      error: null,
      raw: {},
      conductor: null,
      models: {},
      archive_on_done: false,
      updated_at: null,
    };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return {
      file,
      exists: true,
      broken: true,
      error: `读取 agents.json 失败 (${e.code || 'READ_ERROR'}): ${e.message}`,
      raw: null,
      conductor: null,
      models: {},
      archive_on_done: false,
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
        error: 'agents.json 顶层必须是 JSON 对象',
        raw: null,
        conductor: null,
        models: {},
        archive_on_done: false,
        updated_at: null,
      };
    }
    if (parsed.models !== undefined && !isPlainObject(parsed.models)) {
      return {
        file,
        exists: true,
        broken: true,
        error: 'agents.json 中的 models 字段必须是 JSON 对象',
        raw: null,
        conductor: null,
        models: {},
        archive_on_done: false,
        updated_at: null,
      };
    }
    const cleanModels = {};
    for (const [k, v] of Object.entries(parsed.models || {})) {
      if (typeof v === 'string' && v.trim()) {
        cleanModels[k] = v.trim();
      }
    }
    return {
      file,
      exists: true,
      broken: false,
      error: null,
      raw: parsed,
      conductor: typeof parsed.conductor === 'string' && parsed.conductor.trim() ? parsed.conductor.trim() : null,
      models: cleanModels,
      archive_on_done: parsed.archive_on_done === true,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
    };
  } catch (e) {
    return {
      file,
      exists: true,
      broken: true,
      error: `agents.json JSON 解析失败: ${e.message}`,
      raw: null,
      conductor: null,
      models: {},
      archive_on_done: false,
      updated_at: null,
    };
  }
}

function normalizeRoleValue(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'conductor') return 'conductor';
  if (s === 'worker') return 'worker';
  return null;
}

function unquoteScalar(raw) {
  const s = String(raw ?? '').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}

// Strictly inspects ONLY the agentbus MCP entry's AGENTBUS_ROLE and AGENTBUS_ENABLE_DISPATCH.
// Never reads, stores, or returns any tokens, API keys, passwords, or unrelated server settings.
function extractAgentbusEnvFromFile(file, format) {
  const empty = { role: null, enable_dispatch: null };
  if (!file || !fs.existsSync(file)) return empty;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return empty;
  }

  if (format === 'json-mcpServers' || format === 'json-opencode') {
    try {
      const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (!isPlainObject(data)) return empty;
      const entry = format === 'json-mcpServers'
        ? data.mcpServers?.agentbus
        : data.mcp?.agentbus;
      const envObj = format === 'json-mcpServers' ? entry?.env : entry?.environment;
      if (!isPlainObject(envObj)) return empty;
      return {
        role: normalizeRoleValue(envObj.AGENTBUS_ROLE),
        enable_dispatch: envObj.AGENTBUS_ENABLE_DISPATCH !== undefined
          ? String(envObj.AGENTBUS_ENABLE_DISPATCH).trim() === '1'
          : null,
      };
    } catch {
      return empty;
    }
  }

  if (format === 'toml') {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    let inEnv = false;
    let role = null;
    let enableDispatch = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('[')) {
        inEnv = /^\[\s*mcp_servers\.(?:agentbus|"agentbus"|'agentbus')\.env\s*\]/.test(trimmed);
        continue;
      }
      if (!inEnv) continue;
      const m = /^(AGENTBUS_ROLE|AGENTBUS_ENABLE_DISPATCH)\s*=\s*(.+?)(?:\s+#.*)?$/.exec(trimmed);
      if (!m) continue;
      const val = unquoteScalar(m[2]);
      if (m[1] === 'AGENTBUS_ROLE') role = normalizeRoleValue(val);
      if (m[1] === 'AGENTBUS_ENABLE_DISPATCH') enableDispatch = String(val).trim() === '1';
    }
    return { role, enable_dispatch: enableDispatch };
  }

  if (format === 'dsh-cordis') {
    const norm = raw.replace(/\r\n/g, '\n');
    const blockMatch = /# BEGIN agentbus-managed[\s\S]*?# END agentbus-managed/.exec(norm);
    if (!blockMatch) return empty;
    let role = null;
    let enableDispatch = null;
    for (const line of blockMatch[0].split('\n')) {
      const m = /^\s*(AGENTBUS_ROLE|AGENTBUS_ENABLE_DISPATCH)\s*:\s*(.+?)(?:\s+#.*)?$/.exec(line);
      if (!m) continue;
      const val = unquoteScalar(m[2]);
      if (m[1] === 'AGENTBUS_ROLE') role = normalizeRoleValue(val);
      if (m[1] === 'AGENTBUS_ENABLE_DISPATCH') enableDispatch = String(val).trim() === '1';
    }
    return { role, enable_dispatch: enableDispatch };
  }

  if (format === 'hermes-cli') {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    let inMcp = false;
    let mcpIndent = null;
    let inAgentbus = false;
    let abIndent = null;
    let inEnv = false;
    let envIndent = null;
    let role = null;
    let enableDispatch = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;

      if (indent === 0) {
        inMcp = /^mcp_servers\s*:/.test(trimmed);
        mcpIndent = null;
        inAgentbus = false;
        abIndent = null;
        inEnv = false;
        envIndent = null;
        continue;
      }
      if (!inMcp) continue;
      if (mcpIndent === null) mcpIndent = indent;
      if (indent === mcpIndent) {
        inAgentbus = /^(['"]?)agentbus\1\s*:/.test(trimmed);
        abIndent = null;
        inEnv = false;
        envIndent = null;
        continue;
      }
      if (!inAgentbus || indent < mcpIndent) continue;
      if (abIndent === null) abIndent = indent;
      if (indent === abIndent) {
        inEnv = /^(['"]?)env\1\s*:/.test(trimmed);
        envIndent = null;
        continue;
      }
      if (!inEnv || indent < abIndent) continue;
      if (envIndent === null) envIndent = indent;
      if (indent === envIndent) {
        const m = /^(['"]?)(AGENTBUS_ROLE|AGENTBUS_ENABLE_DISPATCH)\1\s*:\s*(.+?)(?:\s+#.*)?$/.exec(trimmed);
        if (!m) continue;
        const val = unquoteScalar(m[3]);
        if (m[2] === 'AGENTBUS_ROLE') role = normalizeRoleValue(val);
        if (m[2] === 'AGENTBUS_ENABLE_DISPATCH') enableDispatch = String(val).trim() === '1';
      }
    }
    return { role, enable_dispatch: enableDispatch };
  }

  return empty;
}

function parseBinFromHermesPreviewCmd(cmdStr) {
  if (!cmdStr || typeof cmdStr !== 'string') return null;
  const marker = ' mcp add agentbus';
  const idx = cmdStr.indexOf(marker);
  const head = (idx >= 0 ? cmdStr.slice(0, idx) : cmdStr).trim();
  if (!head) return null;
  return unquoteScalar(head);
}

function probeHermesBinary({ home, rootDir, platform, env }) {
  try {
    const res = setupClients({
      clients: ['hermes'],
      root: rootDir,
      home,
      dryRun: true,
      platform,
      processEnv: env,
    });
    const entry = res.results?.[0];
    if (entry?.ok && entry.command) {
      return { bin: parseBinFromHermesPreviewCmd(entry.command), diagnostic: null };
    }
    if (entry && !entry.ok) {
      return {
        bin: null,
        diagnostic: {
          code: entry.error_code || 'missing_binary',
          message: entry.error || '未找到 hermes 可执行文件',
          next: entry.next || null,
        },
      };
    }
  } catch (err) {
    return {
      bin: null,
      diagnostic: {
        code: 'probe_failed',
        message: String(err?.message || err),
        next: null,
      },
    };
  }
  return { bin: null, diagnostic: null };
}

export function detectClientSetup({
  rootDir,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  const resolvedHome = path.resolve(home || os.homedir());
  const explicitHome = home !== undefined && home !== null && path.resolve(home) !== path.resolve(os.homedir());

  const described = describeClients({ home: resolvedHome, platform, env });
  const detectedBinAgents = detectAgents(resolvedHome, { platform, env, explicitHome });
  const binById = new Map(detectedBinAgents.map((a) => [a.id, a]));

  const docReport = doctor({ home: resolvedHome, root: rootDir, env, platform });
  const docById = new Map((docReport.clients || []).map((c) => [c.id, c]));

  const agentsCfg = readRawAgentsJson(rootDir, env);
  const detectionErrors = [];

  if (agentsCfg.broken && agentsCfg.error) {
    detectionErrors.push({
      target: 'agents.json',
      file: agentsCfg.file,
      code: 'corrupted_agents_config',
      message: agentsCfg.error,
    });
  }

  let hermesProbe = null;
  const clients = described.map((desc) => {
    const binAgent = binById.get(desc.id) || null;
    const docEntry = docById.get(desc.id) || null;
    const configPath = desc.config;
    const configExists = Boolean(configPath && fs.existsSync(configPath));
    const configDir = configPath ? path.dirname(configPath) : null;
    const configDirExists = Boolean(configDir && fs.existsSync(configDir));

    let bin = binAgent ? binAgent.bin : null;
    let binSource = binAgent ? binAgent.bin_source : null;
    let diagnostic = binAgent ? binAgent.diagnostic : null;

    if (desc.id === 'hermes' && desc.installed) {
      hermesProbe = probeHermesBinary({ home: resolvedHome, rootDir, platform, env });
      if (hermesProbe.bin) {
        bin = hermesProbe.bin;
        binSource = 'hermes';
      } else if (hermesProbe.diagnostic) {
        diagnostic = hermesProbe.diagnostic;
      }
    }

    const mcpConfigured = docEntry?.configured === true;
    const configError = docEntry?.config_error || null;
    if (configError) {
      detectionErrors.push({
        target: desc.id,
        file: configPath,
        code: 'corrupted_config',
        message: `${desc.label} 配置文件损坏: ${configError}`,
      });
    }

    const mcpEnv = mcpConfigured ? extractAgentbusEnvFromFile(configPath, desc.format) : { role: null, enable_dispatch: null };
    const isAgentsJsonConductor = Boolean(agentsCfg.conductor && agentsCfg.conductor === desc.id);

    let currentRole = 'unconfigured';
    if (mcpEnv.role) {
      currentRole = mcpEnv.role;
    } else if (isAgentsJsonConductor) {
      currentRole = 'conductor';
    } else if (mcpConfigured) {
      currentRole = 'worker';
    }

    const roleMismatch = Boolean(
      mcpEnv.role && agentsCfg.conductor && (
        (isAgentsJsonConductor && mcpEnv.role !== 'conductor') ||
        (!isAgentsJsonConductor && mcpEnv.role === 'conductor')
      )
    );

    const cfgModel = agentsCfg.models[desc.id] || null;
    const knownModels = Array.isArray(KNOWN_MODELS[desc.id]) ? KNOWN_MODELS[desc.id] : [];
    const selectableModels = Array.from(new Set([cfgModel, ...knownModels].filter(Boolean)));

    const installStatus = desc.installed
      ? 'installed'
      : (desc.optional ? 'optional_not_installed' : 'not_installed');

    return {
      id: desc.id,
      label: desc.label,
      format: desc.format,
      optional: Boolean(desc.optional),
      installed: Boolean(desc.installed),
      install_status: installStatus,
      bin,
      bin_source: binSource,
      bin_applicable: Boolean(binAgent || desc.id === 'hermes'),
      env_var: binAgent?.env_var || (desc.id === 'hermes' ? 'AGENTBUS_HERMES_BIN' : (desc.id === 'dsh' ? 'AGENTBUS_DSH_BIN' : null)),
      diagnostic,
      config: configPath,
      config_dir: configDir,
      config_exists: configExists,
      config_dir_exists: configDirExists,
      config_error: configError,
      writable: docEntry?.writable ?? null,
      mcp_configured: mcpConfigured,
      mcp_role: mcpEnv.role,
      mcp_dispatch: mcpEnv.enable_dispatch,
      is_conductor: isAgentsJsonConductor,
      current_role: currentRole,
      role_mismatch: roleMismatch,
      model: cfgModel || '未配置',
      model_value: cfgModel || '',
      model_configured: Boolean(cfgModel),
      known_models: knownModels,
      selectable_models: selectableModels,
      capabilities: binAgent?.capabilities || (desc.id === 'hermes' ? 'conductor-capable' : 'mcp-client'),
    };
  });

  const installedClients = clients.filter((c) => c.installed);
  const currentConductorEntry = clients.find((c) => c.id === agentsCfg.conductor);
  const currentConductorDispatch = currentConductorEntry?.mcp_dispatch !== null && currentConductorEntry?.mcp_dispatch !== undefined
    ? currentConductorEntry.mcp_dispatch
    : true;

  return {
    ok: true,
    root: rootDir,
    home: resolvedHome,
    role_scope: 'client',
    role_scope_note: '角色（AGENTBUS_ROLE）是客户端级环境变量配置，对整个客户端进程生效，而非单对话级。',
    agents_json: {
      file: agentsCfg.file,
      exists: agentsCfg.exists,
      broken: agentsCfg.broken,
      error: agentsCfg.error,
      conductor: agentsCfg.conductor,
      models: agentsCfg.models,
      archive_on_done: agentsCfg.archive_on_done,
      updated_at: agentsCfg.updated_at,
    },
    conductor: agentsCfg.conductor,
    conductor_dispatch: currentConductorDispatch,
    archive_on_done: agentsCfg.archive_on_done,
    installed_count: installedClients.length,
    total_count: clients.length,
    clients,
    known_clients: listClients(),
    detection_errors: detectionErrors,
  };
}

export function validateClientConfigRequest({
  body,
  rootDir,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  if (!isPlainObject(body)) {
    throw makeHttpError(400, 'invalid_body', '请求体必须是 JSON 对象');
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_POST_KEYS.has(key)) {
      throw makeHttpError(400, 'invalid_field', `不允许的字段: ${key}（禁止传入自定义路径或命令字段）`);
    }
  }

  const snapshot = detectClientSetup({ rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map(snapshot.clients.map((c) => [c.id, c]));

  let rolesMap = null;
  if (body.roles !== undefined) {
    if (!isPlainObject(body.roles)) {
      throw makeHttpError(400, 'invalid_role', 'roles 必须是 { agentId: "conductor" | "worker" } 对象');
    }
    rolesMap = {};
    for (const [rawId, rawRole] of Object.entries(body.roles)) {
      const id = String(rawId || '').trim();
      if (!knownSet.has(id)) {
        throw makeHttpError(400, 'invalid_agent', `未知 agent id: ${rawId}`);
      }
      if (typeof rawRole !== 'string' || !VALID_ROLES.has(rawRole.trim())) {
        throw makeHttpError(400, 'invalid_role', `agent ${id} 的角色非法: ${String(rawRole)}（仅允许 conductor 或 worker）`);
      }
      rolesMap[id] = rawRole.trim();
    }
  }

  let conductor = null;
  if (body.conductor !== undefined && body.conductor !== null) {
    if (typeof body.conductor !== 'string' || !body.conductor.trim()) {
      throw makeHttpError(400, 'invalid_agent', 'conductor 必须是非空字符串');
    }
    conductor = body.conductor.trim();
    if (!knownSet.has(conductor)) {
      throw makeHttpError(400, 'invalid_agent', `未知 conductor agent id: ${conductor}`);
    }
  }

  if (rolesMap) {
    const conductorsInRoles = Object.entries(rolesMap)
      .filter(([, r]) => r === 'conductor')
      .map(([id]) => id);
    if (conductorsInRoles.length > 1) {
      throw makeHttpError(400, 'invalid_role', `只能选择 1 个 conductor，但收到多个: ${conductorsInRoles.join(', ')}`);
    }
    if (conductor) {
      if (rolesMap[conductor] && rolesMap[conductor] !== 'conductor') {
        throw makeHttpError(400, 'invalid_role', `conductor=${conductor} 与 roles.${conductor}=${rolesMap[conductor]} 冲突`);
      }
      if (conductorsInRoles.length === 1 && conductorsInRoles[0] !== conductor) {
        throw makeHttpError(400, 'invalid_role', `conductor=${conductor} 与 roles 中的主控 ${conductorsInRoles[0]} 冲突`);
      }
    } else if (conductorsInRoles.length === 1) {
      conductor = conductorsInRoles[0];
    }
  }

  if (!conductor) {
    throw makeHttpError(400, 'missing_conductor', '必须指定 1 个 conductor（主控 agent）');
  }

  const conductorInfo = clientById.get(conductor);
  if (!conductorInfo || !conductorInfo.installed) {
    throw makeHttpError(400, 'agent_not_installed', `选定的 conductor (${conductor}) 当前未安装，不能写入配置或伪造为已安装`);
  }

  let targetClients;
  if (body.clients !== undefined) {
    if (!Array.isArray(body.clients) || body.clients.length === 0) {
      throw makeHttpError(400, 'invalid_clients', 'clients 必须是非空数组');
    }
    const seen = new Set();
    targetClients = [];
    for (const rawId of body.clients) {
      if (typeof rawId !== 'string' || !rawId.trim()) {
        throw makeHttpError(400, 'invalid_agent', 'clients 包含空或非字符串 id');
      }
      const id = rawId.trim();
      if (!knownSet.has(id)) {
        throw makeHttpError(400, 'invalid_agent', `未知客户端 id: ${id}`);
      }
      if (!clientById.get(id)?.installed) {
        throw makeHttpError(400, 'agent_not_installed', `客户端 ${id} 未安装，禁止为其写入配置`);
      }
      if (!seen.has(id)) {
        seen.add(id);
        targetClients.push(id);
      }
    }
    if (!seen.has(conductor)) {
      throw makeHttpError(400, 'invalid_clients', `目标客户端列表必须包含选定的 conductor (${conductor})`);
    }
  } else if (rolesMap && Object.keys(rolesMap).length > 0) {
    targetClients = Object.keys(rolesMap);
    for (const id of targetClients) {
      if (!clientById.get(id)?.installed) {
        throw makeHttpError(400, 'agent_not_installed', `客户端 ${id} 未安装，禁止为其写入配置`);
      }
    }
    if (!targetClients.includes(conductor)) {
      targetClients.unshift(conductor);
    }
  } else {
    targetClients = snapshot.clients.filter((c) => c.installed).map((c) => c.id);
  }

  const resolvedRoles = {};
  for (const id of targetClients) {
    resolvedRoles[id] = id === conductor ? 'conductor' : 'worker';
  }
  if (rolesMap) {
    for (const [id, r] of Object.entries(rolesMap)) {
      if (!clientById.get(id)?.installed) {
        throw makeHttpError(400, 'agent_not_installed', `客户端 ${id} 未安装，禁止配置角色`);
      }
      if (resolvedRoles[id] && resolvedRoles[id] !== r) {
        throw makeHttpError(400, 'invalid_role', `agent ${id} 的角色设置冲突`);
      }
    }
  }

  if (body.enable_dispatch !== undefined && typeof body.enable_dispatch !== 'boolean') {
    throw makeHttpError(400, 'invalid_dispatch_flag', 'enable_dispatch 必须是布尔值');
  }
  const enableDispatch = body.enable_dispatch === undefined ? true : body.enable_dispatch;

  if (body.archive_on_done !== undefined && typeof body.archive_on_done !== 'boolean') {
    throw makeHttpError(400, 'invalid_archive_flag', 'archive_on_done 必须是布尔值');
  }
  const archiveOnDone = body.archive_on_done;

  if (body.require_config_dir !== undefined && typeof body.require_config_dir !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'require_config_dir 必须是布尔值');
  }
  const requireConfigDir = body.require_config_dir === true;

  const modelUpdates = {};
  if (body.models !== undefined) {
    if (!isPlainObject(body.models)) {
      throw makeHttpError(400, 'invalid_model', 'models 必须是 { agentId: modelOrEmpty } 对象');
    }
    for (const [rawId, rawModel] of Object.entries(body.models)) {
      const id = String(rawId || '').trim();
      if (!knownSet.has(id)) {
        throw makeHttpError(400, 'invalid_agent', `models 包含未知 agent id: ${rawId}`);
      }
      if (rawModel === null || rawModel === '') {
        modelUpdates[id] = '';
        continue;
      }
      if (typeof rawModel !== 'string') {
        throw makeHttpError(400, 'invalid_model', `agent ${id} 的模型必须是字符串或空值`);
      }
      const trimmed = rawModel.trim();
      if (!trimmed) {
        modelUpdates[id] = '';
        continue;
      }
      if (/[\r\n\0]/.test(trimmed)) {
        throw makeHttpError(400, 'invalid_model', `agent ${id} 的模型包含非法控制字符`);
      }
      const info = clientById.get(id);
      const allowed = new Set(info?.selectable_models || []);
      if (!allowed.has(trimmed)) {
        throw makeHttpError(
          400,
          'invalid_model',
          `模型 ${trimmed} 不在 ${id} 的已知/已配置模型列表中（允许留空表示未指定）`,
        );
      }
      modelUpdates[id] = trimmed;
    }
  }

  return {
    snapshot,
    conductor,
    targetClients,
    roles: resolvedRoles,
    enableDispatch,
    archiveOnDone,
    requireConfigDir,
    modelUpdates,
  };
}

function computeAgentsJsonPlan(rawState, { conductor, modelUpdates, archiveOnDone }) {
  const prevModels = { ...(rawState.models || {}) };
  const nextModels = { ...prevModels };
  for (const [id, val] of Object.entries(modelUpdates)) {
    if (!val) delete nextModels[id];
    else nextModels[id] = val;
  }

  const prevArchive = rawState.archive_on_done === true;
  const effArchive = archiveOnDone !== undefined ? archiveOnDone : prevArchive;

  const modelKeys = Array.from(new Set([...Object.keys(prevModels), ...Object.keys(nextModels)])).sort();
  const modelChanges = [];
  for (const k of modelKeys) {
    const before = prevModels[k] || '';
    const after = nextModels[k] || '';
    if (before !== after) {
      modelChanges.push({
        agent: k,
        before: before || '未配置',
        after: after || '未配置',
      });
    }
  }

  const conductorChanged = (rawState.conductor || null) !== conductor;
  const archiveChanged = archiveOnDone !== undefined && prevArchive !== effArchive;
  const changed = !rawState.exists || conductorChanged || modelChanges.length > 0 || archiveChanged;

  const nextPayload = rawState.raw
    ? {
        ...rawState.raw,
        conductor,
        models: nextModels,
        ...(archiveOnDone !== undefined ? { archive_on_done: effArchive } : {}),
      }
    : null;

  return {
    file: rawState.file,
    exists: rawState.exists,
    broken: rawState.broken,
    error: rawState.error,
    changed,
    conductor_before: rawState.conductor || '未配置',
    conductor_after: conductor,
    archive_before: prevArchive,
    archive_after: effArchive,
    models_before: prevModels,
    models_after: nextModels,
    model_changes: modelChanges,
    nextPayload,
  };
}

function buildClientWarnings(clientInfo, setupEntry, { role, allowDispatch }) {
  const warnings = Array.isArray(setupEntry?.warnings) ? [...setupEntry.warnings] : [];
  if (clientInfo.id === 'hermes' && setupEntry?.ok && !setupEntry.changed) {
    const roleDiffers = clientInfo.mcp_role && clientInfo.mcp_role !== role;
    const dispatchDiffers = clientInfo.mcp_dispatch !== null && clientInfo.mcp_dispatch !== allowDispatch;
    if (roleDiffers || dispatchDiffers) {
      warnings.push({
        code: 'hermes_existing_entry_unchanged',
        message: `Hermes 配置中已存在 agentbus，setupClients 为防重复添加已跳过写入（当前 MCP 角色=${clientInfo.mcp_role || '未知'}，目标=${role}，dispatch=${allowDispatch ? '1' : '0'}）。`,
        next: '如需变更 Hermes 自身 MCP 环境变量，请先执行 hermes mcp remove agentbus 后重新配置，或手动更新 Hermes config.yaml 中的 AGENTBUS_ROLE / AGENTBUS_ENABLE_DISPATCH。',
      });
    }
  }
  return warnings;
}

export function previewClientConfig({
  body,
  rootDir,
  allowedRoots,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  const validated = validateClientConfigRequest({ body, rootDir, home, platform, env });
  const rawAgents = readRawAgentsJson(rootDir, env);
  const agentsPlan = computeAgentsJsonPlan(rawAgents, validated);
  const clientById = new Map(validated.snapshot.clients.map((c) => [c.id, c]));

  const errors = [];
  if (agentsPlan.broken) {
    errors.push({
      target: 'agents.json',
      file: agentsPlan.file,
      code: 'corrupted_agents_config',
      message: agentsPlan.error,
      next: `请先修复或手动备份后清理损坏的 "${agentsPlan.file}"`,
    });
  } else {
    const writableCheck = checkFileWritableLocal(agentsPlan.file);
    if (!writableCheck.ok) {
      errors.push({
        target: 'agents.json',
        file: agentsPlan.file,
        code: writableCheck.code,
        message: `无法写入 agents.json (${writableCheck.reason}): ${writableCheck.path}`,
        next: `检查文件/目录权限: "${writableCheck.path}"`,
      });
    }
  }

  const clientPreviews = [];
  const roleChanges = [];
  const filesToModify = [];
  if (agentsPlan.changed) {
    filesToModify.push(agentsPlan.file);
  }

  for (const id of validated.targetClients) {
    const info = clientById.get(id);
    const role = validated.roles[id];
    const allowDispatch = role === 'conductor' && validated.enableDispatch;

    const beforeRoleLabel = info.current_role === 'unconfigured' ? '未配置' : info.current_role;
    const dispatchChanged = role === 'conductor' && info.mcp_dispatch !== allowDispatch;
    if (beforeRoleLabel !== role || dispatchChanged) {
      roleChanges.push({
        agent: id,
        label: info.label,
        before: beforeRoleLabel,
        after: role,
        allow_dispatch: allowDispatch,
      });
    }

    const dry = setupClients({
      clients: [id],
      root: rootDir,
      allowed: allowedRoots && allowedRoots.length ? allowedRoots : [rootDir],
      home,
      role,
      allowDispatch,
      requireConfigDir: validated.requireConfigDir,
      dryRun: true,
      platform,
      processEnv: env,
    });
    const entry = dry.results?.[0] || { ok: false, client: id, error_code: 'preview_failed', error: '预览失败' };

    let permIssue = null;
    if (entry.ok && entry.changed) {
      if (validated.requireConfigDir && !fs.existsSync(path.dirname(entry.file || info.config))) {
        permIssue = {
          code: 'missing_config_dir',
          message: `缺少配置目录: ${path.dirname(entry.file || info.config)}`,
          next: `先运行一次 ${info.label} 或创建该目录后重试`,
        };
      } else {
        const wc = checkFileWritableLocal(entry.file || info.config);
        if (!wc.ok) {
          permIssue = {
            code: wc.code,
            message: `权限不足或目录不可写 (${wc.reason}): ${wc.path}`,
            next: `检查文件/目录写权限: "${wc.path}"`,
          };
        }
      }
    }

    const ok = Boolean(entry.ok && !permIssue);
    const warnings = buildClientWarnings(info, entry, { role, allowDispatch });

    if (!ok) {
      const errCode = permIssue?.code || entry.error_code || 'preview_failed';
      const errMsg = permIssue?.message || entry.error || '配置预检失败';
      const errNext = permIssue?.next || entry.next || null;
      errors.push({
        target: id,
        file: entry.file || info.config,
        code: errCode,
        message: errMsg,
        next: errNext,
      });
    } else if (entry.changed) {
      filesToModify.push(entry.file || info.config);
    }

    clientPreviews.push({
      ok,
      client: id,
      label: info.label,
      file: entry.file || info.config,
      role,
      allow_dispatch: allowDispatch,
      changed: Boolean(entry.changed),
      dry_run: true,
      backup_will_create: Boolean(entry.changed && fs.existsSync(entry.file || info.config)),
      warnings,
      ...(entry.note ? { note: entry.note } : {}),
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.preview ? { preview: entry.preview } : {}),
      ...(!ok ? {
        error_code: permIssue?.code || entry.error_code || 'preview_failed',
        error: permIssue?.message || entry.error || '配置预检失败',
        next: permIssue?.next || entry.next || null,
      } : {}),
      restart_required: Boolean(entry.changed),
    });
  }

  return {
    ok: errors.length === 0,
    dry_run: true,
    conductor: validated.conductor,
    enable_dispatch: validated.enableDispatch,
    archive_on_done: agentsPlan.archive_after,
    role_scope_note: validated.snapshot.role_scope_note,
    agents_json: {
      file: agentsPlan.file,
      exists: agentsPlan.exists,
      broken: agentsPlan.broken,
      changed: agentsPlan.changed,
      backup_will_create: Boolean(agentsPlan.changed && agentsPlan.exists),
      conductor_before: agentsPlan.conductor_before,
      conductor_after: agentsPlan.conductor_after,
      archive_before: agentsPlan.archive_before,
      archive_after: agentsPlan.archive_after,
      model_changes: agentsPlan.model_changes,
      ...(agentsPlan.error ? { error: agentsPlan.error } : {}),
    },
    clients: clientPreviews,
    summary: {
      files_to_modify: filesToModify,
      role_changes: roleChanges,
      model_changes: agentsPlan.model_changes,
    },
    errors,
    restart_notice: '配置生效需要手动重启已修改的客户端（如 Codex / Antigravity / Hermes / DSH 等），本工具不会自动重启任何主程序。',
  };
}

export function applyClientConfig({
  body,
  rootDir,
  allowedRoots,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  // Run full validation and read-only preflight before writing any file.
  const preflight = previewClientConfig({ body, rootDir, allowedRoots, home, platform, env });
  if (!preflight.ok) {
    const first = preflight.errors[0] || { code: 'preflight_failed', message: '配置预检失败，未写入任何文件' };
    const status = first.code === 'permission_denied' ? 403 : 422;
    return {
      status,
      payload: {
        ok: false,
        applied: false,
        partial: false,
        code: first.code,
        error: first.message,
        next: first.next || null,
        errors: preflight.errors,
        agents_json: preflight.agents_json,
        clients: preflight.clients,
      },
    };
  }

  const validated = validateClientConfigRequest({ body, rootDir, home, platform, env });
  const rawAgents = readRawAgentsJson(rootDir, env);
  const agentsPlan = computeAgentsJsonPlan(rawAgents, validated);
  const clientById = new Map(validated.snapshot.clients.map((c) => [c.id, c]));

  const writeErrors = [];
  let agentsResult;
  try {
    let backup = null;
    let updatedAt = rawAgents.updated_at;
    if (agentsPlan.changed) {
      updatedAt = new Date().toISOString();
      const payloadToWrite = {
        ...agentsPlan.nextPayload,
        updated_at: updatedAt,
      };
      backup = backupIfExists(agentsPlan.file);
      try {
        writeAtomicLocal(agentsPlan.file, JSON.stringify(payloadToWrite, null, 2) + '\n');
      } catch (e) {
        if (backup && fs.existsSync(backup)) {
          try { fs.unlinkSync(backup); } catch {}
        }
        throw e;
      }
    }
    agentsResult = {
      ok: true,
      file: agentsPlan.file,
      changed: agentsPlan.changed,
      backup,
      conductor: validated.conductor,
      models: agentsPlan.models_after,
      archive_on_done: agentsPlan.archive_after,
      updated_at: updatedAt,
    };
  } catch (err) {
    const errCode = err?.errorCode || 'write_failed';
    const status = Number.isInteger(err?.status) ? err.status : 500;
    return {
      status,
      payload: {
        ok: false,
        applied: false,
        partial: false,
        code: errCode,
        error: String(err?.message || err),
        errors: [{ target: 'agents.json', file: agentsPlan.file, code: errCode, message: String(err?.message || err) }],
        clients: [],
      },
    };
  }

  const clientResults = [];
  for (const id of validated.targetClients) {
    const info = clientById.get(id);
    const role = validated.roles[id];
    const allowDispatch = role === 'conductor' && validated.enableDispatch;

    const res = setupClients({
      clients: [id],
      root: rootDir,
      allowed: allowedRoots && allowedRoots.length ? allowedRoots : [rootDir],
      home,
      role,
      allowDispatch,
      requireConfigDir: validated.requireConfigDir,
      dryRun: false,
      platform,
      processEnv: env,
    });
    const entry = res.results?.[0] || { ok: false, client: id, file: info.config, error_code: 'setup_failed', error: '写入失败' };
    const warnings = buildClientWarnings(info, entry, { role, allowDispatch });

    const out = {
      ok: Boolean(entry.ok),
      client: id,
      label: info.label,
      role,
      allow_dispatch: allowDispatch,
      file: entry.file || info.config,
      changed: Boolean(entry.changed),
      backup: entry.backup || null,
      warnings,
      ...(entry.note ? { note: entry.note } : {}),
      ...(entry.verified_by ? { verified_by: entry.verified_by } : {}),
      restart_required: Boolean(entry.changed || entry.restart_required),
      ...(!entry.ok ? {
        error_code: entry.error_code || 'setup_failed',
        error: entry.error || '写入失败',
        next: entry.next || null,
      } : {}),
    };
    clientResults.push(out);
    if (!entry.ok) {
      writeErrors.push({
        target: id,
        file: out.file,
        code: out.error_code,
        message: out.error,
        next: out.next,
      });
    }
  }

  const allOk = writeErrors.length === 0;
  const restartClients = clientResults.filter((r) => r.ok && r.restart_required).map((r) => r.client);
  const restartNotice = restartClients.length > 0
    ? `配置已写入。请手动重启以下客户端以使新角色与环境变量生效：${restartClients.join(', ')}（本工具不会自动重启任何客户端）。`
    : '配置检查与写入完成；客户端 MCP 配置文件无实质变更（如修改了 agents.json 模型/主控，仍建议按需重启主控客户端）。';

  return {
    status: allOk ? 200 : 500,
    payload: {
      ok: allOk,
      applied: allOk,
      partial: !allOk && (agentsResult.changed || clientResults.some((r) => r.ok && r.changed)),
      ...(allOk ? {} : {
        code: writeErrors[0]?.code || 'partial_apply_failed',
        error: `部分或全部客户端写入失败: ${writeErrors.map((e) => `${e.target}: ${e.message}`).join('；')}`,
        errors: writeErrors,
      }),
      conductor: validated.conductor,
      enable_dispatch: validated.enableDispatch,
      archive_on_done: agentsResult.archive_on_done,
      agents_json: agentsResult,
      clients: clientResults,
      restart_required_clients: restartClients,
      restart_notice: restartNotice,
    },
  };
}
