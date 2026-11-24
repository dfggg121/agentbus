// Antigravity session handoff, modelled on magpie's Claude bridge:
// the token is written to a private file (0600) and read by the adapter,
// never exported into a world-readable environment or a command line.

import fs from 'node:fs';
import http from 'node:http';
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

export function resolveCdpPort(portOpt = null, env = process.env) {
  if (portOpt !== null && portOpt !== undefined && portOpt !== '') {
    const p = Number(portOpt);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) {
      throw Object.assign(new Error(`非法 CDP 端口: ${portOpt}`), { code: 1 });
    }
    return p;
  }
  if (env.AGENTBUS_AGY_CDP_PORT) {
    const p = Number(env.AGENTBUS_AGY_CDP_PORT);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) {
      throw Object.assign(new Error(`非法 AGENTBUS_AGY_CDP_PORT: ${env.AGENTBUS_AGY_CDP_PORT}`), { code: 1 });
    }
    return p;
  }
  return 9222;
}

function httpGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`invalid JSON from ${url}: ${err.message}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

function cdpEvaluate(wsUrl, expression, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (typeof globalThis.WebSocket !== 'function') {
      reject(new Error('当前 Node 版本缺少内置 WebSocket 客户端'));
      return;
    }
    const ws = new globalThis.WebSocket(wsUrl);
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => {
      done(new Error(`CDP evaluate timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data || ''));
      } catch {
        return;
      }
      if (msg.id !== 1) return;
      const res = msg.result || {};
      if (res.exceptionDetails) {
        done(new Error(`CDP script error: ${JSON.stringify(res.exceptionDetails)}`));
        return;
      }
      done(null, res.result?.value);
    });
    ws.addEventListener('error', (ev) => {
      done(new Error(ev?.message || 'CDP WebSocket error'));
    });
    ws.addEventListener('close', () => {
      done(new Error('CDP WebSocket closed before response'));
    });
  });
}

function buildArchiveEvalJs({ conversationId, titlePrefix, dryRun }) {
  return `(() => {
    const convId = ${JSON.stringify(conversationId || '')};
    const titlePrefix = ${JSON.stringify(titlePrefix || '')};
    const dryRun = ${dryRun ? 'true' : 'false'};
    const aria = '归档对话';
    const selector = 'button[aria-label="' + aria + '"]';

    let hit = null;
    if (convId) {
      const attrNodes = Array.from(document.querySelectorAll('[data-conversation-id], [data-id], [href]'));
      hit = attrNodes.find((n) => {
        const vals = [
          n.getAttribute('data-conversation-id') || '',
          n.getAttribute('data-id') || '',
          n.getAttribute('href') || '',
        ];
        return vals.some((v) => v === convId || v.includes(convId));
      }) || null;
      if (!hit) {
        const leaves = Array.from(document.querySelectorAll('*'))
          .filter((n) => n.children.length === 0 && (n.textContent || '').trim().includes(convId));
        if (leaves.length) hit = leaves[0];
      }
    }
    if (!hit && titlePrefix) {
      const leaves = Array.from(document.querySelectorAll('*'))
        .filter((n) => n.children.length === 0 && (n.textContent || '').trim().startsWith(titlePrefix));
      if (leaves.length) hit = leaves[0];
    }
    if (!hit) {
      return { ok: false, archived: false, conversation_id: convId || null, reason: 'row_not_found' };
    }

    let btn = hit.matches && hit.matches(selector) ? hit : hit.querySelector(selector);
    let rowEl = hit;
    let cur = hit;
    for (let i = 0; i < 9 && cur && !btn; i++) {
      cur = cur.parentElement;
      if (!cur || cur.tagName === 'BODY' || cur.tagName === 'HTML') break;
      const found = cur.querySelector(selector);
      if (found) {
        btn = found;
        rowEl = cur;
        break;
      }
    }
    const rowText = (rowEl.innerText || rowEl.textContent || '').trim().slice(0, 120);
    if (!btn) {
      return { ok: false, archived: false, conversation_id: convId || null, reason: 'row_not_found', row_text: rowText };
    }
    if (dryRun) {
      return { ok: true, archived: false, dry_run: true, conversation_id: convId || null, row_text: rowText };
    }
    if (typeof btn.scrollIntoView === 'function') btn.scrollIntoView({ block: 'center' });
    btn.click();
    return { ok: true, archived: true, conversation_id: convId || null, row_text: rowText };
  })()`;
}

export async function archiveConversation({ conversationId = null, port = null, titlePrefix = null, dryRun = false } = {}) {
  if (!conversationId && !titlePrefix) {
    throw Object.assign(new Error('archive 需要 <conversation-id> 或 --title-prefix'), { code: 1 });
  }
  const cdpPort = resolveCdpPort(port);
  let targetList;
  try {
    targetList = await httpGetJson(`http://127.0.0.1:${cdpPort}/json`, 5000);
  } catch (err) {
    throw Object.assign(
      new Error(`CDP 端口 ${cdpPort} 不可用（${err.message}）。目标应用需以 --remote-debugging-port=${cdpPort} 启动。`),
      { code: 1 }
    );
  }

  const pages = (Array.isArray(targetList) ? targetList : [])
    .filter((t) => t && t.type === 'page' && String(t.title || '').includes('Antigravity'));
  const page = pages[0];
  if (!page || !page.webSocketDebuggerUrl) {
    throw Object.assign(
      new Error(`CDP 端口 ${cdpPort} 上未找到标题包含 Antigravity 的 page target`),
      { code: 1 }
    );
  }

  const expr = buildArchiveEvalJs({ conversationId, titlePrefix, dryRun });
  try {
    const result = await cdpEvaluate(page.webSocketDebuggerUrl, expr, 10000);
    if (!result || typeof result !== 'object') {
      return { ok: false, archived: false, conversation_id: conversationId || null, reason: 'unexpected_cdp_result' };
    }
    return result;
  } catch (err) {
    throw Object.assign(
      new Error(`CDP 执行归档失败 (port=${cdpPort}): ${err.message}`),
      { code: 1 }
    );
  }
}
