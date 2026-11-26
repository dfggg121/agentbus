// Antigravity session handoff, modelled on magpie's Claude bridge:
// the token is written to a private file (0600) and read by the adapter,
// never exported into a world-readable environment or a command line.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolveAgentBin } from './agents.js';

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

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function extractPortFromAddress(addr) {
  if (!addr || typeof addr !== 'string') return null;
  try {
    const u = new URL(addr);
    if (u.port) return Number(u.port);
  } catch {}
  const m = /:(\d+)(?:\/|$)/.exec(addr);
  return m ? Number(m[1]) : null;
}

// Run this inside Antigravity's own integrated terminal, where the two
// variables exist. Nothing is printed but the path and the token length.
export function exportAgySession(outPath, opts = {}) {
  const env = opts.env || process.env;
  let address = env.ANTIGRAVITY_LS_ADDRESS;
  let csrf = env.ANTIGRAVITY_CSRF_TOKEN;
  let pid = Number(env.ANTIGRAVITY_PID) || null;
  let version = env.ANTIGRAVITY_VERSION ? String(env.ANTIGRAVITY_VERSION).trim() : null;
  let source = 'env';
  if (!address || !csrf) {
    const found = discoverAgySession(opts);
    if (found) {
      address = found.ls_address;
      csrf = found.csrf_token;
      pid = found.pid ?? pid;
      version = found.version ?? version;
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
    ...(pid ? { pid } : {}),
    ...(version ? { version } : {}),
    exported_at: new Date().toISOString(),
    source,
  };
  fs.writeFileSync(target, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  tighten(target);
  return { path: target, ls_address: address, token_chars: csrf.length, source, ...(pid ? { pid } : {}), note: '重启 Antigravity 后需重新导出' };
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

export function detectAgentApi(home = os.homedir(), opts = {}) {
  return resolveAgentBin('antigravity', { home, ...opts }).bin;
}

function splitEnvPathList(raw, platform = process.platform) {
  if (!raw || !String(raw).trim()) return [];
  const text = String(raw).trim();
  const delim = platform === 'win32'
    ? ';'
    : (text.includes(';') ? ';' : (text.includes(':') && !/^[A-Za-z]:[\\/]/.test(text) ? ':' : path.delimiter));
  return text
    .split(delim)
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1').trim())
    .filter(Boolean);
}

// Antigravity keeps its live coordinates in a daemon hub file. Reading it beats
// asking the user to export env vars by hand, and the file is per-run so a stale
// copy is detected by its pid.
export function resolveDaemonDirs({
  home = null,
  env = process.env,
  platform = process.platform,
  existingOnly = false,
} = {}) {
  const dirs = [];
  for (const d of splitEnvPathList(env?.AGENTBUS_AGY_DAEMON_DIR, platform)) {
    dirs.push(d);
  }
  const resolvedHome = home || (platform === 'win32'
    ? (env?.USERPROFILE || env?.HOME || os.homedir())
    : (env?.HOME || os.homedir()));
  const normalizeDir = (d) => {
    if (platform !== 'win32' && d.startsWith('/')) return path.posix.normalize(d);
    return path.resolve(d);
  };
  const pathJoin = (platform !== 'win32' && String(resolvedHome).startsWith('/')) ? path.posix.join : path.join;

  dirs.push(pathJoin(resolvedHome, '.gemini', 'antigravity', 'daemon'));
  if (platform === 'win32') {
    const appData = env?.APPDATA && String(env.APPDATA).trim()
      ? String(env.APPDATA).trim()
      : pathJoin(resolvedHome, 'AppData', 'Roaming');
    dirs.push(pathJoin(appData, 'Antigravity', 'daemon'));
  } else if (platform === 'darwin') {
    dirs.push(pathJoin(resolvedHome, 'Library', 'Application Support', 'Antigravity', 'daemon'));
  } else {
    dirs.push(pathJoin(resolvedHome, '.config', 'Antigravity', 'daemon'));
  }

  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    const norm = normalizeDir(d);
    const key = platform === 'win32' ? norm.toLowerCase() : norm;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!existingOnly || fs.existsSync(norm)) {
      out.push(norm);
    }
  }
  return out;
}

export function daemonDirs(opts = {}) {
  return resolveDaemonDirs({ ...opts, existingOnly: true });
}

export function discoverAgySession(opts = {}) {
  const pidAliveFn = typeof opts.isPidAlive === 'function' ? opts.isPidAlive : isPidAlive;
  let best = null;
  for (const dir of daemonDirs(opts)) {
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
      const filePid = Number(name.match(/^hub_(\d+)\.json$/)?.[1] || 0);
      const pid = Number(data.pid || filePid || 0) || null;
      const pidAlive = pid ? Boolean(pidAliveFn(pid)) : false;
      if (opts.requireAlivePid && !pidAlive) continue;
      const version = data.version || data.appVersion || data.lsVersion || null;
      const cand = {
        mtime,
        source: full,
        ls_address: `http://127.0.0.1:${data.httpPort}`,
        csrf_token: data.csrfToken,
        pid,
        pid_alive: pidAlive,
        ...(version ? { version: String(version) } : {}),
      };
      if (
        !best ||
        (cand.pid_alive && !best.pid_alive) ||
        (cand.pid_alive === best.pid_alive && cand.mtime > best.mtime)
      ) {
        best = cand;
      }
    }
  }
  return best;
}

