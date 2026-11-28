// Project Task Board persistence, bootstrap decomposition, plan validation,
// working-copy part card CRUD, auto-routing integration, and part task dispatch.
// Zero third-party dependencies. Stored strictly under the active bus root.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PKG_ROOT, openBus, openBusReadOnly } from '../db.js';
import { dispatchTask, listAdapters, waitForTask } from '../dispatch.js';
import { listClients } from '../setup.js';
import { createTask } from '../tasks.js';
import { detectClientSetup } from './client.js';
import { evaluateAutoRouting, readRoutingConfig } from './routes.js';
import {
  inspectPartPathsOnDisk,
  resolveAllowedRoots,
  scanWorkspaceDirectory,
  validateWorkspaceDir,
} from './workspace.js';

export const PROJECT_PLAN_SCHEMA = 'agentbus/project-plan@1';
export const PROJECT_PLAN_DELTA_SCHEMA = 'agentbus/project-plan-delta@1';
export const PART_ENRICH_SCHEMA = 'agentbus/part-enrich@1';
export const PROJECTS_STORE_SCHEMA = 'agentbus/projects-store@1';
export const MAX_PARTS_PER_PROJECT = 50;

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SAFE_PART_CODE_RE = /^[a-zA-Z0-9._-]{1,32}$/;
const SAFE_PROJECT_ID_RE = /^p_[a-zA-Z0-9_-]{4,64}$/;
const VALID_PART_STATUSES = new Set(['existing', 'partial', 'missing', 'planned']);
export const VALID_PART_GROUPS = new Set(['dev', 'debug']);
export const DEFAULT_PROJECT_GROUPS = [
  { key: 'dev', title: '研发组', order: 0 },
  { key: 'debug', title: '调试组', order: 1 },
];
const DEBUG_GROUP_CATEGORY_RE = /^(debug|debugging|troubleshoot|troubleshooting|regression|bugfix|hotfix|qa|verify|verification)$/i;
const DEBUG_GROUP_TEXT_RE = /(排查|调试|回归|回传|排障|诊断|故障|报错|debug|troubleshoot|regression|bugfix|hotfix)/i;
const FORBIDDEN_MATERIALS_TOP_DIRS = new Set(['src', 'bin', 'docs', 'test', 'tests', 'node_modules', '.git']);

const ALLOWED_CREATE_PROJECT_KEYS = new Set([
  'name',
  'goal',
  'workspace_dir',
  'dev_materials_dir',
  'main_agent',
  'main_model',
  'auto_dispatch',
  'auto_enrich',
  'wait_s',
  'idempotency_key',
]);

const ALLOWED_READ_EXISTING_KEYS = new Set([
  'workspace_dir',
  'dev_materials_dir',
  'name',
  'goal',
  'main_agent',
  'main_model',
  'auto_dispatch',
  'auto_enrich',
  'wait_s',
  'scan_with_agent',
  'idempotency_key',
]);

const ALLOWED_ASK_CARDS_KEYS = new Set([
  'prompt',
  'main_agent',
  'main_model',
  'auto_dispatch',
  'wait_s',
]);

const ALLOWED_APPLY_DELTA_KEYS = new Set([
  'request_id',
  'confirm_overwrite_manual',
  'auto_dispatch',
  'wait_s',
]);

const ALLOWED_REGENERATE_PART_KEYS = new Set([
  'agent',
  'model',
  'notes',
  'auto_dispatch',
  'wait_s',
]);

const ALLOWED_PART_KEYS = new Set([
  'key',
  'code',
  'title',
  'category',
  'group',
  'goal',
  'paths',
  'acceptance',
  'agent',
  'model',
  'depends_on',
  'manual_override',
  'implementation_status',
]);

const ALLOWED_ADD_PART_KEYS = new Set([
  ...ALLOWED_PART_KEYS,
  'auto_enrich',
  'auto_dispatch',
  'wait_s',
  'idempotency_key',
]);

const ALLOWED_ENRICH_PART_KEYS = new Set(['auto_dispatch', 'wait_s', 'force']);
const ALLOWED_COMPLETE_PART_KEYS = new Set(['auto_dispatch', 'wait_s', 'notes']);

const ALLOWED_REORDER_KEYS = new Set(['keys']);
const ALLOWED_AUTO_ROUTE_KEYS = new Set(['dry_run', 'overwrite_manual']);
const ALLOWED_DISPATCH_KEYS = new Set(['part_keys', 'all', 'auto_dispatch', 'serial', 'wait_s']);
const ALLOWED_RETRY_BOOTSTRAP_KEYS = new Set(['main_agent', 'main_model', 'auto_dispatch', 'wait_s', 'force_new']);
const ALLOWED_SYNC_PLAN_KEYS = new Set(['force', 'auto_dispatch', 'wait_s']);

export function makeHttpError(status, code, message) {
  return Object.assign(new Error(message), { status, errorCode: code });
}

export function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function assertAllowedKeys(obj, allowedSet, context = '请求体') {
  if (!isPlainObject(obj)) {
    throw makeHttpError(400, 'invalid_body', `${context}必须是 JSON 对象`);
  }
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw makeHttpError(400, 'invalid_field', `${context}包含不允许的字段: ${key}（禁止传入路径/命令等未声明字段）`);
    }
  }
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

export function writeAtomicJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw makeHttpError(500, 'write_failed', `写入项目存储失败: ${err.message}`);
  }
}

export function projectsStorePath(rootDir) {
  return path.join(rootDir, 'projects.json');
}

export function validateRelativePath(rawPath) {
  if (typeof rawPath !== 'string') {
    return { ok: false, error: '路径必须是字符串' };
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { ok: false, error: '路径不能为空' };
  }
  if (trimmed.length > 260) {
    return { ok: false, error: `路径过长: ${trimmed.slice(0, 40)}...` };
  }
  if (/[\r\n\0]/.test(trimmed)) {
    return { ok: false, error: '路径包含非法控制字符' };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return { ok: false, error: `路径必须是相对项目路径，禁止 URI: ${trimmed}` };
  }
  if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\') || path.isAbsolute(trimmed)) {
    return { ok: false, error: `路径必须是相对项目路径，禁止绝对路径: ${trimmed}` };
  }
  const normalized = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
  const segs = normalized.split('/');
  if (segs.some((s) => s === '..')) {
    return { ok: false, error: `路径禁止包含越级目录 (..): ${trimmed}` };
  }
  if (!normalized || normalized === '.') {
    return { ok: false, error: `路径不能为空或单点: ${trimmed}` };
  }
  return { ok: true, value: normalized };
}

function normalizeRelativePaths(rawPaths, { fieldName = 'paths' } = {}) {
  if (rawPaths === undefined || rawPaths === null) return [];
  const list = Array.isArray(rawPaths)
    ? rawPaths
    : (typeof rawPaths === 'string' ? rawPaths.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean) : null);
  if (!list) {
    throw makeHttpError(400, 'invalid_path', `${fieldName} 必须是相对路径数组`);
  }
  if (list.length > 30) {
    throw makeHttpError(400, 'invalid_path', `${fieldName} 最多允许 30 条路径`);
  }
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const check = validateRelativePath(item);
    if (!check.ok) {
      throw makeHttpError(400, 'invalid_path', check.error);
    }
    if (!seen.has(check.value)) {
      seen.add(check.value);
      out.push(check.value);
    }
  }
  return out;
}

function normalizeTextList(raw, { fieldName = 'acceptance', maxItems = 30, maxLen = 500 } = {}) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : null);
  if (!list) {
    throw makeHttpError(400, 'invalid_field', `${fieldName} 必须是字符串数组`);
  }
  if (list.length > maxItems) {
    throw makeHttpError(400, 'invalid_field', `${fieldName} 最多允许 ${maxItems} 条`);
  }
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') {
      throw makeHttpError(400, 'invalid_field', `${fieldName} 仅允许字符串项`);
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxLen) {
      throw makeHttpError(400, 'invalid_field', `${fieldName} 单条不能超过 ${maxLen} 字符`);
    }
    if (/\0/.test(trimmed)) {
      throw makeHttpError(400, 'invalid_field', `${fieldName} 包含非法字符`);
    }
    out.push(trimmed);
  }
  return out;
}

function normalizeDependsOn(raw) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) : null);
  if (!list) {
    throw makeHttpError(400, 'invalid_depends_on', 'depends_on 必须是 part key 数组');
  }
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) {
      throw makeHttpError(400, 'invalid_depends_on', 'depends_on 包含空或非字符串项');
    }
    const k = item.trim();
    if (!SAFE_ID_RE.test(k)) {
      throw makeHttpError(400, 'invalid_depends_on', `depends_on 包含非法 key: ${k}`);
    }
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

export function inferPartGroup({ group, category, title, goal } = {}) {
  if (typeof group === 'string') {
    const g = group.trim().toLowerCase();
    if (VALID_PART_GROUPS.has(g)) return g;
  }
  const cat = typeof category === 'string' ? category.trim() : '';
  if (cat && DEBUG_GROUP_CATEGORY_RE.test(cat)) return 'debug';
  const text = `${cat} ${title || ''} ${goal || ''}`;
  if (DEBUG_GROUP_TEXT_RE.test(text)) return 'debug';
  return 'dev';
}

export function normalizePartGroupInput(rawGroup, { required = false, defaultGroup = 'dev' } = {}) {
  if (rawGroup === undefined) {
    if (required) {
      throw makeHttpError(400, 'invalid_part_group', '所属环节 group 必填，且仅允许 dev 或 debug');
    }
    return defaultGroup;
  }
  if (typeof rawGroup !== 'string') {
    throw makeHttpError(400, 'invalid_part_group', '所属环节 group 必须是字符串（仅允许 dev 或 debug）');
  }
  const norm = rawGroup.trim().toLowerCase();
  if (!VALID_PART_GROUPS.has(norm)) {
    throw makeHttpError(400, 'invalid_part_group', `非法所属环节 group: "${rawGroup}"（仅允许 dev 或 debug）`);
  }
  return norm;
}

export function resolveProjectGroups(rawGroups) {
  const defaultByKey = new Map(DEFAULT_PROJECT_GROUPS.map((g) => [g.key, { ...g }]));
  if (!Array.isArray(rawGroups) || rawGroups.length === 0) {
    return DEFAULT_PROJECT_GROUPS.map((g) => ({ ...g }));
  }
  const byKey = new Map();
  for (const item of rawGroups) {
    if (!isPlainObject(item) || typeof item.key !== 'string') continue;
    const k = item.key.trim().toLowerCase();
    if (!VALID_PART_GROUPS.has(k)) continue;
    const def = defaultByKey.get(k);
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : def.title;
    const order = Number.isFinite(Number(item.order)) ? Number(item.order) : def.order;
    byKey.set(k, { key: k, title, order });
  }
  for (const [k, def] of defaultByKey.entries()) {
    if (!byKey.has(k)) byKey.set(k, { ...def });
  }
  return Array.from(byKey.values()).sort((a, b) => a.order - b.order);
}

export function defaultPartCode(partKey, usedCodes = null) {
  const base = String(partKey || 'PART')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .toUpperCase()
    .slice(0, 32) || 'PART';
  if (!usedCodes || !usedCodes.has(base)) {
    if (usedCodes) usedCodes.add(base);
    return base;
  }
  let seq = 2;
  while (seq < 1000) {
    const suffix = `_${seq++}`;
    const cand = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!usedCodes.has(cand)) {
      usedCodes.add(cand);
      return cand;
    }
  }
  return `${base.slice(0, 25)}_${randomBytes(3).toString('hex').toUpperCase()}`;
}

export function resolvePartCode(part) {
  if (part && typeof part.code === 'string') {
    const c = part.code.trim();
    if (SAFE_PART_CODE_RE.test(c)) return c;
  }
  return defaultPartCode(part?.key || 'PART');
}

export function normalizePartCodeInput(rawCode, { required = false } = {}) {
  if (rawCode === undefined || rawCode === null) {
    if (required) {
      throw makeHttpError(400, 'invalid_part_code', '模块代号 code 必填且为 1-32 位字母/数字/._-');
    }
    return null;
  }
  if (typeof rawCode !== 'string') {
    throw makeHttpError(400, 'invalid_part_code', '模块代号 code 必须是字符串');
  }
  const trimmed = rawCode.trim();
  if (!trimmed) {
    if (required) {
      throw makeHttpError(400, 'invalid_part_code', '模块代号 code 不能为空');
    }
    return null;
  }
  if (!SAFE_PART_CODE_RE.test(trimmed)) {
    throw makeHttpError(400, 'invalid_part_code', `模块代号 code 非法: "${rawCode}"（仅允许 1-32 位字母、数字、.、_、-）`);
  }
  return trimmed;
}

function isDriveRootPath(targetPath) {
  const norm = path.resolve(targetPath);
  const parsed = path.parse(norm);
  return norm === parsed.root;
}

function isSubPathOrSame(parentDir, childPath) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveRealAncestor(fsPath) {
  let cur = path.resolve(fsPath);
  const suffix = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    suffix.unshift(path.basename(cur));
    cur = parent;
  }
  const realBase = fs.realpathSync(cur);
  return suffix.length > 0 ? path.join(realBase, ...suffix) : realBase;
}

export function validateDevMaterialsDirInput(rawDir, { workspaceDir = null, config, pkgRoot } = {}) {
  if (rawDir === undefined || rawDir === null || String(rawDir).trim() === '') {
    return null;
  }
  if (typeof rawDir !== 'string') {
    throw makeHttpError(400, 'invalid_dev_materials_dir', 'dev_materials_dir 必须是字符串路径');
  }
  const trimmed = rawDir.trim();
  if (/[\r\n\0]/.test(trimmed)) {
    throw makeHttpError(400, 'invalid_dev_materials_dir', 'dev_materials_dir 包含非法控制字符');
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    throw makeHttpError(400, 'invalid_dev_materials_dir', 'dev_materials_dir 不能使用 URI');
  }

  const allowedDirs = resolveAllowedRoots({ config, pkgRoot });
  const isAbs = /^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\') || path.isAbsolute(trimmed);
  let resolved;
  if (!isAbs) {
    const vc = validateRelativePath(trimmed);
    if (!vc.ok) {
      throw makeHttpError(400, 'invalid_dev_materials_dir', `dev_materials_dir 相对路径非法: ${vc.error}`);
    }
    const baseDir = workspaceDir || config?.rootDir || pkgRoot;
    resolved = path.resolve(baseDir, vc.value);
    const topSeg = vc.value.split('/')[0].toLowerCase();
    if (FORBIDDEN_MATERIALS_TOP_DIRS.has(topSeg)) {
      throw makeHttpError(400, 'invalid_dev_materials_dir', `dev_materials_dir 禁止指向正式目录: ${topSeg}/`);
    }
  } else {
    if (trimmed.split(/[\\/]+/).includes('..')) {
      throw makeHttpError(400, 'invalid_dev_materials_dir', 'dev_materials_dir 禁止包含越级目录 (..)');
    }
    resolved = path.resolve(trimmed);
  }

  if (isDriveRootPath(resolved)) {
    throw makeHttpError(403, 'invalid_dev_materials_dir', 'dev_materials_dir 禁止指向磁盘根目录');
  }

  let realTarget;
  try {
    realTarget = resolveRealAncestor(resolved);
  } catch (err) {
    throw makeHttpError(400, 'invalid_dev_materials_dir', `无法解析 dev_materials_dir 路径: ${err.message}`);
  }

  const realAllowed = allowedDirs
    .filter((r) => r && fs.existsSync(r))
    .map((r) => fs.realpathSync(r));
  if (!realAllowed.some((r) => isSubPathOrSame(r, realTarget))) {
    throw makeHttpError(403, 'path_outside_allowed_roots', `dev_materials_dir 超出允许根目录范围: ${realTarget}`);
  }

  if (workspaceDir && fs.existsSync(workspaceDir)) {
    const realWs = fs.realpathSync(workspaceDir);
    if (path.resolve(realTarget) === path.resolve(realWs)) {
      throw makeHttpError(400, 'invalid_dev_materials_dir', 'dev_materials_dir 不能直接设为项目根目录本身');
    }
    const relFromWs = path.relative(realWs, realTarget);
    if (relFromWs && !relFromWs.startsWith('..') && !path.isAbsolute(relFromWs)) {
      const top = relFromWs.split(/[\\/]+/)[0].toLowerCase();
      if (FORBIDDEN_MATERIALS_TOP_DIRS.has(top)) {
        throw makeHttpError(400, 'invalid_dev_materials_dir', `dev_materials_dir 禁止放在正式目录 ${top}/ 内`);
      }
    }
  }

  return realTarget;
}

export function resolveProjectDevMaterialsDir(project, { config, pkgRoot } = {}) {
  if (project?.dev_materials_dir && typeof project.dev_materials_dir === 'string' && project.dev_materials_dir.trim()) {
    try {
      return validateDevMaterialsDirInput(project.dev_materials_dir, {
        workspaceDir: project.workspace_dir || null,
        config,
        pkgRoot,
      });
    } catch {
      // Fallback safely on read if legacy value cannot resolve
    }
  }
  if (project?.workspace_dir) {
    return path.join(project.workspace_dir, '.agentbus', 'dev-materials');
  }
  return path.join(config?.rootDir || pkgRoot, 'dev-materials', project?.id || 'default');
}

export function validateProjectPlan(rawPlan, expectedProjectId = null, { allowDelta = false } = {}) {
  if (!isPlainObject(rawPlan)) {
    return { ok: false, code: 'invalid_plan', error: 'project plan 必须是合法 JSON 对象（不能仅凭文本结果）' };
  }
  const allowedSchemas = allowDelta
    ? new Set([PROJECT_PLAN_SCHEMA, PROJECT_PLAN_DELTA_SCHEMA])
    : new Set([PROJECT_PLAN_SCHEMA]);
  if (!allowedSchemas.has(rawPlan.schema)) {
    return {
      ok: false,
      code: 'invalid_plan_schema',
      error: `plan schema 不匹配：期望 "${Array.from(allowedSchemas).join(' 或 ')}"，实际 "${String(rawPlan.schema ?? '')}"`,
    };
  }
  const projectId = typeof rawPlan.project_id === 'string' ? rawPlan.project_id.trim() : '';
  if (!projectId) {
    return { ok: false, code: 'invalid_plan_project_id', error: 'plan 缺少必填字段 project_id' };
  }
  if (expectedProjectId && projectId !== expectedProjectId) {
    return {
      ok: false,
      code: 'plan_project_id_mismatch',
      error: `plan project_id 不匹配：期望 "${expectedProjectId}"，实际 "${projectId}"`,
    };
  }
  const title = typeof rawPlan.title === 'string' ? rawPlan.title.trim() : '';
  if (!allowDelta && !title) {
    return { ok: false, code: 'invalid_plan_title', error: 'plan 缺少必填字段 title' };
  }
  const summary = typeof rawPlan.summary === 'string' ? rawPlan.summary.trim() : '';

  if (!Array.isArray(rawPlan.parts) || rawPlan.parts.length === 0) {
    return { ok: false, code: 'invalid_plan_parts', error: 'plan 必须包含非空 parts 数组' };
  }
  if (rawPlan.parts.length > MAX_PARTS_PER_PROJECT) {
    return { ok: false, code: 'too_many_parts', error: `plan parts 数量超过上限 (${MAX_PARTS_PER_PROJECT})` };
  }

  const seenKeys = new Set();
  const seenExplicitCodes = new Set();
  const parts = [];
  for (let i = 0; i < rawPlan.parts.length; i++) {
    const p = rawPlan.parts[i];
    if (!isPlainObject(p)) {
      return { ok: false, code: 'invalid_plan_part', error: `plan parts[${i}] 必须是 JSON 对象` };
    }
    const key = typeof p.key === 'string' ? p.key.trim() : '';
    if (!key || !SAFE_ID_RE.test(key)) {
      return { ok: false, code: 'invalid_part_key', error: `plan parts[${i}].key 非法: "${key}"` };
    }
    if (seenKeys.has(key)) {
      return { ok: false, code: 'duplicate_part_key', error: `plan 中存在重复 part key: "${key}"` };
    }
    seenKeys.add(key);

    let explicitCode = null;
    if (p.code !== undefined && p.code !== null) {
      if (typeof p.code !== 'string') {
        return { ok: false, code: 'invalid_part_code', error: `plan part "${key}" 的 code 必须是字符串` };
      }
      const trimmedCode = p.code.trim();
      if (trimmedCode) {
        if (!SAFE_PART_CODE_RE.test(trimmedCode)) {
          return { ok: false, code: 'invalid_part_code', error: `plan part "${key}" 的 code 非法: "${p.code}"` };
        }
        if (seenExplicitCodes.has(trimmedCode)) {
          return { ok: false, code: 'duplicate_part_code', error: `plan 中存在重复模块代号 code: "${trimmedCode}"` };
        }
        seenExplicitCodes.add(trimmedCode);
        explicitCode = trimmedCode;
      }
    }

    const pTitle = typeof p.title === 'string' ? p.title.trim() : '';
    if (!pTitle || pTitle.length > 120) {
      return { ok: false, code: 'invalid_part_title', error: `plan part "${key}" 缺少有效 title` };
    }
    const categoryProvided = typeof p.category === 'string' && Boolean(p.category.trim());
    const category = categoryProvided ? p.category.trim() : 'general';
    if (category.length > 64 || /[\r\n\0]/.test(category)) {
      return { ok: false, code: 'invalid_part_category', error: `plan part "${key}" 的 category 非法` };
    }
    if (p.goal !== undefined && p.goal !== null && typeof p.goal !== 'string') {
      return { ok: false, code: 'invalid_part_goal', error: `plan part "${key}" 的 goal 必须是字符串` };
    }
    const goal = typeof p.goal === 'string' ? p.goal.trim() : '';
    if (goal.length > 4000) {
      return { ok: false, code: 'invalid_part_goal', error: `plan part "${key}" 的 goal 不能超过 4000 字符` };
    }

    const rawPaths = Array.isArray(p.paths) ? p.paths : [];
    const cleanPaths = [];
    for (const rp of rawPaths) {
      const vc = validateRelativePath(rp);
      if (!vc.ok) {
        return { ok: false, code: 'invalid_part_path', error: `plan part "${key}" 路径非法: ${vc.error}` };
      }
      if (!cleanPaths.includes(vc.value)) cleanPaths.push(vc.value);
    }

    const rawAcc = Array.isArray(p.acceptance) ? p.acceptance : [];
    const cleanAcc = rawAcc.map((a) => String(a ?? '').trim()).filter(Boolean).slice(0, 30);

    const rawDeps = Array.isArray(p.depends_on) ? p.depends_on : [];
    const cleanDeps = [];
    for (const d of rawDeps) {
      if (typeof d !== 'string' || !SAFE_ID_RE.test(d.trim())) {
        return { ok: false, code: 'invalid_part_depends_on', error: `plan part "${key}" 的 depends_on 非法: ${String(d)}` };
      }
      const dk = d.trim();
      if (dk !== key && !cleanDeps.includes(dk)) cleanDeps.push(dk);
    }

    const suggestedAgent = typeof p.agent === 'string' ? p.agent.trim() : '';
    const suggestedModel = typeof p.model === 'string' ? p.model.trim() : '';
    const rawStatus = typeof p.status === 'string'
      ? p.status.trim().toLowerCase()
      : (typeof p.implementation_status === 'string' ? p.implementation_status.trim().toLowerCase() : '');
    const statusExplicit = VALID_PART_STATUSES.has(rawStatus);
    const implStatus = statusExplicit ? rawStatus : 'planned';
    const evidence = typeof p.evidence === 'string' ? p.evidence.trim().slice(0, 300) : '';

    let partGroup;
    let groupExplicit = false;
    if (p.group !== undefined && p.group !== null) {
      if (typeof p.group !== 'string') {
        return { ok: false, code: 'invalid_part_group', error: `plan part "${key}" 的 group 必须是字符串（dev 或 debug）` };
      }
      const rawGroup = p.group.trim().toLowerCase();
      if (rawGroup) {
        if (!VALID_PART_GROUPS.has(rawGroup)) {
          return { ok: false, code: 'invalid_part_group', error: `plan part "${key}" 的 group 非法: "${p.group}"（仅允许 dev 或 debug）` };
        }
        partGroup = rawGroup;
        groupExplicit = true;
      } else {
        partGroup = inferPartGroup({ category, title: pTitle, goal });
      }
    } else {
      partGroup = inferPartGroup({ category, title: pTitle, goal });
    }

    parts.push({
      key,
      code: explicitCode,
      code_is_placeholder: !explicitCode,
      title: pTitle,
      category,
      category_is_placeholder: !categoryProvided,
      group: partGroup,
      group_is_placeholder: !groupExplicit,
      goal,
      paths: cleanPaths,
      acceptance: cleanAcc,
      agent: suggestedAgent,
      model: suggestedModel,
      depends_on: cleanDeps,
      status: implStatus,
      status_explicit: statusExplicit,
      evidence,
    });
  }

  const usedCodes = new Set(seenExplicitCodes);
  for (const part of parts) {
    if (!part.code) {
      part.code = defaultPartCode(part.key, usedCodes);
    }
  }

  const removeKeys = [];
  if (Array.isArray(rawPlan.remove_keys)) {
    for (const rk of rawPlan.remove_keys) {
      if (typeof rk === 'string' && SAFE_ID_RE.test(rk.trim()) && !removeKeys.includes(rk.trim())) {
        removeKeys.push(rk.trim());
      }
    }
  }

  return {
    ok: true,
    plan: {
      schema: rawPlan.schema,
      project_id: projectId,
      title: title || 'plan-delta',
      summary,
      parts,
      ...(removeKeys.length > 0 ? { remove_keys: removeKeys } : {}),
    },
  };
}

