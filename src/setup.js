// Client auto-configuration for agentbus.
// Writes (or updates) the MCP server entry for supported agent CLIs.
// Rules: idempotent, always backs up the target file before modification, never touches unrelated keys.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientConfigFile, resolveAgentBin } from './agents.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUS_BIN = path.resolve(HERE, '..', 'bin', 'bus.js');

export function defaultRoot() {
  return path.join(os.homedir(), '.agentbus');
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

function makeDiagError(code, message, next) {
  return Object.assign(new Error(message), { code: 1, errorCode: code, next });
}

function isPermError(err) {
  return err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS');
}

function permissionNextHint(targetPath, platform = process.platform) {
  if (platform === 'win32') {
    return `检查只读属性或权限（可尝试: attrib -R "${targetPath}"），或改用有写权限的目录（--home "<可写目录>" --root "<可写目录>"）`;
  }
  return `检查目录/文件权限（可尝试: chmod u+w "${targetPath}"），或改用有写权限的目录（--home "<可写目录>" --root "<可写目录>"）`;
}

function checkDirWritable(dirPath, platform = process.platform) {
  if (fs.existsSync(dirPath)) {
    let st;
    try {
      st = fs.statSync(dirPath);
    } catch (e) {
      if (isPermError(e)) return { ok: false, code: 'permission_denied', reason: e.code, path: dirPath };
      return { ok: false, code: 'missing_config_dir', reason: e.code || 'stat_failed', path: dirPath };
    }
    if (!st.isDirectory()) {
      return { ok: false, code: 'missing_config_dir', reason: 'ENOTDIR', path: dirPath };
    }
    try {
      fs.accessSync(dirPath, fs.constants.W_OK);
      return { ok: true };
    } catch (e) {
      return { ok: false, code: 'permission_denied', reason: e.code || 'EACCES', path: dirPath };
    }
  }

  let cur = path.dirname(dirPath);
  while (cur && cur !== path.dirname(cur)) {
    if (fs.existsSync(cur)) {
      let st;
      try {
        st = fs.statSync(cur);
      } catch (e) {
        if (isPermError(e)) return { ok: false, code: 'permission_denied', reason: e.code, path: cur };
        return { ok: false, code: 'missing_config_dir', reason: e.code || 'stat_failed', path: cur };
      }
      if (!st.isDirectory()) {
        return { ok: false, code: 'missing_config_dir', reason: 'ENOTDIR', path: cur };
      }
      try {
        fs.accessSync(cur, fs.constants.W_OK);
        return { ok: true };
      } catch (e) {
        return { ok: false, code: 'permission_denied', reason: e.code || 'EACCES', path: cur };
      }
    }
    cur = path.dirname(cur);
  }
  return { ok: false, code: 'missing_config_dir', reason: 'ENOENT', path: dirPath };
}

function checkTargetWritable(file, platform = process.platform) {
  const dir = path.dirname(file);
  if (fs.existsSync(file)) {
    let st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      if (isPermError(e)) {
        throw makeDiagError('permission_denied', `权限不足，无法读取配置文件 ${file} (${e.code})`, permissionNextHint(file, platform));
      }
      throw makeDiagError('invalid_config_path', `无法访问配置文件 ${file}: ${e.message}`, `检查路径 ${file} 是否有效`);
    }
    if (!st.isFile()) {
      throw makeDiagError('invalid_config_path', `目标配置路径不是普通文件: ${file}`, `确认 ${file} 不是目录，或通过 --home 指定其他目录`);
    }
    try {
      fs.accessSync(file, fs.constants.W_OK);
    } catch (e) {
      throw makeDiagError('permission_denied', `权限不足，无法写入配置文件 ${file} (${e.code || 'EACCES'})`, permissionNextHint(file, platform));
    }
  }
  const dirCheck = checkDirWritable(dir, platform);
  if (!dirCheck.ok) {
    if (dirCheck.code === 'permission_denied') {
      throw makeDiagError(
        'permission_denied',
        `权限不足，无法写入配置目录 ${dirCheck.path} (${dirCheck.reason})`,
        permissionNextHint(dirCheck.path, platform),
      );
    }
    throw makeDiagError(
      'missing_config_dir',
      `配置目录不可创建或上层路径非法: ${dirCheck.path} (${dirCheck.reason})`,
      `确保父路径是有效目录，或改用 --home "<有效目录>"`,
    );
  }
}