export function resolveAgySession({
  busRoot = null,
  sessionFile = null,
  daemonOpts = {},
  isPidAlive: pidAliveOverride = null,
} = {}) {
  const pidAliveFn = typeof pidAliveOverride === 'function' ? pidAliveOverride : isPidAlive;
  const targetFile = sessionFile || defaultAgySessionPath(busRoot);
  const live = discoverAgySession({ ...daemonOpts, isPidAlive: pidAliveFn });
  const liveAlive = Boolean(live && (live.pid_alive || !live.pid));

  let exported = null;
  let readErr = null;
  try {
    exported = readAgySession(targetFile);
  } catch (err) {
    readErr = err;
  }

  if (!exported) {
    if (live) return { ...live, fallback: true, stale_reason: 'missing_exported_session' };
    throw readErr;
  }

  const expPid = Number(exported.pid) || null;
  const expPort = extractPortFromAddress(exported.ls_address);
  const livePort = live ? extractPortFromAddress(live.ls_address) : null;
  const expVer = exported.version ? String(exported.version) : null;
  const liveVer = live?.version ? String(live.version) : null;

  let staleReason = null;
  if (expPid && !pidAliveFn(expPid)) {
    staleReason = 'pid_not_alive';
  } else if (live && liveAlive) {
    if (expVer && liveVer && expVer !== liveVer) {
      staleReason = 'hub_version_mismatch';
    } else if (expPort && livePort && expPort !== livePort) {
      staleReason = 'hub_port_mismatch';
    } else if (expPid && live.pid && expPid !== live.pid) {
      staleReason = 'hub_pid_mismatch';
    }
  }

  if (staleReason) {
    if (live && liveAlive) {
      return {
        ...live,
        fallback: true,
        stale_reason: staleReason,
      };
    }
    if (staleReason === 'pid_not_alive') {
      throw Object.assign(
        new Error(`导出会话对应的 Antigravity 进程已退出 (pid=${expPid})，且未发现活跃 hub_*.json；请重新运行 agentbus agy-session`),
        { code: 1 }
      );
    }
  }

  return { ...exported, fallback: false, stale_reason: null };
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

function cdpSend(wsUrl, method, params = {}, timeoutMs = 8000) {
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
    const timer = setTimeout(() => done(new Error(`CDP ${method} timeout after ${timeoutMs}ms`)), timeoutMs);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data || '')); } catch { return; }
      if (msg.id !== 1) return;
      if (msg.error) done(new Error(`CDP ${method} error: ${JSON.stringify(msg.error)}`));
      else done(null, msg.result || {});
    });
    ws.addEventListener('error', (ev) => done(new Error(ev?.message || 'CDP WebSocket error')));
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

