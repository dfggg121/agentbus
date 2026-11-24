// Client auto-configuration for agentbus.
// Writes (or updates) the MCP server entry for supported agent CLIs.
// Rules: idempotent, always backs up the target file, never touches unrelated keys.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const bak = `${file}.bak-${stamp()}`;
  fs.copyFileSync(file, bak);
  return bak;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- server spec ----------

function serverSpec({ root, allowed, bin = 'node', env: extraEnv }) {
  const roots = (allowed && allowed.length ? allowed : [root]).map((p) => path.resolve(p));
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

function stripTomlSection(text, section) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  const head = `[${section}`;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('[') && !t.startsWith('[[')) {
      if (t === `[${section}]` || t.startsWith(head + '.')) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function tomlValue(v) {
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  return JSON.stringify(String(v));
}

function mergeToml(file, spec) {
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const base = stripTomlSection(prev, 'mcp_servers.agentbus');
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

function mergeJson(file, mutate) {
  let data = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (e) {
        throw new Error(`${file} 不是合法 JSON，已停止（未写入）: ${e.message}`);
      }
    }
  }
  mutate(data);
  return JSON.stringify(data, null, 2) + '\n';
}

// ---------- client adapters ----------

const CLIENTS = [
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    file: (home) => path.join(home, '.codex', 'config.toml'),
    format: 'toml',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    file: (home) => path.join(home, '.claude.json'),
    format: 'json-mcpServers',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    file: (home) => path.join(home, '.gemini', 'settings.json'),
    format: 'json-mcpServers',
  },
  {
    id: 'antigravity',
    label: 'Google Antigravity',
    // Official docs: global config is ~/.gemini/config/mcp_config.json (App/IDE/CLI share it).
    file: (home) => path.join(home, '.gemini', 'config', 'mcp_config.json'),
    format: 'json-mcpServers',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    file: (home) => path.join(home, '.cursor', 'mcp.json'),
    format: 'json-mcpServers',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    file: (home) => path.join(home, '.config', 'opencode', 'opencode.json'),
    format: 'json-opencode',
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    file: (home) => {
      if (process.platform === 'win32') {
        return path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
      }
      if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    },
    format: 'json-mcpServers',
  },
];

export function listClients() {
  return CLIENTS.map((c) => c.id);
}

function applyClient(client, opts) {
  const file = client.file(opts.home);
  const spec = serverSpec(opts);
  const bak = backupIfExists(file);
  let text;
  if (client.format === 'toml') {
    text = mergeToml(file, spec);
  } else if (client.format === 'json-mcpServers') {
    text = mergeJson(file, (data) => {
      data.mcpServers = data.mcpServers || {};
      data.mcpServers.agentbus = { command: spec.command, args: spec.args, env: spec.env };
    });
  } else if (client.format === 'json-opencode') {
    text = mergeJson(file, (data) => {
      data.mcp = data.mcp || {};
      data.mcp.agentbus = { type: 'local', command: [spec.command, ...spec.args], enabled: true, environment: spec.env };
    });
  } else {
    throw new Error(`unknown client format: ${client.format}`);
  }
  if (opts.dryRun) return { client: client.id, file, backup: bak, changed: true, dry_run: true, preview: text.slice(0, 400) };
  writeAtomic(file, text);
  return { client: client.id, file, backup: bak, changed: true };
}

export function setupClients({ clients, root, allowed, bin, home, dryRun, env }) {
  const ids = clients && clients.length ? clients : CLIENTS.map((c) => c.id);
  const unknown = ids.filter((id) => !CLIENTS.some((c) => c.id === id));
  if (unknown.length) {
    throw Object.assign(new Error(`未知客户端: ${unknown.join(', ')}；可选: ${listClients().join(', ')}`), { code: 1 });
  }
  const opts = { root: root || defaultRoot(), allowed, bin: bin || 'node', home: home || os.homedir(), dryRun: !!dryRun, env };
  const results = [];
  for (const id of ids) {
    const client = CLIENTS.find((c) => c.id === id);
    try {
      results.push({ ok: true, ...applyClient(client, opts) });
    } catch (e) {
      results.push({ ok: false, client: id, error: String(e.message || e) });
    }
  }
  return {
    ok: results.every((r) => r.ok),
    root: path.resolve(opts.root),
    allowed_roots: (opts.allowed && opts.allowed.length ? opts.allowed : [opts.root]).map((p) => path.resolve(p)),
    server: serverSpec(opts),
    results,
  };
}

// ---------- doctor ----------

function hasEntry(file, format) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    if (format === 'toml') return /\[mcp_servers\.agentbus\]/.test(raw);
    const data = JSON.parse(raw);
    if (format === 'json-mcpServers') return !!(data.mcpServers && data.mcpServers.agentbus);
    if (format === 'json-opencode') return !!(data.mcp && data.mcp.agentbus);
    return null;
  } catch {
    return null;
  }
}

export function doctor({ home, root }) {
  const h = home || os.homedir();
  const r = root || defaultRoot();
  const clients = CLIENTS.map((c) => {
    const file = c.file(h);
    return {
      id: c.id,
      label: c.label,
      config: file,
      exists: fs.existsSync(file),
      configured: hasEntry(file, c.format),
    };
  });
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    sqlite: (() => {
      try {
        // eslint-disable-next-line no-new-func
        return typeof process.getBuiltinModule === 'function' ? 'available' : 'unknown';
      } catch { return 'unknown'; }
    })(),
    home: h,
    root: path.resolve(r),
    root_exists: fs.existsSync(path.resolve(r)),
    clients,
    next: clients.some((c) => c.configured)
      ? 'At least one client is configured. Restart that client to load the agentbus tools.'
      : 'No client configured yet. Run: agentbus setup --client <id>',
  };
}
