// Generic client presets: safe auto-registration for MCP clients that are
// outside the hand-tested `setup` matrix, followed by a real MCP handshake.
// Every write is backed up; a failed probe restores the previous file.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServerSpec, defaultRoot } from './setup.js';

export const PRESET_FORMATS = [
  'json-mcpServers',
  'json-servers',
  'json-opencode',
  'json-openclaw',
  'json-zed-context',
];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUS_BIN = path.resolve(HERE, '..', 'bin', 'bus.js');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const base = `${file}.bak-${stamp()}`;
  let bak = base;
  let seq = 1;
  while (fs.existsSync(bak)) bak = `${base}-${seq++}`;
  fs.copyFileSync(file, bak);
  return bak;
}

function atomicWrite(file, text) {
  const dir = path.dirname(file);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  return dir;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function parseJsonObject(raw, file) {
  const text = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!text) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const err = new Error(`JSON 解析失败: ${e.message}`);
    err.code = 'json_parse_failed';
    err.config = file;
    throw err;
  }
  if (!isPlainObject(data)) {
    const err = new Error('配置文件顶层不是 JSON 对象');
    err.code = 'invalid_config_shape';
    err.config = file;
    throw err;
  }
  return data;
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function sameValue(a, b) {
  return canonical(a) === canonical(b);
}

function ensureObject(parent, key, file) {
  if (parent[key] !== undefined && !isPlainObject(parent[key])) {
    const err = new Error(`${file} 中的 "${key}" 字段不是对象，已停止（未写入）`);
    err.code = 'invalid_config_shape';
    err.config = file;
    throw err;
  }
  if (!isPlainObject(parent[key])) parent[key] = {};
  return parent[key];
}

function targetFor(data, format, file) {
  if (format === 'json-mcpServers') return ensureObject(data, 'mcpServers', file);
  if (format === 'json-servers') return ensureObject(data, 'servers', file);
  if (format === 'json-zed-context') return ensureObject(data, 'context_servers', file);
  if (format === 'json-openclaw') {
    const mcp = ensureObject(data, 'mcp', file);
    return ensureObject(mcp, 'servers', file);
  }
  if (format === 'json-opencode') return ensureObject(data, 'mcp', file);
  const err = new Error(`不支持的预设格式: ${format}`);
  err.code = 'unsupported_format';
  throw err;
}

function entryFor(spec, format) {
  if (format === 'json-opencode') {
    return {
      type: 'local',
      command: [spec.command, ...spec.args],
      enabled: true,
      environment: { ...spec.env },
    };
  }
  if (format === 'json-openclaw') {
    return {
      transport: 'stdio',
      command: spec.command,
      args: [...spec.args],
      env: { ...spec.env },
    };
  }
  if (format === 'json-zed-context') {
    return {
      command: spec.command,
      args: [...spec.args],
      env: { ...spec.env },
    };
  }
  return {
    type: 'stdio',
    command: spec.command,
    args: [...spec.args],
    env: { ...spec.env },
  };
}

function inspectText(raw, format, file) {
  const data = parseJsonObject(raw, file);
  const target = targetFor(data, format, file);
  const entry = target.agentbus;
  if (entry !== undefined && !isPlainObject(entry)) {
    return { configured: false, entry: null, error: 'agentbus 条目不是对象' };
  }
  return { configured: Boolean(entry), entry: entry || null, error: null, data };
}

function mergeText(raw, spec, format, file) {
  const data = parseJsonObject(raw, file);
  const target = targetFor(data, format, file);
  const desired = entryFor(spec, format);
  const changed = !sameValue(target.agentbus, desired);
  target.agentbus = desired;
  return {
    text: `${JSON.stringify(data, null, 2)}\n`,
    changed,
    entry: desired,
    configured: true,
  };
}

