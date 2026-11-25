// Local agent detection + per-machine settings (models, conductor).
// The repo ships the mechanism only: no personal preference is stored here.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

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
    bins: ['codex.cmd', 'codex'],
    config: (home) => path.join(home, '.codex', 'config.toml'),
    role: 'conductor-capable',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    bins: ['claude.cmd', 'claude'],
    config: (home) => path.join(home, '.claude.json'),
    role: 'conductor-capable',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bins: ['gemini.cmd', 'gemini'],
    config: (home) => path.join(home, '.gemini', 'settings.json'),
    role: 'conductor-capable',
  },
  {
    id: 'antigravity',
    label: 'Google Antigravity',
    bins: [],
    config: (home) => path.join(home, '.gemini', 'config', 'mcp_config.json'),
    marker: (home) => path.join(home, '.gemini', 'antigravity', 'bin', 'agentapi.bat'),
    role: 'worker-async',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bins: ['opencode.cmd', 'opencode'],
    config: (home) => path.join(home, '.config', 'opencode', 'opencode.json'),
    role: 'conductor-capable',
  },
];

function which(bin) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, [bin], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first || null;
}

export function detectAgents(home = os.homedir()) {
  return DEFS.map((d) => {
    const binPath = d.bins.map(which).find(Boolean) || null;
    const marker = d.marker ? d.marker(home) : null;
    const markerOk = marker ? fs.existsSync(marker) : false;
    const cfg = d.config(home);
    const configExists = fs.existsSync(cfg);
    return {
      id: d.id,
      label: d.label,
      installed: Boolean(binPath || markerOk || configExists),
      bin: binPath || (markerOk ? marker : null),
      config: cfg,
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