function buildArchiveEvalJs({ conversationId, titlePrefix, titleContains, dryRun }) {
  return `(() => {
    const convId = ${JSON.stringify(conversationId || '')};
    const titlePrefix = ${JSON.stringify(titlePrefix || '')};
    const titleContains = ${JSON.stringify(titleContains || '')};
    const dryRun = ${dryRun ? 'true' : 'false'};
    const selector = 'button[aria-label="归档对话"], button[aria-label="Archive conversation"]';
    const stopSelector = 'button[aria-label="停止执行"], button[aria-label="Stop execution"], button[aria-label="Stop"]';

    // The archive button is not a descendant of the title node: it lives in a
    // sibling action wrapper. Match from the button side instead — each button
    // has a short ancestor whose text is its row title.
    const rowTextOf = (btn) => {
      let p = btn;
      for (let i = 0; i < 8 && p; i++) {
        p = p.parentElement;
        if (!p || p.tagName === 'BODY' || p.tagName === 'HTML') break;
        const t = (p.innerText || p.textContent || '').trim();
        if (t && t.length <= 250) return t;
      }
      return '';
    };
    const matches = (t) => {
      if (!t) return false;
      if (titlePrefix && t.startsWith(titlePrefix)) return true;
      if (titleContains && t.includes(titleContains)) return true;
      if (convId && t.includes(convId)) return true;
      return false;
    };

    let btn = null;
    let rowText = '';
    for (const b of Array.from(document.querySelectorAll(selector))) {
      const t = rowTextOf(b);
      if (matches(t)) { btn = b; rowText = t; break; }
    }

    // In current builds the action button is portalled outside the row, so the
    // ancestor-text lookup above finds only a time label ("2d") or nothing.
    // Associate each button with the sidebar title that shares its vertical center.
    let leavesCache = null;
    const getSidebarLeaves = () => {
      if (leavesCache) return leavesCache;
      leavesCache = Array.from(document.querySelectorAll('*'))
        .filter((n) => n.children.length === 0)
        .map((n) => {
          const r = n.getBoundingClientRect();
          return { text: (n.textContent || '').trim(), y: r.top + r.height / 2, left: r.left, width: r.width, height: r.height };
        })
        .filter((x) => x.text && x.width > 20 && x.height > 0 && x.left < 320);
      return leavesCache;
    };

    if (!btn) {
      const leaves = getSidebarLeaves();
      for (const b of Array.from(document.querySelectorAll(selector))) {
        const br = b.getBoundingClientRect();
        const cy = br.top + br.height / 2;
        const hit = leaves.find((x) => Math.abs(x.y - cy) <= 14 && matches(x.text));
        if (hit) { btn = b; rowText = hit.text; break; }
      }
    }

    const findByConvId = () => {
      if (!convId) return null;
      const attrNodes = Array.from(document.querySelectorAll('[data-conversation-id], [data-id], [href]'));
      return attrNodes.find((n) => {
        const vals = [
          n.getAttribute('data-conversation-id') || '',
          n.getAttribute('data-id') || '',
          n.getAttribute('href') || '',
        ];
        return vals.some((v) => v === convId || v.includes(convId));
      }) || null;
    };

    // Fallback: locate by data attribute / href (/c/<convId>), then map that row to its button.
    let convHit = null;
    if (!btn && convId) {
      convHit = findByConvId();
      if (convHit) {
        const hr = convHit.getBoundingClientRect();
        const cy = hr.top + hr.height / 2;
        let row = convHit;
        for (let i = 0; i < 8 && row; i++) {
          const t = (row.innerText || '').trim();
          if (!rowText && t && t.length <= 250) rowText = t;
          const directBtn = row.querySelector ? row.querySelector(selector) : null;
          if (directBtn && row.tagName !== 'BODY' && row.tagName !== 'HTML') {
            const rr = row.getBoundingClientRect();
            if (rr.height <= 80) { btn = directBtn; break; }
          }
          row = row.parentElement;
        }
        if (!btn) {
          const byY = Array.from(document.querySelectorAll(selector)).find((b) => {
            const br = b.getBoundingClientRect();
            return Math.abs((br.top + br.height / 2) - cy) <= 14;
          });
          if (byY) btn = byY;
        }
      }
    }

    // While a conversation turn is still executing, Antigravity renders a "停止执行"
    // button in place of "归档对话". Distinguish that state from a missing row so
    // the auto-archive poller knows the row is present and waiting for turn completion.
    if (!btn) {
      const stopBtns = Array.from(document.querySelectorAll(stopSelector));
      if (stopBtns.length > 0) {
        let runningText = '';
        for (const sb of stopBtns) {
          const t = rowTextOf(sb);
          if (matches(t)) { runningText = t; break; }
          const sr = sb.getBoundingClientRect();
          const scy = sr.top + sr.height / 2;
          const leafHit = getSidebarLeaves().find((x) => Math.abs(x.y - scy) <= 14 && matches(x.text));
          if (leafHit) { runningText = leafHit.text; break; }
          if (convHit) {
            const hr = convHit.getBoundingClientRect();
            const hcy = hr.top + hr.height / 2;
            if (Math.abs(hcy - scy) <= 14) { runningText = rowText || convId; break; }
          }
        }
        if (runningText) {
          return { ok: false, archived: false, conversation_id: convId || null, reason: 'row_running', row_text: runningText.slice(0, 120) };
        }
      }
      return { ok: false, archived: false, conversation_id: convId || null, reason: 'row_not_found' };
    }
    if (dryRun) {
      return { ok: true, archived: false, dry_run: true, conversation_id: convId || null, row_text: rowText.slice(0, 120) };
    }
    if (typeof btn.scrollIntoView === 'function') btn.scrollIntoView({ block: 'center' });
    btn.click();
    return { ok: true, archived: true, conversation_id: convId || null, row_text: rowText.slice(0, 120) };
  })()`;
}

