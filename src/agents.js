// Local agent detection + per-machine settings (models, conductor).
// The repo ships the mechanism only: no personal preference is stored here.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// Product model lists are public knowledge; per-machine choices live in agents.json.
export const KNOWN_MODELS = {
  antigravity: [
    'gemini-4-neon',
    'gemini-4-neon-extra-high',
    'gemini-4-argon',
    'gemini-4-hydrogen',
    'gemini-3.8-flash',
    'claude-opus-5.5',
    'claude-sonnet-5.5',
    'gpt-oss-120b',
  ],
  codex: [],
  claude: ['claude-opus-5.5', 'claude-sonnet-5.5'],
  gemini: ['gemini-4-neon', 'gemini-3.8-flash'],
  opencode: [],
};

const DEFS = [
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    envVar: 'AGENTBUS_CODEX_BIN',
    bins: ['codex'],
    installHint: 'npm i -g @openai/codex',
    role: 'conductor-capable',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    envVar: 'AGENTBUS_CLAUDE_BIN',
    bins: ['claude'],
    installHint: 'npm i -g @anthropic-ai/claude-code',
    role: 'conductor-capable',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    envVar: 'AGENTBUS_GEMINI_BIN',
    bins: ['gemini'],
    installHint: 'npm i -g @google/gemini-cli',
    role: 'conductor-capable',
  },
  {
    id: 'antigravity',
    label: 'Google Antigravity',
    envVar: 'AGENTBUS_ANTIGRAVITY_BIN',
    bins: ['agentapi', 'antigravity'],
    installHint: '安装或启动 Antigravity（提供 ~/.gemini/antigravity/bin/agentapi）',
    role: 'worker-async',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    envVar: 'AGENTBUS_OPENCODE_BIN',
    bins: ['opencode'],
    installHint: 'npm i -g opencode-ai',
    role: 'conductor-capable',
  },
];

export function hermesPaths(home = os.homedir(), opts = {}) {
  const h = path.resolve(home || os.homedir());
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const explicitHome = opts.explicitHome !== undefined
    ? Boolean(opts.explicitHome)
    : (home !== undefined && home !== null && path.resolve(home) !== path.resolve(os.homedir()));

  const dotHermes = path.join(h, '.hermes');
  const dotCfg = path.join(dotHermes, 'config.yaml');

  if (explicitHome) {
    if (platform === 'win32') {
      const localHermes = path.join(h, 'AppData', 'Local', 'hermes');
      const localCfg = path.join(localHermes, 'config.yaml');
      if (fs.existsSync(localCfg)) return { hermesHome: localHermes, file: localCfg };
      if (fs.existsSync(dotCfg) || fs.existsSync(dotHermes)) return { hermesHome: dotHermes, file: dotCfg };
      if (fs.existsSync(localHermes)) return { hermesHome: localHermes, file: localCfg };
    } else if (fs.existsSync(dotHermes)) {
      return { hermesHome: dotHermes, file: dotCfg };
    }
    const directCfg = path.join(h, 'config.yaml');
    if (fs.existsSync(directCfg)) {
      return { hermesHome: h, file: directCfg };
    }
    return { hermesHome: dotHermes, file: dotCfg };
  }

  const envHermesHome = env.HERMES_HOME && String(env.HERMES_HOME).trim();
  if (envHermesHome) {
    const dir = path.resolve(envHermesHome);
    return { hermesHome: dir, file: path.join(dir, 'config.yaml') };
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA && String(env.LOCALAPPDATA).trim()
      ? path.resolve(String(env.LOCALAPPDATA).trim())
      : path.join(h, 'AppData', 'Local');
    const localHermes = path.join(localAppData, 'hermes');
    const localCfg = path.join(localHermes, 'config.yaml');
    if (fs.existsSync(localCfg)) return { hermesHome: localHermes, file: localCfg };
    if (fs.existsSync(dotCfg)) return { hermesHome: dotHermes, file: dotCfg };
    if (fs.existsSync(localHermes) && !fs.existsSync(dotHermes)) {
      return { hermesHome: localHermes, file: localCfg };
    }
    return { hermesHome: dotHermes, file: dotCfg };
  }

  return { hermesHome: dotHermes, file: dotCfg };
}

