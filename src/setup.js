// Client auto-configuration for agentbus.
// Writes (or updates) the MCP server entry for supported agent CLIs.
// Rules: idempotent, always backs up the target file before modification, never touches unrelated keys.

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentConfigPath, clientConfigFile, hermesPaths, readAgentConfig, resolveAgentBin } from './agents.js';
import { resolveCdpPort } from './agy.js';
import { loadConfig, PKG_ROOT } from './db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUS_BIN = path.resolve(HERE, '..', 'bin', 'bus.js');
const MCP_FILE = path.resolve(HERE, 'mcp.js');

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

function serverSpec({ root, allowed, bin = 'node', env: extraEnv, role, allowDispatch }) {
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

  const resolvedRoot = path.resolve(root);
  const candidateRole = String((extraEnv && extraEnv.AGENTBUS_ROLE) ?? role ?? 'worker').trim().toLowerCase();
  const normalizedRole = candidateRole === 'conductor' ? 'conductor' : 'worker';
  const enableDispatch = Boolean(allowDispatch) || String(extraEnv?.AGENTBUS_ENABLE_DISPATCH || '') === '1';

  const env = {
    AGENTBUS_ROOT: resolvedRoot,
    AGENTBUS_ALLOWED_ROOTS: roots.join(path.delimiter),
    ...(extraEnv || {}),
    AGENTBUS_ROLE: normalizedRole,
    AGENTBUS_ENABLE_DISPATCH: enableDispatch ? '1' : '0',
  };
  if (bin === 'npx') {
    return { command: 'npx', args: ['-y', 'agentbus-mcp', 'mcp', '--root', resolvedRoot], env };
  }
  return {
    command: process.env.AGENTBUS_MCP_COMMAND || process.execPath,
    args: [BUS_BIN, 'mcp', '--root', resolvedRoot],
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

function validateTomlText(raw) {
  const clean = String(raw || '').replace(/^\uFEFF/, '');
  if (!clean.trim()) return null;
  const lines = clean.split(/\r?\n/);
  let multilineDelim = null;
  let bracketDepth = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const startMultiline = Boolean(multilineDelim);
    const startBracketDepth = bracketDepth;
    let i = 0;
    let code = '';

    while (i < line.length) {
      if (multilineDelim) {
        if (line.startsWith(multilineDelim, i)) {
          i += 3;
          multilineDelim = null;
          continue;
        }
        if (multilineDelim === '"""' && line[i] === '\\') {
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      const ch = line[i];
      if (ch === '#') break;
      if (line.startsWith('"""', i)) {
        multilineDelim = '"""';
        code += '""';
        i += 3;
        continue;
      }
      if (line.startsWith("'''", i)) {
        multilineDelim = "'''";
        code += "''";
        i += 3;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        code += quote;
        i++;
        let closed = false;
        while (i < line.length) {
          const c = line[i];
          if (quote === '"' && c === '\\') {
            i += 2;
            continue;
          }
          if (c === quote) {
            closed = true;
            code += quote;
            i++;
            break;
          }
          i++;
        }
        if (!closed) {
          return `第 ${idx + 1} 行字符串未闭合`;
        }
        continue;
      }
      if (ch === '[') bracketDepth++;
      else if (ch === ']') {
        bracketDepth--;
        if (bracketDepth < 0) return `第 ${idx + 1} 行存在多余的 ]`;
      }
      code += ch;
      i++;
    }

    if (multilineDelim) continue;
    const trimmed = code.trim();
    if (!trimmed) continue;
    if (bracketDepth > 0) continue;
    if (startBracketDepth > 0 || startMultiline) continue;

    if (trimmed.startsWith('[')) {
      const hdr = parseTomlSectionHeader(line);
      if (!hdr) return `第 ${idx + 1} 行 section 头语法错误: ${trimmed.slice(0, 40)}`;
      if (!hdr.arrayTable && (!hdr.parts || hdr.parts.length === 0 || hdr.parts.some((p) => !p))) {
        return `第 ${idx + 1} 行 section 名无效`;
      }
      continue;
    }

    if (!trimmed.includes('=')) {
      return `第 ${idx + 1} 行缺少 '=' 赋值: ${trimmed.slice(0, 40)}`;
    }
  }

  if (multilineDelim) return '存在未闭合的多行字符串';
  if (bracketDepth !== 0) return '存在未闭合的 [ ] 方括号';
  return null;
}

function mergeToml(prev, spec, file = 'config.toml') {
  const tomlErr = validateTomlText(prev);
  if (tomlErr) {
    throw makeDiagError(
      'corrupted_config',
      `${file} 不是合法 TOML，已停止（未写入且未覆盖）: ${tomlErr}`,
      `请先修复或手动备份后清理该损坏文件: "${file}"`,
    );
  }
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
  { id: 'codex', label: 'OpenAI Codex CLI', format: 'toml', hasBinary: true, optional: false },
  { id: 'claude', label: 'Claude Code', format: 'json-mcpServers', hasBinary: true, optional: false },
  { id: 'gemini', label: 'Gemini CLI', format: 'json-mcpServers', hasBinary: true, optional: false },
  { id: 'antigravity', label: 'Google Antigravity', format: 'json-mcpServers', hasBinary: true, optional: false },
  { id: 'cursor', label: 'Cursor', format: 'json-mcpServers', hasBinary: false, optional: false },
  { id: 'opencode', label: 'OpenCode', format: 'json-opencode', hasBinary: true, optional: false },
  { id: 'claude-desktop', label: 'Claude Desktop', format: 'json-mcpServers', hasBinary: false, optional: false },
  { id: 'windsurf', label: 'Windsurf', format: 'json-mcpServers', hasBinary: false, optional: true },
  { id: 'kiro', label: 'Kiro', format: 'json-mcpServers', hasBinary: false, optional: true },
  { id: 'lmstudio', label: 'LM Studio', format: 'json-mcpServers', hasBinary: false, optional: true },
  { id: 'cline', label: 'Cline', format: 'json-mcpServers', hasBinary: false, optional: true },
  { id: 'dsh', label: 'DeepSeek Harness', format: 'dsh-cordis', hasBinary: false, optional: true },
  { id: 'hermes', label: 'Hermes Agent', format: 'hermes-cli', hasBinary: false, optional: true },
];

function clineExtensionDir(home, platform) {
  if (platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
  }
  return path.join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
}

function resolveClientConfigPath(id, home, platform, explicitHome, env) {
  return clientConfigFile(id, home, platform, { explicitHome, env });
}

function isRegularNonEmptyFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function hasNonEmptyDshProfile(home) {
  const desktopDir = path.join(home, '.dsh', 'profiles', 'desktop');
  if (!fs.existsSync(desktopDir)) return false;
  try {
    const entries = fs.readdirSync(desktopDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name.includes('.bak-')) continue;
      const full = path.join(desktopDir, ent.name);
      if (ent.isFile() && isRegularNonEmptyFile(full)) return true;
      if (ent.isDirectory()) {
        const sub = fs.readdirSync(full, { withFileTypes: true });
        if (sub.some((s) => !s.name.includes('.bak-') && s.isFile())) return true;
      }
    }
  } catch {}
  return false;
}

function getEnvVar(env, key) {
  if (!env || typeof env !== 'object') return undefined;
  if (env[key] !== undefined) return env[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower) return env[k];
  }
  return undefined;
}

function setEnvVar(env, key, value) {
  if (!env || typeof env !== 'object') return;
  const lower = key.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower && k !== key) {
      delete env[k];
    }
  }
  env[key] = value;
}