export function readProjectsStore(rootDir) {
  const file = projectsStorePath(rootDir);
  if (!fs.existsSync(file)) {
    return {
      file,
      exists: false,
      broken: false,
      error: null,
      raw: {},
      projects: [],
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
      error: `读取 projects.json 失败 (${err.code || 'READ_ERROR'}): ${err.message}`,
      raw: null,
      projects: [],
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
        error: 'projects.json 顶层必须是 JSON 对象',
        raw: null,
        projects: [],
        updated_at: null,
      };
    }
    if (parsed.projects !== undefined && !Array.isArray(parsed.projects)) {
      return {
        file,
        exists: true,
        broken: true,
        error: 'projects.json 中的 projects 字段必须是数组',
        raw: null,
        projects: [],
        updated_at: null,
      };
    }
    return {
      file,
      exists: true,
      broken: false,
      error: null,
      raw: parsed,
      projects: (parsed.projects || []).filter((p) => isPlainObject(p) && typeof p.id === 'string'),
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
    };
  } catch (err) {
    return {
      file,
      exists: true,
      broken: true,
      error: `projects.json JSON 解析失败: ${err.message}`,
      raw: null,
      projects: [],
      updated_at: null,
    };
  }
}

function saveProjectsStore(rootDir, storeState, nextProjects) {
  if (storeState.broken) {
    throw makeHttpError(
      422,
      'corrupted_projects_config',
      `项目存储文件已损坏，已拒绝覆盖：${storeState.error}（请手动检查 ${storeState.file}）`,
    );
  }
  const updatedAt = new Date().toISOString();
  const payload = {
    ...(storeState.raw && isPlainObject(storeState.raw) ? storeState.raw : {}),
    schema: PROJECTS_STORE_SCHEMA,
    projects: nextProjects,
    updated_at: updatedAt,
  };
  const backup = backupIfExists(storeState.file);
  try {
    writeAtomicJson(storeState.file, payload);
  } catch (err) {
    if (backup && fs.existsSync(backup)) {
      try { fs.unlinkSync(backup); } catch {}
    }
    throw err;
  }
  return { file: storeState.file, backup, updated_at: updatedAt };
}

export function readTasksByIdsReadOnly(config, taskIds) {
  const map = new Map();
  const uniqueIds = Array.from(new Set((taskIds || []).filter((id) => typeof id === 'string' && id.trim())));
  if (uniqueIds.length === 0 || !fs.existsSync(config.dbPath)) {
    return map;
  }
  const bus = openBusReadOnly({ config });
  try {
    const placeholders = uniqueIds.map(() => '?').join(',');
    const rows = bus.db.prepare(
      `SELECT id, from_agent, to_agent, state, goal, claimed_by, attempt, created_at, finished_at,
              result_json, blocked_at, last_message_at, history_json
       FROM tasks
       WHERE id IN (${placeholders})`
    ).all(...uniqueIds);

    const msgIds = rows.filter((r) => r.last_message_at).map((r) => r.id);
    const lastMsgByTask = new Map();
    if (msgIds.length > 0) {
      const mPlaceholders = msgIds.map(() => '?').join(',');
      const msgs = bus.db.prepare(
        `SELECT tm.seq, tm.task_id, tm.from_agent, tm.to_agent, tm.kind, tm.body, tm.created_at
         FROM task_messages tm
         JOIN (
           SELECT task_id, MAX(seq) AS max_seq
           FROM task_messages
           WHERE task_id IN (${mPlaceholders})
           GROUP BY task_id
         ) latest ON tm.task_id = latest.task_id AND tm.seq = latest.max_seq`
      ).all(...msgIds);
      for (const m of msgs) {
        lastMsgByTask.set(m.task_id, {
          seq: Number(m.seq),
          from: m.from_agent,
          to: m.to_agent || null,
          kind: m.kind,
          body: String(m.body || '').slice(0, 400),
          created_at: m.created_at,
        });
      }
    }

    for (const r of rows) {
      let resultObj = null;
      try { resultObj = r.result_json ? JSON.parse(r.result_json) : null; } catch {}
      let history = [];
      try { history = r.history_json ? JSON.parse(r.history_json) : []; } catch {}
      map.set(r.id, {
        id: r.id,
        from: r.from_agent,
        to: r.to_agent,
        state: r.state,
        claimed_by: r.claimed_by || null,
        attempt: Number(r.attempt || 0),
        created_at: r.created_at,
        finished_at: r.finished_at || null,
        result: resultObj,
        blocked: Boolean(r.blocked_at),
        blocked_at: r.blocked_at || null,
        last_message_at: r.last_message_at || null,
        last_message: lastMsgByTask.get(r.id) || null,
        history,
      });
    }
  } finally {
    bus.close();
  }
  return map;
}

function isWithinAllowedRoots(fsPath, roots) {
  try {
    const realTarget = fs.realpathSync(fsPath);
    for (const r of roots || []) {
      if (!r || !fs.existsSync(r)) continue;
      try {
        const realRoot = fs.realpathSync(r);
        const rel = path.relative(realRoot, realTarget);
        if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
          return true;
        }
      } catch {}
    }
  } catch {
    return false;
  }
  return false;
}

function resolveResultUriPath(uri) {
  if (!uri || typeof uri !== 'string') return null;
  try {
    if (uri.startsWith('file://')) return fileURLToPath(uri);
    return path.resolve(uri);
  } catch {
    return null;
  }
}

function readPlanCandidate({ project, bootstrapTask, config, pkgRoot, relPathOverride = null, allowDelta = false }) {
  const allowedDirs = resolveAllowedRoots({ config, pkgRoot });

  const candidates = [];
  if (bootstrapTask?.result?.uri) {
    const p = resolveResultUriPath(bootstrapTask.result.uri);
    if (p) candidates.push({ path: p, source: 'task_result' });
  }
  const targetRel = relPathOverride || project.plan_rel_path;
  if (targetRel) {
    const relCheck = validateRelativePath(targetRel);
    if (relCheck.ok) {
      if (project.workspace_dir) {
        candidates.push({ path: path.resolve(project.workspace_dir, relCheck.value), source: 'workspace_plan_file' });
      }
      candidates.push({ path: path.resolve(pkgRoot, relCheck.value), source: 'project_plan_file' });
    }
  }

  let lastInvalid = null;
  const seen = new Set();
  for (const cand of candidates) {
    const norm = path.resolve(cand.path);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (!fs.existsSync(norm)) continue;
    if (!isWithinAllowedRoots(norm, allowedDirs)) {
      lastInvalid = {
        status: 'invalid',
        code: 'plan_path_outside_root',
        error: `plan 文件超出允许根目录范围: ${norm}`,
        path: norm,
      };
      continue;
    }
    let st;
    try {
      st = fs.statSync(norm);
      if (!st.isFile() || st.size > 1024 * 1024) {
        lastInvalid = {
          status: 'invalid',
          code: 'plan_file_invalid_size',
          error: `plan 文件大小异常或不是普通文件: ${norm}`,
          path: norm,
        };
        continue;
      }
    } catch (err) {
      lastInvalid = { status: 'invalid', code: 'plan_read_error', error: err.message, path: norm };
      continue;
    }

    let parsed;
    try {
      const txt = fs.readFileSync(norm, 'utf8').replace(/^\uFEFF/, '');
      parsed = JSON.parse(txt);
    } catch (err) {
      lastInvalid = {
        status: 'invalid',
        code: 'plan_invalid_json',
        error: `plan 文件不是合法 JSON（不能仅凭文本结果）: ${err.message}`,
        path: norm,
      };
      continue;
    }

    const validated = validateProjectPlan(parsed, project.id, { allowDelta });
    if (validated.ok) {
      return {
        status: 'loaded',
        plan: validated.plan,
        path: norm,
        source: cand.source,
        error: null,
      };
    }
    lastInvalid = {
      status: 'invalid',
      code: validated.code,
      error: validated.error,
      path: norm,
    };
  }

  if (lastInvalid) return lastInvalid;
  return {
    status: 'missing',
    code: 'plan_missing',
    error: `拆解任务已完成，但未找到有效的 ${allowDelta ? `${PROJECT_PLAN_SCHEMA} / ${PROJECT_PLAN_DELTA_SCHEMA}` : PROJECT_PLAN_SCHEMA} 文件（检查任务 result 或 ${targetRel}）`,
    path: null,
  };
}

export function validatePartEnrichResult(raw, { projectId, partKey } = {}) {
  if (!isPlainObject(raw)) {
    return { ok: false, code: 'invalid_enrich_json', error: '补全结果必须是合法 JSON 对象（不能仅凭文本）' };
  }
  if (raw.schema !== undefined && raw.schema !== null && String(raw.schema).trim()) {
    const s = String(raw.schema).trim();
    if (s !== PART_ENRICH_SCHEMA) {
      return {
        ok: false,
        code: 'invalid_enrich_schema',
        error: `补全结果 schema 不匹配：期望 "${PART_ENRICH_SCHEMA}"，实际 "${s}"`,
      };
    }
  }
  if (raw.project_id !== undefined && raw.project_id !== null && String(raw.project_id).trim()) {
    const pid = String(raw.project_id).trim();
    if (projectId && pid !== projectId) {
      return {
        ok: false,
        code: 'enrich_project_id_mismatch',
        error: `补全结果 project_id 不匹配：期望 "${projectId}"，实际 "${pid}"`,
      };
    }
  }

  const payload = isPlainObject(raw.part) ? raw.part : raw;
  const rawKey = payload.part_key ?? payload.key ?? raw.part_key ?? raw.key;
  if (rawKey !== undefined && rawKey !== null && String(rawKey).trim()) {
    const pk = String(rawKey).trim();
    if (partKey && pk !== partKey) {
      return {
        ok: false,
        code: 'enrich_part_key_mismatch',
        error: `补全结果 part_key 不匹配：期望 "${partKey}"，实际 "${pk}"`,
      };
    }
  }

  let code = null;
  if (payload.code !== undefined && payload.code !== null && String(payload.code).trim()) {
    if (typeof payload.code !== 'string') {
      return { ok: false, code: 'invalid_part_code', error: '补全结果 code 必须是字符串' };
    }
    const c = payload.code.trim();
    if (!SAFE_PART_CODE_RE.test(c)) {
      return { ok: false, code: 'invalid_part_code', error: `补全结果 code 非法: "${c}"` };
    }
    code = c;
  }

  let group = null;
  if (payload.group !== undefined && payload.group !== null && String(payload.group).trim()) {
    if (typeof payload.group !== 'string') {
      return { ok: false, code: 'invalid_part_group', error: '补全结果 group 必须是字符串' };
    }
    const g = payload.group.trim().toLowerCase();
    if (!VALID_PART_GROUPS.has(g)) {
      return { ok: false, code: 'invalid_part_group', error: `补全结果 group 非法: "${payload.group}"（仅允许 dev 或 debug）` };
    }
    group = g;
  }

  let title = null;
  if (payload.title !== undefined && payload.title !== null && String(payload.title).trim()) {
    if (typeof payload.title !== 'string') {
      return { ok: false, code: 'invalid_part_title', error: '补全结果 title 必须是字符串' };
    }
    const t = payload.title.trim();
    if (t.length > 120) {
      return { ok: false, code: 'invalid_part_title', error: '补全结果 title 超过 120 字符' };
    }
    title = t;
  }

  let category = null;
  if (payload.category !== undefined && payload.category !== null && String(payload.category).trim()) {
    if (typeof payload.category !== 'string') {
      return { ok: false, code: 'invalid_part_category', error: '补全结果 category 必须是字符串' };
    }
    const cat = payload.category.trim();
    if (cat.length > 64 || /[\r\n\0]/.test(cat)) {
      return { ok: false, code: 'invalid_part_category', error: '补全结果 category 非法' };
    }
    category = cat;
  }

  let goal = null;
  if (payload.goal !== undefined && payload.goal !== null) {
    if (typeof payload.goal !== 'string') {
      return { ok: false, code: 'invalid_part_goal', error: '补全结果 goal 必须是字符串' };
    }
    const gText = payload.goal.trim();
    if (gText.length > 4000) {
      return { ok: false, code: 'invalid_part_goal', error: '补全结果 goal 超过 4000 字符' };
    }
    if (gText) goal = gText;
  }

  let paths = null;
  if (payload.paths !== undefined && payload.paths !== null) {
    try {
      paths = normalizeRelativePaths(payload.paths, { fieldName: 'paths' });
    } catch (err) {
      return { ok: false, code: err.errorCode || 'invalid_part_path', error: err.message };
    }
  }

  let acceptance = null;
  if (payload.acceptance !== undefined && payload.acceptance !== null) {
    try {
      acceptance = normalizeTextList(payload.acceptance, { fieldName: 'acceptance' });
    } catch (err) {
      return { ok: false, code: err.errorCode || 'invalid_acceptance', error: err.message };
    }
  }

  let dependsOn = null;
  if (payload.depends_on !== undefined && payload.depends_on !== null) {
    try {
      dependsOn = normalizeDependsOn(payload.depends_on).filter((d) => !partKey || d !== partKey);
    } catch (err) {
      return { ok: false, code: err.errorCode || 'invalid_depends_on', error: err.message };
    }
  }

  const agent = typeof payload.agent === 'string' ? payload.agent.trim() : '';
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  const rawStatus = typeof payload.status === 'string'
    ? payload.status.trim().toLowerCase()
    : (typeof payload.implementation_status === 'string' ? payload.implementation_status.trim().toLowerCase() : '');
  const implementationStatus = VALID_PART_STATUSES.has(rawStatus) ? rawStatus : null;

  const hasAnyField = Boolean(
    code || group || title || category || goal ||
    (paths && paths.length > 0) ||
    (acceptance && acceptance.length > 0) ||
    agent || model || implementationStatus
  );
  if (!hasAnyField) {
    return { ok: false, code: 'empty_enrich_result', error: '补全结果 JSON 缺少任何有效补全字段（code/group/goal/paths/acceptance/agent/model）' };
  }

  return {
    ok: true,
    data: {
      schema: raw.schema || PART_ENRICH_SCHEMA,
      code,
      group,
      title,
      category,
      goal,
      paths,
      acceptance,
      depends_on: dependsOn,
      agent,
      model,
      implementation_status: implementationStatus,
    },
  };
}

function readEnrichmentResultCandidate({ project, part, enrichTask, config, pkgRoot }) {
  const allowedDirs = resolveAllowedRoots({ config, pkgRoot });
  if (project?.workspace_dir && !allowedDirs.includes(project.workspace_dir)) {
    allowedDirs.push(project.workspace_dir);
  }
  const candidates = [];
  if (enrichTask?.result?.uri) {
    const p = resolveResultUriPath(enrichTask.result.uri);
    if (p) candidates.push({ path: p, source: 'task_result' });
  }
  const fallbackRel = `out/projects/${project.id}/enrich_${part.key}.json`;
  if (project?.workspace_dir) {
    candidates.push({ path: path.resolve(project.workspace_dir, fallbackRel), source: 'workspace_enrich_file' });
  }
  candidates.push({ path: path.resolve(pkgRoot, fallbackRel), source: 'pkg_enrich_file' });

  let lastInvalid = null;
  const seen = new Set();
  for (const cand of candidates) {
    const norm = path.resolve(cand.path);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (!fs.existsSync(norm)) continue;
    if (!isWithinAllowedRoots(norm, allowedDirs)) {
      lastInvalid = {
        status: 'invalid',
        code: 'enrich_path_outside_root',
        error: `补全结果文件超出允许根目录范围: ${norm}`,
        path: norm,
      };
      continue;
    }
    let st;
    try {
      st = fs.statSync(norm);
      if (!st.isFile() || st.size > 1024 * 1024) {
        lastInvalid = {
          status: 'invalid',
          code: 'enrich_file_invalid_size',
          error: `补全结果文件大小异常或不是普通文件: ${norm}`,
          path: norm,
        };
        continue;
      }
    } catch (err) {
      lastInvalid = { status: 'invalid', code: 'enrich_read_error', error: err.message, path: norm };
      continue;
    }

    let parsed;
    try {
      const txt = fs.readFileSync(norm, 'utf8').replace(/^\uFEFF/, '');
      parsed = JSON.parse(txt);
    } catch (err) {
      lastInvalid = {
        status: 'invalid',
        code: 'enrich_invalid_json',
        error: `补全结果文件不是合法 JSON: ${err.message}`,
        path: norm,
      };
      continue;
    }

    const validated = validatePartEnrichResult(parsed, { projectId: project.id, partKey: part.key });
    if (validated.ok) {
      return {
        status: 'loaded',
        data: validated.data,
        path: norm,
        source: cand.source,
        error: null,
      };
    }
    lastInvalid = {
      status: 'invalid',
      code: validated.code,
      error: validated.error,
      path: norm,
    };
  }

  if (lastInvalid) return lastInvalid;
  return {
    status: 'missing',
    code: 'enrich_result_missing',
    error: `补全任务已完成，但未找到有效的 JSON 结果文件 (${PART_ENRICH_SCHEMA})`,
    path: null,
  };
}

function applyEnrichmentResultToPart(part, enriched, { existingCodes, clientById, taskId, workspaceDir = null } = {}) {
  if (!enriched) return part;
  if (taskId && part.enrichment_applied_task_id === taskId) {
    return {
      ...part,
      enrichment_status: 'done',
      enrichment_error: null,
    };
  }

  const ph = isPlainObject(part.enrichment_placeholders) ? part.enrichment_placeholders : {};
  const next = { ...part };

  if (!String(next.title || '').trim() && enriched.title) {
    next.title = enriched.title;
  }

  const canFillCode = Boolean(ph.code || !String(next.code || '').trim());
  if (canFillCode && enriched.code) {
    const prevCode = next.code ? resolvePartCode(next) : null;
    if (!existingCodes || !existingCodes.has(enriched.code) || enriched.code === prevCode) {
      if (existingCodes && prevCode && prevCode !== enriched.code) {
        existingCodes.delete(prevCode);
      }
      if (existingCodes) existingCodes.add(enriched.code);
      next.code = enriched.code;
    }
  }

  const canFillCategory = Boolean(ph.category || !String(next.category || '').trim() || next.category === 'general');
  if (canFillCategory && enriched.category) {
    next.category = enriched.category;
  }

  const canFillGroup = Boolean(ph.group || !VALID_PART_GROUPS.has(next.group));
  if (canFillGroup && enriched.group) {
    next.group = enriched.group;
  }

  const canFillGoal = Boolean(!String(next.goal || '').trim() || ph.goal);
  if (canFillGoal && enriched.goal) {
    next.goal = enriched.goal;
  }

  const canFillPaths = (!Array.isArray(next.paths) || next.paths.length === 0) && ph.paths !== false;
  if (canFillPaths && Array.isArray(enriched.paths) && enriched.paths.length > 0) {
    next.paths = [...enriched.paths];
    if (workspaceDir && (!Array.isArray(next.existing_paths) || next.existing_paths.length === 0)) {
      const diskCheck = inspectPartPathsOnDisk(workspaceDir, next.paths);
      next.existing_paths = diskCheck.existing_paths;
      next.missing_paths = diskCheck.missing_paths;
      if ((ph.implementation_status || next.implementation_status === 'planned') && diskCheck.status) {
        next.implementation_status = diskCheck.status;
      }
    }
  }

  const canFillAcc = (!Array.isArray(next.acceptance) || next.acceptance.length === 0) && ph.acceptance !== false;
  if (canFillAcc && Array.isArray(enriched.acceptance) && enriched.acceptance.length > 0) {
    next.acceptance = [...enriched.acceptance];
  }

  const canFillDeps = (!Array.isArray(next.depends_on) || next.depends_on.length === 0) && ph.depends_on !== false;
  if (canFillDeps && Array.isArray(enriched.depends_on) && enriched.depends_on.length > 0) {
    next.depends_on = [...enriched.depends_on];
  }

  if (ph.implementation_status && enriched.implementation_status) {
    next.implementation_status = enriched.implementation_status;
  }

  if (!next.manual_override && !String(next.agent || '').trim() && enriched.agent) {
    const info = clientById ? clientById.get(enriched.agent) : null;
    if (info && info.installed) {
      next.agent = enriched.agent;
      next.suggested_agent = enriched.agent;
      next.assignment_source = 'enrichment';
      next.agent_warning = null;
      if (enriched.model && (!String(next.model || '').trim() || ph.model)) {
        if ((info.selectable_models || []).includes(enriched.model)) {
          next.model = enriched.model;
          next.suggested_model = enriched.model;
        } else {
          next.agent_warning = `补全建议的模型 "${enriched.model}" 不在 ${enriched.agent} 允许列表中，已回退为默认配置`;
        }
      }
    } else {
      next.suggested_agent = enriched.agent;
      next.agent_warning = `补全建议的 agent "${enriched.agent}" 当前未安装，请手动指定或使用自动分配`;
    }
  } else if (!next.manual_override && String(next.agent || '').trim() && !String(next.model || '').trim() && ph.model && enriched.model) {
    if (!enriched.agent || enriched.agent === next.agent) {
      const info = clientById ? clientById.get(next.agent) : null;
      if (info && (info.selectable_models || []).includes(enriched.model)) {
        next.model = enriched.model;
        next.suggested_model = enriched.model;
      }
    }
  }

  next.enrichment_status = 'done';
  next.enrichment_error = null;
  if (taskId) next.enrichment_applied_task_id = taskId;
  return next;
}

