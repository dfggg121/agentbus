// Controlled local workspace folder browser & low-token project file scanner.
// Strictly enforces allowed_roots + realpathSync boundaries (no .., no symlink escape, no arbitrary drive scan).
// Zero third-party dependencies.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.cache',
  'dist',
  'build',
  'coverage',
  '.idea',
  '.vscode',
]);

const TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.json', '.md', '.txt', '.html', '.htm', '.css', '.scss',
  '.py', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp',
  '.yml', '.yaml', '.toml', '.ini', '.sh', '.bat', '.ps1', '.sql', '.xml', '.svg',
]);

const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_FILES = 200;
const MAX_MANIFEST_ITEMS = 80;
const MAX_HASH_BYTES = 512 * 1024;
const MAX_SUMMARY_BYTES = 64 * 1024;

function makeHttpError(status, code, message) {
  return Object.assign(new Error(message), { status, errorCode: code });
}

function samePath(a, b) {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function isSubPath(rootReal, targetReal) {
  if (samePath(rootReal, targetReal)) return true;
  const rel = path.relative(rootReal, targetReal);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function resolveAllowedRoots({ config, pkgRoot }) {
  const raw = [
    pkgRoot,
    ...(Array.isArray(config?.allowedRoots) ? config.allowedRoots : []),
    config?.rootDir,
  ].filter(Boolean);

  const out = [];
  const seen = new Set();
  for (const item of raw) {
    try {
      const abs = path.resolve(String(item));
      if (!fs.existsSync(abs)) continue;
      const st = fs.statSync(abs);
      if (!st.isDirectory()) continue;
      const real = fs.realpathSync(abs);
      const key = process.platform === 'win32' ? real.toLowerCase() : real;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(real);
    } catch {}
  }
  return out;
}

export function validateWorkspaceDir(rawDir, { config, pkgRoot }) {
  if (typeof rawDir !== 'string' || !rawDir.trim()) {
    throw makeHttpError(400, 'invalid_workspace_dir', '请选择或填写项目文件夹路径');
  }
  const trimmed = rawDir.trim();
  if (trimmed.length > 500 || /[\r\n\0]/.test(trimmed)) {
    throw makeHttpError(400, 'invalid_workspace_dir', '文件夹路径格式非法');
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    throw makeHttpError(400, 'invalid_workspace_dir', '不支持 URI 格式，请提供本机文件夹路径');
  }
  // Reject explicit .. traversal segments regardless of OS separator
  const segs = trimmed.replace(/\\/g, '/').split('/');
  if (segs.some((s) => s === '..')) {
    throw makeHttpError(400, 'path_traversal_denied', `禁止在文件夹路径中使用越级段 (..): ${trimmed}`);
  }
  // Reject bare drive roots like C:\ or / to avoid arbitrary drive scanning
  const normRaw = trimmed.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\/?$/.test(normRaw) || normRaw === '/') {
    throw makeHttpError(403, 'drive_root_denied', `禁止扫描整盘根目录: ${trimmed}`);
  }

  const allowedRoots = resolveAllowedRoots({ config, pkgRoot });
  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(pkgRoot || process.cwd(), trimmed);

  if (!fs.existsSync(candidate)) {
    throw makeHttpError(404, 'workspace_not_found', `目录不存在: ${candidate}`);
  }

  let lstat;
  let realPath;
  try {
    lstat = fs.lstatSync(candidate);
    realPath = fs.realpathSync(candidate);
  } catch (err) {
    throw makeHttpError(400, 'workspace_unreadable', `无法访问目录: ${err.message}`);
  }

  let st;
  try {
    st = fs.statSync(realPath);
  } catch (err) {
    throw makeHttpError(400, 'workspace_unreadable', `无法读取目录状态: ${err.message}`);
  }
  if (!st.isDirectory()) {
    throw makeHttpError(400, 'workspace_not_directory', `目标路径不是文件夹: ${candidate}`);
  }

  const matchedRoot = allowedRoots.find((rootReal) => isSubPath(rootReal, realPath));
  if (!matchedRoot) {
    const code = lstat.isSymbolicLink() ? 'symlink_escape' : 'path_outside_allowed_roots';
    const msg = lstat.isSymbolicLink()
      ? `符号链接指向允许根目录之外，已拒绝访问: ${candidate}`
      : `目录超出允许根目录范围，已拒绝访问: ${candidate}`;
    throw makeHttpError(403, code, msg);
  }

  // Also reject if candidate sits outside allowed roots even before symlink or vice versa
  const lexicalCandidate = path.resolve(candidate);
  const lexicalOk = allowedRoots.some((rootReal) => isSubPath(rootReal, lexicalCandidate));
  if (!lexicalOk && lstat.isSymbolicLink()) {
    throw makeHttpError(403, 'symlink_escape', `符号链接越界，已拒绝访问: ${candidate}`);
  }

  return {
    realPath,
    matchedRoot,
    allowedRoots,
  };
}

function hasProjectMarkers(dirPath) {
  const markers = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'README.md', 'src'];
  return markers.some((m) => {
    try { return fs.existsSync(path.join(dirPath, m)); } catch { return false; }
  });
}