function resolveWinCmd(env) {
  const comspec = getEnvVar(env, 'ComSpec');
  if (comspec && String(comspec).trim()) {
    const p = String(comspec).trim();
    if (fs.existsSync(p)) return p;
  }
  const sysRoot = getEnvVar(env, 'SystemRoot')
    || getEnvVar(env, 'windir')
    || process.env.SystemRoot
    || process.env.windir
    || 'C:\\Windows';
  const candidate = path.win32.join(String(sysRoot).trim(), 'System32', 'cmd.exe');
  if (fs.existsSync(candidate)) return candidate;
  const fallback = 'C:\\Windows\\System32\\cmd.exe';
  if (fs.existsSync(fallback)) return fallback;
  return 'cmd.exe';
}

function findDshExecutable(home, { platform = process.platform, explicitHome = false, env = process.env } = {}) {
  const rawOverride = getEnvVar(env, 'AGENTBUS_DSH_BIN');
  const override = rawOverride && String(rawOverride).trim();
  if (override) {
    try {
      if (fs.existsSync(override) && fs.statSync(override).isFile()) return override;
    } catch {}
    return null;
  }
  const onPath = findExecutable('dsh', env, platform);
  if (onPath) return onPath;
  if (explicitHome) return null;
  const h = path.resolve(home || os.homedir());
  if (platform === 'win32') {
    const rawLocalAppData = getEnvVar(env, 'LOCALAPPDATA');
    const localAppData = rawLocalAppData && String(rawLocalAppData).trim()
      ? path.resolve(String(rawLocalAppData).trim())
      : path.join(h, 'AppData', 'Local');
    const cands = [
      path.join(localAppData, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
      path.join(localAppData, 'Programs', 'dsh', 'dsh.exe'),
    ];
    for (const c of cands) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      } catch {}
    }
  }
  return null;
}

function clientInstalled(client, home, { platform = process.platform, explicitHome = false, env = process.env } = {}) {
  const h = path.resolve(home || os.homedir());
  const cfg = resolveClientConfigPath(client.id, h, platform, explicitHome, env);
  if (client.optional) {
    switch (client.id) {
      case 'windsurf':
        return fs.existsSync(path.join(h, '.codeium', 'windsurf')) || fs.existsSync(cfg);
      case 'kiro':
        return fs.existsSync(path.join(h, '.kiro')) || fs.existsSync(cfg);
      case 'lmstudio':
        return fs.existsSync(path.join(h, '.lmstudio')) || fs.existsSync(cfg);
      case 'cline':
        return fs.existsSync(path.join(h, '.cline')) || fs.existsSync(clineExtensionDir(h, platform)) || fs.existsSync(cfg);
      case 'dsh':
        return Boolean(findDshExecutable(h, { platform, explicitHome, env })) ||
          isRegularNonEmptyFile(cfg) ||
          hasNonEmptyDshProfile(h);
      case 'hermes': {
        const hp = hermesPaths(h, { platform, explicitHome, env });
        return fs.existsSync(hp.hermesHome) ||
          fs.existsSync(hp.file) ||
          Boolean(findHermesExecutable(h, { platform, explicitHome, env }));
      }
      default:
        return fs.existsSync(cfg);
    }
  }
  if (client.hasBinary) {
    // A config directory or a leftover config file is not evidence that the
    // client executable exists. Treat binary-backed clients as installed only
    // when the binary is actually discoverable; otherwise doctor --fix could
    // write agentbus into unrelated configs (Gemini/Cursor/OpenCode/etc.).
    const binInfo = resolveAgentBin(client.id, { home: h, env, platform, explicitHome });
    return Boolean(binInfo?.bin);
  }
  if (fs.existsSync(cfg)) return true;
  if (client.id !== 'claude' && fs.existsSync(path.dirname(cfg))) return true;
  return false;
}

export function listClients() {
  return CLIENTS.map((c) => c.id);
}

export function describeClients({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const explicitHome = home !== undefined && home !== null && path.resolve(home) !== path.resolve(os.homedir());
  const h = path.resolve(home || os.homedir());
  return CLIENTS.map((c) => ({
    id: c.id,
    label: c.label,
    format: c.format,
    config: resolveClientConfigPath(c.id, h, platform, explicitHome, env),
    optional: Boolean(c.optional),
    installed: clientInstalled(c, h, { platform, explicitHome, env }),
  }));
}

// ---------- DSH (Cordis plugin tree) ----------

function yamlQuote(v) {
  return JSON.stringify(String(v));
}

function dshBlock(spec) {
  const envLines = Object.entries(spec.env)
    .map(([k, v]) => `          ${k}: ${yamlQuote(v)}`)
    .join('\n');
  return [
    '# BEGIN agentbus-managed',
    '- insert:',
    '    - id: agentbus-mcp',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        transport: stdio',
    '        serverName: agentbus',
    `        command: ${yamlQuote(spec.command)}`,
    `        args: [${spec.args.map(yamlQuote).join(', ')}]`,
    '        env:',
    envLines,
    '        failOnStartupError: false',
    '# END agentbus-managed',
  ].join('\n');
}

function mergeDshPatch(file, prev, spec) {
  const norm = String(prev || '').replace(/\r\n/g, '\n');
  const hasBegin = /# BEGIN agentbus-managed/.test(norm);
  const hasEnd = /# END agentbus-managed/.test(norm);
  if (hasBegin !== hasEnd) {
    throw makeDiagError(
      'corrupted_config',
      `${file} 中的 agentbus-managed 标记不成对，已停止（未写入且未覆盖）`,
      `请修复或移除 "${file}" 中不完整的 # BEGIN/END agentbus-managed 块`,
    );
  }
  const block = dshBlock(spec);
  const marker = /# BEGIN agentbus-managed[\s\S]*?# END agentbus-managed/;
  if (marker.test(norm)) {
    const replaced = norm.replace(marker, block);
    return replaced.endsWith('\n') ? replaced : `${replaced}\n`;
  }
  const trimmed = norm.trim();
  if (!trimmed || trimmed === '[]') {
    return `${block}\n`;
  }
  const firstMeaningful = norm
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && l !== '---');
  if (firstMeaningful && !firstMeaningful.startsWith('-')) {
    throw makeDiagError(
      'corrupted_config',
      `${file} 顶层不是 YAML 列表（- ...），无法安全合并 agentbus 插件块`,
      `请确认 "${file}" 为 Cordis patch YAML 列表格式，或手动添加 @deepseek-ai/dsh-mcp-client 节点`,
    );
  }
  const base = norm.replace(/\s+$/, '');
  return `${base}\n\n${block}\n`;
}

// ---------- Hermes (native MCP CLI) ----------