function writeAtomic(file, text, platform = process.platform) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (isPermError(e)) {
      throw makeDiagError('permission_denied', `权限不足，无法创建配置目录 ${dir} (${e.code})`, permissionNextHint(dir, platform));
    }
    throw makeDiagError('missing_config_dir', `无法创建配置目录 ${dir}: ${e.message}`, `先手动创建目录 "${dir}" 或检查路径权限`);
  }
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    if (isPermError(e)) {
      throw makeDiagError('permission_denied', `权限不足，无法写入配置 ${file} (${e.code})`, permissionNextHint(file, platform));
    }
    throw makeDiagError('write_failed', `写入配置文件失败 ${file}: ${e.message}`, `检查文件是否被占用或路径是否有效: ${file}`);
  }
}

// ---------- server spec ----------

function serverSpec({ root, allowed, bin = 'node', env: extraEnv }) {
  const rawList = allowed && allowed.length ? allowed : [root];
  const seen = new Set();
  const roots = [];
  for (const item of rawList) {
    const s = String(item || '').trim();
    if (!s) continue;
    const resolved = path.resolve(s);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(resolved);
  }
  if (!roots.length) roots.push(path.resolve(root));

  const env = { AGENTBUS_ALLOWED_ROOTS: roots.join(path.delimiter), ...(extraEnv || {}) };
  if (bin === 'npx') {
    return { command: 'npx', args: ['-y', 'agentbus-mcp', 'mcp', '--root', path.resolve(root)], env };
  }
  return {
    command: process.env.AGENTBUS_MCP_COMMAND || process.execPath,
    args: [BUS_BIN, 'mcp', '--root', path.resolve(root)],
    env,
  };
}

// ---------- TOML (codex) ----------

function stripTomlComment(line) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inDouble) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '#') return line.slice(0, i).trim();
  }
  return line.trim();
}