export function clientConfigFile(id, home = os.homedir(), platform = process.platform, opts = {}) {
  const h = path.resolve(home || os.homedir());
  switch (id) {
    case 'codex':
      return path.join(h, '.codex', 'config.toml');
    case 'claude':
      return path.join(h, '.claude.json');
    case 'gemini':
      return path.join(h, '.gemini', 'settings.json');
    case 'antigravity': {
      // Official docs: global config is ~/.gemini/config/mcp_config.json (App/IDE/CLI share it).
      // Fall back to legacy ~/.gemini/antigravity/mcp_config.json if that already exists.
      const primary = path.join(h, '.gemini', 'config', 'mcp_config.json');
      if (fs.existsSync(primary)) return primary;
      const legacy = path.join(h, '.gemini', 'antigravity', 'mcp_config.json');
      if (fs.existsSync(legacy)) return legacy;
      return primary;
    }
    case 'cursor':
      return path.join(h, '.cursor', 'mcp.json');
    case 'opencode':
      return path.join(h, '.config', 'opencode', 'opencode.json');
    case 'claude-desktop':
      if (platform === 'win32') {
        return path.join(h, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
      }
      if (platform === 'darwin') {
        return path.join(h, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      return path.join(h, '.config', 'Claude', 'claude_desktop_config.json');
    case 'windsurf':
      return path.join(h, '.codeium', 'windsurf', 'mcp_config.json');
    case 'kiro':
      return path.join(h, '.kiro', 'settings', 'mcp.json');
    case 'lmstudio':
      return path.join(h, '.lmstudio', 'mcp.json');
    case 'cline': {
      const extDir = platform === 'win32'
        ? path.join(h, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
        : platform === 'darwin'
          ? path.join(h, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
          : path.join(h, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
      if (fs.existsSync(extDir)) {
        return path.join(extDir, 'settings', 'cline_mcp_settings.json');
      }
      return path.join(h, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
    }
    case 'dsh':
      return path.join(h, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
    case 'hermes':
      return hermesPaths(h, { platform, explicitHome: opts.explicitHome, env: opts.env }).file;
    default:
      return null;
  }
}

function stripQuotes(s) {
  const t = String(s || '').trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function isRunnableFile(filePath, platform) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    if (platform !== 'win32' && platform === process.platform) {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function resolveBinInDir(dir, name, platform) {
  if (!dir) return null;
  const cleanDir = stripQuotes(dir);
  if (!cleanDir) return null;
  const lower = name.toLowerCase();
  const hasWinExt = /\.(exe|cmd|bat|com)$/i.test(lower);
  const candidates = platform === 'win32'
    ? (hasWinExt ? [name] : [`${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.com`])
    : [name];
  for (const cand of candidates) {
    const full = path.join(cleanDir, cand);
    if (isRunnableFile(full, platform)) return full;
  }
  return null;
}

let codexDesktopBinCache = null;
let codexDesktopBinCacheKey = null;

function findCodexDesktopBin(env, platform) {
  if (platform !== 'win32') return null;
  if (env.AGENTBUS_CODEX_PREFER_DESKTOP === '0') return null;
  const explicit = env.AGENTBUS_CODEX_DESKTOP_BIN;
  const cacheKey = `${process.platform}|${explicit || ''}|${env.ProgramFiles || ''}`;
  if (codexDesktopBinCacheKey === cacheKey) return codexDesktopBinCache;

  const candidates = [];
  if (explicit) candidates.push(explicit);
  try {
    const ps = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-AppxPackage -Name OpenAI.Codex).InstallLocation',
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const install = String(ps || '').trim().split(/\r?\n/).find((line) => line.trim());
    if (install) candidates.push(path.join(install.trim(), 'app', 'resources', 'codex.exe'));
  } catch {}
  candidates.push(
    path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Codex', 'resources', 'codex.exe'),
    path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Codex', 'codex.exe'),
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(stripQuotes(candidate));
    if (isRunnableFile(resolved, platform)) {
      codexDesktopBinCache = resolved;
      codexDesktopBinCacheKey = cacheKey;
      return resolved;
    }
  }
  codexDesktopBinCache = null;
  codexDesktopBinCacheKey = cacheKey;
  return null;
}

function readPathEntries(env, platform) {
  if (!env || typeof env !== 'object') return [];
  let raw = '';
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === 'PATH' && env[k]) {
      raw = String(env[k]);
      break;
    }
  }
  if (!raw) return [];
  const delim = platform === 'win32' ? ';' : (raw.includes(path.delimiter) ? path.delimiter : ':');
  return raw
    .split(delim)
    .map((s) => stripQuotes(s))
    .filter(Boolean);
}

function parseSemverParts(name) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(name);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

function listVersionDirsDesc(parentDir) {
  if (!parentDir || !fs.existsSync(parentDir)) return [];
  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
    entries.sort((a, b) => {
      const pa = parseSemverParts(a);
      const pb = parseSemverParts(b);
      if (pa && pb) {
        for (let i = 0; i < 3; i++) {
          if (pb[i] !== pa[i]) return pb[i] - pa[i];
        }
        return b.localeCompare(a);
      }
      if (pa) return -1;
      if (pb) return 1;
      return b.localeCompare(a);
    });
    return entries.map((name) => path.join(parentDir, name));
  } catch {
    return [];
  }
}

function dedupeDirs(dirs) {
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    if (!d) continue;
    const norm = path.resolve(d);
    const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

function commonDirsForAgent(agentId, home, env, platform, explicitHome) {
  const h = path.resolve(home || os.homedir());
  const dirs = [];

  const appData = !explicitHome && env.APPDATA ? env.APPDATA : path.join(h, 'AppData', 'Roaming');
  const localAppData = !explicitHome && env.LOCALAPPDATA ? env.LOCALAPPDATA : path.join(h, 'AppData', 'Local');

  // 1. Agent-specific install directories
  if (agentId === 'antigravity') {
    dirs.push(path.join(h, '.gemini', 'antigravity', 'bin'));
    if (platform === 'win32') {
      dirs.push(path.join(localAppData, 'Programs', 'Antigravity', 'bin'));
      dirs.push(path.join(localAppData, 'Programs', 'Antigravity', 'resources', 'app', 'bin'));
      dirs.push(path.join(localAppData, 'Programs', 'Antigravity'));
    } else if (platform === 'darwin') {
      dirs.push('/Applications/Antigravity.app/Contents/Resources/app/bin');
      dirs.push(path.join(h, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin'));
    } else {
      dirs.push('/opt/Antigravity/bin', '/usr/share/antigravity/bin', path.join(h, '.local', 'share', 'Antigravity', 'bin'));
    }
  } else if (agentId === 'claude') {
    dirs.push(path.join(h, '.local', 'bin'));
    dirs.push(path.join(h, '.claude', 'local'));
    dirs.push(path.join(h, '.claude', 'local', 'node_modules', '.bin'));
  } else if (agentId === 'codex') {
    dirs.push(path.join(h, '.codex', 'bin'));
  } else if (agentId === 'gemini') {
    dirs.push(path.join(h, '.gemini', 'bin'));
  }

  // 2. Volta
  if (env.VOLTA_HOME) dirs.push(path.join(stripQuotes(env.VOLTA_HOME), 'bin'));
  dirs.push(path.join(h, '.volta', 'bin'));
  if (platform === 'win32') {
    dirs.push(path.join(localAppData, 'Volta', 'bin'));
  }

  // 3. Scoop (Windows)
  if (platform === 'win32') {
    if (env.SCOOP) dirs.push(path.join(stripQuotes(env.SCOOP), 'shims'));
    dirs.push(path.join(h, 'scoop', 'shims'));
    if (env.SCOOP_GLOBAL) dirs.push(path.join(stripQuotes(env.SCOOP_GLOBAL), 'shims'));
  }

  // 4. nvm (nvm-windows & POSIX nvm)
  if (platform === 'win32') {
    if (env.NVM_SYMLINK) dirs.push(stripQuotes(env.NVM_SYMLINK));
    const nvmRoots = dedupeDirs([
      env.NVM_HOME ? stripQuotes(env.NVM_HOME) : null,
      path.join(appData, 'nvm'),
      path.join(localAppData, 'nvm'),
    ]);
    for (const root of nvmRoots) {
      for (const verDir of listVersionDirsDesc(root)) {
        dirs.push(verDir);
      }
    }
  } else {
    const nvmDirs = dedupeDirs([
      env.NVM_DIR ? stripQuotes(env.NVM_DIR) : null,
      path.join(h, '.nvm'),
    ]);
    for (const nvmRoot of nvmDirs) {
      dirs.push(path.join(nvmRoot, 'current', 'bin'));
      for (const verDir of listVersionDirsDesc(path.join(nvmRoot, 'versions', 'node'))) {
        dirs.push(path.join(verDir, 'bin'));
      }
    }
  }

  // 5. npm / pnpm / bun / cargo / homebrew / standard user bins
  if (env.npm_config_prefix) {
    const prefix = stripQuotes(env.npm_config_prefix);
    dirs.push(platform === 'win32' ? prefix : path.join(prefix, 'bin'));
  }

  if (platform === 'win32') {
    dirs.push(path.join(appData, 'npm'));
    dirs.push(path.join(localAppData, 'pnpm'));
    dirs.push(path.join(h, '.bun', 'bin'));
    dirs.push(path.join(h, '.local', 'bin'));
    dirs.push(path.join(h, '.cargo', 'bin'));
    if (!explicitHome && env.ProgramFiles) dirs.push(path.join(env.ProgramFiles, 'nodejs'));
  } else {
    dirs.push(path.join(h, '.npm-global', 'bin'));
    dirs.push(path.join(h, '.local', 'bin'));
    if (platform === 'darwin') dirs.push(path.join(h, 'Library', 'pnpm'));
    dirs.push(path.join(h, '.local', 'share', 'pnpm'));
    dirs.push(path.join(h, '.bun', 'bin'));
    dirs.push(path.join(h, '.cargo', 'bin'));
    if (platform === 'darwin') {
      dirs.push('/opt/homebrew/bin', '/usr/local/bin');
    } else {
      dirs.push('/usr/local/bin', '/usr/bin');
    }
  }

  return dedupeDirs(dirs);
}

export function agentEnvVar(agentId) {
  return DEFS.find((d) => d.id === agentId)?.envVar || null;
}

export function resolveAgentBin(agentId, opts = {}) {
  const def = DEFS.find((d) => d.id === agentId);
  if (!def) return { bin: null, source: null, envVar: null, envValue: null, error: 'unknown_agent', message: `未知 agent: ${agentId}`, next: null };

  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const home = path.resolve(opts.home || os.homedir());
  const explicitHome = opts.explicitHome !== undefined
    ? Boolean(opts.explicitHome)
    : (opts.home !== undefined && opts.home !== null && path.resolve(opts.home) !== path.resolve(os.homedir()));

  const pathDirs = readPathEntries(env, platform);

  // 1. Env override
  const rawEnv = env[def.envVar];
  if (typeof rawEnv === 'string' && rawEnv.trim()) {
    const val = stripQuotes(rawEnv);
    const looksLikePath = path.isAbsolute(val) || val.includes('/') || val.includes('\\');
    if (looksLikePath) {
      const resolved = path.resolve(val);
      if (isRunnableFile(resolved, platform)) {
        return { bin: resolved, source: 'env', envVar: def.envVar, envValue: val, error: null, message: null, next: null };
      }
      const inDir = resolveBinInDir(path.dirname(resolved), path.basename(resolved), platform);
      if (inDir) {
        return { bin: inDir, source: 'env', envVar: def.envVar, envValue: val, error: null, message: null, next: null };
      }
    } else {
      for (const dir of pathDirs) {
        const hit = resolveBinInDir(dir, val, platform);
        if (hit) {
          return { bin: hit, source: 'env', envVar: def.envVar, envValue: val, error: null, message: null, next: null };
        }
      }
    }
    const envCmd = platform === 'win32'
      ? `set ${def.envVar}=<${def.id} 可执行文件绝对路径>`
      : `export ${def.envVar}=<${def.id} 可执行文件绝对路径>`;
    return {
      bin: null,
      source: null,
      envVar: def.envVar,
      envValue: val,
      error: 'env_bin_not_found',
      message: `${def.envVar} 指向的可执行文件不存在或不可执行: ${val}`,
      next: `检查 ${def.envVar} 路径是否正确，或取消覆盖后重装: ${envCmd}`,
    };
  }

  // 1b. Codex Desktop bundles its own CLI binary. Prefer it over a possibly
  // stale npm CLI: it supports the models configured in agents.json and its
  // threads are the ones the Desktop app can show under a project.
  if (agentId === 'codex') {
    const desktop = findCodexDesktopBin(env, platform);
    if (desktop) {
      return {
        bin: desktop,
        source: 'desktop_app',
        envVar: def.envVar,
        envValue: null,
        error: null,
        message: null,
        next: null,
      };
    }
  }

  // 2. PATH
  for (const binName of def.bins) {
    for (const dir of pathDirs) {
      const hit = resolveBinInDir(dir, binName, platform);
      if (hit) {
        return { bin: hit, source: 'path', envVar: def.envVar, envValue: null, error: null, message: null, next: null };
      }
    }
  }

  // 3. Common install directories (agent dirs / volta / scoop / nvm / npm / homebrew)
  const commonDirs = commonDirsForAgent(agentId, home, env, platform, explicitHome);
  for (const binName of def.bins) {
    for (const dir of commonDirs) {
      const hit = resolveBinInDir(dir, binName, platform);
      if (hit) {
        return { bin: hit, source: 'common_dir', envVar: def.envVar, envValue: null, error: null, message: null, next: null };
      }
    }
  }

  const nextHint = platform === 'win32'
    ? `安装 ${def.label}（${def.installHint}），或设置环境变量 ${def.envVar}=<可执行文件绝对路径>`
    : `安装 ${def.label}（${def.installHint}），或设置环境变量 export ${def.envVar}=<可执行文件绝对路径>`;
  return {
    bin: null,
    source: null,
    envVar: def.envVar,
    envValue: null,
    error: 'missing_binary',
    message: `未找到 ${def.id} 可执行文件（已按顺序检查 ${def.envVar} > PATH > nvm/scoop/volta 等常见目录）`,
    next: nextHint,
  };
}

export function detectAgents(home = os.homedir(), opts = {}) {
  const resolvedHome = path.resolve(home || os.homedir());
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const explicitHome = opts.explicitHome !== undefined
    ? Boolean(opts.explicitHome)
    : (home !== undefined && home !== null && path.resolve(home) !== path.resolve(os.homedir()));

  return DEFS.map((d) => {
    const binRes = resolveAgentBin(d.id, { home: resolvedHome, env, platform, explicitHome });
    const cfg = clientConfigFile(d.id, resolvedHome, platform, { explicitHome, env });
    const cfgDir = path.dirname(cfg);
    const configExists = fs.existsSync(cfg);
    const configDirExists = fs.existsSync(cfgDir);
    return {
      id: d.id,
      label: d.label,
      installed: Boolean(binRes.bin || configExists),
      bin: binRes.bin,
      bin_source: binRes.source,
      env_var: d.envVar,
      env_override: binRes.envValue,
      bin_error: binRes.error,
      diagnostic: binRes.bin ? null : { code: binRes.error, message: binRes.message, next: binRes.next },
      config: cfg,
      config_dir: cfgDir,
      config_dir_exists: configDirExists,
      config_exists: configExists,
      capabilities: d.role,
      models: KNOWN_MODELS[d.id] || [],
    };
  });
}

export function agentConfigPath(root) {
  return process.env.AGENTBUS_AGENTS_CONFIG || path.join(root, 'agents.json');
}

export function readAgentConfig(root) {
  const file = agentConfigPath(root);
  if (!fs.existsSync(file)) return { conductor: null, models: {}, thread_limits: {}, archive_on_done: false, updated_at: null };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      conductor: data.conductor || null,
      models: data.models || {},
      thread_limits: data.thread_limits && typeof data.thread_limits === 'object' ? data.thread_limits : {},
      archive_on_done: data.archive_on_done === true,
      updated_at: data.updated_at || null,
    };
  } catch {
    return { conductor: null, models: {}, thread_limits: {}, archive_on_done: false, updated_at: null, broken: true };
  }
}

export function writeAgentConfig(root, cfg) {
  const file = agentConfigPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readAgentConfig(root);
  const threadLimits = cfg.thread_limits !== undefined ? cfg.thread_limits : existing.thread_limits;
  const archiveOnDone = cfg.archive_on_done !== undefined ? cfg.archive_on_done === true : existing.archive_on_done;
  const payload = {
    conductor: cfg.conductor || null,
    models: cfg.models || {},
    ...(threadLimits && Object.keys(threadLimits).length > 0 ? { thread_limits: threadLimits } : {}),
    ...(archiveOnDone ? { archive_on_done: true } : {}),
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { path: file, ...payload };
}

export function modelFor(root, agent, env = process.env) {
  if (env.AGENTBUS_AGY_MODEL && agent === 'antigravity') return env.AGENTBUS_AGY_MODEL;
  const cfg = readAgentConfig(root);
  return cfg.models[agent] || null;
}