function findExecutable(name, env, platform = process.platform) {
  const pathVar = getEnvVar(env, 'PATH') || '';
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const rawDir of String(pathVar).split(platform === 'win32' ? ';' : path.delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function findHermesExecutable(home, { platform = process.platform, explicitHome = false, env = process.env } = {}) {
  const rawOverride = getEnvVar(env, 'AGENTBUS_HERMES_BIN');
  const override = rawOverride && String(rawOverride).trim();
  if (override) {
    try {
      if (fs.existsSync(override) && fs.statSync(override).isFile()) return override;
    } catch {}
    return null;
  }
  const h = path.resolve(home || os.homedir());
  if (explicitHome) {
    const fakeLocalBin = platform === 'win32'
      ? path.join(h, 'AppData', 'Local', 'hermes', 'bin')
      : path.join(h, '.local', 'bin');
    return findExecutable('hermes', { PATH: fakeLocalBin }, platform);
  }
  const onPath = findExecutable('hermes', env, platform);
  if (onPath) return onPath;
  const rawLocalAppData = getEnvVar(env, 'LOCALAPPDATA');
  const commonBins = platform === 'win32'
    ? [
        path.join(
          rawLocalAppData && String(rawLocalAppData).trim()
            ? path.resolve(String(rawLocalAppData).trim())
            : path.join(h, 'AppData', 'Local'),
          'hermes',
          'bin',
        ),
        path.join(h, '.local', 'bin'),
      ]
    : [path.join(h, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  return findExecutable('hermes', { PATH: commonBins.join(platform === 'win32' ? ';' : path.delimiter) }, platform);
}

function hasHermesAgentbus(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  let inMcpServers = false;
  let childIndent = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inMcpServers = /^mcp_servers\s*:/.test(trimmed);
      childIndent = null;
      continue;
    }
    if (!inMcpServers) continue;
    if (childIndent === null) childIndent = indent;
    if (indent === childIndent && /^(['"]?)agentbus\1\s*:/.test(trimmed)) {
      return true;
    }
  }
  return false;
}

function winQuoteArg(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

function spawnHermes(bin, args, { env, input, platform = process.platform }) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const exe = String(bin).replace(/\//g, '\\');
    const inner = [exe, ...args].map(winQuoteArg).join(' ');
    return spawnSync(resolveWinCmd(env), ['/d', '/s', '/c', `"${inner}"`], {
      encoding: 'utf8',
      timeout: 30000,
      env,
      input,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 30000,
    env,
    input,
    windowsHide: true,
  });
}

function formatCmdPreview(bin, args) {
  return [bin, ...args].map((s) => (/\s/.test(String(s)) ? JSON.stringify(String(s)) : String(s))).join(' ');
}

function applyHermes(spec, opts) {
  const { hermesHome, file } = hermesPaths(opts.home, {
    platform: opts.platform,
    explicitHome: opts.explicitHome,
    env: opts.processEnv,
  });
  const bin = findHermesExecutable(opts.home, {
    platform: opts.platform,
    explicitHome: opts.explicitHome,
    env: opts.processEnv,
  });
  if (!bin) {
    throw makeDiagError(
      'missing_binary',
      '未找到 hermes 可执行文件，无法写入 Hermes MCP 配置',
      '先安装 Hermes CLI，或设置 AGENTBUS_HERMES_BIN 指向 hermes 可执行文件后重试',
    );
  }

  const envPairs = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);
  const addArgs = ['mcp', 'add', 'agentbus'];
  if (envPairs.length) addArgs.push('--env', ...envPairs);
  addArgs.push('--command', spec.command, '--args', ...spec.args);

  let alreadyInYaml = false;
  if (fs.existsSync(file)) {
    try {
      alreadyInYaml = hasHermesAgentbus(fs.readFileSync(file, 'utf8'));
    } catch {}
  }

  if (opts.dryRun) {
    return {
      client: 'hermes',
      file,
      config_dir: hermesHome,
      hermes_home: hermesHome,
      backup: null,
      changed: !alreadyInYaml,
      dry_run: true,
      command: formatCmdPreview(bin, addArgs),
    };
  }

  if (opts.requireConfigDir && !fs.existsSync(hermesHome)) {
    throw makeDiagError(
      'missing_config_dir',
      `缺少配置目录: ${hermesHome}`,
      `先运行一次 Hermes 或创建目录后重试（或去掉 --require-config-dir 让 setup 自动创建）`,
    );
  }

  if (alreadyInYaml) {
    return {
      client: 'hermes',
      file,
      config_dir: hermesHome,
      hermes_home: hermesHome,
      backup: null,
      changed: false,
      note: 'agentbus 已在 Hermes 配置中，跳过重复添加',
    };
  }

  const childEnv = { ...opts.processEnv };
  if (opts.explicitHome) {
    setEnvVar(childEnv, 'HERMES_HOME', hermesHome);
    setEnvVar(childEnv, 'HOME', opts.home);
    setEnvVar(childEnv, 'USERPROFILE', opts.home);
    if (opts.platform === 'win32') {
      setEnvVar(childEnv, 'LOCALAPPDATA', path.join(opts.home, 'AppData', 'Local'));
      setEnvVar(childEnv, 'APPDATA', path.join(opts.home, 'AppData', 'Roaming'));
    }
  }

  if (fs.existsSync(hermesHome)) {
    const preList = spawnHermes(bin, ['mcp', 'list'], { env: childEnv, platform: opts.platform });
    if (!preList.error && preList.status === 0 && /^\s*(?:[-*]\s*)?agentbus(?:\s|:|$)/m.test(preList.stdout || '')) {
      return {
        client: 'hermes',
        file,
        config_dir: hermesHome,
        hermes_home: hermesHome,
        backup: null,
        changed: false,
        note: 'hermes mcp list 已包含 agentbus，跳过重复添加',
      };
    }
  }

  checkTargetWritable(file, opts.platform);
  const existedBefore = fs.existsSync(file);
  const backup = existedBefore ? backupIfExists(file) : null;
  fs.mkdirSync(hermesHome, { recursive: true });

  const rollback = () => {
    if (backup && fs.existsSync(backup)) {
      try { fs.copyFileSync(backup, file); } catch {}
    } else if (!existedBefore && fs.existsSync(file)) {
      try { fs.unlinkSync(file); } catch {}
    }
  };

  const r = spawnHermes(bin, addArgs, { env: childEnv, input: 'y\n', platform: opts.platform });
  if (r.error || r.status !== 0) {
    rollback();
    const detail = (r.stderr || r.stdout || r.error?.message || '').trim().split('\n').slice(-4).join(' | ');
    throw makeDiagError(
      'hermes_cli_failed',
      `hermes mcp add 失败 (exit ${r.status ?? 'error'}): ${detail || '无输出'}`,
      `手动运行: hermes mcp add agentbus --command "${spec.command}" --args ${spec.args.join(' ')}`,
    );
  }
  const combined = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (/Cancelled/i.test(combined)) {
    rollback();
    throw makeDiagError(
      'hermes_cli_cancelled',
      'hermes mcp add 在非交互环境被取消（需要确认启用工具）',
      `在终端手动运行: hermes mcp add agentbus --command "${spec.command}" --args ${spec.args.join(' ')}，按提示输入 y`,
    );
  }

  const verifyList = spawnHermes(bin, ['mcp', 'list'], { env: childEnv, platform: opts.platform });
  const verifyOut = `${verifyList.stdout || ''}\n${verifyList.stderr || ''}`;
  if (verifyList.error || verifyList.status !== 0 || !/\bagentbus\b/.test(verifyList.stdout || '')) {
    rollback();
    throw makeDiagError(
      'hermes_verify_failed',
      `hermes mcp list 未确认到 agentbus（已回滚，exit ${verifyList.status ?? 'error'}）: ${verifyOut.trim().slice(0, 200)}`,
      '运行 hermes mcp list 检查 HERMES_HOME 与配置状态，或手动执行 hermes mcp add agentbus',
    );
  }

  return {
    client: 'hermes',
    file,
    config_dir: hermesHome,
    hermes_home: hermesHome,
    backup,
    changed: true,
    verified_by: 'hermes mcp list',
    ...(r.stdout?.trim() ? { stdout: r.stdout.trim().split('\n').slice(-6).join('\n') } : {}),
  };
}

function applyClient(client, opts) {
  const spec = serverSpec(opts);
  if (client.format === 'hermes-cli') return applyHermes(spec, opts);

  const file = clientConfigFile(client.id, opts.home, opts.platform, {
    explicitHome: opts.explicitHome,
    env: opts.processEnv,
  });
  const dir = path.dirname(file);
  const exists = fs.existsSync(file);

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
    text = mergeToml(prev, spec, file);
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
  } else if (client.format === 'dsh-cordis') {
    text = mergeDshPatch(file, prev, spec);
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
      ...(client.id === 'dsh' ? { restart_required: true } : {}),
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
  return {
    client: client.id,
    file,
    config_dir: dir,
    backup: bak,
    changed: true,
    ...(client.id === 'dsh' ? {
      restart_required: true,
      note: '已写入 DSH 配置，请重启 DeepSeek Harness (DSH) 使配置生效（不会自动重启）',
    } : {}),
  };
}

export function setupClients({
  clients,
  root,
  allowed,
  bin,
  home,
  dryRun,
  env,
  role,
  allowDispatch = false,
  requireConfigDir = false,
  platform = process.platform,
  processEnv = process.env,
}) {
  const explicitHome = home !== undefined && home !== null && path.resolve(home) !== path.resolve(os.homedir());
  const resolvedHome = path.resolve(home || os.homedir());
  const explicitClients = Boolean(clients && clients.length);
  const skippedOptional = [];
  const ids = explicitClients
    ? clients
    : CLIENTS.filter((c) => {
      if (!c.optional) return true;
      const inst = clientInstalled(c, resolvedHome, { platform, explicitHome, env: processEnv });
      if (!inst) skippedOptional.push(c.id);
      return inst;
    }).map((c) => c.id);

  const unknown = ids.filter((id) => !CLIENTS.some((c) => c.id === id));
  if (unknown.length) {
    throw Object.assign(new Error(`未知客户端: ${unknown.join(', ')}；可选: ${listClients().join(', ')}`), { code: 1 });
  }

  const opts = {
    root: root || defaultRoot(),
    allowed,
    bin: bin || 'node',
    home: resolvedHome,
    explicitHome,
    dryRun: !!dryRun,
    env,
    role,
    allowDispatch: !!allowDispatch,
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
        file: resolveClientConfigPath(id, resolvedHome, platform, explicitHome, processEnv),
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
    ...(skippedOptional.length ? { skipped_optional: skippedOptional } : {}),
  };
}

// ---------- doctor ----------

function validateDshPatchText(raw) {
  const norm = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const hasBegin = /# BEGIN agentbus-managed/.test(norm);
  const hasEnd = /# END agentbus-managed/.test(norm);
  if (hasBegin !== hasEnd) {
    return 'agentbus-managed 标记不成对';
  }
  const lines = norm.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (/^\t+/.test(line)) return `第 ${idx + 1} 行包含非法 Tab 缩进`;
  }
  const firstMeaningful = lines
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && l !== '---');
  if (firstMeaningful && firstMeaningful !== '[]' && !firstMeaningful.startsWith('-')) {
    return '顶层不是 YAML 列表（- ...）';
  }
  return null;
}

function validateHermesYamlText(raw) {
  const norm = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!norm.trim()) return null;
  const lines = norm.split('\n');
  let inBlockScalar = false;
  let blockIndent = -1;
  let inMcpServers = false;
  let mcpChildIndent = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (/^\t+/.test(line)) return `第 ${idx + 1} 行包含非法 Tab 缩进`;
    const indent = line.length - line.trimStart().length;

    if (inBlockScalar) {
      if (indent > blockIndent) continue;
      inBlockScalar = false;
      blockIndent = -1;
    }

    if (indent === 0) {
      inMcpServers = false;
      mcpChildIndent = null;
      if (t === '---' || t === '...') continue;
      if (!/^[A-Za-z0-9_."'/-]+\s*:/.test(t)) {
        return `第 ${idx + 1} 行顶层不是合法 YAML 映射键`;
      }
      const mcpMatch = /^mcp_servers\s*:(.*)$/.exec(t);
      if (mcpMatch) {
        const rest = mcpMatch[1].replace(/\s+#.*$/, '').trim();
        if (rest && rest !== '{}' && rest !== 'null' && rest !== '~') {
          return 'mcp_servers 字段不是映射对象';
        }
        if (!rest) inMcpServers = true;
      }
      if (/:\s*[|>][+-]?\d*\s*(?:#.*)?$/.test(t)) {
        inBlockScalar = true;
        blockIndent = indent;
      }
      continue;
    }

    if (inMcpServers) {
      if (mcpChildIndent === null) mcpChildIndent = indent;
      if (indent === mcpChildIndent && t.startsWith('-')) {
        return 'mcp_servers 字段不是映射对象（不能是列表）';
      }
    }
    if (/:\s*[|>][+-]?\d*\s*(?:#.*)?$/.test(t)) {
      inBlockScalar = true;
      blockIndent = indent;
    }
  }
  return null;
}

function inspectConfigEntry(file, format) {
  if (!fs.existsSync(file)) return { configured: null, error: null };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { configured: null, error: `${e.code || 'READ_ERROR'}: ${e.message}` };
  }
  if (format === 'toml') {
    const tomlErr = validateTomlText(raw);
    if (tomlErr) {
      return { configured: null, error: `TOML 损坏: ${tomlErr}` };
    }
    const has = /^\s*\[\s*mcp_servers\.(?:agentbus|"agentbus"|'agentbus')\s*\]/m.test(raw);
    return { configured: has, error: null };
  }
  if (format === 'dsh-cordis') {
    const dshErr = validateDshPatchText(raw);
    if (dshErr) {
      return { configured: null, error: dshErr };
    }
    const has = /# BEGIN agentbus-managed[\s\S]*?id:\s*agentbus-mcp[\s\S]*?# END agentbus-managed/.test(raw);
    return { configured: has, error: null };
  }
  if (format === 'hermes-cli') {
    const yamlErr = validateHermesYamlText(raw);
    if (yamlErr) {
      return { configured: null, error: `YAML 损坏: ${yamlErr}` };
    }
    return { configured: hasHermesAgentbus(raw), error: null };
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

  const optionalHints = [];
  const clients = CLIENTS.map((c) => {
    const file = resolveClientConfigPath(c.id, h, platform, explicitHome, env);
    const dir = path.dirname(file);
    const dirExists = fs.existsSync(dir);
    const exists = fs.existsSync(file);
    if (c.optional && !clientInstalled(c, h, { platform, explicitHome, env })) {
      optionalHints.push(`可选客户端 ${c.label} 未安装；如需接入可运行: node "${BUS_BIN}" setup --client ${c.id} --home "${h}" --root "${r}"`);
      return {
        id: c.id,
        label: c.label,
        optional: true,
        installed: false,
        skipped: true,
        config: file,
        config_dir: dir,
        config_dir_exists: dirExists,
        exists,
        configured: null,
        config_error: null,
        writable: null,
        issues: [],
      };
    }

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
      optional: Boolean(c.optional),
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
        installed: Boolean(binInfo?.bin),
      } : {
        installed: clientInstalled(c, h, { platform, explicitHome, env }),
      }),
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
  for (const hStep of optionalHints) {
    if (!seenNext.has(hStep)) {
      seenNext.add(hStep);
      nextSteps.push(hStep);
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

const AUTO_REPAIR_CLIENTS = new Set(['codex', 'antigravity', 'dsh', 'hermes']);

function isClientInstalledForFix(def, reportClient, home, { platform, explicitHome, env }) {
  if (def.id === 'hermes') {
    return Boolean(findHermesExecutable(home, { platform, explicitHome, env }));
  }
  if (def.id === 'dsh') {
    return Boolean(findDshExecutable(home, { platform, explicitHome, env })) ||
      isRegularNonEmptyFile(reportClient.config) ||
      hasNonEmptyDshProfile(home);
  }
  if (def.hasBinary) {
    return Boolean(reportClient?.bin);
  }
  return Boolean(reportClient?.installed);
}

export function doctorFix({
  home,
  root,
  allowed,
  bin = 'node',
  role = null,
  allowDispatch = undefined,
  clients: targetClients = null,
  dryRun = false,
  env = process.env,
  platform = process.platform,
} = {}) {
  const explicitHome = home !== undefined && home !== null && path.resolve(home) !== path.resolve(os.homedir());
  const h = path.resolve(home || os.homedir());
  const r = path.resolve(root || defaultRoot());

  const filterIds = Array.isArray(targetClients) && targetClients.length ? targetClients : null;
  if (filterIds) {
    const unknown = filterIds.filter((id) => !CLIENTS.some((c) => c.id === id));
    if (unknown.length) {
      throw Object.assign(new Error(`未知客户端: ${unknown.join(', ')}；可选: ${listClients().join(', ')}`), { code: 1 });
    }
  }
  const filterSet = filterIds ? new Set(filterIds) : null;

  const report = doctor({ home: h, root: r, env, platform });
  const agentsCfg = readAgentConfig(r);

  const repaired = [];
  const skipped = [];
  const issues = [];

  if (!report.root_writable) {
    const rootDiag = report.diagnostics.find((d) => d.target === 'root');
    issues.push({
      client: 'root',
      target: 'root',
      config: r,
      result: 'manual',
      code: rootDiag?.code || 'root_not_writable',
      message: rootDiag?.message || `总线根目录不可写: ${r}`,
      next: rootDiag?.next || `检查目录权限: "${r}"`,
    });
  }

  for (const c of report.clients) {
    if (filterSet && !filterSet.has(c.id)) continue;
    const def = CLIENTS.find((x) => x.id === c.id);
    if (!def) continue;

    if (!AUTO_REPAIR_CLIENTS.has(c.id)) {
      skipped.push({
        client: c.id,
        label: c.label,
        config: c.config,
        result: 'out_of_scope',
        reason: 'doctor --fix 只自动修复 codex/antigravity/dsh/hermes',
        changed: false,
      });
      continue;
    }

    const isInstalled = isClientInstalledForFix(def, c, h, { platform, explicitHome, env });

    if (!isInstalled) {
      skipped.push({
        client: c.id,
        label: c.label,
        config: c.config,
        result: 'not_installed',
        reason: 'not_installed',
        changed: false,
      });
      continue;
    }

    if (c.config_error) {
      let backup = null;
      if (!dryRun && fs.existsSync(c.config)) {
        try {
          backup = backupIfExists(c.config);
        } catch {}
      }
      const iss = {
        client: c.id,
        label: c.label,
        config: c.config,
        result: 'manual',
        code: 'corrupted_config',
        backup,
        message: `配置文件损坏，未覆盖 (${c.config_error})${backup ? `；已备份至 ${backup}` : ''}`,
        next: `请先手动修复 "${c.config}"${backup ? `（备份: "${backup}"）` : ''} 后重新运行 agentbus doctor --fix`,
      };
      issues.push(iss);
      skipped.push({
        client: c.id,
        label: c.label,
        config: c.config,
        result: 'manual',
        reason: 'corrupted_config',
        backup,
        changed: false,
      });
      continue;
    }

    if (c.configured === true) {
      skipped.push({
        client: c.id,
        label: c.label,
        config: c.config,
        result: 'already_configured',
        reason: 'already_configured',
        changed: false,
      });
      continue;
    }

    const effRole = role || (agentsCfg.conductor === c.id ? 'conductor' : 'worker');
    const effDispatch = allowDispatch !== undefined ? Boolean(allowDispatch) : (agentsCfg.conductor === c.id);

    const setupRes = setupClients({
      clients: [c.id],
      root: r,
      allowed,
      bin,
      home: h,
      dryRun: !!dryRun,
      role: effRole,
      allowDispatch: effDispatch,
      platform,
      processEnv: env,
    });
    const entry = setupRes.results[0];

    if (entry && entry.ok && entry.changed) {
      repaired.push({
        client: c.id,
        label: c.label,
        config: entry.file || c.config,
        result: 'repaired',
        changed: true,
        backup: entry.backup || null,
        ...(entry.dry_run ? { dry_run: true } : {}),
        ...(entry.restart_required ? { restart_required: true } : {}),
        ...(entry.note ? { note: entry.note } : {}),
      });
    } else if (entry && entry.ok) {
      skipped.push({
        client: c.id,
        label: c.label,
        config: entry.file || c.config,
        result: 'already_configured',
        reason: entry.note || 'unchanged',
        changed: false,
      });
    } else {
      const code = entry?.error_code || 'repair_failed';
      const isManual = code === 'corrupted_config' || code === 'permission_denied' || code === 'missing_binary';
      const resTag = isManual ? 'manual' : 'failed';
      issues.push({
        client: c.id,
        label: c.label,
        config: entry?.file || c.config,
        result: resTag,
        code,
        message: entry?.error || 'repair failed',
        next: entry?.next || null,
      });
      skipped.push({
        client: c.id,
        label: c.label,
        config: entry?.file || c.config,
        result: resTag,
        reason: code,
        changed: false,
      });
    }
  }

  return {
    ok: issues.length === 0,
    home: h,
    root: r,
    changed: repaired.length > 0,
    repaired,
    skipped,
    issues,
  };
}

// ---------- doctor --bootstrap ----------

export function parseNodeSemver(versionStr = process.version) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(versionStr || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] || 0) };
}

export async function checkNodeSqlite({ nodeVersion = process.version, sqliteAvailable = null } = {}) {
  const ver = parseNodeSemver(nodeVersion);
  const verOk = Boolean(ver && (ver.major > 22 || (ver.major === 22 && ver.minor >= 5)));
  let hasSqlite = sqliteAvailable;
  let sqliteErr = null;
  if (typeof hasSqlite !== 'boolean') {
    try {
      const mod = await import('node:sqlite');
      hasSqlite = typeof mod?.DatabaseSync === 'function';
    } catch (err) {
      hasSqlite = false;
      sqliteErr = err?.message || String(err);
    }
  }
  if (verOk && hasSqlite) {
    return {
      id: 'node_sqlite',
      status: 'pass',
      detail: `Node ${nodeVersion} >= 22.5 且 node:sqlite 可用`,
      fix: null,
    };
  }
  const reasons = [];
  if (!verOk) reasons.push(`Node ${nodeVersion} 低于 22.5`);
  if (!hasSqlite) reasons.push(`node:sqlite 不可用${sqliteErr ? ` (${sqliteErr})` : ''}`);
  return {
    id: 'node_sqlite',
    status: 'fail',
    detail: reasons.join('；'),
    fix: '安装或切换到 Node.js >= 22.5.0（需内置 node:sqlite）',
  };
}

function normalizeComparePath(p, platform = process.platform) {
  let resolved;
  try {
    resolved = fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p);
  } catch {
    resolved = path.resolve(p);
  }
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveBootstrapAllowedRoots({ rootDir, env, platform = process.platform, customEnvProvided = false }) {
  if (customEnvProvided && env && typeof env.AGENTBUS_ALLOWED_ROOTS === 'string' && env.AGENTBUS_ALLOWED_ROOTS.trim()) {
    const raw = env.AGENTBUS_ALLOWED_ROOTS
      .split(platform === 'win32' ? ';' : (env.AGENTBUS_ALLOWED_ROOTS.includes(';') ? ';' : path.delimiter))
      .map((s) => s.trim().replace(/^"(.*)"$/, '$1').trim())
      .filter(Boolean);
    const roots = raw.map((r) => (path.isAbsolute(r) ? path.resolve(r) : path.resolve(PKG_ROOT, r)));
    const same = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (!roots.some((r) => same(r, rootDir))) roots.push(rootDir);
    return roots;
  }
  // When custom env is passed without AGENTBUS_ALLOWED_ROOTS, read config files without inheriting process.env.AGENTBUS_ALLOWED_ROOTS.
  if (customEnvProvided) {
    let rawAllowed = ['..', 'var'];
    for (const cf of [path.join(PKG_ROOT, 'config.json'), path.join(rootDir, 'config.json')]) {
      if (fs.existsSync(cf)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(cf, 'utf8'));
          if (Array.isArray(parsed.allowed_roots)) rawAllowed = parsed.allowed_roots;
        } catch {}
      }
    }
    const roots = rawAllowed.map((r) => (path.isAbsolute(r) ? path.resolve(r) : path.resolve(PKG_ROOT, r)));
    const same = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (!roots.some((r) => same(r, rootDir))) roots.push(rootDir);
    return roots;
  }
  return loadConfig({ rootOverride: rootDir }).allowedRoots;
}

export function evaluateAllowedRoots({ allowedRoots = [], cwd = process.cwd(), platform = process.platform } = {}) {
  const cwdPath = path.resolve(cwd || process.cwd());
  const targetNorm = normalizeComparePath(cwdPath, platform);
  const sep = platform === 'win32' ? '\\' : '/';
  let matched = null;
  for (const r of allowedRoots) {
    const rootNorm = normalizeComparePath(r, platform);
    const prefix = rootNorm.endsWith(sep) || rootNorm.endsWith('/') ? rootNorm : rootNorm + sep;
    const altPrefix = rootNorm.endsWith('/') ? rootNorm : `${rootNorm}/`;
    if (targetNorm === rootNorm || targetNorm.startsWith(prefix) || targetNorm.startsWith(altPrefix)) {
      matched = r;
      break;
    }
  }
  if (matched) {
    return {
      id: 'allowed_roots',
      status: 'pass',
      detail: `当前目录 ${cwdPath} 已包含在 allowed_roots (${matched})`,
      fix: null,
    };
  }
  return {
    id: 'allowed_roots',
    status: 'fail',
    detail: `当前目录 ${cwdPath} 不在 AGENTBUS_ALLOWED_ROOTS (${allowedRoots.join(', ') || '空'}) 内`,
    fix: `在 AGENTBUS_ALLOWED_ROOTS 或 setup --allow 中加入 "${cwdPath}"`,
  };
}

export function evaluateAgentsJson({ root, env = process.env } = {}) {
  const prevEnvCfg = process.env.AGENTBUS_AGENTS_CONFIG;
  const cfgPath = env?.AGENTBUS_AGENTS_CONFIG
    ? path.resolve(String(env.AGENTBUS_AGENTS_CONFIG))
    : (prevEnvCfg && env === process.env ? agentConfigPath(root) : path.join(root, 'agents.json'));

  if (!fs.existsSync(cfgPath)) {
    return {
      id: 'agents_json',
      status: 'warn',
      detail: `agents.json 不存在 (${cfgPath})`,
      fix: `运行 node "${BUS_BIN}" onboard --root "${root}"`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    return {
      id: 'agents_json',
      status: 'fail',
      detail: `agents.json 解析失败 (${cfgPath}): ${err.message}`,
      fix: `修复或重新运行 node "${BUS_BIN}" onboard --root "${root}"`,
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      id: 'agents_json',
      status: 'fail',
      detail: `agents.json 顶层不是对象 (${cfgPath})`,
      fix: `修复或重新运行 node "${BUS_BIN}" onboard --root "${root}"`,
    };
  }

  const conductor = typeof parsed.conductor === 'string' && parsed.conductor.trim() ? parsed.conductor.trim() : null;
  const models = isPlainObject(parsed.models) ? parsed.models : {};
  const agents = Object.keys(models);
  const emptyModels = agents.filter((k) => !String(models[k] || '').trim());
  const archiveConfigured = 'archive_on_done' in parsed;
  const archiveOnDone = parsed.archive_on_done === true;

  if (!conductor || agents.length === 0 || emptyModels.length > 0) {
    return {
      id: 'agents_json',
      status: 'warn',
      detail: `agents.json 配置不完整 (conductor=${conductor || '空'}, agents=${agents.join(',') || '无'}, empty_models=${emptyModels.join(',') || '无'}, archive_on_done=${archiveOnDone}${archiveConfigured ? '' : '(默认false)'})`,
      fix: `运行 node "${BUS_BIN}" onboard --root "${root}" --model <agent>=<model> 补全配置`,
    };
  }

  return {
    id: 'agents_json',
    status: 'pass',
    detail: `conductor=${conductor}, agents=${agents.map((k) => `${k}=${models[k]}`).join(', ')}, archive_on_done=${archiveOnDone}${archiveConfigured ? '' : '(默认false)'}`,
    fix: null,
  };
}

async function checkBusRootReadOnly({ rootDir, platform = process.platform, sqliteAvailable = true } = {}) {
  const dbPath = path.join(rootDir, 'agentbus.db');
  if (!fs.existsSync(rootDir)) {
    const parentCheck = checkDirWritable(rootDir, platform);
    if (!parentCheck.ok) {
      return {
        id: 'bus_root',
        status: 'fail',
        detail: `总线根目录不可创建 ${rootDir} (${parentCheck.reason})`,
        fix: parentCheck.code === 'permission_denied' ? permissionNextHint(parentCheck.path, platform) : `检查路径 "${rootDir}"`,
      };
    }
    return {
      id: 'bus_root',
      status: 'warn',
      detail: `总线根目录尚不存在（父目录可写）: ${rootDir}`,
      fix: `运行 node "${BUS_BIN}" init --root "${rootDir}"`,
    };
  }

  try {
    const st = fs.statSync(rootDir);
    if (!st.isDirectory()) {
      return {
        id: 'bus_root',
        status: 'fail',
        detail: `总线根路径不是目录: ${rootDir}`,
        fix: `检查或更换 --root 路径: "${rootDir}"`,
      };
    }
    fs.accessSync(rootDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch (err) {
    return {
      id: 'bus_root',
      status: 'fail',
      detail: `总线根目录不可读写 ${rootDir} (${err.code || err.message})`,
      fix: permissionNextHint(rootDir, platform),
    };
  }

  if (!fs.existsSync(dbPath)) {
    return {
      id: 'bus_root',
      status: 'warn',
      detail: `总线根目录可读写，但数据库尚未初始化: ${dbPath}`,
      fix: `运行 node "${BUS_BIN}" init --root "${rootDir}"`,
    };
  }

  try {
    const st = fs.statSync(dbPath);
    if (!st.isFile()) {
      return {
        id: 'bus_root',
        status: 'fail',
        detail: `数据库路径不是普通文件: ${dbPath}`,
        fix: `检查路径 "${dbPath}"`,
      };
    }
    fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (err) {
    return {
      id: 'bus_root',
      status: 'fail',
      detail: `总线数据库不可读写 ${dbPath} (${err.code || err.message})`,
      fix: permissionNextHint(dbPath, platform),
    };
  }

  if (sqliteAvailable) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        db.prepare('SELECT COUNT(*) AS c FROM sqlite_master').get();
      } finally {
        db.close();
      }
    } catch (err) {
      return {
        id: 'bus_root',
        status: 'fail',
        detail: `无法只读校验数据库 ${dbPath}: ${err.message}`,
        fix: `检查数据库文件是否损坏或权限受限: "${dbPath}"`,
      };
    }
  }

  return {
    id: 'bus_root',
    status: 'pass',
    detail: `总线根目录与数据库可读写: ${dbPath}`,
    fix: null,
  };
}

export function checkClientsBinaries({ home = os.homedir(), env = process.env, platform = process.platform, explicitHome = false } = {}) {
  const h = path.resolve(home || os.homedir());
  const detected = [];
  const missing = [];
  for (const id of ['codex', 'claude', 'gemini', 'antigravity', 'opencode']) {
    const res = resolveAgentBin(id, { home: h, env, platform, explicitHome });
    if (res.bin) detected.push({ id, bin: res.bin, source: res.source });
    else missing.push(id);
  }
  const dshBin = findDshExecutable(h, { platform, explicitHome, env });
  if (dshBin) detected.push({ id: 'dsh', bin: dshBin, source: 'dsh' });
  else missing.push('dsh');

  const hermesBin = findHermesExecutable(h, { platform, explicitHome, env });
  if (hermesBin) detected.push({ id: 'hermes', bin: hermesBin, source: 'hermes' });
  else missing.push('hermes');

  if (detected.length === 0) {
    return {
      id: 'clients',
      status: 'warn',
      detail: `未检测到任何客户端 binary (${missing.join('/')})`,
      fix: '按需安装至少一个受支持的 agent CLI，或通过 AGENTBUS_<CLIENT>_BIN 指定可执行文件',
    };
  }
  return {
    id: 'clients',
    status: 'pass',
    detail: `已检测到 ${detected.length} 个客户端 binary: ${detected.map((d) => `${d.id}(${path.basename(d.bin)})`).join(', ')}${missing.length ? `；未检测到(可选): ${missing.join(', ')}` : ''}`,
    fix: null,
  };
}

function defaultProbeCdp(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) {
          resolve({ reachable: false, hasAntigravityPage: false, error: `HTTP ${res.statusCode}` });
          return;
        }
        try {
          const list = JSON.parse(body);
          const hasAntigravityPage = Array.isArray(list) && list.some((t) => t && t.type === 'page' && String(t.title || '').includes('Antigravity'));
          resolve({ reachable: true, hasAntigravityPage, error: null });
        } catch (err) {
          resolve({ reachable: false, hasAntigravityPage: false, error: `invalid JSON: ${err.message}` });
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      resolve({ reachable: false, hasAntigravityPage: false, error: err?.message || String(err) });
    });
  });
}