function parseTomlSectionHeader(line) {
  const clean = stripTomlComment(line);
  if (!clean.startsWith('[')) return null;
  if (clean.startsWith('[[')) {
    const m = /^\[\[\s*(.+?)\s*\]\]$/.exec(clean);
    return m ? { arrayTable: true, name: m[1] } : null;
  }
  const m = /^\[\s*(.+?)\s*\]$/.exec(clean);
  if (!m) return null;
  const parts = [];
  let cur = '';
  let quote = null;
  let esc = false;
  for (const ch of m[1]) {
    if (quote) {
      if (quote === '"' && !esc && ch === '\\') { esc = true; continue; }
      if (esc) { cur += ch; esc = false; continue; }
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '.') { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() || parts.length) parts.push(cur.trim());
  return { arrayTable: false, parts };
}

function isAgentbusTomlSection(header) {
  if (!header || header.arrayTable) return false;
  return header.parts[0] === 'mcp_servers' && header.parts[1] === 'agentbus';
}

function stripTomlSection(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const header = parseTomlSectionHeader(line);
    if (header) {
      skipping = isAgentbusTomlSection(header);
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function tomlValue(v) {
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  return JSON.stringify(String(v));
}

function mergeToml(prev, spec) {
  const base = stripTomlSection(prev);
  const block = [
    '[mcp_servers.agentbus]',
    `command = ${tomlValue(spec.command)}`,
    `args = ${tomlValue(spec.args)}`,
    '',
    '[mcp_servers.agentbus.env]',
    ...Object.entries(spec.env).map(([k, v]) => `${k} = ${tomlValue(v)}`),
    '',
  ].join('\n');
  return base ? `${base}\n\n${block}` : block;
}

// ---------- JSON clients ----------

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function mergeJson(file, prev, targetKey, mutate) {
  let data = {};
  const raw = prev.replace(/^\uFEFF/, '').trim();
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw makeDiagError(
        'corrupted_config',
        `${file} 不是合法 JSON，已停止（未写入且未覆盖）: ${e.message}`,
        `请先修复或手动备份后清理该损坏文件: "${file}"`,
      );
    }
    if (!isPlainObject(data)) {
      throw makeDiagError(
        'corrupted_config',
        `${file} 顶层必须是 JSON 对象，已停止（未写入且未覆盖）`,
        `检查并修复 "${file}" 为合法 JSON 对象（如 {}）`,
      );
    }
    if (data[targetKey] !== undefined && !isPlainObject(data[targetKey])) {
      throw makeDiagError(
        'corrupted_config',
        `${file} 中的 "${targetKey}" 字段不是对象，已停止（未写入且未覆盖）`,
        `检查并修复 "${file}" 中的 "${targetKey}" 为 JSON 对象`,
      );
    }
  }
  mutate(data);
  return JSON.stringify(data, null, 2) + '\n';
}

// ---------- client adapters ----------

const CLIENTS = [
  { id: 'codex', label: 'OpenAI Codex CLI', format: 'toml', hasBinary: true },
  { id: 'claude', label: 'Claude Code', format: 'json-mcpServers', hasBinary: true },
  { id: 'gemini', label: 'Gemini CLI', format: 'json-mcpServers', hasBinary: true },
  { id: 'antigravity', label: 'Google Antigravity', format: 'json-mcpServers', hasBinary: true },
  { id: 'cursor', label: 'Cursor', format: 'json-mcpServers', hasBinary: false },
  { id: 'opencode', label: 'OpenCode', format: 'json-opencode', hasBinary: true },
  { id: 'claude-desktop', label: 'Claude Desktop', format: 'json-mcpServers', hasBinary: false },
];

export function listClients() {
  return CLIENTS.map((c) => c.id);
}

export function describeClients({ home = os.homedir(), platform = process.platform } = {}) {
  return CLIENTS.map((c) => ({
    id: c.id,
    label: c.label,
    format: c.format,
    config: clientConfigFile(c.id, home, platform),
  }));
}

function applyClient(client, opts) {
  const file = clientConfigFile(client.id, opts.home, opts.platform);
  const dir = path.dirname(file);
  const exists = fs.existsSync(file);
  const spec = serverSpec(opts);

  let prev = '';
  if (exists) {
    let st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      if (isPermError(e)) {
        throw makeDiagError('permission_denied', `权限不足，无法读取配置 ${file} (${e.code})`, permissionNextHint(file, opts.platform));
      }
      throw makeDiagError('invalid_config_path', `无法读取配置 ${file}: ${e.message}`, `检查路径 "${file}"`);
    }
    if (!st.isFile()) {
      throw makeDiagError('invalid_config_path', `配置路径不是普通文件: ${file}`, `确认 "${file}" 不是目录`);
    }
    try {
      prev = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (isPermError(e)) {
        throw makeDiagError('permission_denied', `权限不足，无法读取配置 ${file} (${e.code})`, permissionNextHint(file, opts.platform));
      }
      throw makeDiagError('read_failed', `读取配置失败 ${file}: ${e.message}`, `检查文件 "${file}"`);
    }
  }

  let text;
  if (client.format === 'toml') {
    text = mergeToml(prev, spec);
  } else if (client.format === 'json-mcpServers') {
    text = mergeJson(file, prev, 'mcpServers', (data) => {
      data.mcpServers = data.mcpServers || {};
      data.mcpServers.agentbus = { command: spec.command, args: spec.args, env: spec.env };
    });
  } else if (client.format === 'json-opencode') {
    text = mergeJson(file, prev, 'mcp', (data) => {
      data.mcp = data.mcp || {};
      data.mcp.agentbus = { type: 'local', command: [spec.command, ...spec.args], enabled: true, environment: spec.env };
    });
  } else {
    throw new Error(`unknown client format: ${client.format}`);
  }

  const unchanged = exists && prev.replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n');
  if (unchanged) {
    return {
      client: client.id,
      file,
      config_dir: dir,
      backup: null,
      changed: false,
      ...(opts.dryRun ? { dry_run: true, preview: text.slice(0, 400) } : {}),
    };
  }

  if (opts.requireConfigDir && !fs.existsSync(dir)) {
    throw makeDiagError(
      'missing_config_dir',
      `缺少配置目录: ${dir}`,
      `先运行一次 ${client.label} 或创建目录后重试（或去掉 --require-config-dir 让 setup 自动创建）`,
    );
  }

  if (opts.dryRun) {
    return { client: client.id, file, config_dir: dir, backup: null, changed: true, dry_run: true, preview: text.slice(0, 400) };
  }

  checkTargetWritable(file, opts.platform);
  const bak = backupIfExists(file);
  try {
    writeAtomic(file, text, opts.platform);
  } catch (e) {
    if (bak && fs.existsSync(bak)) {
      try { fs.unlinkSync(bak); } catch {}
    }
    throw e;
  }
  return { client: client.id, file, config_dir: dir, backup: bak, changed: true };
}

