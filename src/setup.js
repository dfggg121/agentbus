// Client auto-configuration for agentbus.
// Writes (or updates) the MCP server entry for supported agent CLIs.
// Rules: idempotent, always backs up the target file before modification, never touches unrelated keys.

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientConfigFile, hermesPaths, resolveAgentBin } from './agents.js';

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
        return fs.existsSync(path.join(h, '.dsh')) || fs.existsSync(cfg);
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
    const binInfo = resolveAgentBin(client.id, { home: h, env, platform, explicitHome });
    if (binInfo?.bin) return true;
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
  const pathVar = env.PATH || env.Path || '';
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const rawDir of pathVar.split(platform === 'win32' ? ';' : path.delimiter)) {
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
  const override = env.AGENTBUS_HERMES_BIN && String(env.AGENTBUS_HERMES_BIN).trim();
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
  const commonBins = platform === 'win32'
    ? [
        path.join(
          env.LOCALAPPDATA && String(env.LOCALAPPDATA).trim()
            ? path.resolve(String(env.LOCALAPPDATA).trim())
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
    return spawnSync(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${inner}"`], {
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
    childEnv.HERMES_HOME = hermesHome;
    childEnv.HOME = opts.home;
    childEnv.USERPROFILE = opts.home;
    if (opts.platform === 'win32') {
      childEnv.LOCALAPPDATA = path.join(opts.home, 'AppData', 'Local');
      childEnv.APPDATA = path.join(opts.home, 'AppData', 'Roaming');
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

  const file = clientConfigFile(client.id, opts.home, opts.platform);
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
  if (format === 'dsh-cordis') {
    const hasBegin = /# BEGIN agentbus-managed/.test(raw);
    const hasEnd = /# END agentbus-managed/.test(raw);
    if (hasBegin !== hasEnd) {
      return { configured: null, error: 'agentbus-managed 标记不成对' };
    }
    const has = /# BEGIN agentbus-managed[\s\S]*?id:\s*agentbus-mcp[\s\S]*?# END agentbus-managed/.test(raw);
    return { configured: has, error: null };
  }
  if (format === 'hermes-cli') {
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
        installed: Boolean(binInfo?.bin || exists),
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