export function browseWorkspaceDir({ rawDir = '', config, pkgRoot }) {
  const allowedRoots = resolveAllowedRoots({ config, pkgRoot });
  const defaultDir = allowedRoots[0] || path.resolve(pkgRoot || process.cwd());

  let currentDir = defaultDir;
  let matchedRoot = allowedRoots[0] || defaultDir;
  if (rawDir && String(rawDir).trim()) {
    const validated = validateWorkspaceDir(String(rawDir), { config, pkgRoot });
    currentDir = validated.realPath;
    matchedRoot = validated.matchedRoot;
  }

  const subdirs = [];
  let fileCountTop = 0;
  try {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const ent of entries) {
      if (IGNORED_DIRS.has(ent.name)) continue;
      const full = path.join(currentDir, ent.name);
      let real;
      let st;
      try {
        real = fs.realpathSync(full);
        st = fs.statSync(real);
      } catch {
        continue;
      }
      if (!allowedRoots.some((r) => isSubPath(r, real))) continue;
      if (st.isDirectory()) {
        subdirs.push({
          name: ent.name,
          path: real,
          is_project: hasProjectMarkers(real),
        });
      } else if (st.isFile()) {
        fileCountTop += 1;
      }
    }
  } catch (err) {
    throw makeHttpError(400, 'workspace_unreadable', `读取目录列表失败: ${err.message}`);
  }

  subdirs.sort((a, b) => {
    if (a.is_project !== b.is_project) return a.is_project ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parentCandidate = path.dirname(currentDir);
  const canGoUp = !samePath(parentCandidate, currentDir) &&
    allowedRoots.some((r) => isSubPath(r, parentCandidate));

  return {
    ok: true,
    current_dir: currentDir,
    current_name: path.basename(currentDir) || currentDir,
    parent_dir: canGoUp ? parentCandidate : null,
    matched_root: matchedRoot,
    is_project: hasProjectMarkers(currentDir),
    top_file_count: fileCountTop,
    allowed_roots: allowedRoots.map((r) => ({
      path: r,
      name: path.basename(r) || r,
      is_current: samePath(r, currentDir),
    })),
    subdirs: subdirs.slice(0, 120),
  };
}

function readShortFileSummary(filePath, bytes) {
  const ext = path.extname(filePath).toLowerCase();
  if (!TEXT_EXTS.has(ext) || bytes > MAX_SUMMARY_BYTES) return '';
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(bytes, 1024));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const snippet = buf.subarray(0, n).toString('utf8');
    if (snippet.includes('\0')) return '';
    const lines = snippet.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line === '{' || line === '[' || line.startsWith('#!') || line.startsWith('<!doctype') || line.startsWith('<!DOCTYPE')) continue;
      const cleaned = line.replace(/^(\/\/|\/\*|\*|#|<!--)\s*/, '').replace(/\s*(\*\/|-->)$/, '').trim();
      if (cleaned.length >= 4) {
        return cleaned.slice(0, 110);
      }
    }
  } catch {}
  return '';
}