export function setupClients({
  clients,
  root,
  allowed,
  bin,
  home,
  dryRun,
  env,
  requireConfigDir = false,
  platform = process.platform,
  processEnv = process.env,
}) {
  const ids = clients && clients.length ? clients : CLIENTS.map((c) => c.id);
  const unknown = ids.filter((id) => !CLIENTS.some((c) => c.id === id));
  if (unknown.length) {
    throw Object.assign(new Error(`未知客户端: ${unknown.join(', ')}；可选: ${listClients().join(', ')}`), { code: 1 });
  }
  const explicitHome = home !== undefined && home !== null && path.resolve(home) !== path.resolve(os.homedir());
  const resolvedHome = path.resolve(home || os.homedir());
  const opts = {
    root: root || defaultRoot(),
    allowed,
    bin: bin || 'node',
    home: resolvedHome,
    explicitHome,
    dryRun: !!dryRun,
    env,
    requireConfigDir: !!requireConfigDir,
    platform,
    processEnv,
  };
  const results = [];
  for (const id of ids) {
    const client = CLIENTS.find((c) => c.id === id);
    const binInfo = client.hasBinary
      ? resolveAgentBin(id, { home: resolvedHome, env: processEnv, platform, explicitHome })
      : null;
    try {
      const res = applyClient(client, opts);
      const entry = {
        ok: true,
        ...res,
        ...(binInfo ? { bin: binInfo.bin, bin_source: binInfo.source } : {}),
      };
      if (binInfo && !binInfo.bin) {
        entry.warnings = [{ code: binInfo.error, message: binInfo.message, next: binInfo.next }];
      }
      results.push(entry);
    } catch (e) {
      results.push({
        ok: false,
        client: id,
        file: clientConfigFile(id, resolvedHome, platform),
        error_code: e?.errorCode || 'setup_failed',
        error: String(e?.message || e),
        ...(e?.next ? { next: e.next } : {}),
        ...(binInfo ? { bin: binInfo.bin } : {}),
      });
    }
  }
  return {
    ok: results.every((r) => r.ok),
    home: resolvedHome,
    root: path.resolve(opts.root),
    allowed_roots: serverSpec(opts).env.AGENTBUS_ALLOWED_ROOTS.split(path.delimiter),
    server: serverSpec(opts),
    results,
  };
}

// ---------- doctor ----------

function inspectConfigEntry(file, format) {
  if (!fs.existsSync(file)) return { configured: null, error: null };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { configured: null, error: `${e.code || 'READ_ERROR'}: ${e.message}` };
  }
  if (format === 'toml') {
    const has = /^\s*\[\s*mcp_servers\.(?:agentbus|"agentbus"|'agentbus')\s*\]/m.test(raw);
    return { configured: has, error: null };
  }
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return { configured: false, error: null };
  try {
    const data = JSON.parse(trimmed);
    if (!isPlainObject(data)) return { configured: null, error: '顶层不是 JSON 对象' };
    if (format === 'json-mcpServers') {
      if (data.mcpServers !== undefined && !isPlainObject(data.mcpServers)) {
        return { configured: null, error: 'mcpServers 字段不是对象' };
      }
      return { configured: Boolean(data.mcpServers && data.mcpServers.agentbus), error: null };
    }
    if (format === 'json-opencode') {
      if (data.mcp !== undefined && !isPlainObject(data.mcp)) {
        return { configured: null, error: 'mcp 字段不是对象' };
      }
      return { configured: Boolean(data.mcp && data.mcp.agentbus), error: null };
    }
    return { configured: null, error: null };
  } catch (e) {
    return { configured: null, error: `JSON 损坏: ${e.message}` };
  }
}

function checkClientWritableState(file, platform) {
  const dir = path.dirname(file);
  if (fs.existsSync(file)) {
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return { writable: false, code: 'invalid_config_path', reason: 'not_a_file', path: file };
      fs.accessSync(file, fs.constants.W_OK);
    } catch (e) {
      return { writable: false, code: 'permission_denied', reason: e.code || 'EACCES', path: file };
    }
  }
  const d = checkDirWritable(dir, platform);
  if (!d.ok) return { writable: false, code: d.code, reason: d.reason, path: d.path };
  return { writable: true, code: null, reason: null, path: null };
}