function needsEnrichmentForDecomposed(part) {
  if (!part) return false;
  const missingGoal = !String(part.goal || '').trim();
  const missingPaths = !Array.isArray(part.paths) || part.paths.length === 0;
  const missingAcc = !Array.isArray(part.acceptance) || part.acceptance.length === 0;
  const missingAgent = !String(part.agent || '').trim() && !part.manual_override;
  return missingGoal || (missingPaths && missingAcc) || (missingGoal && missingAgent);
}

function buildWorkingPartFromPlanPart(planPart, clientById, { source = 'plan', workspaceDir = null } = {}) {
  const suggestedAgent = planPart.agent || '';
  const suggestedModel = planPart.model || '';
  const info = suggestedAgent ? clientById.get(suggestedAgent) : null;
  const installed = Boolean(info && info.installed);

  let agent = '';
  let model = '';
  let agentWarning = null;

  if (suggestedAgent) {
    if (installed) {
      agent = suggestedAgent;
      if (suggestedModel) {
        if ((info.selectable_models || []).includes(suggestedModel)) {
          model = suggestedModel;
        } else {
          agentWarning = `plan 建议的模型 "${suggestedModel}" 不在 ${suggestedAgent} 允许列表中，已回退为默认配置`;
        }
      }
    } else {
      agentWarning = `plan 建议的 agent "${suggestedAgent}" 当前未安装，请手动指定或使用自动分配`;
    }
  }

  const paths = Array.isArray(planPart.paths) ? [...planPart.paths] : [];
  let implStatus = VALID_PART_STATUSES.has(planPart.status) ? planPart.status : 'planned';
  let existingPaths = Array.isArray(planPart.existing_paths) ? [...planPart.existing_paths] : [];
  let missingPaths = Array.isArray(planPart.missing_paths) ? [...planPart.missing_paths] : [];
  if (workspaceDir && paths.length > 0 && existingPaths.length === 0 && missingPaths.length === 0) {
    const diskCheck = inspectPartPathsOnDisk(workspaceDir, paths);
    existingPaths = diskCheck.existing_paths;
    missingPaths = diskCheck.missing_paths;
    if (implStatus === 'planned' && diskCheck.status) {
      implStatus = diskCheck.status;
    }
  }

  return {
    key: planPart.key,
    code: resolvePartCode(planPart),
    title: planPart.title,
    category: planPart.category || 'general',
    group: inferPartGroup(planPart),
    goal: planPart.goal,
    paths,
    existing_paths: existingPaths,
    missing_paths: missingPaths,
    implementation_status: implStatus,
    scan_evidence: planPart.evidence || '',
    acceptance: Array.isArray(planPart.acceptance) ? [...planPart.acceptance] : [],
    agent,
    model,
    depends_on: Array.isArray(planPart.depends_on) ? [...planPart.depends_on] : [],
    suggested_agent: suggestedAgent || null,
    suggested_model: suggestedModel || null,
    agent_warning: agentWarning,
    source,
    manual_override: false,
    matched_rule_id: null,
    matched_rule_name: null,
    matched_by: null,
    assignment_source: agent ? 'plan_suggestion' : 'unassigned',
    task_id: null,
    task_history: [],
    regenerate_count: 0,
    last_dispatch: null,
    enrichment_task_id: null,
    enrichment_status: null,
    enrichment_error: null,
    enrichment_dispatch: null,
    enrichment_retry_count: 0,
    enrichment_applied_task_id: null,
    enrichment_placeholders: {
      title: false,
      code: Boolean(planPart.code_is_placeholder),
      category: Boolean(planPart.category_is_placeholder),
      group: Boolean(planPart.group_is_placeholder),
      goal: !planPart.goal,
      paths: paths.length === 0,
      acceptance: !Array.isArray(planPart.acceptance) || planPart.acceptance.length === 0,
      depends_on: !Array.isArray(planPart.depends_on) || planPart.depends_on.length === 0,
      implementation_status: !planPart.status_explicit,
      agent: !agent,
      model: !model,
    },
  };
}

function mergeExistingPartRuntimeFields(built, cur) {
  return {
    ...built,
    code: cur.code || built.code,
    task_id: cur.task_id || null,
    task_history: Array.isArray(cur.task_history) ? cur.task_history : [],
    regenerate_count: Number(cur.regenerate_count || 0),
    last_dispatch: cur.last_dispatch || null,
    completion_task_id: cur.completion_task_id || null,
    completed_at: cur.completed_at || null,
    completion_status: cur.completion_status || null,
    completion_dispatch: cur.completion_dispatch || null,
    enrichment_task_id: cur.enrichment_task_id || null,
    enrichment_status: cur.enrichment_status || null,
    enrichment_error: cur.enrichment_error || null,
    enrichment_dispatch: cur.enrichment_dispatch || null,
    enrichment_retry_count: Number(cur.enrichment_retry_count || 0),
    enrichment_applied_task_id: cur.enrichment_applied_task_id || null,
  };
}

function mergeDeltaPartsIntoList(baseParts, deltaParts, clientById, { workspaceDir = null } = {}) {
  const nextParts = baseParts.map((p) => ({ ...p }));
  const usedCodes = new Set(nextParts.map((p) => resolvePartCode(p)));
  for (const dp of deltaParts || []) {
    const built = buildWorkingPartFromPlanPart(dp, clientById, {
      source: 'delta',
      workspaceDir,
    });
    const existingIdx = nextParts.findIndex((p) => p.key === dp.key);
    if (existingIdx < 0) {
      if (nextParts.length >= MAX_PARTS_PER_PROJECT) continue;
      if (usedCodes.has(built.code)) {
        built.code = defaultPartCode(built.key, usedCodes);
      } else {
        usedCodes.add(built.code);
      }
      nextParts.push(built);
    } else {
      const cur = nextParts[existingIdx];
      if (cur.manual_override !== true) {
        nextParts[existingIdx] = mergeExistingPartRuntimeFields(built, cur);
      }
    }
  }
  return nextParts;
}

function resolveEffectiveParts(project, planResult, clientById, { config = null, pkgRoot = PKG_ROOT, taskMap = null, skipAutoApplyDeltas = false } = {}) {
  const storedParts = Array.isArray(project.parts) ? project.parts : [];
  let parts = storedParts;
  let syncedFromPlan = false;

  if (project.parts_initialized !== true) {
    if (planResult?.status === 'loaded' && planResult.plan) {
      const planWorking = planResult.plan.parts.map((pp) =>
        buildWorkingPartFromPlanPart(pp, clientById, { workspaceDir: project.workspace_dir || null })
      );
      const planKeys = new Set(planWorking.map((p) => p.key));
      const extras = storedParts.filter((p) => p && !planKeys.has(p.key));
      parts = [...planWorking, ...extras];
      syncedFromPlan = true;
    }
  } else if (
    planResult?.status === 'loaded' &&
    planResult.plan &&
    !project.plan_snapshot &&
    project.bootstrap_synced_task_id !== project.bootstrap_task_id
  ) {
    const existingKeys = new Set(storedParts.map((p) => p?.key).filter(Boolean));
    const additions = planResult.plan.parts
      .filter((pp) => !existingKeys.has(pp.key))
      .map((pp) => buildWorkingPartFromPlanPart(pp, clientById, { workspaceDir: project.workspace_dir || null }));
    if (additions.length > 0) {
      parts = [...storedParts, ...additions];
      syncedFromPlan = true;
    }
  }

  let autoAppliedDeltas = false;
  if (!skipAutoApplyDeltas && config && taskMap && Array.isArray(project.card_requests) && project.card_requests.length > 0) {
    const pendingReqs = [...project.card_requests].reverse();
    for (const req of pendingReqs) {
      if (!req || req.merged || req.merge_summary?.needs_confirmation) continue;
      const rTask = req.task_id ? taskMap.get(req.task_id) : null;
      if (!rTask || rTask.state !== 'done') continue;
      const cand = readPlanCandidate({
        project,
        bootstrapTask: rTask,
        config,
        pkgRoot,
        relPathOverride: req.delta_rel_path || null,
        allowDelta: true,
      });
      if (cand.status === 'loaded' && cand.plan) {
        parts = mergeDeltaPartsIntoList(parts, cand.plan.parts, clientById, {
          workspaceDir: project.workspace_dir || null,
        });
        autoAppliedDeltas = true;
      }
    }
  }

  return { parts, syncedFromPlan, autoAppliedDeltas };
}

function hydrateCardRequests(project, { config, pkgRoot, taskMap, env = process.env }) {
  const rawReqs = Array.isArray(project.card_requests) ? project.card_requests : [];
  const manualKeys = new Set(
    (project.parts || []).filter((p) => p && p.manual_override === true).map((p) => p.key)
  );
  return rawReqs.map((req) => {
    const rTask = req.task_id ? (taskMap.get(req.task_id) || null) : null;
    const state = rTask ? rTask.state : (req.task_id ? 'missing' : 'none');
    let deltaStatus = req.merged ? 'merged' : 'pending';
    let deltaError = null;
    let readyToMerge = false;
    let deltaPreviewCount = 0;
    let manualConflicts = [];

    if (!req.merged && rTask?.state === 'done') {
      const cand = readPlanCandidate({
        project,
        bootstrapTask: rTask,
        config,
        pkgRoot,
        relPathOverride: req.delta_rel_path || null,
        allowDelta: true,
      });
      if (cand.status === 'loaded' && cand.plan) {
        deltaStatus = 'ready';
        readyToMerge = true;
        deltaPreviewCount = cand.plan.parts.length;
        manualConflicts = cand.plan.parts.map((p) => p.key).filter((k) => manualKeys.has(k));
      } else {
        deltaStatus = cand.status;
        deltaError = cand.error;
      }
    } else if (!req.merged && rTask?.state === 'failed') {
      deltaStatus = 'failed';
      deltaError = rTask.last_message?.body || rTask.history?.[rTask.history.length - 1]?.reason || '追加卡片任务失败';
    } else if (!req.merged && rTask?.blocked) {
      deltaStatus = 'blocked';
      deltaError = rTask.last_message?.body || '追加卡片任务已阻塞';
    } else if (!req.merged && req.dispatch_error && state === 'open') {
      deltaStatus = 'dispatch_error';
      deltaError = req.dispatch_error;
    }

    return {
      ...req,
      state,
      blocked: Boolean(rTask?.blocked),
      last_message: rTask?.last_message || null,
      finished_at: rTask?.finished_at || null,
      awaiting_main_agent: !isAgentDispatchable(rTask?.to || req.to || project.main_agent, env) && (state === 'open' || state === 'claimed'),
      delta_status: deltaStatus,
      delta_error: deltaError,
      ready_to_merge: readyToMerge,
      delta_preview_count: deltaPreviewCount,
      manual_conflicts: manualConflicts,
      dispatch_command: req.task_id
        ? `node bin/bus.js dispatch ${req.task_id} --allow-dispatch --root "${config.rootDir}"`
        : null,
    };
  });
}

function hydrateProjectRecord(project, { config, pkgRoot, clientById, taskMap, env = process.env }) {
  const bTask = project.bootstrap_task_id ? (taskMap.get(project.bootstrap_task_id) || null) : null;
  const rawState = bTask ? bTask.state : (project.bootstrap_task_id ? 'missing' : 'none');
  const dispatchCmd = project.bootstrap_task_id
    ? `node bin/bus.js dispatch ${project.bootstrap_task_id} --allow-dispatch --root "${config.rootDir}"`
    : null;

  let planResult = null;
  let planStatus = 'pending';
  let planError = null;
  let planSnapshot = project.plan_snapshot || null;
  let planSourcePath = project.plan_source_path || null;

  if (bTask?.state === 'done') {
    planResult = readPlanCandidate({ project, bootstrapTask: bTask, config, pkgRoot });
    if (planResult.status === 'loaded') {
      planStatus = 'loaded';
      planSnapshot = planResult.plan;
      planSourcePath = planResult.path;
      planError = null;
    } else {
      planStatus = planResult.status; // 'invalid' | 'missing'
      planError = planResult.error;
    }
  } else if (bTask?.state === 'failed') {
    planStatus = 'failed';
    const failReason = bTask.last_message?.body || bTask.history?.[bTask.history.length - 1]?.reason || '主 Agent 拆解任务失败';
    planError = failReason;
  } else if (bTask?.blocked) {
    planStatus = 'blocked';
    planError = bTask.last_message?.body || '主 Agent 拆解任务已阻塞，等待处理或重试';
  } else if (project.bootstrap_dispatch_error && rawState === 'open') {
    planStatus = 'dispatch_error';
    planError = project.bootstrap_dispatch_error;
  } else if (planSnapshot) {
    planStatus = 'loaded';
  } else if (project.source_mode === 'read_existing' && rawState === 'none') {
    planStatus = 'scanned';
  } else if (rawState === 'missing') {
    planStatus = 'missing';
    planError = `未在当前总线数据库中找到拆解任务 ${project.bootstrap_task_id}`;
  } else {
    planStatus = 'pending';
  }

  const { parts: workingParts, syncedFromPlan, autoAppliedDeltas } = resolveEffectiveParts(project, planResult, clientById, {
    config,
    pkgRoot,
    taskMap,
  });
  const groups = resolveProjectGroups(project.groups);
  const usedCodes = new Set(workingParts.map((pt) => resolvePartCode(pt)));
  const projectAutoEnrich = project.auto_enrich !== false;

  const hydratedParts = workingParts.map((rawPart) => {
    const eTask = rawPart.enrichment_task_id ? (taskMap.get(rawPart.enrichment_task_id) || null) : null;
    let part = rawPart;
    let enrichmentStatus = rawPart.enrichment_status || null;
    let enrichmentError = rawPart.enrichment_error || null;

    if (eTask) {
      if (eTask.state === 'done') {
        if (rawPart.enrichment_applied_task_id === eTask.id) {
          enrichmentStatus = 'done';
          enrichmentError = null;
        } else {
          const enrichRes = readEnrichmentResultCandidate({
            project,
            part: rawPart,
            enrichTask: eTask,
            config,
            pkgRoot,
          });
          if (enrichRes.status === 'loaded' && enrichRes.data) {
            part = applyEnrichmentResultToPart(rawPart, enrichRes.data, {
              existingCodes: usedCodes,
              clientById,
              taskId: eTask.id,
              workspaceDir: project.workspace_dir || null,
            });
            enrichmentStatus = 'done';
            enrichmentError = null;
          } else {
            enrichmentStatus = 'failed';
            enrichmentError = enrichRes.error || '补全结果校验失败';
          }
        }
      } else if (eTask.state === 'failed') {
        enrichmentStatus = 'failed';
        enrichmentError = eTask.last_message?.body || eTask.history?.[eTask.history.length - 1]?.reason || '主 Agent 补全任务失败';
      } else {
        enrichmentStatus = 'pending';
        if (eTask.blocked) {
          enrichmentError = eTask.last_message?.body || '主 Agent 补全任务已阻塞';
        } else if (rawPart.enrichment_dispatch?.dispatch_error && eTask.state === 'open') {
          enrichmentError = rawPart.enrichment_dispatch.dispatch_error;
        } else {
          enrichmentError = null;
        }
      }
    }

    const pTask = part.task_id ? (taskMap.get(part.task_id) || null) : null;
    const pInfo = part.agent ? clientById.get(part.agent) : null;
    const agentInstalled = part.agent ? Boolean(pInfo && pInfo.installed) : false;
    const activeTask = Boolean(pTask && (pTask.state === 'open' || pTask.state === 'claimed'));
    const partDispatchCmd = part.task_id
      ? `node bin/bus.js dispatch ${part.task_id} --allow-dispatch --root "${config.rootDir}"`
      : null;
    const historyList = Array.isArray(part.task_history) ? part.task_history : [];
    const implStatus = VALID_PART_STATUSES.has(part.implementation_status)
      ? part.implementation_status
      : 'planned';
    const partGroup = VALID_PART_GROUPS.has(part.group) ? part.group : 'dev';
    const partCode = resolvePartCode(part);
    const cTask = part.completion_task_id ? (taskMap.get(part.completion_task_id) || null) : null;
    let completionStatus = null;
    if (cTask) {
      if (cTask.state === 'done') completionStatus = 'done';
      else if (cTask.state === 'failed') completionStatus = 'failed';
      else completionStatus = 'pending';
    } else if (part.completion_status === 'pending' || part.completion_status === 'done' || part.completion_status === 'failed') {
      completionStatus = part.completion_status;
    }
    const completionError = cTask && cTask.state === 'failed'
      ? (cTask.last_message?.body || cTask.history?.[cTask.history.length - 1]?.reason || '模块完成任务失败')
      : null;
    const enrichmentNeeded = Boolean(
      projectAutoEnrich &&
      !eTask &&
      enrichmentStatus !== 'skipped' &&
      enrichmentStatus !== 'done' &&
      needsEnrichmentForDecomposed(part)
    );

    return {
      ...part,
      code: partCode,
      group: partGroup,
      implementation_status: implStatus,
      enrichment_task_id: part.enrichment_task_id || null,
      enrichment_status: enrichmentStatus,
      enrichment_error: enrichmentError,
      enrichment_needed: enrichmentNeeded,
      enrichment_task: eTask
        ? {
            id: eTask.id,
            to: eTask.to,
            state: eTask.state,
            claimed_by: eTask.claimed_by,
            blocked: eTask.blocked,
            blocked_at: eTask.blocked_at,
            finished_at: eTask.finished_at,
            result: eTask.result,
            last_message: eTask.last_message,
            error: enrichmentError,
            awaiting_main_agent: !isAgentDispatchable(eTask.to, env) && (eTask.state === 'open' || eTask.state === 'claimed'),
            dispatched: part.enrichment_dispatch?.dispatched === true,
            dispatch_error: part.enrichment_dispatch?.dispatch_error || null,
            dispatch_command: `node bin/bus.js dispatch ${eTask.id} --allow-dispatch --root "${config.rootDir}"`,
          }
        : null,
      completion_task_id: part.completion_task_id || null,
      completed_at: (cTask?.state === 'done' && cTask.finished_at) ? cTask.finished_at : (part.completed_at || null),
      completion_status: completionStatus,
      completion_task: cTask
        ? {
            id: cTask.id,
            to: cTask.to,
            state: cTask.state,
            claimed_by: cTask.claimed_by,
            blocked: cTask.blocked,
            blocked_at: cTask.blocked_at,
            finished_at: cTask.finished_at,
            result: cTask.result,
            last_message: cTask.last_message,
            error: completionError,
            awaiting_main_agent: !isAgentDispatchable(cTask.to, env) && (cTask.state === 'open' || cTask.state === 'claimed'),
            dispatched: part.completion_dispatch?.dispatched === true,
            dispatch_error: part.completion_dispatch?.dispatch_error || null,
            dispatch_command: `node bin/bus.js dispatch ${cTask.id} --allow-dispatch --root "${config.rootDir}"`,
          }
        : null,
      existing_paths: Array.isArray(part.existing_paths) ? part.existing_paths : [],
      missing_paths: Array.isArray(part.missing_paths) ? part.missing_paths : [],
      scan_evidence: part.scan_evidence || '',
      paths: Array.isArray(part.paths) ? part.paths : [],
      acceptance: Array.isArray(part.acceptance) ? part.acceptance : [],
      depends_on: Array.isArray(part.depends_on) ? part.depends_on : [],
      agent_installed: agentInstalled,
      agent_model_default: pInfo?.model || '未配置',
      active_task: activeTask,
      task_history: historyList,
      task_history_count: historyList.length,
      regenerate_count: Number(part.regenerate_count || 0),
      can_regenerate: !activeTask && (
        Boolean(pTask) || implStatus === 'existing' || implStatus === 'partial'
      ),
      task: pTask
        ? {
            id: pTask.id,
            to: pTask.to,
            state: pTask.state,
            claimed_by: pTask.claimed_by,
            blocked: pTask.blocked,
            blocked_at: pTask.blocked_at,
            finished_at: pTask.finished_at,
            result: pTask.result,
            last_message: pTask.last_message,
            dispatch_requested: part.last_dispatch?.dispatch_requested ?? null,
            dispatched: part.last_dispatch?.dispatched ?? null,
            queued: part.last_dispatch?.queued === true,
            queue_position: part.last_dispatch?.queue_position ?? null,
            dispatch_error: part.last_dispatch?.dispatch_error || null,
            dispatch_command: partDispatchCmd,
          }
        : null,
    };
  });

  const hydratedCardRequests = hydrateCardRequests(project, { config, pkgRoot, taskMap, env });

  // Compute real project status solely from bus task states (never claim open is dispatched!)
  let projectStatus = rawState;
  if (rawState === 'open' && bTask?.blocked) projectStatus = 'blocked';
  if (rawState === 'claimed' && bTask?.blocked) projectStatus = 'blocked';

  return {
    id: project.id,
    name: project.name,
    goal: project.goal,
    summary: planSnapshot?.summary || project.summary || '',
    source_mode: project.source_mode || 'new',
    workspace_dir: project.workspace_dir || null,
    dev_materials_dir: resolveProjectDevMaterialsDir(project, { config, pkgRoot }),
    workspace_scan: project.workspace_scan || null,
    main_agent: project.main_agent,
    main_model: project.main_model || '',
    auto_enrich: projectAutoEnrich,
    plan_rel_path: project.plan_rel_path,
    plan_source_path: planSourcePath,
    plan_status: planStatus,
    plan_error: planError,
    plan_snapshot: planSnapshot,
    plan_synced_in_view: syncedFromPlan,
    deltas_synced_in_view: autoAppliedDeltas,
    parts_initialized: Boolean(project.parts_initialized),
    status: projectStatus,
    created_at: project.created_at,
    updated_at: project.updated_at,
    bootstrap_task: {
      id: project.bootstrap_task_id || null,
      to: bTask?.to || project.main_agent,
      state: rawState,
      claimed_by: bTask?.claimed_by || null,
      blocked: Boolean(bTask?.blocked),
      blocked_at: bTask?.blocked_at || null,
      created_at: bTask?.created_at || project.created_at,
      finished_at: bTask?.finished_at || null,
      result: bTask?.result || null,
      last_message: bTask?.last_message || null,
      awaiting_main_agent: !isAgentDispatchable(bTask?.to || project.main_agent, env) && (rawState === 'open' || rawState === 'claimed'),
      dispatch_requested: project.bootstrap_dispatch_requested === true,
      dispatched: project.bootstrap_dispatched === true && rawState !== 'none',
      dispatch_error: project.bootstrap_dispatch_error || null,
      dispatch_command: dispatchCmd,
    },
    card_requests: hydratedCardRequests,
    groups,
    parts: hydratedParts,
    part_count: hydratedParts.length,
    status_counts: {
      existing: hydratedParts.filter((x) => x.implementation_status === 'existing').length,
      partial: hydratedParts.filter((x) => x.implementation_status === 'partial').length,
      missing: hydratedParts.filter((x) => x.implementation_status === 'missing').length,
      planned: hydratedParts.filter((x) => x.implementation_status === 'planned').length,
    },
  };
}

