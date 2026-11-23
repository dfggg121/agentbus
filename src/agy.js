// Antigravity session handoff, modelled on magpie's Claude bridge:
// the token is written to a private file (0600) and read by the adapter,
// never exported into a world-readable environment or a command line.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

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
  const address = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!address || !csrf) {
    throw Object.assign(new Error(
      '当前环境没有 ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN。'
      + '这两个变量只存在于 Antigravity 的集成终端里，请在那里面运行本命令。',
    ), { code: 1 });
  }
  const target = path.resolve(outPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = {
    kind: 'antigravity-session',
    ls_address: address,
    csrf_token: csrf,
    exported_at: new Date().toISOString(),
  };
  fs.writeFileSync(target, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  tighten(target);
  return { path: target, ls_address: address, token_chars: csrf.length, note: '重启 Antigravity 后需重新导出' };
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