function buildTitleRectJs({ conversationId, titlePrefix, titleContains }) {
  return `(() => {
    const convId = ${JSON.stringify(conversationId || '')};
    const titlePrefix = ${JSON.stringify(titlePrefix || '')};
    const titleContains = ${JSON.stringify(titleContains || '')};
    const leaves = Array.from(document.querySelectorAll('*')).filter((n) => n.children.length === 0);
    const matches = leaves.filter((n) => {
      const t = (n.textContent || '').trim();
      if (!t) return false;
      if (titlePrefix && t.startsWith(titlePrefix)) return true;
      if (titleContains && t.includes(titleContains)) return true;
      if (convId && t.includes(convId)) return true;
      return false;
    });
    if (!matches.length) return null;
    // Prefer the sidebar copy (left edge); the open conversation header repeats the title.
    const leaf = matches
      .map((n) => ({ n, r: n.getBoundingClientRect() }))
      .sort((a, b) => (a.r.left < 320 ? 0 : 1) - (b.r.left < 320 ? 0 : 1) || a.r.left - b.r.left)[0].n;
    leaf.scrollIntoView({ block: 'center' });
    const r = leaf.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`;
}

export async function archiveConversation({ conversationId = null, port = null, titlePrefix = null, titleContains = null, dryRun = false } = {}) {
  if (!conversationId && !titlePrefix && !titleContains) {
    throw Object.assign(new Error('archive 需要 <conversation-id>、--title-prefix 或 titleContains'), { code: 1 });
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
    .filter((t) => t && t.type === 'page' && String(t.title || '').includes('Antigravity') && t.webSocketDebuggerUrl)
    .sort((a, b) => {
      const aData = String(a.url || '').startsWith('data:') ? 1 : 0;
      const bData = String(b.url || '').startsWith('data:') ? 1 : 0;
      return aData - bData;
    });
  if (!pages.length) {
    throw Object.assign(
      new Error(`CDP 端口 ${cdpPort} 上未找到标题包含 Antigravity 的 page target`),
      { code: 1 }
    );
  }

  const expr = buildArchiveEvalJs({ conversationId, titlePrefix, titleContains, dryRun });
  let runningResult = null;
  let lastResult = null;
  let lastError = null;

  for (const page of pages) {
    try {
      let result = await cdpEvaluate(page.webSocketDebuggerUrl, expr, 10000);
      // The active row hides its action buttons until hovered. Move a real mouse
      // over the title, then re-run the matcher so that row can still be archived.
      // Skip hovering when reason === 'row_running' because the row is visible and
      // waiting for the turn to finish before the archive button is rendered.
      if (result?.reason === 'row_not_found') {
        const rect = await cdpEvaluate(page.webSocketDebuggerUrl, buildTitleRectJs({ conversationId, titlePrefix, titleContains }), 5000).catch(() => null);
        if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y)) {
          await cdpSend(page.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y }, 5000).catch(() => {});
          await sleep(450);
          result = await cdpEvaluate(page.webSocketDebuggerUrl, expr, 10000);
        }
      }
      if (!result || typeof result !== 'object') {
        lastResult = { ok: false, archived: false, conversation_id: conversationId || null, reason: 'unexpected_cdp_result' };
        continue;
      }
      if (result.ok) {
        return result;
      }
      if (result.reason === 'row_running' && !runningResult) {
        runningResult = result;
      }
      lastResult = result;
    } catch (err) {
      lastError = err;
    }
  }

  if (runningResult) return runningResult;
  if (lastResult) return lastResult;
  throw Object.assign(
    new Error(`CDP 执行归档失败 (port=${cdpPort}): ${lastError?.message || 'unknown error'}`),
    { code: 1 }
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseIntOpt(optVal, envVal, fallback, { min = 0 } = {}) {
  const raw = optVal !== undefined && optVal !== null ? optVal : envVal;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= min) return Math.floor(n);
  }
  return fallback;
}