// A small catalog of clients with stable, public MCP file locations. These
// are intentionally separate from setup's hand-tested CLIENTS matrix.
export const PRESET_DEFS = [
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    format: 'json-mcpServers',
    confidence: 'tested-manually',
    config: (h) => path.join(h, '.workbuddy', 'mcp.json'),
    detect: (h) => fs.existsSync(path.join(h, '.workbuddy')),
    activation: 'ui',
    restart_required: true,
    note: 'WorkBuddy 需在「连接器 → 自定义连接器 → 我的 MCP」保存并信任；列表显示 9/9(worker) 或 15/15(conductor) 才算客户端加载成功。',
  },
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    format: 'json-mcpServers',
    confidence: 'catalog',
    config: (h) => path.join(h, '.codebuddy', '.mcp.json'),
    detect: (h) => fs.existsSync(path.join(h, '.codebuddy')),
    activation: 'restart',
    restart_required: true,
    note: 'CodeBuddy 也可使用项目级 .mcp.json；全局文件写入后重启 IDE。',
  },
  {
    id: 'vscode',
    label: 'VS Code / Copilot (global)',
    format: 'json-mcpServers',
    confidence: 'catalog',
    config: (h) => path.join(h, '.copilot', 'mcp-config.json'),
    detect: (h) => fs.existsSync(path.join(h, '.copilot')),
    activation: 'restart',
    restart_required: true,
    note: '全局 MCP 配置；工作区也可用 .vscode/mcp.json（格式为 servers）。',
  },
  {
    id: 'trae',
    label: 'Trae',
    format: 'json-mcpServers',
    confidence: 'catalog',
    config: (h) => path.join(h, '.trae', 'mcp.json'),
    detect: (h) => fs.existsSync(path.join(h, '.trae')),
    activation: 'ui',
    restart_required: true,
    note: 'Trae 也可在项目 .trae/mcp.json 中配置；部分版本需在设置里开启项目级 MCP。',
  },
  {
    id: 'qoder',
    label: 'Qoder',
    format: 'json-mcpServers',
    confidence: 'catalog',
    config: (h) => path.join(h, '.qoder', 'mcp.json'),
    detect: (h) => fs.existsSync(path.join(h, '.qoder')),
    activation: 'ui',
    restart_required: true,
    note: 'Qoder 的 MCP 入口在设置面板；写入后重启并确认服务列表。',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    format: 'json-openclaw',
    confidence: 'catalog',
    config: (h) => path.join(h, '.openclaw', 'openclaw.json'),
    detect: (h) => fs.existsSync(path.join(h, '.openclaw')),
    activation: 'ui',
    restart_required: true,
    note: 'OpenClaw 使用 mcp.servers 嵌套结构；其控制 UI 也可手工添加。',
  },
  {
    id: 'zed',
    label: 'Zed',
    format: 'json-zed-context',
    confidence: 'catalog',
    config: (h, platform) => {
      if (platform === 'win32') return path.join(h, 'AppData', 'Roaming', 'Zed', 'settings.json');
      if (platform === 'darwin') return path.join(h, 'Library', 'Application Support', 'Zed', 'settings.json');
      return path.join(h, '.config', 'zed', 'settings.json');
    },
    detect: (h, platform) => {
      const file = PRESET_DEFS.find((p) => p.id === 'zed').config(h, platform);
      return fs.existsSync(path.dirname(file));
    },
    activation: 'restart',
    restart_required: true,
    note: 'Zed 的 settings.json 常含 JSONC 注释；若无法无损坏解析，会留为手工接入，不覆盖原文件。',
  },
];

function resolvePresetFile(preset, home, platform) {
  const file = preset.config(home, platform);
  return path.resolve(file);
}

function presetMeta(preset, file, detected) {
  return {
    id: preset.id,
    label: preset.label,
    format: preset.format,
    confidence: preset.confidence || 'catalog',
    config: file,
    detected,
    activation: preset.activation || 'restart',
    restart_required: Boolean(preset.restart_required),
    ...(preset.note ? { note: preset.note } : {}),
  };
}

export function listPresets({ home = os.homedir(), platform = process.platform } = {}) {
  const h = path.resolve(home || os.homedir());
  return PRESET_DEFS.map((preset) => {
    const file = resolvePresetFile(preset, h, platform);
    const exists = fs.existsSync(file);
    let configured = null;
    let error = null;
    if (exists) {
      try {
        const inspected = inspectText(fs.readFileSync(file, 'utf8'), preset.format, file);
        configured = inspected.configured;
        error = inspected.error;
      } catch (e) {
        error = String(e.message || e);
      }
    }
    return {
      ...presetMeta(preset, file, Boolean(preset.detect?.(h, platform) || exists)),
      config_exists: exists,
      configured,
      config_error: error,
    };
  });
}

function inferFormat(file, raw) {
  try {
    const data = parseJsonObject(raw, file);
    if (isPlainObject(data.context_servers)) return 'json-zed-context';
    if (isPlainObject(data.mcpServers)) return 'json-mcpServers';
    if (isPlainObject(data.servers)) return 'json-servers';
    if (isPlainObject(data.mcp)) {
      const vals = Object.values(data.mcp);
      if (vals.some((v) => isPlainObject(v) && v.type === 'local')) return 'json-opencode';
      return 'json-openclaw';
    }
  } catch {}
  if (/\.json$/i.test(file)) return 'json-mcpServers';
  return null;
}