function collectProjectTaskIds(projects) {
  const ids = [];
  for (const p of projects || []) {
    if (p.bootstrap_task_id) ids.push(p.bootstrap_task_id);
    for (const part of p.parts || []) {
      if (part?.task_id) ids.push(part.task_id);
      if (part?.completion_task_id) ids.push(part.completion_task_id);
      if (part?.enrichment_task_id) ids.push(part.enrichment_task_id);
    }
    for (const cr of p.card_requests || []) {
      if (cr?.task_id) ids.push(cr.task_id);
    }
  }
  return ids;
}

function resolveDefaultMainAgent(setup) {
  const clients = setup.clients || [];
  const installed = clients.filter((c) => c.installed);
  if (installed.length === 0) return null;
  const agy = installed.find((c) => c.id === 'antigravity');
  if (agy) return agy.id;
  if (setup.conductor && installed.some((c) => c.id === setup.conductor)) {
    return setup.conductor;
  }
  return installed[0].id;
}

export function validateAgentAndModel({ agent, model, clientById, knownSet, allowEmptyAgent = false }) {
  const cleanAgent = typeof agent === 'string' ? agent.trim() : '';
  const cleanModel = typeof model === 'string' ? model.trim() : '';

  if (!cleanAgent) {
    if (allowEmptyAgent) {
      if (cleanModel) {
        throw makeHttpError(400, 'invalid_model', '未指定 agent 时不能单独指定模型');
      }
      return { agent: '', model: '' };
    }
    throw makeHttpError(400, 'missing_agent', '必须指定有效的执行 Agent');
  }

  if (!knownSet.has(cleanAgent)) {
    throw makeHttpError(400, 'invalid_agent', `未知 agent id: ${cleanAgent}`);
  }
  const info = clientById.get(cleanAgent);
  if (!info || !info.installed) {
    throw makeHttpError(400, 'agent_not_installed', `Agent "${cleanAgent}" 当前未安装，禁止选择或派发`);
  }

  if (cleanModel) {
    if (/[\r\n\0]/.test(cleanModel)) {
      throw makeHttpError(400, 'invalid_model', '模型名称包含非法控制字符');
    }
    const allowed = new Set(info.selectable_models || []);
    if (!allowed.has(cleanModel)) {
      throw makeHttpError(400, 'invalid_model', `模型 "${cleanModel}" 不在 ${cleanAgent} 的允许模型列表中`);
    }
  }

  return { agent: cleanAgent, model: cleanModel };
}

function buildBootstrapGoal({ projectId, name, goal, mainAgent, mainModel, planRelPath, installedAgents }) {
  const agentList = (installedAgents || []).map((a) => a.id).join(', ') || mainAgent;
  const schemaExample = JSON.stringify({
    schema: PROJECT_PLAN_SCHEMA,
    project_id: projectId,
    title: name,
    summary: '一句话说明整体架构与拆分思路',
    parts: [
      {
        key: 'frontend',
        title: '前端界面',
        category: 'frontend_ui',
        group: 'dev',
        goal: '实现核心交互页面与状态流',
        paths: ['src/web'],
        acceptance: ['关键页面可运行且测试通过'],
        agent: mainAgent,
        model: '',
        depends_on: [],
      },
    ],
  }, null, 2);

  return [
    `# 项目拆解任务：${name}`,
    '',
    `- project_id: \`${projectId}\``,
    `- 主 Agent (执行方): \`${mainAgent}\``,
    `- 主模型要求: ${mainModel || '沿用当前配置'}`,
    `- 本机已安装可用 Agent: ${agentList}`,
    `- 计划输出路径 (相对工作目录): \`${planRelPath}\``,
    '',
    '## 项目目标与需求',
    goal,
    '',
    '## 交付要求（必须遵守）',
    '1. 将上述项目拆解为若干独立可执行、职责清晰的模块/部分（parts，例如前端、通信、数据存储、测试优化等）。',
    '2. 每个 part 请标注 `group`：功能研发/实现放 `"dev"`（研发组），排查/调试/回归/回传问题放 `"debug"`（调试组）；省略时默认归入研发组。',
    `3. 将结构化拆解结果以合法 UTF-8 JSON 写入 \`${planRelPath}\` 并并在调用 \`bus_task_complete\` 时把该文件作为 \`result_path\` 提交（不要只回复纯文本 DONE）。`.replace('并并在', '并在'),
    '4. 每个 part 的 `paths` 必须使用相对项目路径（禁止绝对路径或 `..`）；`acceptance` 必须是可验证条件；`agent` 建议从本机已安装 Agent 中选择，或留空待路由规则分配。',
    '',
    '## 必须符合的 JSON 契约 (`agentbus/project-plan@1`)',
    '```json',
    schemaExample,
    '```',
  ].join('\n');
}

function buildPartTaskGoal({ project, part }) {
  const pathsBlock = (part.paths || []).length > 0
    ? part.paths.map((p) => `- \`${p}\``).join('\n')
    : '- （未限定路径，请在工作目录内按项目结构组织）';
  const accBlock = (part.acceptance || []).length > 0
    ? part.acceptance.map((a) => `- ${a}`).join('\n')
    : '- 产出可验证结果 JSON 并运行相关回归检查。';
  const depsBlock = (part.depends_on || []).length > 0
    ? part.depends_on.join(', ')
    : '无';

  return [
    `# 项目分派任务：${project.name} / ${part.title} (${part.key})`,
    '',
    `- project_id: \`${project.id}\``,
    `- part_key: \`${part.key}\``,
    `- 所属环节 (group): \`${part.group === 'debug' ? 'debug' : 'dev'}\``,
    `- 类别 (category): \`${part.category || 'general'}\``,
    `- 执行 Agent (to): \`${part.agent}\``,
    `- 目标模型: ${part.model || '沿用该 agent 当前配置'}`,
    `- 依赖部分 (depends_on): ${depsBlock}`,
    '',
    '## 所属项目总目标',
    project.goal,
    '',
    '## 本部分具体任务目标',
    part.goal,
    '',
    '## 涉及相对路径',
    pathsBlock,
    '',
    '## 验收条件',
    accBlock,
    '',
    '## 交付说明',
    '- 完成后产出合法结果 JSON 文件并通过 `bus_task_complete` 提交。',
  ].join('\n');
}

export function isAgentDispatchable(agentId, env = process.env) {
  if (!agentId || typeof agentId !== 'string') return false;
  const adapters = new Set(listAdapters());
  if (adapters.has(agentId)) return true;
  const envKey = `AGENTBUS_ADAPTER_${agentId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return Boolean(env && typeof env[envKey] === 'string' && env[envKey].trim());
}

function interpretDispatchOutcome(dispatchResult, caughtErr = null) {
  let dispatchError = null;
  if (caughtErr) {
    dispatchError = String(caughtErr?.message || caughtErr);
  } else if (dispatchResult && dispatchResult.dispatched === false && dispatchResult.reason === 'cooldown') {
    dispatchError = dispatchResult.hint || `agent 冷却中 (${dispatchResult.detail || 'cooldown'})`;
  } else if (dispatchResult && dispatchResult.error) {
    dispatchError = String(dispatchResult.error);
  }
  const dispatched = Boolean(
    dispatchResult &&
    !dispatchError &&
    dispatchResult.dispatched !== false
  );
  return { dispatchResult, dispatchError, dispatched };
}

export async function runUiDispatch({
  bus,
  config,
  dispatchFn,
  taskId,
  toAgent,
  cwd,
  waitS = 3,
  explicitWaitS = false,
  env = process.env,
}) {
  // Custom mock dispatchFn (unit tests) or explicit short wait_s: run synchronously for deterministic callers.
  if (dispatchFn !== dispatchTask || explicitWaitS) {
    try {
      const res = await dispatchFn(bus, { id: taskId, cwd, wait_s: waitS });
      return interpretDispatchOutcome(res, null);
    } catch (err) {
      return interpretDispatchOutcome(null, err);
    }
  }

  // Real dispatchTask: check adapter upfront to fail cleanly instead of hanging or killing at 5s.
  if (toAgent && !isAgentDispatchable(toAgent, env)) {
    const adapterList = listAdapters().join(', ');
    return {
      dispatchResult: null,
      dispatchError: `没有 ${toAgent} 的调用适配器。已内置: ${adapterList}；可用 AGENTBUS_ADAPTER_${toAgent.toUpperCase().replace(/[^A-Z0-9]/g, '_')} 自定义`,
      dispatched: false,
    };
  }

  // Run real dispatchTask with a proper 600s work budget on an isolated bus handle so synchronous
  // CLI agents (codex/claude/gemini) are never killed after 5s ("adapter timeout after 5s").
  // Race against an 800ms fast-fail probe so immediate errors (cooldown / missing bin / bad session) return right away.
  const bgBus = openBus({ config });
  let settled = false;
  const bgPromise = Promise.resolve()
    .then(() => dispatchTask(bgBus, { id: taskId, cwd, wait_s: 600 }))
    .then((res) => {
      settled = true;
      return interpretDispatchOutcome(res, null);
    })
    .catch((err) => {
      settled = true;
      return interpretDispatchOutcome(null, err);
    })
    .finally(() => {
      try { bgBus.close(); } catch {}
    });

  const probe = new Promise((resolve) => {
    setTimeout(() => resolve({ __probeTimeout: true }), 800);
  });

  const first = await Promise.race([bgPromise, probe]);
  if (first && first.__probeTimeout && !settled) {
    bgPromise.catch(() => {});
    return {
      dispatchResult: { id: taskId, to: toAgent || null, state: 'open', dispatched: true, async_running: true },
      dispatchError: null,
      dispatched: true,
    };
  }
  return first;
}

async function runDispatchWithGuard(bus, dispatchFn, { taskId, pkgRoot, waitS, config, toAgent = null, explicitWaitS = false, env = process.env }) {
  return runUiDispatch({
    bus,
    config: config || bus.config,
    dispatchFn,
    taskId,
    toAgent,
    cwd: pkgRoot,
    waitS,
    explicitWaitS,
    env,
  });
}

// Serial project dispatch: the first task is started by the request, then the
// remaining tasks are started only after the previous one reaches `done`.
// This queue is in-memory; if the UI process exits, queued tasks stay `open`
// and remain visible/retryable on the project board.
const serialDispatchQueues = new Map();

function startSerialDispatchQueue({
  config,
  projectId,
  pkgRoot,
  waitS,
  entries,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  if (!Array.isArray(entries) || entries.length === 0) return { started: false };
  if (serialDispatchQueues.has(projectId)) return { started: false, reason: 'already_running' };

  const queue = (async () => {
    const bus = openBus({ config });
    try {
      // The first entry was dispatched by the originating request. Wait for
      // its real terminal state before starting the next card.
      const first = entries[0];
      if (first.initialState !== 'done') {
        if (dispatchFn !== dispatchTask) return;
        const waitedFirst = await waitForTask(bus, first.taskId, 3600, 500);
        if (waitedFirst.state !== 'done') return;
      }

      for (const entry of entries.slice(1)) {
        if (!isAgentDispatchable(entry.to, env)) return;
        const dispatched = dispatchFn === dispatchTask
          ? await dispatchTask(bus, {
              id: entry.taskId,
              cwd: entry.cwd || pkgRoot,
              wait_s: waitS,
            })
          : await dispatchFn(bus, {
              id: entry.taskId,
              cwd: entry.cwd || pkgRoot,
              wait_s: waitS,
            });
        if (dispatched.state === 'done') continue;
        if (dispatched.state === 'failed') return;
        if (dispatched.skipped || dispatched.dispatched === false) return;
        if (dispatchFn !== dispatchTask) return;
        const waited = await waitForTask(bus, entry.taskId, 3600, 500);
        if (waited.state !== 'done') return;
      }
    } catch (err) {
      // Keep the remaining tasks open for manual retry; never silently mark them done.
      console.error(`[agentbus] 串行派发队列 ${projectId} 中止: ${err?.message || err}`);
    } finally {
      try { bus.close(); } catch {}
      serialDispatchQueues.delete(projectId);
    }
  })();

  serialDispatchQueues.set(projectId, queue);
  queue.catch(() => {});
  return { started: true, remaining: entries.length - 1 };
}

export function listProjectsHydrated({
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  const store = readProjectsStore(config.rootDir);
  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));
  const taskIds = collectProjectTaskIds(store.projects);
  const taskMap = readTasksByIdsReadOnly(config, taskIds);

  const projects = store.projects.map((p) =>
    hydrateProjectRecord(p, { config, pkgRoot, clientById, taskMap, env })
  );

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
      dispatchable: isAgentDispatchable(c.id, env),
    }));

  return {
    ok: true,
    schema: PROJECTS_STORE_SCHEMA,
    root: config.rootDir,
    file: store.file,
    exists: store.exists,
    broken: store.broken,
    error: store.error,
    updated_at: store.updated_at,
    default_main_agent: resolveDefaultMainAgent(setup),
    conductor: setup.conductor,
    installed_agents: installedAgents,
    projects,
  };
}

export function getProjectHydrated(projectId, {
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  if (!SAFE_PROJECT_ID_RE.test(String(projectId || ''))) {
    throw makeHttpError(400, 'invalid_project_id', `非法项目 id: ${projectId}`);
  }
  const store = readProjectsStore(config.rootDir);
  if (store.broken) {
    throw makeHttpError(422, 'corrupted_projects_config', store.error);
  }
  const found = store.projects.find((p) => p.id === projectId);
  if (!found) {
    throw makeHttpError(404, 'project_not_found', `找不到项目: ${projectId}`);
  }
  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));
  const taskMap = readTasksByIdsReadOnly(config, collectProjectTaskIds([found]));
  return {
    ok: true,
    project: hydrateProjectRecord(found, { config, pkgRoot, clientById, taskMap, env }),
  };
}

export async function createProject({
  body,
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body, ALLOWED_CREATE_PROJECT_KEYS, '新建项目请求体');

  const store = readProjectsStore(config.rootDir);
  if (store.broken) {
    throw makeHttpError(422, 'corrupted_projects_config', `projects.json 已损坏，拒绝写入：${store.error}`);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) {
    throw makeHttpError(400, 'invalid_project_name', '项目名称必填且长度不超过 120 字符');
  }
  if (/[\r\n\0]/.test(name)) {
    throw makeHttpError(400, 'invalid_project_name', '项目名称包含非法控制字符');
  }

  const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
  if (!goal || goal.length > 4000) {
    throw makeHttpError(400, 'invalid_project_goal', '项目目标/需求必填且长度不超过 4000 字符');
  }

  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const defaultMain = resolveDefaultMainAgent(setup);
  const requestedMainAgent = typeof body.main_agent === 'string' && body.main_agent.trim()
    ? body.main_agent.trim()
    : defaultMain;
  if (!requestedMainAgent) {
    throw makeHttpError(400, 'no_installed_agent', '本机未探测到已安装可用的 Agent，请先在主从配置页核查安装状态');
  }

  const { agent: mainAgent, model: mainModel } = validateAgentAndModel({
    agent: requestedMainAgent,
    model: body.main_model || '',
    clientById,
    knownSet,
    allowEmptyAgent: false,
  });

  if (body.auto_dispatch !== undefined && typeof body.auto_dispatch !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'auto_dispatch 必须是布尔值');
  }
  if (body.auto_enrich !== undefined && typeof body.auto_enrich !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'auto_enrich 必须是布尔值');
  }
  const autoDispatch = body.auto_dispatch !== false;
  const autoEnrich = body.auto_enrich !== false;
  const explicitWaitS = body.wait_s !== undefined && body.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS
    ? Math.max(1, Math.min(600, Number(body.wait_s)))
    : 3;

  let workspaceDir = null;
  let workspaceScan = null;
  let workspaceScanSummary = null;
  if (body.workspace_dir !== undefined && body.workspace_dir !== null && String(body.workspace_dir).trim()) {
    const validatedWs = validateWorkspaceDir(String(body.workspace_dir), { config, pkgRoot });
    workspaceDir = validatedWs.realPath;
    workspaceScan = scanWorkspaceDirectory(workspaceDir, { config, pkgRoot });
    workspaceScanSummary = {
      workspace_dir: workspaceDir,
      file_count: workspaceScan.file_count,
      total_bytes: workspaceScan.total_bytes,
      truncated: workspaceScan.truncated,
      manifest_digest: workspaceScan.manifest_digest,
      scanned_at: workspaceScan.scanned_at,
      top_entries: workspaceScan.top_entries,
      counts: workspaceScan.counts,
    };
  }

  let idempotencyKey = null;
  if (body.idempotency_key !== undefined && body.idempotency_key !== null && String(body.idempotency_key).trim()) {
    idempotencyKey = String(body.idempotency_key).trim();
    if (idempotencyKey.length > 128) {
      throw makeHttpError(400, 'invalid_idempotency_key', 'idempotency_key 不得超过 128 字符');
    }
  }

  const devMaterialsDir = validateDevMaterialsDirInput(body.dev_materials_dir, { workspaceDir, config, pkgRoot });
  const projectId = `p_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const planRelPath = `out/projects/${projectId}/plan.json`;
  const installedAgents = (setup.clients || []).filter((c) => c.installed);

  let bootstrapGoal = buildBootstrapGoal({
    projectId,
    name,
    goal,
    mainAgent,
    mainModel,
    planRelPath,
    installedAgents,
  });
  if (workspaceScan) {
    const topLines = (workspaceScan.top_entries || []).slice(0, 12).map((e) => `- \`${e.name}\` (${e.files} 文件, ${e.bytes}B)`);
    bootstrapGoal += [
      '',
      '## 关联本地项目目录摘要（勿重复全量扫描）',
      `- 项目目录: \`${workspaceDir}\``,
      `- 扫描统计: 共 ${workspaceScan.file_count} 文件 / ${workspaceScan.total_bytes} 字节 (digest=${workspaceScan.manifest_digest})`,
      ...topLines,
    ].join('\n');
  }

  const dispatchable = isAgentDispatchable(mainAgent, env);
  const bus = openBus({ config });
  let created;
  let disp = { dispatchResult: null, dispatchError: null, dispatched: false };
  try {
    created = createTask(bus, {
      to: mainAgent,
      from: 'ui',
      goal: bootstrapGoal,
      constraints: [
        `必须产出合法 ${PROJECT_PLAN_SCHEMA} JSON 到 ${planRelPath} 并作为 bus_task_complete 的 result_path。`,
        '所有 paths 必须为相对项目路径，禁止绝对路径或 .. 越界。',
        '不要编造未安装 agent 或不存在的模型。',
      ],
      acceptance: {
        json: 'true',
        schema: PROJECT_PLAN_SCHEMA,
        project_id: projectId,
      },
      idempotency_key: idempotencyKey,
    });

    if (autoDispatch && dispatchable) {
      disp = await runDispatchWithGuard(bus, dispatchFn, {
        taskId: created.id,
        pkgRoot: workspaceDir || pkgRoot,
        waitS,
        config,
        toAgent: mainAgent,
        explicitWaitS,
        env,
      });
    }
  } finally {
    bus.close();
  }

  const now = new Date().toISOString();
  const projectRecord = {
    id: projectId,
    name,
    goal,
    summary: '',
    source_mode: 'new',
    workspace_dir: workspaceDir,
    ...(devMaterialsDir ? { dev_materials_dir: devMaterialsDir } : {}),
    workspace_scan: workspaceScanSummary,
    main_agent: mainAgent,
    main_model: mainModel,
    auto_enrich: autoEnrich,
    plan_rel_path: planRelPath,
    plan_source_path: null,
    plan_snapshot: null,
    groups: DEFAULT_PROJECT_GROUPS.map((g) => ({ ...g })),
    parts_initialized: false,
    parts: [],
    card_requests: [],
    bootstrap_task_id: created.id,
    bootstrap_history: [
      {
        task_id: created.id,
        to: mainAgent,
        created_at: now,
        dispatch_requested: autoDispatch && dispatchable,
        dispatched: disp.dispatched,
        dispatch_error: disp.dispatchError,
        awaiting_main_agent: !dispatchable,
      },
    ],
    bootstrap_dispatch_requested: autoDispatch && dispatchable,
    bootstrap_dispatched: disp.dispatched,
    bootstrap_dispatch_error: disp.dispatchError,
    created_at: now,
    updated_at: now,
  };

  const nextProjects = [projectRecord, ...store.projects];
  saveProjectsStore(config.rootDir, store, nextProjects);

  const taskMap = readTasksByIdsReadOnly(config, [created.id]);
  const hydrated = hydrateProjectRecord(projectRecord, { config, pkgRoot, clientById, taskMap, env });
  const cmdLine = `node bin/bus.js dispatch ${created.id} --allow-dispatch --root "${config.rootDir}"`;

  return {
    ok: true,
    awaiting_main_agent: Boolean(hydrated.bootstrap_task.awaiting_main_agent),
    project: hydrated,
    bootstrap_task: {
      id: created.id,
      to: mainAgent,
      state: hydrated.bootstrap_task.state,
      uri: created.uri,
      dedup: created.dedup,
      awaiting_main_agent: Boolean(hydrated.bootstrap_task.awaiting_main_agent),
      dispatch_requested: autoDispatch && dispatchable,
      dispatched: disp.dispatched,
      dispatch_error: disp.dispatchError,
      dispatch_command: cmdLine,
      ...(disp.dispatchResult ? { dispatch_result: disp.dispatchResult } : {}),
    },
  };
}

function materializePartsForMutation(project, { config, pkgRoot, clientById, skipAutoApplyDeltas = false }) {
  const taskMap = readTasksByIdsReadOnly(config, collectProjectTaskIds([project]));
  const bTask = project.bootstrap_task_id ? (taskMap.get(project.bootstrap_task_id) || null) : null;
  let planResult = null;
  if (bTask?.state === 'done') {
    planResult = readPlanCandidate({ project, bootstrapTask: bTask, config, pkgRoot });
  }
  const { parts, syncedFromPlan } = resolveEffectiveParts(project, planResult, clientById, {
    config,
    pkgRoot,
    taskMap,
    skipAutoApplyDeltas,
  });
  const usedCodes = new Set(parts.map((p) => resolvePartCode(p)));
  const materializedParts = parts.map((p) => {
    const copy = { ...p };
    const eTask = copy.enrichment_task_id ? (taskMap.get(copy.enrichment_task_id) || null) : null;
    if (eTask && eTask.state === 'done' && copy.enrichment_applied_task_id !== eTask.id) {
      const enrichRes = readEnrichmentResultCandidate({ project, part: copy, enrichTask: eTask, config, pkgRoot });
      if (enrichRes.status === 'loaded' && enrichRes.data) {
        return applyEnrichmentResultToPart(copy, enrichRes.data, {
          existingCodes: usedCodes,
          clientById,
          taskId: eTask.id,
          workspaceDir: project.workspace_dir || null,
        });
      }
      copy.enrichment_status = 'failed';
      copy.enrichment_error = enrichRes.error || '补全结果校验失败';
    }
    return copy;
  });
  const nextProject = {
    ...project,
    parts: materializedParts,
  };
  if (syncedFromPlan && planResult?.status === 'loaded') {
    nextProject.plan_snapshot = planResult.plan;
    nextProject.plan_source_path = planResult.path;
    nextProject.summary = planResult.plan.summary || nextProject.summary || '';
    nextProject.bootstrap_synced_task_id = project.bootstrap_task_id || null;
    nextProject.parts_initialized = true;
  }
  return { nextProject, planResult, taskMap };
}