export function doctor({ home, root, env = process.env, platform = process.platform } = {}) {
  const explicitHome = home !== undefined && home !== null && path.resolve(home) !== path.resolve(os.homedir());
  const h = path.resolve(home || os.homedir());
  const r = path.resolve(root || defaultRoot());
  const rootCheck = checkDirWritable(r, platform);

  const diagnostics = [];
  if (!rootCheck.ok) {
    const next = rootCheck.code === 'permission_denied'
      ? permissionNextHint(rootCheck.path, platform)
      : `确认 --root 路径有效并有权限创建: "${r}"`;
    diagnostics.push({
      target: 'root',
      code: rootCheck.code,
      message: `总线根目录不可写 ${rootCheck.path} (${rootCheck.reason})`,
      next,
    });
  }

  const binMap = new Map();
  for (const c of CLIENTS) {
    if (!c.hasBinary) continue;
    binMap.set(c.id, resolveAgentBin(c.id, { home: h, env, platform, explicitHome }));
  }

  const clients = CLIENTS.map((c) => {
    const file = clientConfigFile(c.id, h, platform);
    const dir = path.dirname(file);
    const dirExists = fs.existsSync(dir);
    const exists = fs.existsSync(file);
    const entry = inspectConfigEntry(file, c.format);
    const writeState = checkClientWritableState(file, platform);
    const binInfo = binMap.get(c.id) || null;
    const issues = [];

    if (binInfo && !binInfo.bin) {
      issues.push({ code: binInfo.error, message: binInfo.message, next: binInfo.next });
    }
    if (!dirExists) {
      issues.push({
        code: 'missing_config_dir',
        message: `缺少配置目录: ${dir}`,
        next: `运行 setup 自动创建并写入配置: node "${BUS_BIN}" setup --client ${c.id} --home "${h}" --root "${r}"`,
      });
    }
    if (!writeState.writable) {
      issues.push({
        code: writeState.code,
        message: `权限不足或路径不可写: ${writeState.path} (${writeState.reason})`,
        next: writeState.code === 'permission_denied'
          ? permissionNextHint(writeState.path, platform)
          : `检查配置目录父路径 "${writeState.path}"`,
      });
    }
    if (entry.error) {
      issues.push({
        code: 'corrupted_config',
        message: `配置文件解析失败 (${file}): ${entry.error}`,
        next: `请先手动修复或移除损坏的配置文件 "${file}"，再重跑 setup`,
      });
    } else if (!entry.configured) {
      issues.push({
        code: 'not_configured',
        message: `${c.label} 尚未配置 agentbus MCP`,
        next: `运行: node "${BUS_BIN}" setup --client ${c.id} --home "${h}" --root "${r}"`,
      });
    }

    for (const iss of issues) {
      diagnostics.push({ target: c.id, ...iss });
    }

    return {
      id: c.id,
      label: c.label,
      config: file,
      config_dir: dir,
      config_dir_exists: dirExists,
      exists,
      configured: entry.configured,
      config_error: entry.error,
      writable: writeState.writable,
      ...(c.hasBinary ? {
        bin: binInfo?.bin || null,
        bin_source: binInfo?.source || null,
        installed: Boolean(binInfo?.bin || exists),
      } : {}),
      issues,
    };
  });

  const nextSteps = [];
  const seenNext = new Set();
  for (const d of diagnostics) {
    if (d.next && !seenNext.has(d.next)) {
      seenNext.add(d.next);
      nextSteps.push(d.next);
    }
  }

  const anyConfigured = clients.some((c) => c.configured === true);
  return {
    node: process.version,
    platform: `${platform}-${process.arch}`,
    sqlite: (() => {
      try {
        return typeof process.getBuiltinModule === 'function' ? 'available' : 'unknown';
      } catch { return 'unknown'; }
    })(),
    home: h,
    root: r,
    root_exists: fs.existsSync(r),
    root_writable: rootCheck.ok,
    clients,
    diagnostics,
    next_steps: nextSteps,
    next: anyConfigured
      ? 'At least one client is configured. Restart that client to load the agentbus tools.'
      : `No client configured yet. Run: node "${BUS_BIN}" setup --client <id> --home "${h}" --root "${r}"`,
  };
}