const SCAN_SKIP = new Set([
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.npm', '.cache',
  '.git', '.svn', '.local', '.vscode-server', '.cursor-server', '.gitconfig',
]);

function scanCandidates(home) {
  const out = [];
  const addDir = (dir, labelPrefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (SCAN_SKIP.has(ent.name)) continue;
      const base = path.join(dir, ent.name);
      for (const name of ['mcp.json', '.mcp.json', 'mcp_config.json', 'mcp-config.json']) {
        const file = path.join(base, name);
        if (!fs.existsSync(file)) continue;
        let raw = '';
        try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
        const format = inferFormat(file, raw);
        if (!format) continue;
        out.push({
          id: `scan:${ent.name}:${name}`,
          label: `自动发现: ${labelPrefix}${ent.name}`,
          format,
          config: file,
          detected: true,
          source: 'scan',
          activation: 'restart',
          restart_required: true,
          confidence: 'low',
          note: '本机扫描发现的 MCP 配置文件；已按内容推断格式。请确认该客户端支持文件级 MCP。',
        });
      }
    }
  };
  addDir(home, '.');
  const dotConfig = path.join(home, '.config');
  if (fs.existsSync(dotConfig)) addDir(dotConfig, '.config/');
  return out;
}

function collectCandidates({ home, platform, ids, paths, scan, format }) {
  const h = path.resolve(home || os.homedir());
  const out = [];
  const seen = new Set();
  if (ids && ids.length) {
    const unknown = ids.filter((id) => !PRESET_DEFS.some((p) => p.id === id));
    if (unknown.length) {
      const err = new Error(`未知预设: ${unknown.join(', ')}；可选: ${PRESET_DEFS.map((p) => p.id).join(', ')}`);
      err.code = 'unknown_preset';
      throw err;
    }
  }
  const add = (c) => {
    const key = path.resolve(c.config);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const preset of PRESET_DEFS) {
    if (ids && ids.length) {
      if (!ids.includes(preset.id)) continue;
    } else if ((paths && paths.length) || scan) {
      // Explicit paths or scan-only must not drag in every detected preset.
      continue;
    }
    const file = resolvePresetFile(preset, h, platform);
    const exists = fs.existsSync(file);
    const detected = Boolean(preset.detect?.(h, platform) || exists);
    if (!ids && !detected) continue;
    add({ ...presetMeta(preset, file, detected), source: 'preset' });
  }
  for (const rawPath of paths || []) {
    const file = path.resolve(rawPath);
    let fmt = typeof format === 'string' && format.trim() ? format.trim() : null;
    if (!fmt && fs.existsSync(file)) {
      try { fmt = inferFormat(file, fs.readFileSync(file, 'utf8')); } catch {}
    }
    if (!fmt) {
      const err = new Error(`无法推断格式，请加 --format: ${file}`);
      err.code = 'unsupported_format';
      err.config = file;
      throw err;
    }
    if (!PRESET_FORMATS.includes(fmt)) {
      const err = new Error(`不支持的格式: ${fmt}；可选: ${PRESET_FORMATS.join(', ')}`);
      err.code = 'unsupported_format';
      err.config = file;
      throw err;
    }
    add({
      id: `custom:${path.basename(file)}`,
      label: `自定义: ${path.basename(file)}`,
      format: fmt,
      config: file,
      detected: true,
      source: 'path',
      activation: 'restart',
      restart_required: true,
      confidence: 'explicit',
    });
  }
  if (scan) {
    for (const c of scanCandidates(h)) add(c);
  }
  return out;
}

function probeEntry(entry, format) {
  if (format === 'json-opencode') {
    return {
      command: Array.isArray(entry.command) ? entry.command[0] : entry.command,
      args: Array.isArray(entry.command) ? entry.command.slice(1) : [],
      env: entry.environment && typeof entry.environment === 'object' ? entry.environment : {},
    };
  }
  return {
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args : [],
    env: entry.env && typeof entry.env === 'object' ? entry.env : {},
  };
}