function loadProjectForWrite(projectId, rootDir) {
  if (!SAFE_PROJECT_ID_RE.test(String(projectId || ''))) {
    throw makeHttpError(400, 'invalid_project_id', `非法项目 id: ${projectId}`);
  }
  const store = readProjectsStore(rootDir);
  if (store.broken) {
    throw makeHttpError(422, 'corrupted_projects_config', `projects.json 已损坏，拒绝写入：${store.error}`);
  }
  const idx = store.projects.findIndex((p) => p.id === projectId);
  if (idx < 0) {
    throw makeHttpError(404, 'project_not_found', `找不到项目: ${projectId}`);
  }
  return { store, idx, project: store.projects[idx] };
}

export async function retryProjectBootstrap({
  projectId,
  body = {},
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body || {}, ALLOWED_RETRY_BOOTSTRAP_KEYS, '重试拆解请求体');
  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);

  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const nextMainAgent = body.main_agent !== undefined ? body.main_agent : project.main_agent;
  const nextMainModel = body.main_model !== undefined ? body.main_model : (project.main_model || '');
  const { agent: mainAgent, model: mainModel } = validateAgentAndModel({
    agent: nextMainAgent,
    model: nextMainModel,
    clientById,
    knownSet,
    allowEmptyAgent: false,
  });

  const autoDispatch = body.auto_dispatch !== false;
  const forceNew = body.force_new === true;
  const explicitWaitS = body.wait_s !== undefined && body.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS
    ? Math.max(1, Math.min(600, Number(body.wait_s)))
    : 3;

  const taskMapBefore = readTasksByIdsReadOnly(config, project.bootstrap_task_id ? [project.bootstrap_task_id] : []);
  const prevTask = project.bootstrap_task_id ? taskMapBefore.get(project.bootstrap_task_id) : null;
  const canReuseOpenTask = Boolean(
    !forceNew &&
    prevTask &&
    prevTask.state === 'open' &&
    prevTask.to === mainAgent
  );

  const dispatchable = isAgentDispatchable(mainAgent, env);
  const bus = openBus({ config });
  let taskId;
  let createdUri = null;
  let reused = false;
  let disp = { dispatchResult: null, dispatchError: null, dispatched: false };

  try {
    if (canReuseOpenTask) {
      taskId = prevTask.id;
      reused = true;
    } else {
      const installedAgents = (setup.clients || []).filter((c) => c.installed);
      const bootstrapGoal = buildBootstrapGoal({
        projectId: project.id,
        name: project.name,
        goal: project.goal,
        mainAgent,
        mainModel,
        planRelPath: project.plan_rel_path,
        installedAgents,
      });
      const created = createTask(bus, {
        to: mainAgent,
        from: 'ui',
        goal: bootstrapGoal,
        constraints: [
          `必须产出合法 ${PROJECT_PLAN_SCHEMA} JSON 到 ${project.plan_rel_path} 并作为 bus_task_complete 的 result_path。`,
          '所有 paths 必须为相对项目路径，禁止绝对路径或 .. 越界。',
        ],
        acceptance: {
          json: 'true',
          schema: PROJECT_PLAN_SCHEMA,
          project_id: project.id,
        },
      });
      taskId = created.id;
      createdUri = created.uri;
    }

    if (autoDispatch && dispatchable) {
      disp = await runDispatchWithGuard(bus, dispatchFn, {
        taskId,
        pkgRoot: project.workspace_dir || pkgRoot,
        waitS,
        config,
        toAgent: mainAgent,
        explicitWaitS,
        env,
      });
    }
  } finally {
    bus.close();
  }

  const now = new Date().toISOString();
  const nextProject = {
    ...project,
    main_agent: mainAgent,
    main_model: mainModel,
    bootstrap_task_id: taskId,
    bootstrap_dispatch_requested: autoDispatch && dispatchable,
    bootstrap_dispatched: disp.dispatched,
    bootstrap_dispatch_error: disp.dispatchError,
    bootstrap_history: [
      ...(Array.isArray(project.bootstrap_history) ? project.bootstrap_history : []),
      {
        task_id: taskId,
        to: mainAgent,
        created_at: now,
        reused,
        dispatch_requested: autoDispatch && dispatchable,
        dispatched: disp.dispatched,
        dispatch_error: disp.dispatchError,
        awaiting_main_agent: !dispatchable,
      },
    ],
    updated_at: now,
  };

  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const taskMapAfter = readTasksByIdsReadOnly(config, collectProjectTaskIds([nextProject]));
  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap: taskMapAfter, env });

  return {
    ok: true,
    reused,
    awaiting_main_agent: Boolean(hydrated.bootstrap_task.awaiting_main_agent),
    project: hydrated,
    bootstrap_task: {
      id: taskId,
      to: mainAgent,
      state: hydrated.bootstrap_task.state,
      ...(createdUri ? { uri: createdUri } : {}),
      awaiting_main_agent: Boolean(hydrated.bootstrap_task.awaiting_main_agent),
      dispatch_requested: autoDispatch && dispatchable,
      dispatched: disp.dispatched,
      dispatch_error: disp.dispatchError,
      dispatch_command: hydrated.bootstrap_task.dispatch_command,
    },
  };
}

function buildEnrichPartGoal({ project, part, enrichRelPath, installedAgents, workspaceDir }) {
  const ph = isPlainObject(part.enrichment_placeholders) ? part.enrichment_placeholders : {};
  const agentList = (installedAgents || []).map((a) => a.id).join(', ') || project.main_agent;
  const fixedFields = [];
  if (part.title) fixedFields.push(`title: "${part.title}"`);
  if (!ph.code && part.code) fixedFields.push(`code: "${part.code}"`);
  if (!ph.group && part.group) fixedFields.push(`group: "${part.group}"`);
  if (!ph.goal && part.goal) fixedFields.push(`goal: "${part.goal}"`);
  if (Array.isArray(part.paths) && part.paths.length > 0) fixedFields.push(`paths: ${JSON.stringify(part.paths)}`);
  if (Array.isArray(part.acceptance) && part.acceptance.length > 0) fixedFields.push(`acceptance: ${JSON.stringify(part.acceptance)}`);
  if (part.manual_override && part.agent) fixedFields.push(`agent: "${part.agent}"`);
  if (part.manual_override && part.model) fixedFields.push(`model: "${part.model}"`);

  const enrichExample = JSON.stringify({
    schema: PART_ENRICH_SCHEMA,
    project_id: project.id,
    part_key: part.key,
    code: part.code || 'MOD_01',
    group: part.group === 'debug' ? 'debug' : 'dev',
    goal: '补全该任务卡片的具体实现目标与边界',
    paths: ['src/example.js'],
    acceptance: ['关键逻辑可运行且通过对应测试'],
    agent: part.agent || project.main_agent,
    model: part.model || '',
  }, null, 2);

  return [
    `# 任务卡片自动补全：${project.name} / ${part.title} (${part.key})`,
    '',
    `- project_id: \`${project.id}\``,
    `- project_name: ${project.name}`,
    `- part_key: \`${part.key}\``,
    `- 当前标题: ${part.title}`,
    `- 当前代号 (code): \`${part.code || ''}\`${ph.code ? ' (占位可优化)' : ' (已指定，勿覆盖)'}`,
    `- 当前分组 (group): \`${part.group === 'debug' ? 'debug' : 'dev'}\`${ph.group ? ' (自动推断，可按职责调整 dev/debug)' : ' (已指定，勿覆盖)'}`,
    `- 工作目录: \`${workspaceDir}\``,
    `- 本机已安装可用 Agent: ${agentList}`,
    `- 建议结果 JSON 输出路径 (相对工作目录): \`${enrichRelPath}\``,
    '',
    '## 所属项目总目标',
    project.goal || '无',
    '',
    '## 已有字段（补全时保留用户已填或手动覆盖项）',
    ...(fixedFields.length > 0 ? fixedFields.map((f) => `- ${f}`) : ['- 仅提供标题']),
    '',
    '## 交付要求（必须遵守）',
    '1. 需补全字段：`code`、`group`（`dev` 或 `debug`）、`goal`、`paths`（相对路径数组）、`acceptance`（验收条件数组）、`agent`（须为本机已安装 Agent）、`model`。',
    `2. **只能补全该卡片 (\`${part.key}\`)**，不得修改或重写项目中其他无关卡片或 \`plan.json\`。`,
    `3. 结果必须为合法 UTF-8 JSON（建议 schema \`${PART_ENRICH_SCHEMA}\`），至少包含上述字段；调用 \`bus_task_complete\` 时 \`result_path\` 必须是该 JSON 文件。`,
    '',
    '## JSON 示例',
    '```json',
    enrichExample,
    '```',
  ].join('\n');
}

async function createAndMaybeDispatchEnrichmentTask({
  project,
  part,
  bus,
  config,
  pkgRoot,
  clientById,
  knownSet,
  installedAgents,
  autoDispatch = true,
  waitS = 3,
  explicitWaitS = false,
  dispatchFn = dispatchTask,
  env = process.env,
  isRetry = false,
}) {
  let validatedMain;
  try {
    validatedMain = validateAgentAndModel({
      agent: project.main_agent,
      model: project.main_model || '',
      clientById,
      knownSet,
      allowEmptyAgent: false,
    });
  } catch (err) {
    return {
      ok: false,
      created: null,
      dispatch: { dispatchResult: null, dispatchError: err.message, dispatched: false },
      awaitingMainAgent: false,
      status: 'failed',
      error: err.message,
    };
  }

  const mainAgent = validatedMain.agent;
  const workspaceDir = project.workspace_dir || pkgRoot;
  const enrichRelPath = `out/projects/${project.id}/enrich_${part.key}.json`;
  const goal = buildEnrichPartGoal({
    project,
    part,
    enrichRelPath,
    installedAgents,
    workspaceDir,
  });

  const retrySeq = Number(part.enrichment_retry_count || 0);
  const idempKey = isRetry
    ? `enrich:${project.id}:${part.key}:retry:${retrySeq + 1}`
    : `enrich:${project.id}:${part.key}`;

  const created = createTask(bus, {
    to: mainAgent,
    from: 'ui',
    goal,
    constraints: [
      `仅补全卡片 ${part.key}，不得重写无关卡片或覆盖项目 plan.json。`,
      `结果必须为合法 JSON（建议 schema ${PART_ENRICH_SCHEMA}），包含 code、group、goal、paths、acceptance、agent、model 字段；所有 paths 必须为相对路径。`,
    ],
    acceptance: { json: 'true' },
    idempotency_key: idempKey,
  });

  const dispatchable = isAgentDispatchable(mainAgent, env);
  let disp = { dispatchResult: null, dispatchError: null, dispatched: false };
  if (autoDispatch && dispatchable) {
    disp = await runDispatchWithGuard(bus, dispatchFn, {
      taskId: created.id,
      pkgRoot: workspaceDir,
      waitS,
      config,
      toAgent: mainAgent,
      explicitWaitS,
      env,
    });
  }

  const now = new Date().toISOString();
  part.enrichment_task_id = created.id;
  part.enrichment_status = 'pending';
  part.enrichment_error = disp.dispatchError || null;
  part.enrichment_applied_task_id = null;
  if (isRetry) {
    part.enrichment_retry_count = retrySeq + 1;
  }
  part.enrichment_dispatch = {
    at: now,
    to: mainAgent,
    dispatch_requested: autoDispatch && dispatchable,
    dispatched: disp.dispatched,
    dispatch_error: disp.dispatchError,
    awaiting_main_agent: !dispatchable,
  };

  return {
    ok: !disp.dispatchError,
    created,
    dispatch: disp,
    awaitingMainAgent: !dispatchable,
    status: 'pending',
    error: disp.dispatchError || null,
  };
}

export async function syncProjectPlan({
  projectId,
  body = {},
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body || {}, ALLOWED_SYNC_PLAN_KEYS, '同步拆解计划请求体');
  const force = body?.force === true;
  if (body?.auto_dispatch !== undefined && typeof body.auto_dispatch !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'auto_dispatch 必须是布尔值');
  }
  const autoDispatch = body?.auto_dispatch !== false;
  const explicitWaitS = body?.wait_s !== undefined && body?.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS ? Math.max(1, Math.min(600, Number(body.wait_s))) : 3;

  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);
  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));
  const installedAgents = (setup.clients || []).filter((c) => c.installed);
  const taskMap = readTasksByIdsReadOnly(config, collectProjectTaskIds([project]));
  const bTask = project.bootstrap_task_id ? taskMap.get(project.bootstrap_task_id) : null;

  if (!bTask || bTask.state !== 'done') {
    throw makeHttpError(409, 'bootstrap_not_done', `拆解任务尚未完成 (state=${bTask?.state || 'missing'})，无法同步 plan`);
  }

  const planResult = readPlanCandidate({ project, bootstrapTask: bTask, config, pkgRoot });
  if (planResult.status !== 'loaded') {
    throw makeHttpError(422, planResult.code || 'invalid_plan', planResult.error || '未找到有效的 project-plan@1');
  }

  const planParts = planResult.plan.parts.map((pp) =>
    buildWorkingPartFromPlanPart(pp, clientById, { workspaceDir: project.workspace_dir || null })
  );
  let nextParts;
  const newlyAddedKeys = new Set();
  if (force || !project.parts_initialized) {
    const planKeys = new Set(planParts.map((p) => p.key));
    const preservedManual = force ? [] : (project.parts || []).filter((p) => p && !planKeys.has(p.key));
    for (const pp of planParts) newlyAddedKeys.add(pp.key);
    nextParts = [...planParts, ...preservedManual];
  } else {
    const existingByKey = new Map((project.parts || []).map((p) => [p.key, p]));
    nextParts = [...(project.parts || [])];
    for (const pp of planParts) {
      if (!existingByKey.has(pp.key)) {
        newlyAddedKeys.add(pp.key);
        nextParts.push(pp);
      }
    }
  }

  const autoEnrich = project.auto_enrich !== false;
  if (autoEnrich) {
    const needEnrichParts = nextParts.filter(
      (pt) => newlyAddedKeys.has(pt.key) && !pt.enrichment_task_id && needsEnrichmentForDecomposed(pt)
    );
    if (needEnrichParts.length > 0) {
      const bus = openBus({ config });
      try {
        for (const pt of needEnrichParts) {
          await createAndMaybeDispatchEnrichmentTask({
            project,
            part: pt,
            bus,
            config,
            pkgRoot,
            clientById,
            knownSet,
            installedAgents,
            autoDispatch,
            waitS,
            explicitWaitS,
            dispatchFn,
            env,
            isRetry: false,
          });
        }
      } finally {
        bus.close();
      }
    }
  }

  const now = new Date().toISOString();
  const nextProject = {
    ...project,
    summary: planResult.plan.summary || project.summary || '',
    plan_snapshot: planResult.plan,
    plan_source_path: planResult.path,
    bootstrap_synced_task_id: project.bootstrap_task_id || null,
    parts_initialized: true,
    parts: nextParts,
    updated_at: now,
  };

  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const taskMapAfter = readTasksByIdsReadOnly(config, collectProjectTaskIds([nextProject]));
  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap: taskMapAfter, env });
  return { ok: true, project: hydrated };
}

export async function addProjectPart({
  projectId,
  body,
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body, ALLOWED_ADD_PART_KEYS, '新增部分卡片请求体');
  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);

  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));
  const installedAgents = (setup.clients || []).filter((c) => c.installed);

  const { nextProject, taskMap } = materializePartsForMutation(project, { config, pkgRoot, clientById });

  let idempotencyKey = null;
  if (body.idempotency_key !== undefined && body.idempotency_key !== null && String(body.idempotency_key).trim()) {
    idempotencyKey = String(body.idempotency_key).trim();
    if (idempotencyKey.length > 128) {
      throw makeHttpError(400, 'invalid_idempotency_key', 'idempotency_key 不得超过 128 字符');
    }
    const existingByIdemp = nextProject.parts.find((p) => p && p.add_idempotency_key === idempotencyKey);
    if (existingByIdemp) {
      const hydratedExisting = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap, env });
      const hydratedPart = hydratedExisting.parts.find((p) => p.key === existingByIdemp.key);
      return {
        ok: true,
        idempotent: true,
        created: false,
        part: hydratedPart,
        enrichment_task_id: hydratedPart?.enrichment_task_id || null,
        enrichment_status: hydratedPart?.enrichment_status || null,
        awaiting_main_agent: hydratedPart?.enrichment_task?.awaiting_main_agent || false,
        enrichment_task: hydratedPart?.enrichment_task || null,
        project: hydratedExisting,
      };
    }
  }

  if (nextProject.parts.length >= MAX_PARTS_PER_PROJECT) {
    throw makeHttpError(400, 'too_many_parts', `单个项目最多允许 ${MAX_PARTS_PER_PROJECT} 张部分卡片`);
  }

  if (body.auto_enrich !== undefined && typeof body.auto_enrich !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'auto_enrich 必须是布尔值');
  }
  if (body.auto_dispatch !== undefined && typeof body.auto_dispatch !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'auto_dispatch 必须是布尔值');
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 120) {
    throw makeHttpError(400, 'invalid_part_title', '部分标题必填且不超过 120 字符');
  }
  if (body.goal !== undefined && body.goal !== null && typeof body.goal !== 'string') {
    throw makeHttpError(400, 'invalid_part_goal', '部分目标必须是字符串');
  }
  const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
  if (goal.length > 4000) {
    throw makeHttpError(400, 'invalid_part_goal', '部分目标不能超过 4000 字符');
  }

  let key = typeof body.key === 'string' && body.key.trim()
    ? body.key.trim()
    : `part_${randomBytes(3).toString('hex')}`;
  if (!SAFE_ID_RE.test(key)) {
    throw makeHttpError(400, 'invalid_part_key', `part key 格式非法: ${key}`);
  }
  if (nextProject.parts.some((p) => p.key === key)) {
    throw makeHttpError(409, 'duplicate_part_key', `项目中已存在相同 part key: ${key}`);
  }

  const categoryProvided = typeof body.category === 'string' && Boolean(body.category.trim());
  const category = categoryProvided ? body.category.trim() : 'general';
  if (category.length > 64 || /[\r\n\0]/.test(category)) {
    throw makeHttpError(400, 'invalid_part_category', 'category 长度不能超过 64 且不能含控制字符');
  }
  const groupProvided = body.group !== undefined && body.group !== null;
  const group = groupProvided
    ? normalizePartGroupInput(body.group, { required: true })
    : inferPartGroup({ category, title, goal });

  const existingCodes = new Set(nextProject.parts.map((p) => resolvePartCode(p)));
  const explicitCode = normalizePartCodeInput(body.code, { required: false });
  if (explicitCode && existingCodes.has(explicitCode)) {
    throw makeHttpError(400, 'duplicate_part_code', `项目中已存在相同模块代号 code: ${explicitCode}`);
  }
  const code = explicitCode || defaultPartCode(key, existingCodes);

  const paths = normalizeRelativePaths(body.paths);
  const acceptance = normalizeTextList(body.acceptance, { fieldName: 'acceptance' });
  const dependsOn = normalizeDependsOn(body.depends_on).filter((d) => d !== key);

  const { agent, model } = validateAgentAndModel({
    agent: body.agent || '',
    model: body.model || '',
    clientById,
    knownSet,
    allowEmptyAgent: true,
  });

  const explicitManual = body.manual_override !== undefined
    ? Boolean(body.manual_override)
    : Boolean(agent || model);

  const rawImplStatus = typeof body.implementation_status === 'string' ? body.implementation_status.trim().toLowerCase() : '';
  const implStatus = VALID_PART_STATUSES.has(rawImplStatus) ? rawImplStatus : 'planned';

  const effectiveAutoEnrich = body.auto_enrich !== undefined
    ? body.auto_enrich
    : (nextProject.auto_enrich !== false);
  const autoDispatch = body.auto_dispatch !== false;
  const explicitWaitS = body.wait_s !== undefined && body.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS ? Math.max(1, Math.min(600, Number(body.wait_s))) : 3;

  const newPart = {
    key,
    code,
    title,
    category,
    group,
    goal,
    paths,
    existing_paths: [],
    missing_paths: [],
    implementation_status: implStatus,
    scan_evidence: '',
    acceptance,
    agent,
    model,
    depends_on: dependsOn,
    suggested_agent: null,
    suggested_model: null,
    agent_warning: null,
    source: 'manual',
    manual_override: explicitManual,
    matched_rule_id: null,
    matched_rule_name: null,
    matched_by: explicitManual ? 'manual_override' : null,
    assignment_source: agent ? 'manual' : 'unassigned',
    task_id: null,
    task_history: [],
    regenerate_count: 0,
    last_dispatch: null,
    ...(idempotencyKey ? { add_idempotency_key: idempotencyKey } : {}),
    enrichment_task_id: null,
    enrichment_status: effectiveAutoEnrich ? 'pending' : 'skipped',
    enrichment_error: null,
    enrichment_dispatch: null,
    enrichment_retry_count: 0,
    enrichment_applied_task_id: null,
    enrichment_placeholders: {
      title: false,
      code: !explicitCode,
      category: !categoryProvided,
      group: !groupProvided,
      goal: !goal,
      paths: paths.length === 0,
      acceptance: acceptance.length === 0,
      depends_on: dependsOn.length === 0,
      implementation_status: !rawImplStatus,
      agent: !agent && !explicitManual,
      model: !model && !explicitManual,
    },
  };

  let enrichMeta = null;
  if (effectiveAutoEnrich) {
    const bus = openBus({ config });
    try {
      enrichMeta = await createAndMaybeDispatchEnrichmentTask({
        project: nextProject,
        part: newPart,
        bus,
        config,
        pkgRoot,
        clientById,
        knownSet,
        installedAgents,
        autoDispatch,
        waitS,
        explicitWaitS,
        dispatchFn,
        env,
        isRetry: false,
      });
      if (!enrichMeta.created) {
        newPart.enrichment_status = 'failed';
        newPart.enrichment_error = enrichMeta.error || '创建补全任务失败';
      }
    } finally {
      bus.close();
    }
  }

  nextProject.parts.push(newPart);
  nextProject.parts_initialized = true;
  nextProject.updated_at = new Date().toISOString();

  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const taskMapAfter = readTasksByIdsReadOnly(config, collectProjectTaskIds([nextProject]));
  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap: taskMapAfter, env });
  const hydratedPart = hydrated.parts.find((p) => p.key === key);
  return {
    ok: true,
    created: true,
    idempotent: false,
    part: hydratedPart,
    enrichment_task_id: hydratedPart?.enrichment_task_id || null,
    enrichment_status: hydratedPart?.enrichment_status || null,
    awaiting_main_agent: Boolean(enrichMeta?.awaitingMainAgent || hydratedPart?.enrichment_task?.awaiting_main_agent),
    enrichment_task: hydratedPart?.enrichment_task || null,
    project: hydrated,
  };
}

