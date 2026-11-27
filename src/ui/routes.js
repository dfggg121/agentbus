// Project auto-routing rules persistence, strict validation, and rule-matching engine.
// Zero third-party dependencies. Stored strictly under the active bus root (never in git-tracked source).

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listClients } from '../setup.js';
import { detectClientSetup } from './client.js';

export const ROUTING_SCHEMA = 'agentbus/project-routing@1';
export const MAX_ROUTING_RULES = 100;

const ALLOWED_TOP_KEYS = new Set(['rules']);
const ALLOWED_RULE_KEYS = new Set([
  'id',
  'name',
  'match_type',
  'categories',
  'keywords',
  'agent',
  'model',
  'priority',
  'enabled',
]);

const VALID_MATCH_TYPES = new Set(['any', 'both', 'category', 'keyword', 'all']);
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

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
    throw makeHttpError(500, 'write_failed', `写入路由配置失败: ${err.message}`);
  }
}

export function routingConfigPath(rootDir) {
  return path.join(rootDir, 'project-routing.json');
}

function normalizeStringList(raw, fieldName, { maxItems = 20, maxLen = 64 } = {}) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) : null);
  if (!list) {
    throw makeHttpError(400, 'invalid_rule', `${fieldName} 必须是字符串数组`);
  }
  if (list.length > maxItems) {
    throw makeHttpError(400, 'invalid_rule', `${fieldName} 最多允许 ${maxItems} 项`);
  }
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') {
      throw makeHttpError(400, 'invalid_rule', `${fieldName} 仅允许字符串项`);
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxLen) {
      throw makeHttpError(400, 'invalid_rule', `${fieldName} 单项长度不能超过 ${maxLen} 字符`);
    }
    if (/[\r\n\0]/.test(trimmed)) {
      throw makeHttpError(400, 'invalid_rule', `${fieldName} 包含非法控制字符`);
    }
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

export function readRoutingConfig(rootDir) {
  const file = routingConfigPath(rootDir);
  if (!fs.existsSync(file)) {
    return {
      file,
      exists: false,
      broken: false,
      error: null,
      raw: {},
      rules: [],
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
      error: `读取路由规则配置失败 (${err.code || 'READ_ERROR'}): ${err.message}`,
      raw: null,
      rules: [],
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
        error: 'project-routing.json 顶层必须是 JSON 对象',
        raw: null,
        rules: [],
        updated_at: null,
      };
    }
    if (parsed.rules !== undefined && !Array.isArray(parsed.rules)) {
      return {
        file,
        exists: true,
        broken: true,
        error: 'project-routing.json 中的 rules 字段必须是数组',
        raw: null,
        rules: [],
        updated_at: null,
      };
    }
    const rules = (parsed.rules || []).map((r, idx) => {
      if (!isPlainObject(r)) {
        throw new Error(`第 ${idx + 1} 条规则不是对象`);
      }
      const matchType = VALID_MATCH_TYPES.has(String(r.match_type || 'any'))
        ? (r.match_type === 'both' ? 'any' : String(r.match_type || 'any'))
        : 'any';
      return {
        id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `rule_${idx + 1}`,
        name: typeof r.name === 'string' ? r.name.trim() : '',
        match_type: matchType,
        categories: Array.isArray(r.categories) ? r.categories.map((s) => String(s || '').trim()).filter(Boolean) : [],
        keywords: Array.isArray(r.keywords) ? r.keywords.map((s) => String(s || '').trim()).filter(Boolean) : [],
        agent: typeof r.agent === 'string' ? r.agent.trim() : '',
        model: typeof r.model === 'string' ? r.model.trim() : '',
        priority: Number.isFinite(Number(r.priority)) ? Math.trunc(Number(r.priority)) : 100,
        enabled: r.enabled !== false,
      };
    });
    return {
      file,
      exists: true,
      broken: false,
      error: null,
      raw: parsed,
      rules,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
    };
  } catch (err) {
    return {
      file,
      exists: true,
      broken: true,
      error: `project-routing.json 解析失败: ${err.message}`,
      raw: null,
      rules: [],
      updated_at: null,
    };
  }
}