export function probeMcpEntry(entry, { timeoutMs = 10000, cwd = process.cwd(), format = 'json-mcpServers' } = {}) {
  return new Promise((resolve) => {
    const normalized = probeEntry(entry, format);
    if (!normalized.command) {
      resolve({ ok: false, error: '配置中没有 command' });
      return;
    }
    const role = normalized.env.AGENTBUS_ROLE === 'conductor' ? 'conductor' : 'worker';
    const expected = role === 'conductor' ? 15 : 9;
    const callMethod = role === 'conductor' ? 'bus_task_list' : 'bus_task_inbox';
    const callArgs = role === 'conductor' ? { limit: 1 } : { id: '__agentbus_probe__' };
    let child;
    try {
      child = spawn(normalized.command, normalized.args, {
        cwd,
        env: { ...process.env, ...normalized.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, error: `spawn failed: ${e.message}` });
      return;
    }

    let outBuf = '';
    let errBuf = '';
    let init = null;
    let tools = null;
    let list = null;
    let settled = false;
    let timer = null;

    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.kill(); } catch {}
      const names = Array.isArray(tools?.tools) ? tools.tools.map((t) => t.name) : [];
      const listOk = role === 'conductor'
        ? Boolean(list?.result && Array.isArray(list.result.structuredContent))
        : Boolean(list?.result);
      const ok = Boolean(init?.protocolVersion) &&
        names.length >= expected &&
        names.includes(callMethod) &&
        listOk &&
        !res.error;
      resolve({
        ok,
        protocolVersion: init?.protocolVersion || null,
        server: init?.serverInfo?.name || null,
        version: init?.serverInfo?.version || null,
        role,
        expected_tools: expected,
        tool_count: names.length,
        tool_names: names,
        tool_call: callMethod,
        tool_call_ok: listOk,
        ...(role === 'conductor' ? { bus_task_list: listOk } : {}),
        ...(res.error ? { error: res.error } : {}),
        stderr_tail: errBuf.slice(-500),
      });
    };

    timer = setTimeout(() => finish({ error: `MCP 测试超时 (${timeoutMs}ms)` }), timeoutMs);
    child.on('error', (e) => finish({ error: `spawn failed: ${e.message}` }));
    child.on('exit', (code) => {
      if (!settled && !init) finish({ error: `MCP 进程提前退出 (code ${code})` });
    });
    child.stderr.on('data', (d) => { errBuf += d.toString('utf8'); });
    child.stdout.on('data', (d) => {
      outBuf += d.toString('utf8');
      let idx;
      while ((idx = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, idx).trim();
        outBuf = outBuf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) init = msg.result;
        if (msg.id === 2 && msg.result) tools = msg.result;
        if (msg.id === 3) {
          list = msg;
          finish({});
        }
      }
    });

    const send = (msg) => {
      try { child.stdin.write(`${JSON.stringify(msg)}\n`); } catch (e) { finish({ error: `stdin: ${e.message}` }); }
    };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agentbus-preset-probe', version: '1.0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: callMethod, arguments: callArgs } });
  });
}

function manualNext(file, format) {
  return `无法安全自动改写时，可手工检查或运行: node "${BUS_BIN}" adapt --path "${file}" --format ${format}`;
}