export async function enrichProjectPart({
  projectId,
  partKey,
  body = {},
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body || {}, ALLOWED_ENRICH_PART_KEYS, '补全卡片请求体');
  if (!SAFE_ID_RE.test(String(partKey || ''))) {
    throw makeHttpError(400, 'invalid_part_key', `非法 part key: ${partKey}`);
  }
  if (body?.auto_dispatch !== undefined && typeof body.auto_dispatch !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'auto_dispatch 必须是布尔值');
  }
  const force = body?.force === true;

  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);
  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));
  const installedAgents = (setup.clients || []).filter((c) => c.installed);

  const { nextProject, taskMap } = materializePartsForMutation(project, { config, pkgRoot, clientById });
  const pIdx = nextProject.parts.findIndex((p) => p.key === partKey);
  if (pIdx < 0) {
    throw makeHttpError(404, 'part_not_found', `项目中找不到部分卡片: ${partKey}`);
  }

  const part = nextProject.parts[pIdx];
  const existingTask = part.enrichment_task_id ? (taskMap.get(part.enrichment_task_id) || null) : null;

  if (existingTask && (existingTask.state === 'open' || existingTask.state === 'claimed')) {
    const hydratedExisting = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap, env });
    const hydratedPart = hydratedExisting.parts.find((p) => p.key === partKey);
    return {
      ok: true,
      idempotent: true,
      created: false,
      project_id: nextProject.id,
      part_key: partKey,
      enrichment_task_id: existingTask.id,
      enrichment_status: hydratedPart?.enrichment_status || 'pending',
      awaiting_main_agent: Boolean(hydratedPart?.enrichment_task?.awaiting_main_agent),
      task: hydratedPart?.enrichment_task || null,
      part: hydratedPart,
      project: hydratedExisting,
    };
  }

  if (!force && existingTask && existingTask.state === 'done' && part.enrichment_status === 'done') {
    const hydratedExisting = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap, env });
    const hydratedPart = hydratedExisting.parts.find((p) => p.key === partKey);
    return {
      ok: true,
      idempotent: true,
      created: false,
      project_id: nextProject.id,
      part_key: partKey,
      enrichment_task_id: existingTask.id,
      enrichment_status: 'done',
      awaiting_main_agent: false,
      task: hydratedPart?.enrichment_task || null,
      part: hydratedPart,
      project: hydratedExisting,
    };
  }

  const autoDispatch = body?.auto_dispatch !== false;
  const explicitWaitS = body?.wait_s !== undefined && body?.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS ? Math.max(1, Math.min(600, Number(body.wait_s))) : 3;

  const bus = openBus({ config });
  let enrichMeta;
  try {
    enrichMeta = await createAndMaybeDispatchEnrichmentTask({
      project: nextProject,
      part,
      bus,
      config,
      pkgRoot,
      clientById,
      knownSet,
      installedAgents,
      autoDispatch,
      waitS,
      explicitWaitS,
      dispatchFn,
      env,
      isRetry: Boolean(existingTask),
    });
    if (!enrichMeta.created) {
      part.enrichment_status = 'failed';
      part.enrichment_error = enrichMeta.error || '创建补全任务失败';
    }
  } finally {
    bus.close();
  }

  nextProject.parts[pIdx] = part;
  nextProject.parts_initialized = true;
  nextProject.updated_at = new Date().toISOString();

  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const taskMapAfter = readTasksByIdsReadOnly(config, collectProjectTaskIds([nextProject]));
  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap: taskMapAfter, env });
  const hydratedPart = hydrated.parts.find((p) => p.key === partKey);

  return {
    ok: Boolean(enrichMeta.created && !enrichMeta.dispatch?.dispatchError),
    idempotent: Boolean(enrichMeta.created?.dedup),
    created: Boolean(enrichMeta.created && !enrichMeta.created.dedup),
    project_id: nextProject.id,
    part_key: partKey,
    enrichment_task_id: hydratedPart?.enrichment_task_id || null,
    enrichment_status: hydratedPart?.enrichment_status || part.enrichment_status,
    awaiting_main_agent: Boolean(enrichMeta.awaitingMainAgent),
    task: hydratedPart?.enrichment_task || null,
    part: hydratedPart,
    project: hydrated,
  };
}

export async function reconcileProjectEnrichment({
  projectId,
  body = {},
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body || {}, ALLOWED_SYNC_PLAN_KEYS, '同步补全请求体');
  const autoDispatch = body?.auto_dispatch !== false;
  const explicitWaitS = body?.wait_s !== undefined && body?.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS ? Math.max(1, Math.min(600, Number(body.wait_s))) : 3;

  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);
  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));
  const installedAgents = (setup.clients || []).filter((c) => c.installed);

  const { nextProject, taskMap } = materializePartsForMutation(project, { config, pkgRoot, clientById });
  const triggeredKeys = [];

  if (nextProject.auto_enrich !== false) {
    const candidates = nextProject.parts.filter(
      (pt) => !pt.enrichment_task_id && pt.enrichment_status !== 'skipped' && pt.enrichment_status !== 'done' && needsEnrichmentForDecomposed(pt)
    );
    if (candidates.length > 0) {
      const bus = openBus({ config });
      try {
        for (const pt of candidates) {
          const meta = await createAndMaybeDispatchEnrichmentTask({
            project: nextProject,
            part: pt,
            bus,
            config,
            pkgRoot,
            clientById,
            knownSet,
            installedAgents,
            autoDispatch,
            waitS,
            explicitWaitS,
            dispatchFn,
            env,
            isRetry: false,
          });
          if (meta.created) triggeredKeys.push(pt.key);
        }
      } finally {
        bus.close();
      }
    }
  }

  nextProject.parts_initialized = true;
  nextProject.updated_at = new Date().toISOString();
  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const taskMapAfter = readTasksByIdsReadOnly(config, collectProjectTaskIds([nextProject]));
  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap: taskMapAfter, env });
  return {
    ok: true,
    triggered_keys: triggeredKeys,
    project: hydrated,
  };
}

export function updateProjectPart({
  projectId,
  partKey,
  body,
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  assertAllowedKeys(body, ALLOWED_PART_KEYS, '编辑部分卡片请求体');
  if (!SAFE_ID_RE.test(String(partKey || ''))) {
    throw makeHttpError(400, 'invalid_part_key', `非法 part key: ${partKey}`);
  }
  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);

  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const { nextProject, taskMap } = materializePartsForMutation(project, { config, pkgRoot, clientById });
  const pIdx = nextProject.parts.findIndex((p) => p.key === partKey);
  if (pIdx < 0) {
    throw makeHttpError(404, 'part_not_found', `项目中找不到部分卡片: ${partKey}`);
  }

  const cur = nextProject.parts[pIdx];
  const updated = { ...cur };
  const nextPlaceholders = isPlainObject(cur.enrichment_placeholders)
    ? { ...cur.enrichment_placeholders }
    : {};

  if (body.title !== undefined) {
    const t = typeof body.title === 'string' ? body.title.trim() : '';
    if (!t || t.length > 120) {
      throw makeHttpError(400, 'invalid_part_title', '部分标题必填且不超过 120 字符');
    }
    updated.title = t;
    nextPlaceholders.title = false;
  }
  if (body.category !== undefined) {
    const c = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : 'general';
    if (c.length > 64 || /[\r\n\0]/.test(c)) {
      throw makeHttpError(400, 'invalid_part_category', 'category 非法');
    }
    updated.category = c;
    nextPlaceholders.category = false;
  }
  if (body.group !== undefined) {
    updated.group = normalizePartGroupInput(body.group, { required: true });
    nextPlaceholders.group = false;
  } else if (!VALID_PART_GROUPS.has(updated.group)) {
    updated.group = 'dev';
  }
  if (body.code !== undefined) {
    const nextCode = normalizePartCodeInput(body.code, { required: true });
    const otherCodes = new Set(
      nextProject.parts.filter((p) => p.key !== partKey).map((p) => resolvePartCode(p))
    );
    if (otherCodes.has(nextCode)) {
      throw makeHttpError(400, 'duplicate_part_code', `项目中已存在相同模块代号 code: ${nextCode}`);
    }
    updated.code = nextCode;
    nextPlaceholders.code = false;
  } else if (!updated.code) {
    updated.code = resolvePartCode(cur);
  }
  if (body.goal !== undefined) {
    if (body.goal !== null && typeof body.goal !== 'string') {
      throw makeHttpError(400, 'invalid_part_goal', '部分目标必须是字符串');
    }
    const g = typeof body.goal === 'string' ? body.goal.trim() : '';
    if (g.length > 4000) {
      throw makeHttpError(400, 'invalid_part_goal', '部分目标不能超过 4000 字符');
    }
    if (!g && cur.enrichment_status !== 'pending' && String(cur.goal || '').trim()) {
      throw makeHttpError(400, 'invalid_part_goal', '部分目标必填且不超过 4000 字符');
    }
    updated.goal = g;
    if (g) nextPlaceholders.goal = false;
  }
  if (body.paths !== undefined) {
    updated.paths = normalizeRelativePaths(body.paths);
    nextPlaceholders.paths = false;
  }
  if (body.acceptance !== undefined) {
    updated.acceptance = normalizeTextList(body.acceptance, { fieldName: 'acceptance' });
    nextPlaceholders.acceptance = false;
  }
  if (body.depends_on !== undefined) {
    updated.depends_on = normalizeDependsOn(body.depends_on).filter((d) => d !== partKey);
    nextPlaceholders.depends_on = false;
  }
  if (body.implementation_status !== undefined) {
    const st = String(body.implementation_status || '').trim().toLowerCase();
    if (!VALID_PART_STATUSES.has(st)) {
      throw makeHttpError(400, 'invalid_field', `非法 implementation_status: ${st}`);
    }
    updated.implementation_status = st;
    nextPlaceholders.implementation_status = false;
  }

  const agentTouched = body.agent !== undefined;
  const modelTouched = body.model !== undefined;
  if (agentTouched || modelTouched) {
    const nextAgentRaw = agentTouched ? (body.agent || '') : (cur.agent || '');
    // If agent changed and model wasn't explicitly passed, clear model to avoid mismatch
    const nextModelRaw = modelTouched
      ? (body.model || '')
      : (agentTouched && nextAgentRaw !== cur.agent ? '' : (cur.model || ''));
    const { agent, model } = validateAgentAndModel({
      agent: nextAgentRaw,
      model: nextModelRaw,
      clientById,
      knownSet,
      allowEmptyAgent: true,
    });
    updated.agent = agent;
    updated.model = model;
    updated.agent_warning = null;
    if (agentTouched) nextPlaceholders.agent = false;
    if (modelTouched) nextPlaceholders.model = false;
    if (body.manual_override !== undefined) {
      updated.manual_override = Boolean(body.manual_override);
    } else {
      updated.manual_override = true;
    }
    if (updated.manual_override) {
      updated.assignment_source = agent ? 'manual' : 'unassigned';
      updated.matched_rule_id = null;
      updated.matched_rule_name = null;
      updated.matched_by = 'manual_override';
    } else {
      updated.assignment_source = agent
        ? (cur.suggested_agent && cur.suggested_agent === agent ? 'plan_suggestion' : 'default')
        : 'unassigned';
      updated.matched_rule_id = null;
      updated.matched_rule_name = null;
      updated.matched_by = null;
    }
  } else if (body.manual_override !== undefined) {
    updated.manual_override = Boolean(body.manual_override);
  }
  updated.enrichment_placeholders = nextPlaceholders;

  nextProject.parts[pIdx] = updated;
  nextProject.parts_initialized = true;
  nextProject.updated_at = new Date().toISOString();

  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap, env });
  return {
    ok: true,
    part: hydrated.parts.find((p) => p.key === partKey),
    project: hydrated,
  };
}

export function deleteProjectPart({
  projectId,
  partKey,
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  if (!SAFE_ID_RE.test(String(partKey || ''))) {
    throw makeHttpError(400, 'invalid_part_key', `非法 part key: ${partKey}`);
  }
  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);
  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const { nextProject, taskMap } = materializePartsForMutation(project, { config, pkgRoot, clientById });
  const beforeLen = nextProject.parts.length;
  nextProject.parts = nextProject.parts
    .filter((p) => p.key !== partKey)
    .map((p) => ({
      ...p,
      depends_on: (p.depends_on || []).filter((d) => d !== partKey),
    }));
  if (nextProject.parts.length === beforeLen) {
    throw makeHttpError(404, 'part_not_found', `项目中找不到部分卡片: ${partKey}`);
  }

  nextProject.parts_initialized = true;
  nextProject.updated_at = new Date().toISOString();

  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap, env });
  return { ok: true, deleted_key: partKey, project: hydrated };
}

export function reorderProjectParts({
  projectId,
  body,
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  assertAllowedKeys(body, ALLOWED_REORDER_KEYS, '卡片排序请求体');
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw makeHttpError(400, 'invalid_keys', 'keys 必须是非空数组');
  }
  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);
  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const { nextProject, taskMap } = materializePartsForMutation(project, { config, pkgRoot, clientById });
  const byKey = new Map(nextProject.parts.map((p) => [p.key, p]));
  const reordered = [];
  const seen = new Set();

  for (const rawKey of body.keys) {
    if (typeof rawKey !== 'string' || !byKey.has(rawKey.trim())) {
      throw makeHttpError(400, 'invalid_part_key', `未知 part key: ${String(rawKey)}`);
    }
    const k = rawKey.trim();
    if (!seen.has(k)) {
      seen.add(k);
      reordered.push(byKey.get(k));
    }
  }
  for (const p of nextProject.parts) {
    if (!seen.has(p.key)) reordered.push(p);
  }

  nextProject.parts = reordered;
  nextProject.parts_initialized = true;
  nextProject.updated_at = new Date().toISOString();

  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap, env });
  return { ok: true, project: hydrated };
}

export function autoRouteProjectParts({
  projectId,
  body = {},
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  assertAllowedKeys(body || {}, ALLOWED_AUTO_ROUTE_KEYS, '自动分配请求体');
  const dryRun = body?.dry_run === true;
  const overwriteManual = body?.overwrite_manual === true;

  const routingCfg = readRoutingConfig(config.rootDir);
  if (routingCfg.broken) {
    throw makeHttpError(422, 'corrupted_routing_config', `路由规则配置已损坏：${routingCfg.error}`);
  }

  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);
  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const { nextProject, taskMap } = materializePartsForMutation(project, { config, pkgRoot, clientById });

  const evaluation = evaluateAutoRouting({
    parts: nextProject.parts,
    rules: routingCfg.rules,
    mainAgent: nextProject.main_agent,
    mainModel: nextProject.main_model || '',
    clientById,
    overwriteManual,
  });

  if (dryRun) {
    const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap, env });
    return {
      ok: true,
      dry_run: true,
      overwrite_manual: overwriteManual,
      ...evaluation,
      project: hydrated,
    };
  }

  const assignByKey = new Map(evaluation.assignments.map((a) => [a.part_key, a]));
  nextProject.parts = nextProject.parts.map((part) => {
    const a = assignByKey.get(part.key);
    if (!a || a.preserved_manual) return part;
    return {
      ...part,
      agent: a.agent,
      model: a.model,
      agent_warning: a.warning || null,
      manual_override: false,
      matched_rule_id: a.matched_rule_id,
      matched_rule_name: a.matched_rule_name,
      matched_by: a.matched_by,
      assignment_source: a.assignment_source,
    };
  });
  nextProject.parts_initialized = true;
  nextProject.updated_at = new Date().toISOString();

  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap, env });
  return {
    ok: true,
    dry_run: false,
    overwrite_manual: overwriteManual,
    ...evaluation,
    project: hydrated,
  };
}

export async function dispatchProjectParts({
  projectId,
  body = {},
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body || {}, ALLOWED_DISPATCH_KEYS, '分派部分任务请求体');
  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);

  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const { nextProject, taskMap } = materializePartsForMutation(project, { config, pkgRoot, clientById });
  if (nextProject.parts.length === 0) {
    throw makeHttpError(400, 'no_parts', '当前项目还没有可分派的部分卡片');
  }

  const autoDispatch = body.auto_dispatch !== false;
  const serial = body.serial === true;
  const explicitWaitS = body.wait_s !== undefined && body.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS
    ? Math.max(1, Math.min(600, Number(body.wait_s)))
    : 3;

  let targetParts;
  if (body.all === true || (body.part_keys === undefined && body.all !== false)) {
    targetParts = nextProject.parts;
  } else {
    if (!Array.isArray(body.part_keys) || body.part_keys.length === 0) {
      throw makeHttpError(400, 'missing_part_keys', '请选择至少一张部分卡片 (part_keys)');
    }
    const byKey = new Map(nextProject.parts.map((p) => [p.key, p]));
    const seen = new Set();
    targetParts = [];
    for (const rawKey of body.part_keys) {
      if (typeof rawKey !== 'string' || !byKey.has(rawKey.trim())) {
        throw makeHttpError(400, 'invalid_part_key', `未知 part key: ${String(rawKey)}`);
      }
      const k = rawKey.trim();
      if (!seen.has(k)) {
        seen.add(k);
        targetParts.push(byKey.get(k));
      }
    }
  }

  const results = [];
  const bus = openBus({ config });
  let createdCount = 0;
  let dispatchedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let queuedCount = 0;
  let serialFirstDispatched = false;
  let serialQueueInfo = null;
  const serialEntries = [];
  const serialFirstKey = serial && autoDispatch
    ? (targetParts.find((part) => {
        const existing = part.task_id ? taskMap.get(part.task_id) : null;
        if (existing && (existing.state === 'open' || existing.state === 'claimed')) return false;
        return isAgentDispatchable(part.agent, env);
      })?.key || null)
    : null;

  try {
    for (const part of targetParts) {
      // Idempotency / active-task protection: do not create duplicate active task for the same part
      const existingTask = part.task_id ? taskMap.get(part.task_id) : null;
      if (existingTask && (existingTask.state === 'open' || existingTask.state === 'claimed')) {
        skippedCount += 1;
        results.push({
          part_key: part.key,
          title: part.title,
          ok: true,
          skipped: true,
          reason: 'active_task_exists',
          message: `该部分已有未完成任务 ${existingTask.id} (state=${existingTask.state}, to=${existingTask.to})，已跳过防重`,
          task_id: existingTask.id,
          to: existingTask.to,
          state: existingTask.state,
        });
        continue;
      }

      // Validate agent & model strictly (cannot bypass uninstalled check)
      let validatedTarget;
      try {
        validatedTarget = validateAgentAndModel({
          agent: part.agent,
          model: part.model || '',
          clientById,
          knownSet,
          allowEmptyAgent: false,
        });
      } catch (err) {
        errorCount += 1;
        results.push({
          part_key: part.key,
          title: part.title,
          ok: false,
          skipped: false,
          code: err.errorCode || 'invalid_agent',
          error: err.message,
        });
        continue;
      }

      const partGoal = buildPartTaskGoal({ project: nextProject, part: { ...part, ...validatedTarget } });
      const round = (Array.isArray(part.task_history) ? part.task_history.length : 0) + 1;
      const created = createTask(bus, {
        to: validatedTarget.agent,
        from: 'ui',
        goal: partGoal,
        constraints: [
          '仅围绕本部分的目标与相对路径开展实现与验证。',
          '完成后提交合法结果 JSON 文件。',
        ],
        acceptance: { json: 'true' },
        idempotency_key: `proj:${nextProject.id}:part:${part.key}:r${round}`,
      });
      createdCount += 1;
      const serialCapable = isAgentDispatchable(validatedTarget.agent, env);
      const isSerialFirst = serial && autoDispatch && part.key === serialFirstKey;
      const isSerialQueued = serial && autoDispatch && serialFirstKey !== null && !isSerialFirst && serialCapable;
      const isSerialUnavailable = serial && autoDispatch && !serialCapable;
      const dispatchCwd = nextProject.workspace_dir || pkgRoot;

      let disp = { dispatchResult: null, dispatchError: null, dispatched: false, queued: false };
      if (autoDispatch) {
        if (isSerialUnavailable) {
          disp = {
            dispatchResult: null,
            dispatchError: `没有 ${validatedTarget.agent} 的调用适配器，无法进入串行队列`,
            dispatched: false,
            queued: false,
          };
        } else if (isSerialQueued) {
          queuedCount += 1;
          disp = {
            dispatchResult: {
              id: created.id,
              to: validatedTarget.agent,
              state: 'queued',
              dispatched: false,
              queued: true,
            },
            dispatchError: null,
            dispatched: false,
            queued: true,
          };
          serialEntries.push({
            taskId: created.id,
            to: validatedTarget.agent,
            cwd: dispatchCwd,
            queuePosition: queuedCount,
          });
        } else {
          disp = await runDispatchWithGuard(bus, dispatchFn, {
            taskId: created.id,
            pkgRoot: dispatchCwd,
            waitS,
            config,
            toAgent: validatedTarget.agent,
            explicitWaitS,
            env,
          });
          if (isSerialFirst && disp.dispatched) {
            serialFirstDispatched = true;
            serialEntries.push({
              taskId: created.id,
              to: validatedTarget.agent,
              cwd: dispatchCwd,
              queuePosition: 0,
              initialState: disp.dispatchResult?.state || created.state,
            });
          }
        }
      }
      if (disp.dispatched) dispatchedCount += 1;
      if (disp.dispatchError) errorCount += 1;

      const now = new Date().toISOString();
      const finalState = disp.dispatchResult?.state || created.state;
      part.task_id = created.id;
      part.task_history = [
        ...(Array.isArray(part.task_history) ? part.task_history : []),
        {
          task_id: created.id,
          to: validatedTarget.agent,
          model: validatedTarget.model || '',
          created_at: now,
          dispatch_requested: autoDispatch,
          dispatched: disp.dispatched,
          queued: disp.queued === true,
          dispatch_error: disp.dispatchError,
        },
      ];
      part.last_dispatch = {
        at: now,
        task_id: created.id,
        to: validatedTarget.agent,
        dispatch_requested: autoDispatch,
        dispatched: disp.dispatched,
        queued: disp.queued === true,
        queue_position: disp.queued ? queuedCount : null,
        dispatch_error: disp.dispatchError,
      };

      const cmdLine = `node bin/bus.js dispatch ${created.id} --allow-dispatch --root "${config.rootDir}"`;
      results.push({
        part_key: part.key,
        title: part.title,
        ok: !disp.dispatchError,
        skipped: false,
        task_id: created.id,
        to: validatedTarget.agent,
        target_agent: validatedTarget.agent,
        target_model: validatedTarget.model || null,
        state: finalState,
        uri: created.uri,
        dedup: created.dedup,
        dispatch_requested: autoDispatch,
        dispatched: disp.dispatched,
        queued: disp.queued === true,
        queue_position: disp.queued ? queuedCount : null,
        dispatch_command: cmdLine,
        ...(disp.dispatchError ? { dispatch_error: disp.dispatchError } : {}),
        ...(disp.dispatchResult ? { dispatch_result: disp.dispatchResult } : {}),
      });
    }
  } finally {
    bus.close();
  }

  nextProject.parts_initialized = true;
  nextProject.updated_at = new Date().toISOString();
  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  if (serial && autoDispatch && serialFirstDispatched && serialEntries.length > 1) {
    serialQueueInfo = startSerialDispatchQueue({
      config,
      projectId: nextProject.id,
      pkgRoot,
      waitS,
      entries: serialEntries,
      env,
      dispatchFn,
    });
  }

  const taskMapAfter = readTasksByIdsReadOnly(config, collectProjectTaskIds([nextProject]));
  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap: taskMapAfter, env });

  return {
    ok: errorCount === 0,
    project_id: nextProject.id,
    serial: Boolean(serial && autoDispatch),
    serial_queue: serialQueueInfo,
    results,
    summary: {
      requested: targetParts.length,
      created: createdCount,
      dispatched: dispatchedCount,
      queued: queuedCount,
      skipped: skippedCount,
      errors: errorCount,
    },
    project: hydrated,
  };
}

