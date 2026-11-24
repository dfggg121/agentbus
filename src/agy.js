// Antigravity session handoff, modelled on magpie's Claude bridge:
// the token is written to a private file (0600) and read by the adapter,
// never exported into a world-readable environment or a command line.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// How many steps a conversation has accumulated. Used by thread limits: a
// long-lived conversation re-reads its whole history on every turn, so past
// ~40 steps a fresh conversation is cheaper than continuity.
export function conversationStepCount(sessionId, home = os.homedir()) {
  if (!sessionId) return null;
  const file = path.join(home, '.gemini', 'antigravity', 'conversations', `${sessionId}.db`);
  if (!fs.existsSync(file)) return null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare('SELECT COUNT(*) AS c FROM steps').get();
    db.close();
    return Number(row?.c || 0);
  } catch {
    return null;
  }
}

export function defaultAgySessionPath(busRoot) {
  return process.env.AGENTBUS_AGY_SESSION || path.join(busRoot || process.cwd(), 'antigravity-session.json');
}

export function agySessionFileHint(busRoot) {
  return defaultAgySessionPath(busRoot);
}

function tighten(file) {
  try {
    if (process.platform === 'win32') {
      const user = process.env.USERNAME;
      if (!user) return;
      spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true });
    } else {
      fs.chmodSync(file, 0o600);
    }
  } catch {
    // Best effort: the file is still user-owned; a failure here must not abort.
  }
}

// Run this inside Antigravity's own integrated terminal, where the two
// variables exist. Nothing is printed but the path and the token length.
export function exportAgySession(outPath) {
  let address = process.env.ANTIGRAVITY_LS_ADDRESS;
  let csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  let source = 'env';
  if (!address || !csrf) {
    const found = discoverAgySession();
    if (found) {
      address = found.ls_address;
      csrf = found.csrf_token;
      source = found.source;
    }
  }
  if (!address || !csrf) {
    throw Object.assign(new Error(
      '找不到 Antigravity 的会话坐标：环境变量没有，daemon 目录里也没有 hub_*.json。'
      + '请在 Antigravity 的集成终端里运行本命令，或用 AGENTBUS_AGY_SESSION 指向已导出的文件。',
    ), { code: 1 });
  }
  const target = path.resolve(outPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = {
    kind: 'antigravity-session',
    ls_address: address,
    csrf_token: csrf,
    exported_at: new Date().toISOString(),
    source,
  };
  fs.writeFileSync(target, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  tighten(target);
  return { path: target, ls_address: address, token_chars: csrf.length, source, note: '重启 Antigravity 后需重新导出' };
}

export function readAgySession(file) {
  const target = path.resolve(file);
  if (!fs.existsSync(target)) {
    throw Object.assign(new Error(
      `找不到 Antigravity 会话文件: ${target}\n`
      + '在 Antigravity 的集成终端里运行一次：\n'
      + `  node <agentbus>/bin/bus.js agy-session --out "${target}"\n`
      + '（该文件含 CSRF 令牌，权限已收紧，不要提交到 git）',
    ), { code: 1 });
  }
  const data = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (!data.ls_address || !data.csrf_token) {
    throw Object.assign(new Error(`会话文件缺少 ls_address / csrf_token: ${target}`), { code: 1 });
  }
  return data;
}

export function detectAgentApi() {
  if (process.env.AGENTBUS_ANTIGRAVITY_BIN) return process.env.AGENTBUS_ANTIGRAVITY_BIN;
  const wrapper = path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi.bat');
  return fs.existsSync(wrapper) ? wrapper : null;
}

// Antigravity keeps its live coordinates in a daemon hub file. Reading it beats
// asking the user to export env vars by hand, and the file is per-run so a stale
// copy is detected by its pid.
function daemonDirs() {
  const dirs = [];
  if (process.env.AGENTBUS_AGY_DAEMON_DIR) dirs.push(process.env.AGENTBUS_AGY_DAEMON_DIR);
  dirs.push(path.join(os.homedir(), '.gemini', 'antigravity', 'daemon'));
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'Antigravity', 'daemon'));
  dirs.push('E:/ai/AntigravityApp_data/dot_gemini/antigravity/daemon');
  return dirs.filter((d) => fs.existsSync(d));
}

export function discoverAgySession() {
  let best = null;
  for (const dir of daemonDirs()) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir).filter((f) => /^hub_\d+\.json$/.test(f));
    } catch { continue; }
    for (const name of entries) {
      const full = path.join(dir, name);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch { continue; }
      if (!data.csrfToken || !data.httpPort) continue;
      const mtime = fs.statSync(full).mtimeMs;
      if (!best || mtime > best.mtime) {
        best = {
          mtime,
          source: full,
          ls_address: `http://127.0.0.1:${data.httpPort}`,
          csrf_token: data.csrfToken,
          pid: data.pid,
        };
      }
    }
  }
  return best;
}