async function adaptOne(candidate, opts) {
  const file = candidate.config;
  const parent = path.dirname(file);
  if (!fs.existsSync(parent)) {
    return {
      ok: false,
      status: 'skipped',
      ...candidate,
      reason: `配置目录不存在: ${parent}`,
      next: `先启动一次 ${candidate.label}，或确认该客户端的配置目录`,
    };
  }

  const existed = fs.existsSync(file);
  let prev = '';
  if (existed) {
    try { prev = fs.readFileSync(file, 'utf8'); } catch (e) {
      return { ok: false, status: 'failed', ...candidate, error: `读取失败: ${e.message}`, next: '检查文件权限' };
    }
  }

  let inspected;
  try {
    inspected = inspectText(prev, candidate.format, file);
  } catch (e) {
    return {
      ok: false,
      status: 'manual',
      ...candidate,
      error: String(e.message || e),
      next: manualNext(file, candidate.format),
    };
  }
  if (inspected.error) {
    return {
      ok: false,
      status: 'manual',
      ...candidate,
      error: inspected.error,
      next: manualNext(file, candidate.format),
    };
  }

  if (inspected.error) {
    return {
      ok: false,
      status: 'manual',
      ...candidate,
      error: inspected.error,
      next: manualNext(file, candidate.format),
    };
  }

  const canWrite = !inspected.configured || opts.force;
  let merged = null;
  let changed = false;
  if (canWrite) {
    merged = mergeText(prev, opts.spec, candidate.format, file);
    changed = merged.changed;
  }
  if (opts.dryRun) {
    return {
      ok: true,
      status: changed ? 'planned' : (inspected.configured ? 'unchanged' : 'planned'),
      ...candidate,
      changed,
      configured: inspected.configured,
      verified: false,
      ...(changed ? { preview: merged.text.slice(0, 500) } : {}),
    };
  }

  let backup = null;
  if (changed) {
    try {
      backup = backupFile(file);
      atomicWrite(file, merged.text);
    } catch (e) {
      if (!existed) { try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {} }
      return { ok: false, status: 'failed', ...candidate, error: `写入失败: ${e.message}`, next: '检查文件权限或占用' };
    }
  }

  if (opts.probe === false) {
    return {
      ok: true,
      status: changed ? 'written_unverified' : 'unchanged_unverified',
      ...candidate,
      changed,
      backup,
      configured: true,
      verified: false,
    };
  }

  const entry = changed ? merged.entry : (inspected.entry || entryFor(opts.spec, candidate.format));
  const probe = await probeMcpEntry(entry, { timeoutMs: opts.timeoutMs, format: candidate.format });
  if (!probe.ok) {
    let rolledBack = false;
    if (changed) {
      try {
        if (existed && backup) fs.copyFileSync(backup, file);
        else if (!existed && fs.existsSync(file)) fs.unlinkSync(file);
        rolledBack = true;
      } catch {}
    }
    return {
      ok: false,
      status: 'failed',
      ...candidate,
      changed,
      backup,
      rolled_back: rolledBack,
      probe,
      error: probe.error || 'MCP 测试未通过',
      next: rolledBack
        ? '已回滚配置文件；请确认客户端实际启动命令或手工接入'
        : (inspected.configured && !opts.force
          ? '已有 agentbus 条目未覆盖；确认其 command/args/env，必要时加 --force 重写'
          : '配置文件未改动；请检查已有 agentbus 条目'),
    };
  }

  return {
    ok: true,
    status: 'ok',
    ...candidate,
    changed,
    backup,
    configured: true,
    verified: true,
    verified_by: 'mcp_probe',
    probe,
    next: candidate.activation === 'ui'
      ? `在 ${candidate.label} 的 MCP/连接器界面保存并信任，然后确认工具列表`
      : `重启 ${candidate.label} 后检查工具列表`,
  };
}

export async function adaptPresets({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  root,
  allowed,
  bin = 'node',
  role = 'worker',
  allowDispatch = false,
  ids,
  paths,
  scan = false,
  format,
  dryRun = false,
  probe = true,
  force = false,
  timeoutMs = 10000,
} = {}) {
  const h = path.resolve(home || os.homedir());
  const resolvedRoot = path.resolve(root || defaultRoot());
  const spec = buildServerSpec({
    root: resolvedRoot,
    allowed: allowed && allowed.length ? allowed : [resolvedRoot],
    bin,
    role,
    allowDispatch,
    env: { AGENTBUS_ROLE: role === 'conductor' ? 'conductor' : 'worker' },
  });
  let candidates;
  try {
    candidates = collectCandidates({ home: h, platform, ids, paths, scan, format });
  } catch (e) {
    return {
      ok: false,
      error: String(e.message || e),
      error_code: e.code || 'adapt_failed',
      home: h,
      root: resolvedRoot,
      presets: [],
      summary: { detected: 0, ok: 0, failed: 1, manual: 0, planned: 0, skipped: 0 },
      next_steps: [String(e.message || e)],
    };
  }

  const results = [];
  for (const candidate of candidates) {
    try {
      results.push(await adaptOne(candidate, { spec, dryRun, probe, force, timeoutMs }));
    } catch (e) {
      results.push({ ok: false, status: 'failed', ...candidate, error: String(e.message || e) });
    }
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  const failed = results.filter((r) => r.status === 'failed');
  const manual = results.filter((r) => r.status === 'manual');
  const nextSteps = [...new Set([
    ...failed.map((r) => r.next).filter(Boolean),
    ...manual.map((r) => r.next).filter(Boolean),
    ...results.filter((r) => r.status === 'ok' && r.next).map((r) => r.next),
  ])];
  return {
    ok: failed.length === 0,
    home: h,
    root: resolvedRoot,
    role: role === 'conductor' ? 'conductor' : 'worker',
    dry_run: Boolean(dryRun),
    presets: results,
    summary: {
      detected: results.length,
      ok: count('ok'),
      failed: failed.length,
      manual: manual.length,
      planned: count('planned'),
      unchanged: count('unchanged'),
      skipped: count('skipped'),
    },
    next_steps: nextSteps,
  };
}