function buildReadExistingScanGoal({ projectId, name, goal, workspaceDir, scan, manifestRelPath, planRelPath, mainAgent, mainModel, installedAgents }) {
  const agentList = (installedAgents || []).map((a) => a.id).join(', ') || mainAgent;
  const manifestLines = (scan.files || []).slice(0, 60).map((f) =>
    `- \`${f.rel_path}\` (${f.bytes}B${f.sha256_short ? `, sha=${f.sha256_short}` : ''})${f.summary ? ` : ${f.summary}` : ''}`
  );
  const detectedLines = (scan.detected_parts || []).map((p) =>
    `- \`${p.key}\` [${p.status}] ${p.title} | paths=${(p.paths || []).join(', ')} | ${p.evidence || ''}`
  );
  const schemaExample = JSON.stringify({
    schema: PROJECT_PLAN_SCHEMA,
    project_id: projectId,
    title: name,
    summary: '项目当前实现状态与后续计划摘要',
    parts: [
      {
        key: 'core_module',
        title: '核心模块',
        category: 'core',
        group: 'dev',
        status: 'existing',
        goal: '已有实现说明与后续优化方向',
        paths: ['src/core.js'],
        acceptance: ['现有测试通过'],
        agent: mainAgent,
        model: '',
        depends_on: [],
        evidence: '实际存在 src/core.js',
      },
    ],
  }, null, 2);

  return [
    `# 读取已有项目并扫描现状：${name}`,
    '',
    `- project_id: \`${projectId}\``,
    `- 本地项目目录: \`${workspaceDir}\``,
    `- 主 Agent (执行方): \`${mainAgent}\``,
    `- 主模型要求: ${mainModel || '沿用当前配置'}`,
    `- 本机已安装可用 Agent: ${agentList}`,
    `- 扫描摘要清单文件: \`${manifestRelPath}\` (共 ${scan.file_count} 文件 / ${scan.total_bytes}B, digest=${scan.manifest_digest})`,
    `- 计划输出路径 (相对工作目录): \`${planRelPath}\``,
    '',
    '## 用户补充目标',
    goal || '基于本地现有文件如实识别已完成/部分完成/缺失模块，生成可执行卡片计划。',
    '',
    '## 初步目录扫描识别的模块',
    ...(detectedLines.length ? detectedLines : ['- （目录为空）']),
    '',
    `## 紧凑文件清单（相对路径 + 大小 + 摘要，前 ${manifestLines.length} 项）`,
    ...(manifestLines.length ? manifestLines : ['- （无文件）']),
    '',
    '## 交付要求（必须遵守）',
    '1. 仅基于真实存在的文件如实标注每个 part 的 `status`: `"existing"`（已实现）、`"partial"`（部分实现/占位）或 `"missing"`（缺失待建）；绝不伪造未实现的功能。',
    '2. 每个 part 可标注 `group`: 功能研发放 `"dev"`（研发组），排查/调试/回归/回传问题放 `"debug"`（调试组）；省略时默认归入研发组。',
    `3. 将结构化结果以合法 UTF-8 JSON 写入 \`${planRelPath}\` 并通过 \`bus_task_complete\` 提交（result_path 指向该文件）。`,
    '4. 所有 `paths` 必须为相对项目路径，禁止绝对路径或 `..` 越界。',
    '',
    '## JSON 契约 (`agentbus/project-plan@1` 含 status)',
    '```json',
    schemaExample,
    '```',
  ].join('\n');
}

export async function readExistingProject({
  body,
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body, ALLOWED_READ_EXISTING_KEYS, '读取已有项目请求体');

  const store = readProjectsStore(config.rootDir);
  if (store.broken) {
    throw makeHttpError(422, 'corrupted_projects_config', `projects.json 已损坏，拒绝写入：${store.error}`);
  }

  const scan = scanWorkspaceDirectory(body.workspace_dir, { config, pkgRoot });
  const workspaceDir = scan.workspace_dir;
  const devMaterialsDir = validateDevMaterialsDirInput(body.dev_materials_dir, { workspaceDir, config, pkgRoot });

  const rawName = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim()
    : scan.name_suggestion;
  if (!rawName || rawName.length > 120 || /[\r\n\0]/.test(rawName)) {
    throw makeHttpError(400, 'invalid_project_name', '项目名称非法或超过 120 字符');
  }
  const goal = typeof body.goal === 'string' && body.goal.trim()
    ? body.goal.trim()
    : (scan.description_suggestion || `读取已有本地项目 ${rawName} 并扫描现状生成部分卡片`);
  if (goal.length > 4000) {
    throw makeHttpError(400, 'invalid_project_goal', '项目目标长度不超过 4000 字符');
  }

  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const defaultMain = resolveDefaultMainAgent(setup);
  const requestedMainAgent = typeof body.main_agent === 'string' && body.main_agent.trim()
    ? body.main_agent.trim()
    : defaultMain;
  if (!requestedMainAgent) {
    throw makeHttpError(400, 'no_installed_agent', '本机未探测到已安装可用的 Agent');
  }

  const { agent: mainAgent, model: mainModel } = validateAgentAndModel({
    agent: requestedMainAgent,
    model: body.main_model || '',
    clientById,
    knownSet,
    allowEmptyAgent: false,
  });

  if (body.auto_dispatch !== undefined && typeof body.auto_dispatch !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'auto_dispatch 必须是布尔值');
  }
  if (body.auto_enrich !== undefined && typeof body.auto_enrich !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'auto_enrich 必须是布尔值');
  }
  const scanWithAgent = body.scan_with_agent !== false;
  const autoDispatch = body.auto_dispatch !== false;
  const autoEnrich = body.auto_enrich !== false;
  const explicitWaitS = body.wait_s !== undefined && body.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS ? Math.max(1, Math.min(600, Number(body.wait_s))) : 3;

  let idempotencyKey = null;
  if (body.idempotency_key !== undefined && body.idempotency_key !== null && String(body.idempotency_key).trim()) {
    idempotencyKey = String(body.idempotency_key).trim();
    if (idempotencyKey.length > 128) {
      throw makeHttpError(400, 'invalid_idempotency_key', 'idempotency_key 不得超过 128 字符');
    }
  }

  const projectId = `p_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const planRelPath = `out/projects/${projectId}/plan.json`;

  // Persist compact manifest strictly inside active bus root (never mutating repo)
  const manifestFile = path.join(config.rootDir, 'scans', `${projectId}_manifest.json`);
  writeAtomicJson(manifestFile, {
    schema: 'agentbus/workspace-manifest@1',
    project_id: projectId,
    workspace_dir: workspaceDir,
    scanned_at: scan.scanned_at,
    file_count: scan.file_count,
    total_bytes: scan.total_bytes,
    truncated: scan.truncated,
    manifest_digest: scan.manifest_digest,
    counts: scan.counts,
    files: scan.files,
    detected_parts: scan.detected_parts,
  });

  const initialParts = (scan.detected_parts || []).map((dp) =>
    buildWorkingPartFromPlanPart(
      {
        key: dp.key,
        title: dp.title,
        category: dp.category,
        goal: dp.goal,
        paths: dp.paths,
        existing_paths: dp.existing_paths,
        missing_paths: dp.missing_paths,
        status: dp.status,
        evidence: dp.evidence,
        acceptance: dp.acceptance,
        agent: '',
        model: '',
        depends_on: [],
      },
      clientById,
      { source: 'scan', workspaceDir },
    )
  );

  let created = null;
  let disp = { dispatchResult: null, dispatchError: null, dispatched: false };
  const dispatchable = isAgentDispatchable(mainAgent, env);
  const installedAgents = (setup.clients || []).filter((c) => c.installed);

  if (scanWithAgent) {
    const scanGoal = buildReadExistingScanGoal({
      projectId,
      name: rawName,
      goal,
      workspaceDir,
      scan,
      manifestRelPath: manifestFile,
      planRelPath,
      mainAgent,
      mainModel,
      installedAgents,
    });

    const bus = openBus({ config });
    try {
      created = createTask(bus, {
        to: mainAgent,
        from: 'ui',
        goal: scanGoal,
        constraints: [
          `仅基于真实存在的文件输出合法 ${PROJECT_PLAN_SCHEMA} 到 ${planRelPath}，准确标记 existing/partial/missing。`,
          '禁止伪造未实现的功能；所有 paths 必须为相对路径。',
        ],
        acceptance: {
          json: 'true',
          schema: PROJECT_PLAN_SCHEMA,
          project_id: projectId,
        },
        idempotency_key: idempotencyKey,
      });

      if (autoDispatch && dispatchable) {
        disp = await runDispatchWithGuard(bus, dispatchFn, {
          taskId: created.id,
          pkgRoot: workspaceDir,
          waitS,
          config,
          toAgent: mainAgent,
          explicitWaitS,
          env,
        });
      }
    } finally {
      bus.close();
    }
  }

  const now = new Date().toISOString();
  const workspaceScanSummary = {
    workspace_dir: workspaceDir,
    file_count: scan.file_count,
    total_bytes: scan.total_bytes,
    truncated: scan.truncated,
    manifest_digest: scan.manifest_digest,
    manifest_file: manifestFile,
    scanned_at: scan.scanned_at,
    top_entries: scan.top_entries,
    counts: scan.counts,
  };

  const projectRecord = {
    id: projectId,
    name: rawName,
    goal,
    summary: scan.description_suggestion || `已关联本地目录 ${path.basename(workspaceDir)}`,
    source_mode: 'read_existing',
    workspace_dir: workspaceDir,
    ...(devMaterialsDir ? { dev_materials_dir: devMaterialsDir } : {}),
    workspace_scan: workspaceScanSummary,
    main_agent: mainAgent,
    main_model: mainModel,
    auto_enrich: autoEnrich,
    plan_rel_path: planRelPath,
    plan_source_path: null,
    plan_snapshot: null,
    groups: DEFAULT_PROJECT_GROUPS.map((g) => ({ ...g })),
    // Keep parts_initialized = false when scanWithAgent is true so completed main-agent plan can hydrate cleanly,
    // while initial scanned parts are already stored and immediately visible!
    parts_initialized: !scanWithAgent,
    parts: initialParts,
    card_requests: [],
    bootstrap_task_id: created ? created.id : null,
    bootstrap_history: created
      ? [
          {
            task_id: created.id,
            to: mainAgent,
            kind: 'scan_existing',
            created_at: now,
            dispatch_requested: autoDispatch && dispatchable,
            dispatched: disp.dispatched,
            dispatch_error: disp.dispatchError,
            awaiting_main_agent: !dispatchable,
          },
        ]
      : [],
    bootstrap_dispatch_requested: Boolean(created && autoDispatch && dispatchable),
    bootstrap_dispatched: Boolean(created && disp.dispatched),
    bootstrap_dispatch_error: disp.dispatchError,
    created_at: now,
    updated_at: now,
  };

  const nextProjects = [projectRecord, ...store.projects];
  saveProjectsStore(config.rootDir, store, nextProjects);

  const taskMap = readTasksByIdsReadOnly(config, created ? [created.id] : []);
  const hydrated = hydrateProjectRecord(projectRecord, { config, pkgRoot, clientById, taskMap, env });

  return {
    ok: true,
    awaiting_main_agent: Boolean(created && hydrated.bootstrap_task.awaiting_main_agent),
    project: hydrated,
    workspace_scan: scan,
    bootstrap_task: created
      ? {
          id: created.id,
          to: mainAgent,
          state: hydrated.bootstrap_task.state,
          uri: created.uri,
          dedup: created.dedup,
          awaiting_main_agent: Boolean(hydrated.bootstrap_task.awaiting_main_agent),
          dispatch_requested: autoDispatch && dispatchable,
          dispatched: disp.dispatched,
          dispatch_error: disp.dispatchError,
          dispatch_command: hydrated.bootstrap_task.dispatch_command,
          ...(disp.dispatchResult ? { dispatch_result: disp.dispatchResult } : {}),
        }
      : null,
  };
}

export function rescanProjectWorkspace({
  projectId,
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);
  if (!project.workspace_dir) {
    throw makeHttpError(400, 'no_workspace_dir', '该项目尚未关联本地项目文件夹，无法重扫');
  }
  const scan = scanWorkspaceDirectory(project.workspace_dir, { config, pkgRoot });
  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const { nextProject, taskMap } = materializePartsForMutation(project, { config, pkgRoot, clientById });
  nextProject.parts = nextProject.parts.map((part) => {
    if (!Array.isArray(part.paths) || part.paths.length === 0) return part;
    const disk = inspectPartPathsOnDisk(scan.workspace_dir, part.paths);
    return {
      ...part,
      existing_paths: disk.existing_paths,
      missing_paths: disk.missing_paths,
      implementation_status: disk.status || part.implementation_status || 'planned',
    };
  });
  nextProject.workspace_scan = {
    ...(nextProject.workspace_scan || {}),
    workspace_dir: scan.workspace_dir,
    file_count: scan.file_count,
    total_bytes: scan.total_bytes,
    truncated: scan.truncated,
    manifest_digest: scan.manifest_digest,
    scanned_at: scan.scanned_at,
    top_entries: scan.top_entries,
    counts: scan.counts,
  };
  nextProject.updated_at = new Date().toISOString();

  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap, env });
  return { ok: true, workspace_scan: scan, project: hydrated };
}

function buildAskCardsGoal({ project, prompt, reqId, deltaRelPath, mainAgent, mainModel }) {
  const existingLines = (project.parts || []).map((p) =>
    `- \`${p.key}\` | ${p.title} | cat=${p.category || 'general'} | status=${p.implementation_status || 'planned'} | manual=${p.manual_override ? 'yes' : 'no'} | paths=${(p.paths || []).join(', ') || '-'}`
  );
  const deltaExample = JSON.stringify({
    schema: PROJECT_PLAN_DELTA_SCHEMA,
    project_id: project.id,
    title: `${project.name} - 新增/调整卡片`,
    summary: '根据用户要求补充的新模块卡片',
    parts: [
      {
        key: 'new_feature',
        title: '新增模块标题',
        category: 'general',
        group: 'dev',
        status: 'missing',
        goal: '具体目标与边界',
        paths: ['src/new_feature.js'],
        acceptance: ['可验证验收条件'],
        agent: mainAgent,
        model: '',
        depends_on: [],
      },
    ],
  }, null, 2);

  return [
    `# 项目追加卡片需求：${project.name}`,
    '',
    `- project_id: \`${project.id}\``,
    `- request_id: \`${reqId}\``,
    `- 主 Agent (执行方): \`${mainAgent}\``,
    `- 主模型要求: ${mainModel || '沿用当前配置'}`,
    ...(project.workspace_dir ? [`- 项目目录: \`${project.workspace_dir}\``] : []),
    `- Delta 输出路径 (相对工作目录): \`${deltaRelPath}\``,
    '',
    '## 用户新要求',
    prompt,
    '',
    '## 当前已有卡片摘要（如非必要请勿改动用户手动修改项）',
    ...(existingLines.length ? existingLines : ['- （当前尚无卡片）']),
    '',
    '## 交付要求',
    `1. 将新增或拆分后的卡片写成合法 UTF-8 JSON 到 \`${deltaRelPath}\` 并作为 \`bus_task_complete\` 的 \`result_path\`。`,
    `2. schema 使用 \`${PROJECT_PLAN_DELTA_SCHEMA}\` 或 \`${PROJECT_PLAN_SCHEMA}\`，携带 \`project_id: "${project.id}"\` 和 \`parts[]\`。`,
    '3. 每个 part 可标注 `group`: `"dev"`（研发组功能开发）或 `"debug"`（调试组排查/调试/回归/回传问题），省略默认归入研发组。',
    '4. 所有 `paths` 必须为相对路径；禁止覆盖或删除无关卡片。',
    '',
    '```json',
    deltaExample,
    '```',
  ].join('\n');
}