function hashFileShort(filePath, bytes) {
  if (bytes > MAX_HASH_BYTES) return null;
  try {
    const buf = fs.readFileSync(filePath);
    return createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function safePartKey(raw, fallback = 'module') {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/_+$/, '')
    .slice(0, 48);
  return cleaned || fallback;
}

function classifyTopDir(dirName, files) {
  const lower = dirName.toLowerCase();
  if (/^(ui|web|frontend|client|pages|components|public|views|app)$/.test(lower)) {
    return { title: `前端界面 (${dirName})`, category: 'frontend_ui' };
  }
  if (/^(api|server|backend|routes|controllers|services)$/.test(lower)) {
    return { title: `服务与接口 (${dirName})`, category: 'backend_api' };
  }
  if (/^(db|data|storage|models|migrations|store)$/.test(lower)) {
    return { title: `数据与存储 (${dirName})`, category: 'data_storage' };
  }
  if (/^(test|tests|spec|__tests__|e2e)$/.test(lower)) {
    return { title: `测试与验证 (${dirName})`, category: 'testing' };
  }
  if (/^(doc|docs|guides)$/.test(lower)) {
    return { title: `项目文档 (${dirName})`, category: 'docs' };
  }
  if (/^(bin|cli|cmd|scripts)$/.test(lower)) {
    return { title: `命令行与脚本 (${dirName})`, category: 'cli' };
  }
  if (/^(src|lib|pkg|core|internal)$/.test(lower)) {
    return { title: `核心源码 (${dirName})`, category: 'core' };
  }
  const hasUi = files.some((f) => /\.(html|css|tsx|jsx|vue|svelte)$/i.test(f.rel_path));
  return {
    title: `${dirName} 模块`,
    category: hasUi ? 'frontend_ui' : 'general',
  };
}

function buildDetectedParts(realRoot, files, pkgMeta) {
  const detected = [];
  const usedKeys = new Set();
  const allocKey = (raw) => {
    let k = safePartKey(raw, 'part');
    let i = 2;
    while (usedKeys.has(k)) {
      k = `${safePartKey(raw, 'part')}_${i++}`;
    }
    usedKeys.add(k);
    return k;
  };

  // Check if folder has a static src/ui/modules.json or modules.json catalog (like agentbus itself)
  // No — keep scanner generic across any project folder, using actual directories/files on disk!
  const byBucket = new Map();
  const rootFiles = [];

  for (const f of files) {
    const segs = f.rel_path.split('/');
    if (segs.length === 1) {
      rootFiles.push(f);
      continue;
    }
    // Split src/<subdir> into distinct modules if src/ has subdirectories with files
    let bucketKey = segs[0];
    if ((segs[0] === 'src' || segs[0] === 'lib' || segs[0] === 'packages') && segs.length >= 3) {
      bucketKey = `${segs[0]}/${segs[1]}`;
    }
    if (!byBucket.has(bucketKey)) byBucket.set(bucketKey, []);
    byBucket.get(bucketKey).push(f);
  }

  for (const [bucket, bucketFiles] of byBucket.entries()) {
    const leaf = bucket.includes('/') ? bucket.split('/').pop() : bucket;
    const cls = classifyTopDir(leaf, bucketFiles);
    const nonEmptyCount = bucketFiles.filter((f) => f.bytes > 0).length;
    const totalBytes = bucketFiles.reduce((s, f) => s + f.bytes, 0);
    // Honest classification: existing if >=1 non-empty file with real content (>=40 bytes), partial if tiny/stub files only
    const status = (nonEmptyCount > 0 && totalBytes >= 40) ? 'existing' : 'partial';
    const samplePaths = bucketFiles.slice(0, 6).map((f) => f.rel_path);
    const summaries = bucketFiles.map((f) => f.summary).filter(Boolean).slice(0, 2);
    const goal = summaries.length > 0
      ? `基于现有 ${bucket}（${bucketFiles.length} 个文件）继续维护或扩展：${summaries.join('；')}`
      : `围绕现有目录 ${bucket}（${bucketFiles.length} 个文件，${totalBytes} 字节）进行核查与增量开发。`;

    detected.push({
      key: allocKey(bucket.replace(/\//g, '_')),
      title: bucket.includes('/') ? `${cls.title.replace(/\([^)]+\)/, '').trim()} (${bucket})` : cls.title,
      category: cls.category,
      status,
      goal,
      paths: samplePaths,
      existing_paths: samplePaths,
      missing_paths: [],
      file_count: bucketFiles.length,
      total_bytes: totalBytes,
      acceptance: [`核查 ${bucket} 现有实现并保持回归通过`],
      evidence: `扫描到 ${bucketFiles.length} 个现有文件（${totalBytes} 字节）`,
    });
  }

  if (rootFiles.length > 0 && detected.length < 12) {
    const rootBytes = rootFiles.reduce((s, f) => s + f.bytes, 0);
    detected.push({
      key: allocKey('project_config'),
      title: '项目配置与入口',
      category: 'config',
      status: rootBytes >= 20 ? 'existing' : 'partial',
      goal: `维护根目录配置与说明文件（${rootFiles.slice(0, 5).map((f) => f.rel_path).join(', ')}）。`,
      paths: rootFiles.slice(0, 8).map((f) => f.rel_path),
      existing_paths: rootFiles.slice(0, 8).map((f) => f.rel_path),
      missing_paths: [],
      file_count: rootFiles.length,
      total_bytes: rootBytes,
      acceptance: ['配置与入口文件有效且可正常加载'],
      evidence: `根目录存在 ${rootFiles.length} 个文件`,
    });
  }

  // Honestly flag clearly missing standard layers (tests / docs) without fabricating code features
  const hasTests = files.some((f) => /(^|\/)(test|tests|spec|__tests__)\/|(\.test\.|\.spec\.)/i.test(f.rel_path));
  if (!hasTests) {
    detected.push({
      key: allocKey('missing_tests'),
      title: '自动化测试（待补充）',
      category: 'testing',
      status: 'missing',
      goal: '当前项目未检测到测试目录或测试文件，建议补充核心功能的自动化验证用例。',
      paths: ['test'],
      existing_paths: [],
      missing_paths: ['test'],
      file_count: 0,
      total_bytes: 0,
      acceptance: ['新增自动化测试且全部通过'],
      evidence: '目录扫描未发现 test/ 或 *.test.* 文件',
    });
  }

  const hasReadmeOrDocs = files.some((f) => /^readme(\.[a-z-]+)?\.md$/i.test(f.rel_path) || /^docs\//i.test(f.rel_path));
  if (!hasReadmeOrDocs) {
    detected.push({
      key: allocKey('missing_docs'),
      title: '使用说明文档（待补充）',
      category: 'docs',
      status: 'missing',
      goal: '当前项目未检测到 README 或 docs 目录，建议补充启动方式与结构说明。',
      paths: ['README.md'],
      existing_paths: [],
      missing_paths: ['README.md'],
      file_count: 0,
      total_bytes: 0,
      acceptance: ['README.md 包含启动与验证步骤'],
      evidence: '目录扫描未发现 README.md 或 docs/',
    });
  }

  // If package.json declares a "main" or "bin" file that does not exist on disk -> mark partial/missing honestly
  if (pkgMeta && typeof pkgMeta.main === 'string' && pkgMeta.main.trim()) {
    const mainRel = pkgMeta.main.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!mainRel.startsWith('..') && !path.isAbsolute(mainRel)) {
      const fullMain = path.resolve(realRoot, mainRel);
      if (!fs.existsSync(fullMain)) {
        detected.push({
          key: allocKey('missing_entry'),
          title: '缺失主入口文件',
          category: 'core',
          status: 'missing',
          goal: `package.json 声明了入口 ${mainRel}，但磁盘上尚未存在该文件，需实现或修正配置。`,
          paths: [mainRel],
          existing_paths: [],
          missing_paths: [mainRel],
          file_count: 0,
          total_bytes: 0,
          acceptance: [`入口文件 ${mainRel} 存在且可加载`],
          evidence: `package.json main="${mainRel}" 对应文件不存在`,
        });
      }
    }
  }

  return detected.slice(0, 20);
}

export function scanWorkspaceDirectory(rawDir, { config, pkgRoot }) {
  const { realPath, matchedRoot } = validateWorkspaceDir(rawDir, { config, pkgRoot });

  const files = [];
  let truncated = false;
  let totalBytes = 0;

  function walk(dir, depth) {
    if (depth > MAX_SCAN_DEPTH || files.length >= MAX_SCAN_FILES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (files.length >= MAX_SCAN_FILES) {
        truncated = true;
        return;
      }
      if (IGNORED_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith('.') && ent.name !== '.env.example' && ent.name !== '.gitignore') continue;

      const full = path.join(dir, ent.name);
      let real;
      let st;
      try {
        real = fs.realpathSync(full);
        st = fs.statSync(real);
      } catch {
        continue;
      }
      // Strictly keep within realPath (blocks symlinks escaping the selected folder!)
      if (!isSubPath(realPath, real)) continue;

      if (st.isDirectory()) {
        walk(real, depth + 1);
      } else if (st.isFile()) {
        const rel = path.relative(realPath, real).replace(/\\/g, '/');
        totalBytes += st.size;
        files.push({
          rel_path: rel,
          bytes: st.size,
          ext: path.extname(ent.name).toLowerCase(),
          sha256_short: hashFileShort(real, st.size),
          summary: readShortFileSummary(real, st.size),
        });
      }
    }
  }

  walk(realPath, 0);

  let pkgMeta = null;
  const pkgJsonPath = path.join(realPath, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        pkgMeta = {
          name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
          description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
          main: typeof parsed.main === 'string' ? parsed.main.trim() : '',
          scripts: parsed.scripts && typeof parsed.scripts === 'object' ? Object.keys(parsed.scripts) : [],
        };
      }
    } catch {}
  }

  const detectedParts = buildDetectedParts(realPath, files, pkgMeta);
  const counts = {
    existing: detectedParts.filter((p) => p.status === 'existing').length,
    partial: detectedParts.filter((p) => p.status === 'partial').length,
    missing: detectedParts.filter((p) => p.status === 'missing').length,
  };

  const manifestItems = files.slice(0, MAX_MANIFEST_ITEMS);
  const manifestDigest = createHash('sha256')
    .update(manifestItems.map((f) => `${f.rel_path}:${f.bytes}:${f.sha256_short || ''}`).join('\n'))
    .digest('hex')
    .slice(0, 16);

  const topMap = new Map();
  for (const f of files) {
    const top = f.rel_path.includes('/') ? `${f.rel_path.split('/')[0]}/` : f.rel_path;
    const prev = topMap.get(top) || { name: top, files: 0, bytes: 0 };
    prev.files += 1;
    prev.bytes += f.bytes;
    topMap.set(top, prev);
  }

  return {
    ok: true,
    workspace_dir: realPath,
    matched_root: matchedRoot,
    name_suggestion: pkgMeta?.name || path.basename(realPath) || 'existing-project',
    description_suggestion: pkgMeta?.description || '',
    file_count: files.length,
    total_bytes: totalBytes,
    truncated,
    manifest_digest: manifestDigest,
    scanned_at: new Date().toISOString(),
    top_entries: Array.from(topMap.values()).slice(0, 20),
    files: manifestItems,
    detected_parts: detectedParts,
    counts,
  };
}

export function inspectPartPathsOnDisk(workspaceDir, relPaths) {
  if (!workspaceDir || !fs.existsSync(workspaceDir)) {
    return {
      status: null,
      existing_paths: [],
      missing_paths: Array.isArray(relPaths) ? [...relPaths] : [],
      file_summaries: [],
    };
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(workspaceDir);
  } catch {
    return { status: null, existing_paths: [], missing_paths: [], file_summaries: [] };
  }

  const existingPaths = [];
  const missingPaths = [];
  const fileSummaries = [];

  for (const rp of Array.isArray(relPaths) ? relPaths : []) {
    if (typeof rp !== 'string' || !rp.trim()) continue;
    const norm = rp.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (norm.split('/').some((s) => s === '..') || path.isAbsolute(norm)) continue;
    const full = path.resolve(realRoot, norm);
    if (!fs.existsSync(full)) {
      missingPaths.push(norm);
      continue;
    }
    let real;
    let st;
    try {
      real = fs.realpathSync(full);
      st = fs.statSync(real);
    } catch {
      missingPaths.push(norm);
      continue;
    }
    if (!isSubPath(realRoot, real)) continue;
    existingPaths.push(norm);
    if (st.isFile()) {
      fileSummaries.push({
        rel_path: norm,
        bytes: st.size,
        sha256_short: hashFileShort(real, st.size),
        summary: readShortFileSummary(real, st.size),
      });
    } else if (st.isDirectory()) {
      try {
        const inner = fs.readdirSync(real).filter((n) => !IGNORED_DIRS.has(n));
        fileSummaries.push({
          rel_path: norm,
          is_dir: true,
          entry_count: inner.length,
          sample: inner.slice(0, 6),
        });
      } catch {}
    }
  }

  let status = null;
  if (existingPaths.length > 0 && missingPaths.length === 0) status = 'existing';
  else if (existingPaths.length > 0 && missingPaths.length > 0) status = 'partial';
  else if (missingPaths.length > 0) status = 'missing';

  return {
    status,
    existing_paths: existingPaths,
    missing_paths: missingPaths,
    file_summaries: fileSummaries,
  };
}
