// agentbus: Artifact registration, SHA-256 hashing, and strict path/root security validation
// NEVER stores file contents in SQLite and NEVER copies registered files into data dir.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withImmediateTx, appendEvent } from './db.js';

const IS_WIN = process.platform === 'win32';

const MIME_BY_EXT = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.bin': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

export function sha256File(filePath) {
  const h = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function normalizeForCompare(p) {
  const resolved = path.resolve(p);
  return IS_WIN ? resolved.toLowerCase() : resolved;
}

/**
 * Parse and strictly validate a file path or file:// URI against security redlines (§8):
 * 1. Only file:// or absolute local paths allowed (rejects http(s), UNC \\server\share, relative paths).
 * 2. Resolves symlinks/junctions with fs.realpathSync.
 * 3. Must reside inside config.allowedRoots (case-insensitive on Windows).
 * 4. Must be an existing regular file within maxRefBytes.
 */
export function resolveAndValidatePath(input, config, { checkSize = true } = {}) {
  if (typeof input !== 'string' || !input.trim()) {
    throw Object.assign(new Error('路径不能为空'), { code: 1 });
  }
  const raw = input.trim();

  // Reject http(s) or other non-file URI schemes
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    if (!/^file:\/\//i.test(raw)) {
      throw Object.assign(new Error(`仅允许 file:// 或本地绝对路径，拒绝协议: ${raw.split('://')[0]}`), { code: 1 });
    }
  }

  // Reject UNC network paths (\\server\share or //server/share)
  if (/^(\\\\|\/\/)/.test(raw) || /^file:\/\/[^/]/i.test(raw)) {
    throw Object.assign(new Error('安全拒绝：禁止 UNC 网络共享路径'), { code: 1 });
  }

  let fsPath;
  if (/^file:\/\//i.test(raw)) {
    try {
      fsPath = fileURLToPath(raw);
    } catch {
      throw Object.assign(new Error(`非法 file:// URI: ${raw}`), { code: 1 });
    }
  } else {
    // Reject relative paths explicitly (§8.1)
    if (!path.isAbsolute(raw)) {
      throw Object.assign(new Error(`安全拒绝：仅接受绝对路径或 file:// URI，拒绝相对路径`), { code: 1 });
    }
    fsPath = raw;
  }

  // Double-check resolved path is not UNC
  if (/^(\\\\|\/\/)/.test(fsPath)) {
    throw Object.assign(new Error('安全拒绝：禁止 UNC 网络共享路径'), { code: 1 });
  }

  if (!fs.existsSync(fsPath)) {
    throw Object.assign(new Error(`文件不存在: ${path.basename(fsPath)}`), { code: 1 });
  }

  // Resolve realpath to defeat symlinks / Windows junctions pointing outside allowed_roots (§8.2 & §8.3)
  let realTarget;
  try {
    realTarget = fs.realpathSync(fsPath);
  } catch {
    throw Object.assign(new Error(`无法解析真实路径: ${path.basename(fsPath)}`), { code: 1 });
  }

  const realTargetNorm = normalizeForCompare(realTarget);
  let insideRoot = false;
  for (const root of config.allowedRoots || []) {
    let realRoot;
    try {
      realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
    } catch {
      realRoot = path.resolve(root);
    }
    const rootNorm = normalizeForCompare(realRoot);
    const rootPrefix = rootNorm.endsWith(path.sep) ? rootNorm : rootNorm + path.sep;
    if (realTargetNorm === rootNorm || realTargetNorm.startsWith(rootPrefix)) {
      insideRoot = true;
      break;
    }
  }

  if (!insideRoot) {
    throw Object.assign(new Error(`安全拒绝：路径位于 allowed_roots 之外 (${path.basename(realTarget)})`), { code: 1 });
  }

  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) {
    throw Object.assign(new Error(`不是普通文件: ${path.basename(realTarget)}`), { code: 1 });
  }

  if (checkSize && stat.size > config.maxRefBytes) {
    throw Object.assign(
      new Error(`文件 ${path.basename(realTarget)} (${stat.size} B) 超过单文件上限 ${config.maxRefBytes} B`),
      { code: 1 }
    );
  }

  return {
    fsPath: realTarget,
    uri: pathToFileURL(realTarget).href,
    stat,
  };
}

/**
 * Register a local file into `artifacts` table (pointer + sha256 only, zero file copy).
 */
export function registerArtifact(bus, { filePath, name = null, by = 'unknown' }) {
  const { fsPath, uri, stat } = resolveAndValidatePath(filePath, bus.config, { checkSize: true });
  const sha = sha256File(fsPath);
  const displayName = name || path.basename(fsPath);
  const mime = guessMime(fsPath);
  const now = new Date().toISOString();
  const mtime = stat.mtime.toISOString();

  return withImmediateTx(bus.db, () => {
    const existing = bus.db.prepare('SELECT * FROM artifacts WHERE sha256 = ?').get(sha);
    if (existing) {
      appendEvent(bus.db, null, 'register', { sha256: sha, uri: existing.uri, by, reused: true });
      return {
        schema: 'agentbus/artifact@1',
        sha256: existing.sha256,
        bytes: existing.bytes,
        uri: existing.uri,
        name: existing.name,
        mime: existing.mime,
        registered_by: existing.registered_by,
        registered_at: existing.registered_at,
        mtime: existing.mtime,
        reused: true,
      };
    }

    bus.db.prepare(
      `INSERT INTO artifacts (sha256, bytes, uri, name, mime, registered_by, registered_at, mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sha, stat.size, uri, displayName, mime, by || 'unknown', now, mtime);

    appendEvent(bus.db, null, 'register', { sha256: sha, uri, bytes: stat.size, by, reused: false });

    return {
      schema: 'agentbus/artifact@1',
      sha256: sha,
      bytes: stat.size,
      uri,
      name: displayName,
      mime,
      registered_by: by || 'unknown',
      registered_at: now,
      mtime,
      reused: false,
    };
  });
}

export function getArtifact(bus, sha256) {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) return null;
  return bus.db.prepare('SELECT * FROM artifacts WHERE sha256 = ?').get(sha256.toLowerCase()) || null;
}

/**
 * Verify a single reference pointer (realpath inside allowed_roots + exists + sha256 match).
 */
export function verifyRefIntegrity(ref, config) {
  let fsPath;
  try {
    const validated = resolveAndValidatePath(ref.uri, config, { checkSize: false });
    fsPath = validated.fsPath;
  } catch (err) {
    return {
      name: ref.name,
      sha256: ref.sha256,
      ok: false,
      reason: /不存在/.test(err.message) ? 'missing' : err.message,
    };
  }
  const actual = sha256File(fsPath);
  const ok = actual === ref.sha256;
  return {
    name: ref.name,
    sha256: ref.sha256,
    actual_sha256: ok ? undefined : actual.slice(0, 12),
    ok,
    reason: ok ? 'ok' : 'drift:hash_mismatch',
  };
}