export async function askMainAgentAddCards({
  projectId,
  body,
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body, ALLOWED_ASK_CARDS_KEYS, '向主 Agent 追加卡片请求体');
  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt || prompt.length > 4000) {
    throw makeHttpError(400, 'invalid_prompt', '请填写要向主 Agent 提出的要求（不超过 4000 字符）');
  }

  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const requestedAgent = typeof body.main_agent === 'string' && body.main_agent.trim()
    ? body.main_agent.trim()
    : project.main_agent;
  const requestedModel = body.main_model !== undefined ? (body.main_model || '') : (project.main_model || '');
  const { agent: mainAgent, model: mainModel } = validateAgentAndModel({
    agent: requestedAgent,
    model: requestedModel,
    clientById,
    knownSet,
    allowEmptyAgent: false,
  });

  if (body.auto_dispatch !== undefined && typeof body.auto_dispatch !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'auto_dispatch 必须是布尔值');
  }
  const autoDispatch = body.auto_dispatch !== false;
  const explicitWaitS = body.wait_s !== undefined && body.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS ? Math.max(1, Math.min(600, Number(body.wait_s))) : 3;

  const { nextProject } = materializePartsForMutation(project, { config, pkgRoot, clientById });
  const reqId = `req_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
  const deltaRelPath = `out/projects/${nextProject.id}/delta_${reqId}.json`;

  const goal = buildAskCardsGoal({
    project: nextProject,
    prompt,
    reqId,
    deltaRelPath,
    mainAgent,
    mainModel,
  });

  const dispatchable = isAgentDispatchable(mainAgent, env);
  const bus = openBus({ config });
  let created;
  let disp = { dispatchResult: null, dispatchError: null, dispatched: false };
  try {
    created = createTask(bus, {
      to: mainAgent,
      from: 'ui',
      goal,
      constraints: [
        `产出合法 ${PROJECT_PLAN_DELTA_SCHEMA} 或 ${PROJECT_PLAN_SCHEMA} 到 ${deltaRelPath}。`,
        '所有 paths 必须为相对项目路径，禁止绝对路径或 .. 越界。',
      ],
      acceptance: {
        json: 'true',
        project_id: nextProject.id,
      },
    });

    if (autoDispatch && dispatchable) {
      disp = await runDispatchWithGuard(bus, dispatchFn, {
        taskId: created.id,
        pkgRoot: nextProject.workspace_dir || pkgRoot,
        waitS,
        config,
        toAgent: mainAgent,
        explicitWaitS,
        env,
      });
    }
  } finally {
    bus.close();
  }

  const now = new Date().toISOString();
  const reqEntry = {
    id: reqId,
    prompt,
    task_id: created.id,
    to: mainAgent,
    model: mainModel,
    delta_rel_path: deltaRelPath,
    created_at: now,
    dispatch_requested: autoDispatch && dispatchable,
    dispatched: disp.dispatched,
    dispatch_error: disp.dispatchError,
    awaiting_main_agent: !dispatchable,
    merged: false,
    merged_at: null,
    merge_summary: null,
  };

  nextProject.card_requests = [
    reqEntry,
    ...(Array.isArray(nextProject.card_requests) ? nextProject.card_requests : []),
  ].slice(0, 30);
  nextProject.updated_at = now;

  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const taskMapAfter = readTasksByIdsReadOnly(config, collectProjectTaskIds([nextProject]));
  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap: taskMapAfter, env });
  const hydratedReq = hydrated.card_requests.find((r) => r.id === reqId) || reqEntry;
  const awaitingMainAgent = Boolean(hydratedReq.awaiting_main_agent ?? !dispatchable);

  return {
    ok: true,
    awaiting_main_agent: awaitingMainAgent,
    request: hydratedReq,
    task: {
      id: created.id,
      to: mainAgent,
      state: hydratedReq.state || created.state,
      uri: created.uri,
      awaiting_main_agent: awaitingMainAgent,
      dispatch_requested: autoDispatch && dispatchable,
      dispatched: disp.dispatched,
      dispatch_error: disp.dispatchError,
      dispatch_command: hydratedReq.dispatch_command,
    },
    project: hydrated,
  };
}

export async function applyProjectCardDelta({
  projectId,
  body = {},
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body || {}, ALLOWED_APPLY_DELTA_KEYS, '合并追加卡片结果请求体');
  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);
  if (body?.auto_dispatch !== undefined && typeof body.auto_dispatch !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'auto_dispatch 必须是布尔值');
  }
  const autoDispatch = body?.auto_dispatch !== false;
  const explicitWaitS = body?.wait_s !== undefined && body?.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS ? Math.max(1, Math.min(600, Number(body.wait_s))) : 3;

  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));
  const installedAgents = (setup.clients || []).filter((c) => c.installed);
  const { nextProject, taskMap } = materializePartsForMutation(project, {
    config,
    pkgRoot,
    clientById,
    skipAutoApplyDeltas: true,
  });

  const confirmOverwriteManual = body?.confirm_overwrite_manual === true;
  const targetReqId = typeof body?.request_id === 'string' && body.request_id.trim() ? body.request_id.trim() : null;

  const reqs = Array.isArray(nextProject.card_requests) ? nextProject.card_requests.map((r) => ({ ...r })) : [];
  const candidates = targetReqId
    ? reqs.filter((r) => r.id === targetReqId)
    : reqs.filter((r) => !r.merged);

  if (candidates.length === 0) {
    throw makeHttpError(404, 'card_request_not_found', targetReqId ? `找不到追加卡片请求: ${targetReqId}` : '当前没有待合并的追加卡片任务');
  }

  const addedKeys = [];
  const updatedKeys = [];
  const skippedManualKeys = [];
  const mergedRequestIds = [];
  const now = new Date().toISOString();

  for (const req of candidates) {
    const rTask = req.task_id ? taskMap.get(req.task_id) : null;
    if (!rTask || rTask.state !== 'done') {
      if (targetReqId) {
        throw makeHttpError(409, 'card_request_not_done', `追加卡片任务 ${req.task_id || req.id} 尚未完成 (state=${rTask?.state || 'missing'})`);
      }
      continue;
    }

    const planRes = readPlanCandidate({
      project: nextProject,
      bootstrapTask: rTask,
      config,
      pkgRoot,
      relPathOverride: req.delta_rel_path || null,
      allowDelta: true,
    });
    if (planRes.status !== 'loaded' || !planRes.plan) {
      if (targetReqId) {
        throw makeHttpError(422, planRes.code || 'invalid_delta', planRes.error || '未找到合法的 plan delta JSON');
      }
      continue;
    }

    const reqAdded = [];
    const reqUpdated = [];
    const reqSkippedManual = [];

    for (const dp of planRes.plan.parts) {
      const existingIdx = nextProject.parts.findIndex((p) => p.key === dp.key);
      const built = buildWorkingPartFromPlanPart(dp, clientById, {
        source: 'delta',
        workspaceDir: nextProject.workspace_dir || null,
      });

      if (existingIdx < 0) {
        if (nextProject.parts.length >= MAX_PARTS_PER_PROJECT) {
          throw makeHttpError(400, 'too_many_parts', `合并后超出单项目最多 ${MAX_PARTS_PER_PROJECT} 张卡片上限`);
        }
        const usedCodes = new Set(nextProject.parts.map((p) => resolvePartCode(p)));
        if (usedCodes.has(built.code)) {
          if (dp.code) {
            throw makeHttpError(400, 'duplicate_part_code', `合并卡片代号冲突: ${built.code}`);
          }
          built.code = defaultPartCode(built.key, usedCodes);
        }
        nextProject.parts.push(built);
        addedKeys.push(dp.key);
        reqAdded.push(dp.key);
      } else {
        const cur = nextProject.parts[existingIdx];
        if (cur.manual_override === true && !confirmOverwriteManual) {
          skippedManualKeys.push(dp.key);
          reqSkippedManual.push(dp.key);
        } else {
          nextProject.parts[existingIdx] = mergeExistingPartRuntimeFields(built, cur);
          updatedKeys.push(dp.key);
          reqUpdated.push(dp.key);
        }
      }
    }

    req.merged = reqSkippedManual.length === 0 || confirmOverwriteManual;
    req.merged_at = now;
    req.merge_summary = {
      added_keys: reqAdded,
      updated_keys: reqUpdated,
      skipped_manual_keys: reqSkippedManual,
      needs_confirmation: reqSkippedManual.length > 0 && !confirmOverwriteManual,
      source_path: planRes.path,
    };
    mergedRequestIds.push(req.id);
  }

  if (mergedRequestIds.length === 0) {
    throw makeHttpError(409, 'no_ready_deltas', '没有已完成且校验通过的追加卡片结果可合并');
  }

  nextProject.card_requests = reqs;
  nextProject.parts_initialized = true;
  nextProject.updated_at = now;

  if (nextProject.auto_enrich !== false && addedKeys.length > 0) {
    const addedSet = new Set(addedKeys);
    const needEnrich = nextProject.parts.filter(
      (pt) => addedSet.has(pt.key) && !pt.enrichment_task_id && needsEnrichmentForDecomposed(pt)
    );
    if (needEnrich.length > 0) {
      const bus = openBus({ config });
      try {
        for (const pt of needEnrich) {
          await createAndMaybeDispatchEnrichmentTask({
            project: nextProject,
            part: pt,
            bus,
            config,
            pkgRoot,
            clientById,
            knownSet,
            installedAgents,
            autoDispatch,
            waitS,
            explicitWaitS,
            dispatchFn,
            env,
            isRetry: false,
          });
        }
      } finally {
        bus.close();
      }
    }
  }

  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const taskMapAfter = readTasksByIdsReadOnly(config, collectProjectTaskIds([nextProject]));
  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap: taskMapAfter, env });
  return {
    ok: true,
    merged_request_ids: mergedRequestIds,
    added_keys: addedKeys,
    updated_keys: updatedKeys,
    skipped_manual_keys: skippedManualKeys,
    needs_confirmation: skippedManualKeys.length > 0 && !confirmOverwriteManual,
    project: hydrated,
  };
}

function buildRegeneratePartGoal({ project, part, diskInfo, prevTask, notes }) {
  const pathsBlock = (part.paths || []).length > 0
    ? part.paths.map((p) => `- \`${p}\``).join('\n')
    : '- （未限定路径，请在项目目录内组织）';
  const accBlock = (part.acceptance || []).length > 0
    ? part.acceptance.map((a) => `- ${a}`).join('\n')
    : '- 产出可验证结果 JSON 并运行相关回归检查。';

  const implLines = [];
  if (diskInfo && diskInfo.file_summaries && diskInfo.file_summaries.length > 0) {
    for (const f of diskInfo.file_summaries) {
      if (f.is_dir) {
        implLines.push(`- 目录 \`${f.rel_path}\`：当前含 ${f.entry_count} 项 (${(f.sample || []).join(', ')})`);
      } else {
        implLines.push(`- 文件 \`${f.rel_path}\` (${f.bytes}B${f.sha256_short ? `, sha=${f.sha256_short}` : ''})${f.summary ? ` : ${f.summary}` : ''}`);
      }
    }
  }
  if (diskInfo && diskInfo.missing_paths && diskInfo.missing_paths.length > 0) {
    implLines.push(`- 尚未存在的路径: ${diskInfo.missing_paths.map((x) => `\`${x}\``).join(', ')}`);
  }

  return [
    `# 重生成部分任务：${project.name} / ${part.title} (${part.key})`,
    '',
    `- project_id: \`${project.id}\``,
    `- part_key: \`${part.key}\``,
    `- 所属环节 (group): \`${part.group === 'debug' ? 'debug' : 'dev'}\``,
    `- 类别 (category): \`${part.category || 'general'}\``,
    `- 执行 Agent (to): \`${part.agent}\``,
    `- 目标模型: ${part.model || '沿用该 agent 当前配置'}`,
    ...(project.workspace_dir ? [`- 项目目录: \`${project.workspace_dir}\``] : []),
    ...(prevTask ? [`- 上次任务记录: \`${prevTask.id}\` (state=${prevTask.state}${prevTask.result?.uri ? `, result=${prevTask.result.uri}` : ''})`] : []),
    '',
    '## 所属项目总目标',
    project.goal,
    '',
    '## 本部分任务目标',
    part.goal,
    '',
    '## 涉及相对路径',
    pathsBlock,
    '',
    '## 现有实现摘要（轻量指针，按需只读相关文件）',
    ...(implLines.length ? implLines : ['- （未检测到既有实现文件，按目标重新实现）']),
    ...(notes ? ['', '## 本次重生成补充要求', notes] : []),
    '',
    '## 验收条件',
    accBlock,
    '',
    '## 交付说明',
    '- 仅围绕本部分的相对路径重生成/重构实现，勿破坏无关模块。',
    '- 完成后产出合法结果 JSON 文件并通过 `bus_task_complete` 提交。',
  ].join('\n');
}

export async function regenerateProjectPart({
  projectId,
  partKey,
  body = {},
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body || {}, ALLOWED_REGENERATE_PART_KEYS, '重生成部分卡片请求体');
  if (!SAFE_ID_RE.test(String(partKey || ''))) {
    throw makeHttpError(400, 'invalid_part_key', `非法 part key: ${partKey}`);
  }

  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);
  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const { nextProject, taskMap } = materializePartsForMutation(project, { config, pkgRoot, clientById });
  const pIdx = nextProject.parts.findIndex((p) => p.key === partKey);
  if (pIdx < 0) {
    throw makeHttpError(404, 'part_not_found', `项目中找不到部分卡片: ${partKey}`);
  }

  const part = nextProject.parts[pIdx];
  const prevTask = part.task_id ? (taskMap.get(part.task_id) || null) : null;

  // Strictly prevent duplicate active tasks on the same part!
  if (prevTask && (prevTask.state === 'open' || prevTask.state === 'claimed')) {
    throw makeHttpError(
      409,
      'active_task_exists',
      `该部分已有进行中的任务 ${prevTask.id} (state=${prevTask.state}, to=${prevTask.to})，禁止重复重生成`,
    );
  }

  const notes = body.notes === undefined || body.notes === null ? '' : String(body.notes).trim();
  if (notes.length > 2000) {
    throw makeHttpError(400, 'notes_too_long', '重生成备注不能超过 2000 字符');
  }

  const agentProvided = body.agent !== undefined && body.agent !== null && String(body.agent).trim() !== '';
  const targetAgentRaw = agentProvided ? String(body.agent).trim() : (part.agent || nextProject.main_agent || '');
  const targetModelRaw = body.model !== undefined
    ? String(body.model || '').trim()
    : (agentProvided && targetAgentRaw !== part.agent ? '' : (part.model || ''));

  const validatedTarget = validateAgentAndModel({
    agent: targetAgentRaw,
    model: targetModelRaw,
    clientById,
    knownSet,
    allowEmptyAgent: false,
  });

  if (body.auto_dispatch !== undefined && typeof body.auto_dispatch !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'auto_dispatch 必须是布尔值');
  }
  const autoDispatch = body.auto_dispatch !== false;
  const explicitWaitS = body.wait_s !== undefined && body.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS ? Math.max(1, Math.min(600, Number(body.wait_s))) : 3;

  const diskInfo = inspectPartPathsOnDisk(nextProject.workspace_dir || pkgRoot, part.paths || []);
  const regenGoal = buildRegeneratePartGoal({
    project: nextProject,
    part: { ...part, agent: validatedTarget.agent, model: validatedTarget.model },
    diskInfo,
    prevTask,
    notes,
  });

  const round = (Array.isArray(part.task_history) ? part.task_history.length : 0) + 1;
  const bus = openBus({ config });
  let created;
  let disp = { dispatchResult: null, dispatchError: null, dispatched: false };
  try {
    created = createTask(bus, {
      to: validatedTarget.agent,
      from: 'ui',
      goal: regenGoal,
      constraints: [
        '仅围绕本部分的相对路径重生成/重构实现，不得覆盖项目原始 plan.json。',
        '完成后提交合法结果 JSON 文件。',
      ],
      acceptance: { json: 'true' },
      idempotency_key: `proj:${nextProject.id}:part:${part.key}:regen:${round}`,
    });

    if (autoDispatch) {
      disp = await runDispatchWithGuard(bus, dispatchFn, {
        taskId: created.id,
        pkgRoot: nextProject.workspace_dir || pkgRoot,
        waitS,
        config,
        toAgent: validatedTarget.agent,
        explicitWaitS,
        env,
      });
    }
  } finally {
    bus.close();
  }

  const now = new Date().toISOString();
  const prevHistory = Array.isArray(part.task_history) ? [...part.task_history] : [];
  // Ensure any pre-existing task_id not yet recorded in history is preserved
  if (part.task_id && !prevHistory.some((h) => h.task_id === part.task_id)) {
    prevHistory.push({
      task_id: part.task_id,
      to: prevTask?.to || part.agent || '',
      kind: 'dispatch',
      created_at: prevTask?.created_at || now,
    });
  }
  prevHistory.push({
    task_id: created.id,
    to: validatedTarget.agent,
    model: validatedTarget.model || '',
    kind: 'regenerate',
    notes: notes || null,
    created_at: now,
    dispatch_requested: autoDispatch,
    dispatched: disp.dispatched,
    dispatch_error: disp.dispatchError,
  });

  part.agent = validatedTarget.agent;
  part.model = validatedTarget.model;
  if (agentProvided) {
    part.manual_override = true;
    part.assignment_source = 'manual';
  }
  part.task_id = created.id;
  part.task_history = prevHistory;
  part.regenerate_count = Number(part.regenerate_count || 0) + 1;
  part.last_dispatch = {
    at: now,
    kind: 'regenerate',
    task_id: created.id,
    to: validatedTarget.agent,
    dispatch_requested: autoDispatch,
    dispatched: disp.dispatched,
    dispatch_error: disp.dispatchError,
  };

  nextProject.parts[pIdx] = part;
  nextProject.parts_initialized = true;
  nextProject.updated_at = now;

  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const taskMapAfter = readTasksByIdsReadOnly(config, collectProjectTaskIds([nextProject]));
  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap: taskMapAfter, env });
  const hydratedPart = hydrated.parts.find((p) => p.key === partKey);

  return {
    ok: !disp.dispatchError,
    project_id: nextProject.id,
    part_key: partKey,
    part: hydratedPart,
    task: {
      id: created.id,
      to: validatedTarget.agent,
      model: validatedTarget.model || null,
      state: disp.dispatchResult?.state || created.state,
      uri: created.uri,
      kind: 'regenerate',
      dispatch_requested: autoDispatch,
      dispatched: disp.dispatched,
      dispatch_error: disp.dispatchError,
      dispatch_command: hydratedPart?.task?.dispatch_command || `node bin/bus.js dispatch ${created.id} --allow-dispatch --root "${config.rootDir}"`,
    },
    project: hydrated,
  };
}

function buildCompletePartGoal({
  project,
  part,
  moduleCode,
  workspaceDir,
  materialsBaseDir,
  moduleMaterialsDir,
  busRoot,
  notes,
}) {
  const envelopesDir = path.join(materialsBaseDir, 'envelopes');
  const manifestPath = path.join(moduleMaterialsDir, 'manifest.json');
  const readmePath = path.join(moduleMaterialsDir, 'README.md');
  const resultPath = path.join(moduleMaterialsDir, 'result.json');
  const relatedTaskIds = Array.from(new Set([
    part.task_id,
    ...(Array.isArray(part.task_history) ? part.task_history.map((h) => h?.task_id) : []),
    project.bootstrap_task_id,
  ].filter(Boolean)));

  return [
    `# 模块完成与开发资料归档任务：${project.name} / ${part.title} (代号 ${moduleCode})`,
    '',
    `- project_id: \`${project.id}\``,
    `- part_key: \`${part.key}\``,
    `- module_code (模块代号): \`${moduleCode}\``,
    `- 所属环节 (group): \`${part.group === 'debug' ? 'debug' : 'dev'}\``,
    `- 主 Agent (执行方): \`${project.main_agent}\``,
    `- 工作目录: \`${workspaceDir}\``,
    `- 开发资料目标目录: \`${moduleMaterialsDir}\``,
    `- 总线信封副本目录 (只复制不删除): \`${envelopesDir}\``,
    `- 清单输出路径: \`${manifestPath}\``,
    `- 说明文件输出路径: \`${readmePath}\``,
    `- 任务结果 JSON 路径 (bus_task_complete result_path): \`${resultPath}\``,
    ...(relatedTaskIds.length > 0 ? [`- 关联总线任务 ID: ${relatedTaskIds.map((id) => `\`${id}\``).join(', ')}`] : []),
    ...(notes ? [`- 用户补充说明: ${notes}`] : []),
    '',
    '## 允许移动的开发过程临时/中间文件范围（仅限确认是生成物时移动）',
    '- 项目根或输出目录下的临时测试目录与中间生成物：`.pytest_cache/`、`test-results/`、`test-output/`、`coverage/`、`tmp/`、以及明确的临时测试日志/临时报告文件。',
    '- 若目标文件名已存在，必须使用带时间戳或序号的隔离文件名，禁止覆盖已有用户文件；移动失败时保留源文件并在结果中报告。',
    '',
    '## 必须复制而非移动的总线记录（严禁删除源文件）',
    `- 总线根目录 \`${busRoot}\` 下的任务与产物记录（如 \`${path.join(busRoot, 'tasks')}\` 中的指针信封 \`<task_id>.json\`、\`${path.join(busRoot, 'artifacts')}\` 等）仅可**复制**到 \`${envelopesDir}\`。`,
    '- **严禁删除或移动**总线数据库 (`agentbus.db`)、任务信封或 artifacts 源文件，否则会破坏任务可追溯性。',
    '',
    '## 严禁移动或覆盖的正式文件范围',
    '- 严禁移动或覆盖：`src/`、`bin/`、`docs/`、正式测试源码（例如 `test/accept.mjs`）、`package.json`、`package-lock.json`、项目配置文件及用户正式交付产物。',
    '- 任何归属不确定的文件一律先写入 dry-run 清单，禁止擅自移动。',
    '',
    '## 交付要求（manifest.json + result.json）',
    `1. 生成 \`${manifestPath}\`，列出每条 \`entries[]\` 的 \`source\`、\`destination\`、\`sha256\`、\`bytes\`、\`action\`（\`"moved"\` 或 \`"copied"\`）；若无可归档文件，也必须写入空 \`entries: []\` 的合法 JSON，绝不伪造文件。`,
    `2. 在 \`${readmePath}\` 写简短归档说明。`,
    `3. 将合法 UTF-8 JSON 写入 \`${resultPath}\` 并通过 \`bus_task_complete\` 提交，至少包含字段：\`module_code\`、\`task_id\`、\`materials_dir\`、\`moved_count\`、\`copied_count\`、\`formal_files_unchanged\`、\`manifest_path\`、\`tests_rc\`（如有运行测试）。`,
  ].join('\n');
}

export async function completeProjectPart({
  projectId,
  partKey,
  body = {},
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body || {}, ALLOWED_COMPLETE_PART_KEYS, '模块完成请求体');
  if (!SAFE_ID_RE.test(String(partKey || ''))) {
    throw makeHttpError(400, 'invalid_part_key', `非法 part key: ${partKey}`);
  }
  if (body?.auto_dispatch !== undefined && typeof body.auto_dispatch !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'auto_dispatch 必须是布尔值');
  }

  const { store, idx, project } = loadProjectForWrite(projectId, config.rootDir);
  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const { nextProject, taskMap } = materializePartsForMutation(project, { config, pkgRoot, clientById });
  const pIdx = nextProject.parts.findIndex((p) => p.key === partKey);
  if (pIdx < 0) {
    throw makeHttpError(404, 'part_not_found', `项目中找不到部分卡片: ${partKey}`);
  }

  const part = nextProject.parts[pIdx];
  const moduleCode = part.code
    ? normalizePartCodeInput(part.code, { required: true })
    : resolvePartCode(part);
  const materialsBaseDir = resolveProjectDevMaterialsDir(nextProject, { config, pkgRoot });
  const moduleMaterialsDir = path.join(materialsBaseDir, moduleCode);

  const existingCompTask = part.completion_task_id ? (taskMap.get(part.completion_task_id) || null) : null;
  if (existingCompTask && existingCompTask.state !== 'failed') {
    const hydratedExisting = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap, env });
    const hydratedPart = hydratedExisting.parts.find((p) => p.key === partKey);
    return {
      ok: true,
      idempotent: true,
      created: false,
      project_id: nextProject.id,
      part_key: partKey,
      module_code: moduleCode,
      materials_dir: moduleMaterialsDir,
      dev_materials_dir: materialsBaseDir,
      completion_task_id: existingCompTask.id,
      completed_at: hydratedPart?.completed_at || part.completed_at || null,
      completion_status: hydratedPart?.completion_status || 'pending',
      task: hydratedPart?.completion_task || null,
      project: hydratedExisting,
    };
  }

  const { agent: mainAgent } = validateAgentAndModel({
    agent: nextProject.main_agent,
    model: nextProject.main_model || '',
    clientById,
    knownSet,
    allowEmptyAgent: false,
  });

  const notes = body?.notes === undefined || body?.notes === null ? '' : String(body.notes).trim();
  if (notes.length > 2000) {
    throw makeHttpError(400, 'notes_too_long', '完成说明不能超过 2000 字符');
  }

  const autoDispatch = body?.auto_dispatch !== false;
  const explicitWaitS = body?.wait_s !== undefined && body?.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS ? Math.max(1, Math.min(600, Number(body.wait_s))) : 3;

  const workspaceDir = nextProject.workspace_dir || pkgRoot;
  const goal = buildCompletePartGoal({
    project: nextProject,
    part,
    moduleCode,
    workspaceDir,
    materialsBaseDir,
    moduleMaterialsDir,
    busRoot: config.rootDir,
    notes,
  });

  const retrySeq = Number(part.completion_retry_count || 0);
  const idempKey = existingCompTask
    ? `complete:${nextProject.id}:${part.key}:retry:${retrySeq + 1}`
    : `complete:${nextProject.id}:${part.key}`;

  const dispatchable = isAgentDispatchable(mainAgent, env);
  const bus = openBus({ config });
  let created;
  let disp = { dispatchResult: null, dispatchError: null, dispatched: false };
  try {
    created = createTask(bus, {
      to: mainAgent,
      from: 'ui',
      goal,
      constraints: [
        `将确认属于开发过程的临时/中间文件归档到 ${moduleMaterialsDir} 并写 manifest.json。`,
        '总线 tasks/artifacts 指针信封只复制不删除；严禁移动 src/、bin/、docs/、test/accept.mjs、package.json 等正式文件。',
      ],
      acceptance: {
        json: 'true',
      },
      idempotency_key: idempKey,
    });

    if (autoDispatch && dispatchable) {
      disp = await runDispatchWithGuard(bus, dispatchFn, {
        taskId: created.id,
        pkgRoot: workspaceDir,
        waitS,
        config,
        toAgent: mainAgent,
        explicitWaitS,
        env,
      });
    }
  } finally {
    bus.close();
  }

  const now = new Date().toISOString();
  part.code = moduleCode;
  part.completion_task_id = created.id;
  part.completed_at = part.completed_at || now;
  part.completion_status = 'pending';
  if (existingCompTask) {
    part.completion_retry_count = retrySeq + 1;
  }
  part.completion_dispatch = {
    at: now,
    to: mainAgent,
    dispatch_requested: autoDispatch && dispatchable,
    dispatched: disp.dispatched,
    dispatch_error: disp.dispatchError,
    awaiting_main_agent: !dispatchable,
  };

  nextProject.parts[pIdx] = part;
  nextProject.parts_initialized = true;
  nextProject.updated_at = now;

  const nextProjects = [...store.projects];
  nextProjects[idx] = nextProject;
  saveProjectsStore(config.rootDir, store, nextProjects);

  const taskMapAfter = readTasksByIdsReadOnly(config, collectProjectTaskIds([nextProject]));
  const hydrated = hydrateProjectRecord(nextProject, { config, pkgRoot, clientById, taskMap: taskMapAfter, env });
  const hydratedPart = hydrated.parts.find((p) => p.key === partKey);

  return {
    ok: !disp.dispatchError,
    idempotent: Boolean(created.dedup),
    created: !created.dedup,
    project_id: nextProject.id,
    part_key: partKey,
    module_code: moduleCode,
    materials_dir: moduleMaterialsDir,
    dev_materials_dir: materialsBaseDir,
    completion_task_id: created.id,
    completed_at: hydratedPart?.completed_at || part.completed_at,
    completion_status: hydratedPart?.completion_status || 'pending',
    awaiting_main_agent: !dispatchable,
    task: hydratedPart?.completion_task || {
      id: created.id,
      to: mainAgent,
      state: created.state,
      awaiting_main_agent: !dispatchable,
      dispatched: disp.dispatched,
      dispatch_error: disp.dispatchError,
      dispatch_command: `node bin/bus.js dispatch ${created.id} --allow-dispatch --root "${config.rootDir}"`,
    },
    project: hydrated,
  };
}