export function listMcpProcesses({ platform = process.platform } = {}) {
  if (platform === 'win32') {
    const psScript = "$procs = @(Get-CimInstance Win32_Process -Filter \"Name LIKE '%node%'\" | Where-Object { $_.CommandLine -and $_.CommandLine -match 'bus\\.js' -and $_.CommandLine -match '\\bmcp\\b' } | ForEach-Object { [PSCustomObject]@{ pid = [int]$_.ProcessId; createdAtMs = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(); commandLine = [string]$_.CommandLine } }); ConvertTo-Json -InputObject $procs -Compress";
    const r = spawnSync('powershell', ['-NoProfile', '-Command', psScript], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    if (r.error || r.status !== 0) {
      return {
        processes: [],
        probeError: r.error?.message || (r.stderr || '').trim() || `powershell exit ${r.status}`,
      };
    }
    const raw = (r.stdout || '').trim();
    if (!raw) return { processes: [], probeError: null };
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
      return { processes: list, probeError: null };
    } catch (err) {
      return { processes: [], probeError: `解析进程列表失败: ${err.message}` };
    }
  }

  const r = spawnSync('ps', ['-eo', 'pid=,lstart=,args='], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (r.error || r.status !== 0) {
    return {
      processes: [],
      probeError: r.error?.message || (r.stderr || '').trim() || `ps exit ${r.status}`,
    };
  }
  const processes = [];
  for (const line of String(r.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (!m) continue;
    const cmdLine = m[3];
    if (!/bus\.js["']?\s+mcp\b/i.test(cmdLine)) continue;
    const ts = Date.parse(m[2]);
    processes.push({
      pid: Number(m[1]),
      createdAtMs: Number.isFinite(ts) ? ts : null,
      commandLine: cmdLine,
    });
  }
  return { processes, probeError: null };
}

export function evaluateStaleMcp({
  processes = [],
  codeMtimeMs = null,
  probeError = null,
  currentPid = process.pid,
} = {}) {
  if (probeError) {
    return {
      id: 'stale_mcp',
      status: 'warn',
      detail: `无法检查运行中的 bus.js mcp 进程 (${probeError})`,
      fix: '如最近更新过 src/mcp.js，请手动重启对应 MCP 客户端',
    };
  }
  const matched = (Array.isArray(processes) ? processes : []).filter((p) => {
    if (!p || Number(p.pid) === Number(currentPid)) return false;
    return /bus\.js["']?\s+mcp\b/i.test(String(p.commandLine || ''));
  });
  if (matched.length === 0) {
    return {
      id: 'stale_mcp',
      status: 'pass',
      detail: '未发现运行中的 bus.js mcp 进程',
      fix: null,
    };
  }

  const mtime = Number.isFinite(codeMtimeMs) ? codeMtimeMs : (fs.existsSync(MCP_FILE) ? fs.statSync(MCP_FILE).mtimeMs : 0);
  const stale = matched.filter((p) => Number.isFinite(p.createdAtMs) && p.createdAtMs < mtime);
  const unknown = matched.filter((p) => !Number.isFinite(p.createdAtMs));

  if (stale.length > 0) {
    return {
      id: 'stale_mcp',
      status: 'fail',
      detail: `发现 ${stale.length} 个早于 src/mcp.js 修改时间的旧 MCP 进程 (pid=${stale.map((p) => p.pid).join(',')})`,
      fix: '请重启对应 MCP 客户端（如 Codex / Antigravity / Claude / Hermes）以加载最新 src/mcp.js',
    };
  }
  if (unknown.length > 0) {
    return {
      id: 'stale_mcp',
      status: 'warn',
      detail: `发现 ${unknown.length} 个 bus.js mcp 进程但无法读取创建时间 (pid=${unknown.map((p) => p.pid).join(',')})`,
      fix: '如最近更新过代码，请重启对应 MCP 客户端',
    };
  }
  return {
    id: 'stale_mcp',
    status: 'pass',
    detail: `运行中的 ${matched.length} 个 bus.js mcp 进程均晚于 src/mcp.js 最新修改`,
    fix: null,
  };
}

export async function doctorBootstrap({
  root = null,
  home = undefined,
  cwd = process.cwd(),
  env = undefined,
  platform = process.platform,
  checkArchive = false,
  cdpPort = null,
  allowedRoots = null,
  nodeVersion = process.version,
  sqliteAvailable = null,
  processes = undefined,
  probeError = null,
  codeMtimeMs = null,
  probeCdp = null,
} = {}) {
  const customEnvProvided = env !== undefined && env !== null;
  const effEnv = customEnvProvided ? env : process.env;
  const explicitHome = home !== undefined && home !== null && path.resolve(home) !== path.resolve(os.homedir());
  const resolvedHome = path.resolve(home || os.homedir());
  const effRoot = root || effEnv.AGENTBUS_ROOT || null;
  const resolvedRoot = effRoot
    ? path.resolve(effRoot)
    : (customEnvProvided ? defaultRoot() : loadConfig({ rootOverride: null }).rootDir);
  const resolvedCwd = path.resolve(cwd || process.cwd());

  const checks = [];

  // 1. node_sqlite
  const cNode = await checkNodeSqlite({ nodeVersion, sqliteAvailable });
  checks.push(cNode);

  // 2. bus_root (strictly read-only)
  const cRoot = await checkBusRootReadOnly({
    rootDir: resolvedRoot,
    platform,
    sqliteAvailable: cNode.status === 'pass',
  });
  checks.push(cRoot);

  // 3. allowed_roots
  const effAllowed = Array.isArray(allowedRoots)
    ? allowedRoots
    : resolveBootstrapAllowedRoots({ rootDir: resolvedRoot, env: effEnv, platform, customEnvProvided });
  const cAllowed = evaluateAllowedRoots({ allowedRoots: effAllowed, cwd: resolvedCwd, platform });
  checks.push(cAllowed);

  // 4. agents_json
  const cAgents = evaluateAgentsJson({ root: resolvedRoot, env: effEnv });
  checks.push(cAgents);

  // 5. clients
  const cClients = checkClientsBinaries({ home: resolvedHome, env: effEnv, platform, explicitHome });
  checks.push(cClients);

  // 6. archive_cdp
  let archiveOnDone = String(effEnv.AGENTBUS_ARCHIVE_ON_DONE || '') === '1';
  if (!archiveOnDone) {
    const agFile = effEnv.AGENTBUS_AGENTS_CONFIG
      ? path.resolve(String(effEnv.AGENTBUS_AGENTS_CONFIG))
      : path.join(resolvedRoot, 'agents.json');
    if (fs.existsSync(agFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(agFile, 'utf8'));
        if (parsed && parsed.archive_on_done === true) archiveOnDone = true;
      } catch {}
    }
  }
  const port = resolveCdpPort(cdpPort, effEnv);
  if (!archiveOnDone && !checkArchive) {
    checks.push({
      id: 'archive_cdp',
      status: 'pass',
      detail: `archive_on_done 未启用，跳过 CDP ${port} 检查（加 --check-archive 可显式探测）`,
      fix: null,
    });
  } else {
    const prober = typeof probeCdp === 'function' ? probeCdp : defaultProbeCdp;
    const probe = await prober(port);
    if (probe?.reachable && probe.hasAntigravityPage) {
      checks.push({
        id: 'archive_cdp',
        status: 'pass',
        detail: `CDP 端口 ${port} 可连且检测到 Antigravity 页面`,
        fix: null,
      });
    } else if (probe?.reachable) {
      checks.push({
        id: 'archive_cdp',
        status: 'warn',
        detail: `CDP 端口 ${port} 可连但未发现 Antigravity page target`,
        fix: '确认 Antigravity 窗口已打开',
      });
    } else {
      checks.push({
        id: 'archive_cdp',
        status: checkArchive ? 'fail' : 'warn',
        detail: `CDP 端口 ${port} 不可连 (${probe?.error || 'unreachable'})；自动归档将跳过（不影响核心总线）`,
        fix: `以 --remote-debugging-port=${port} 启动 Antigravity，或在 agents.json 关闭 archive_on_done`,
      });
    }
  }

  // 7. stale_mcp
  let procList = processes;
  let procErr = probeError;
  if (procList === undefined) {
    const listed = listMcpProcesses({ platform });
    procList = listed.processes;
    procErr = listed.probeError;
  }
  const cStale = evaluateStaleMcp({
    processes: procList,
    codeMtimeMs,
    probeError: procErr,
  });
  checks.push(cStale);

  const summary = {
    pass: checks.filter((c) => c.status === 'pass').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  };
  return {
    ok: summary.fail === 0,
    root: resolvedRoot,
    cwd: resolvedCwd,
    checks,
    summary,
  };
}