// Archive every sidebar row matching the finished task (by taskId in title and/or
// snapshotted conversationId). Polls with a bounded retry budget until the row
// appears and finishes its turn ("停止执行" -> "归档对话"), or times out cleanly.
export async function archiveTaskConversations({
  taskId,
  conversationId = null,
  port = null,
  dryRun = false,
  maxRows = 12,
  lagMs,
  retryIntervalMs,
  maxWaitMs,
  maxAttempts,
  cdpMaxAttempts,
} = {}) {
  if (!taskId) {
    throw Object.assign(new Error('archiveTaskConversations 需要 taskId'), { code: 1 });
  }
  const effLagMs = parseIntOpt(lagMs, process.env.AGENTBUS_ARCHIVE_LAG_MS, 2500, { min: 0 });
  const effRetryMs = parseIntOpt(retryIntervalMs, process.env.AGENTBUS_ARCHIVE_RETRY_MS, 2000, { min: 20 });
  const effMaxWaitMs = parseIntOpt(maxWaitMs, process.env.AGENTBUS_ARCHIVE_TIMEOUT_MS, 45000, { min: 50 });
  const effMaxAttempts = parseIntOpt(maxAttempts, process.env.AGENTBUS_ARCHIVE_MAX_ATTEMPTS, 15, { min: 1 });
  const effCdpMaxAttempts = parseIntOpt(cdpMaxAttempts, process.env.AGENTBUS_ARCHIVE_CDP_RETRIES, 2, { min: 1 });

  const startedAt = Date.now();
  let archived = 0;
  let probeAttempts = 0;
  let cdpErrors = 0;
  let lastMissReason = null;
  const attemptLog = [];
  const archivedRows = [];

  if (effLagMs > 0) {
    await sleep(effLagMs);
  }

  while (archived < maxRows) {
    probeAttempts += 1;
    let res;
    try {
      res = await archiveConversation({
        titleContains: taskId,
        conversationId: conversationId || null,
        port,
        dryRun,
      });
    } catch (err) {
      cdpErrors += 1;
      const errMsg = String(err?.message || err);
      attemptLog.push({ attempt: probeAttempts, ok: false, error: errMsg });
      const elapsed = Date.now() - startedAt;
      if (cdpErrors >= effCdpMaxAttempts || probeAttempts >= effMaxAttempts || elapsed >= effMaxWaitMs) {
        return {
          ok: archived > 0,
          archived_count: archived,
          attempts: probeAttempts,
          max_attempts: effMaxAttempts,
          timed_out: false,
          elapsed_ms: elapsed,
          reason: archived > 0 ? null : 'cdp_unavailable',
          error: errMsg,
          attempt_log: attemptLog,
          archived_rows: archivedRows,
        };
      }
      await sleep(Math.min(effRetryMs, 1000));
      continue;
    }

    cdpErrors = 0;
    attemptLog.push({ attempt: probeAttempts, ...res });

    if (res?.ok && res.archived) {
      archived += 1;
      if (res.row_text) archivedRows.push(res.row_text);
      await sleep(350);
      continue;
    }

    if (res?.ok && dryRun) {
      return {
        ok: true,
        archived_count: 0,
        dry_run: true,
        attempts: probeAttempts,
        max_attempts: effMaxAttempts,
        timed_out: false,
        elapsed_ms: Date.now() - startedAt,
        reason: null,
        row_text: res.row_text || null,
        attempt_log: attemptLog,
        archived_rows: archivedRows,
      };
    }

    if (res?.reason === 'row_not_found' && archived > 0) {
      break;
    }

    if (res?.reason === 'row_not_found' || res?.reason === 'row_running') {
      lastMissReason = res.reason;
      const elapsed = Date.now() - startedAt;
      if (probeAttempts >= effMaxAttempts || elapsed >= effMaxWaitMs) {
        const timeoutReason = lastMissReason === 'row_running'
          ? 'row_running_timeout'
          : 'row_not_found_timeout';
        return {
          ok: archived > 0,
          archived_count: archived,
          attempts: probeAttempts,
          max_attempts: effMaxAttempts,
          timed_out: archived === 0,
          elapsed_ms: elapsed,
          reason: archived > 0 ? null : timeoutReason,
          last_reason: lastMissReason,
          attempt_log: attemptLog,
          archived_rows: archivedRows,
        };
      }
      const remaining = effMaxWaitMs - elapsed;
      await sleep(Math.min(effRetryMs, Math.max(20, remaining)));
      continue;
    }

    return {
      ok: archived > 0,
      archived_count: archived,
      attempts: probeAttempts,
      max_attempts: effMaxAttempts,
      timed_out: false,
      elapsed_ms: Date.now() - startedAt,
      reason: archived > 0 ? null : (res?.reason || 'archive_failed'),
      attempt_log: attemptLog,
      archived_rows: archivedRows,
    };
  }

  return {
    ok: archived > 0,
    archived_count: archived,
    attempts: probeAttempts,
    max_attempts: effMaxAttempts,
    timed_out: false,
    elapsed_ms: Date.now() - startedAt,
    reason: archived > 0 ? null : 'row_not_found_timeout',
    attempt_log: attemptLog,
    archived_rows: archivedRows,
  };
}