export function getRoutingPayload({
  rootDir,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  const cfg = readRoutingConfig(rootDir);
  const setup = detectClientSetup({ rootDir, home, platform, env });
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const annotatedRules = cfg.rules.map((r) => {
    const info = clientById.get(r.agent) || null;
    const agentInstalled = Boolean(info && info.installed);
    const modelValid = !r.model || Boolean(info && (info.selectable_models || []).includes(r.model));
    return {
      ...r,
      agent_installed: agentInstalled,
      model_valid: modelValid,
    };
  });

  const installedAgents = (setup.clients || [])
    .filter((c) => c.installed)
    .map((c) => ({
      id: c.id,
      label: c.label,
      model: c.model,
      model_value: c.model_value,
      model_configured: c.model_configured,
      selectable_models: c.selectable_models,
      is_conductor: c.is_conductor,
    }));

  return {
    ok: true,
    schema: ROUTING_SCHEMA,
    root: rootDir,
    file: cfg.file,
    exists: cfg.exists,
    broken: cfg.broken,
    error: cfg.error,
    updated_at: cfg.updated_at,
    rules: annotatedRules,
    installed_agents: installedAgents,
    conductor: setup.conductor,
  };
}

export function validateRoutingRulesPayload({
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
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw makeHttpError(400, 'invalid_field', `不允许的字段: ${key}（禁止传入路径/命令等未声明字段）`);
    }
  }
  if (!Array.isArray(body.rules)) {
    throw makeHttpError(400, 'invalid_rules', 'rules 必须是数组');
  }
  if (body.rules.length > MAX_ROUTING_RULES) {
    throw makeHttpError(400, 'too_many_rules', `规则数量不能超过 ${MAX_ROUTING_RULES} 条`);
  }

  const setup = detectClientSetup({ rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const seenIds = new Set();
  const normalized = [];

  for (let i = 0; i < body.rules.length; i++) {
    const rawRule = body.rules[i];
    if (!isPlainObject(rawRule)) {
      throw makeHttpError(400, 'invalid_rule', `第 ${i + 1} 条规则必须是 JSON 对象`);
    }
    for (const key of Object.keys(rawRule)) {
      if (!ALLOWED_RULE_KEYS.has(key)) {
        throw makeHttpError(400, 'invalid_field', `规则包含不允许的字段: ${key}`);
      }
    }

    let id = typeof rawRule.id === 'string' && rawRule.id.trim()
      ? rawRule.id.trim()
      : `rule_${randomBytes(4).toString('hex')}`;
    if (!SAFE_ID_RE.test(id)) {
      throw makeHttpError(400, 'invalid_rule_id', `规则 id 格式非法: ${id}`);
    }
    if (seenIds.has(id)) {
      throw makeHttpError(400, 'duplicate_rule_id', `存在重复的规则 id: ${id}`);
    }
    seenIds.add(id);

    const name = rawRule.name === undefined || rawRule.name === null ? '' : String(rawRule.name).trim();
    if (name.length > 100) {
      throw makeHttpError(400, 'invalid_rule', `规则名称过长（上限 100 字符）: ${id}`);
    }
    if (/[\r\n\0]/.test(name)) {
      throw makeHttpError(400, 'invalid_rule', `规则名称包含非法控制字符: ${id}`);
    }

    const rawMatchType = rawRule.match_type === undefined || rawRule.match_type === null
      ? 'any'
      : String(rawRule.match_type).trim().toLowerCase();
    if (!VALID_MATCH_TYPES.has(rawMatchType)) {
      throw makeHttpError(400, 'invalid_match_type', `非法 match_type: ${rawMatchType}（可选: any, category, keyword, all）`);
    }
    const matchType = rawMatchType === 'both' ? 'any' : rawMatchType;

    const categories = normalizeStringList(rawRule.categories, 'categories');
    const keywords = normalizeStringList(rawRule.keywords, 'keywords');

    if (categories.length === 0 && keywords.length === 0) {
      throw makeHttpError(400, 'invalid_rule', `规则 ${name || id} 至少需要填写一个类别 (categories) 或关键字 (keywords)`);
    }
    if (matchType === 'category' && categories.length === 0) {
      throw makeHttpError(400, 'invalid_rule', `规则 ${name || id} 使用 category 模式时必须填写至少一个类别`);
    }
    if (matchType === 'keyword' && keywords.length === 0) {
      throw makeHttpError(400, 'invalid_rule', `规则 ${name || id} 使用 keyword 模式时必须填写至少一个关键字`);
    }

    const agent = typeof rawRule.agent === 'string' ? rawRule.agent.trim() : '';
    if (!agent || !knownSet.has(agent)) {
      throw makeHttpError(400, 'invalid_agent', `规则 ${name || id} 的目标 agent 非法: ${agent || '(空)'}`);
    }
    const clientInfo = clientById.get(agent);
    if (!clientInfo || !clientInfo.installed) {
      throw makeHttpError(400, 'agent_not_installed', `规则 ${name || id} 的目标 agent (${agent}) 当前未安装，禁止配置为路由目标`);
    }

    let model = '';
    if (rawRule.model !== undefined && rawRule.model !== null && String(rawRule.model).trim()) {
      if (typeof rawRule.model !== 'string') {
        throw makeHttpError(400, 'invalid_model', `规则 ${name || id} 的模型必须是字符串`);
      }
      model = rawRule.model.trim();
      if (/[\r\n\0]/.test(model)) {
        throw makeHttpError(400, 'invalid_model', `规则 ${name || id} 的模型包含非法控制字符`);
      }
      const allowedModels = new Set(clientInfo.selectable_models || []);
      if (!allowedModels.has(model)) {
        throw makeHttpError(400, 'invalid_model', `规则 ${name || id} 的模型 ${model} 不在 ${agent} 的允许模型列表中`);
      }
    }

    let priority = 100;
    if (rawRule.priority !== undefined && rawRule.priority !== null && rawRule.priority !== '') {
      const n = Number(rawRule.priority);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < -1000 || n > 10000) {
        throw makeHttpError(400, 'invalid_priority', `规则 ${name || id} 的优先级必须是 -1000 到 10000 的整数`);
      }
      priority = n;
    }

    const enabled = rawRule.enabled === undefined ? true : Boolean(rawRule.enabled);
    if (rawRule.enabled !== undefined && typeof rawRule.enabled !== 'boolean') {
      throw makeHttpError(400, 'invalid_rule', `规则 ${name || id} 的 enabled 必须是布尔值`);
    }

    normalized.push({
      id,
      name,
      match_type: matchType,
      categories,
      keywords,
      agent,
      model,
      priority,
      enabled,
    });
  }

  return { rules: normalized, setup, clientById };
}

export function saveRoutingConfig({
  body,
  rootDir,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  const existing = readRoutingConfig(rootDir);
  if (existing.broken) {
    throw makeHttpError(
      422,
      'corrupted_routing_config',
      `路由配置文件已损坏，已拒绝覆盖：${existing.error}（请先手动修复或备份移走 ${existing.file}）`,
    );
  }

  const { rules } = validateRoutingRulesPayload({ body, rootDir, home, platform, env });
  const updatedAt = new Date().toISOString();
  const nextPayload = {
    ...(existing.raw && isPlainObject(existing.raw) ? existing.raw : {}),
    schema: ROUTING_SCHEMA,
    rules,
    updated_at: updatedAt,
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
    schema: ROUTING_SCHEMA,
    file: existing.file,
    backup,
    rules,
    updated_at: updatedAt,
  };
}

function matchRuleAgainstPart(rule, part) {
  const partCat = String(part.category || '').trim().toLowerCase();
  const haystack = [
    part.key,
    part.title,
    part.category,
    part.goal,
    ...(Array.isArray(part.paths) ? part.paths : []),
  ].join(' ').toLowerCase();

  let hitCategory = null;
  for (const c of rule.categories || []) {
    if (partCat && partCat === String(c).trim().toLowerCase()) {
      hitCategory = c;
      break;
    }
  }

  let hitKeyword = null;
  for (const kw of rule.keywords || []) {
    const kLower = String(kw).trim().toLowerCase();
    if (kLower && haystack.includes(kLower)) {
      hitKeyword = kw;
      break;
    }
  }

  const mt = rule.match_type || 'any';
  if (mt === 'category') {
    return hitCategory ? { matched: true, reason: `category=${hitCategory}` } : { matched: false };
  }
  if (mt === 'keyword') {
    return hitKeyword ? { matched: true, reason: `keyword=${hitKeyword}` } : { matched: false };
  }
  if (mt === 'all') {
    const needCat = (rule.categories || []).length > 0;
    const needKw = (rule.keywords || []).length > 0;
    if (!needCat && !needKw) return { matched: false };
    if ((!needCat || hitCategory) && (!needKw || hitKeyword)) {
      const reasons = [];
      if (hitCategory) reasons.push(`category=${hitCategory}`);
      if (hitKeyword) reasons.push(`keyword=${hitKeyword}`);
      return { matched: true, reason: reasons.join(' & ') };
    }
    return { matched: false };
  }
  // 'any' / 'both': category OR keyword
  if (hitCategory) return { matched: true, reason: `category=${hitCategory}` };
  if (hitKeyword) return { matched: true, reason: `keyword=${hitKeyword}` };
  return { matched: false };
}

export function evaluateAutoRouting({
  parts = [],
  rules = [],
  mainAgent = '',
  mainModel = '',
  clientById = new Map(),
  overwriteManual = false,
}) {
  const indexedEnabled = (rules || [])
    .map((rule, index) => ({ rule, index }))
    .filter((x) => x.rule && x.rule.enabled !== false)
    .sort((a, b) => {
      const pa = Number.isFinite(Number(a.rule.priority)) ? Number(a.rule.priority) : 100;
      const pb = Number.isFinite(Number(b.rule.priority)) ? Number(b.rule.priority) : 100;
      if (pb !== pa) return pb - pa;
      return a.index - b.index;
    });

  const skippedUninstalledRules = [];
  const runnableRules = [];
  for (const { rule } of indexedEnabled) {
    const info = clientById.get(rule.agent);
    if (!info || !info.installed) {
      skippedUninstalledRules.push({
        rule_id: rule.id,
        rule_name: rule.name || rule.id,
        agent: rule.agent,
        reason: 'agent_not_installed',
      });
      continue;
    }
    runnableRules.push({ rule, clientInfo: info });
  }

  const mainInfo = clientById.get(mainAgent);
  const mainInstalled = Boolean(mainInfo && mainInfo.installed);
  const safeMainModel = mainInstalled && mainModel && (mainInfo.selectable_models || []).includes(mainModel)
    ? mainModel
    : '';

  const assignments = [];
  let matchedCount = 0;
  let fallbackCount = 0;
  let preservedManualCount = 0;
  let unassignedCount = 0;

  for (const part of parts) {
    if (part.manual_override === true && !overwriteManual) {
      preservedManualCount += 1;
      assignments.push({
        part_key: part.key,
        title: part.title,
        category: part.category || '',
        agent: part.agent || '',
        model: part.model || '',
        matched_rule_id: null,
        matched_rule_name: null,
        matched_by: 'manual_override',
        assignment_source: 'manual',
        fallback: false,
        preserved_manual: true,
        changed: false,
      });
      continue;
    }

    let matchedEntry = null;
    for (const { rule, clientInfo } of runnableRules) {
      const res = matchRuleAgainstPart(rule, part);
      if (!res.matched) continue;
      const allowedModels = new Set(clientInfo.selectable_models || []);
      const resolvedModel = rule.model && allowedModels.has(rule.model) ? rule.model : '';
      matchedEntry = {
        part_key: part.key,
        title: part.title,
        category: part.category || '',
        agent: rule.agent,
        model: resolvedModel,
        matched_rule_id: rule.id,
        matched_rule_name: rule.name || rule.id,
        matched_by: res.reason,
        assignment_source: 'auto_rule',
        fallback: false,
        preserved_manual: false,
        changed: (part.agent || '') !== rule.agent || (part.model || '') !== resolvedModel || part.manual_override === true,
      };
      break;
    }

    if (matchedEntry) {
      matchedCount += 1;
      assignments.push(matchedEntry);
    } else if (mainInstalled) {
      fallbackCount += 1;
      assignments.push({
        part_key: part.key,
        title: part.title,
        category: part.category || '',
        agent: mainAgent,
        model: safeMainModel,
        matched_rule_id: null,
        matched_rule_name: null,
        matched_by: 'fallback_main_agent',
        assignment_source: 'fallback_main',
        fallback: true,
        preserved_manual: false,
        changed: (part.agent || '') !== mainAgent || (part.model || '') !== safeMainModel || part.manual_override === true,
      });
    } else {
      unassignedCount += 1;
      assignments.push({
        part_key: part.key,
        title: part.title,
        category: part.category || '',
        agent: '',
        model: '',
        matched_rule_id: null,
        matched_rule_name: null,
        matched_by: 'no_installed_fallback',
        assignment_source: 'unassigned',
        fallback: true,
        preserved_manual: false,
        warning: `无匹配规则且主 Agent (${mainAgent || '未指定'}) 当前未安装`,
        changed: false,
      });
    }
  }

  return {
    assignments,
    skipped_uninstalled_rules: skippedUninstalledRules,
    summary: {
      total: parts.length,
      matched: matchedCount,
      fallback: fallbackCount,
      preserved_manual: preservedManualCount,
      unassigned: unassignedCount,
    },
  };
}
