#!/usr/bin/env node
// agentbus self-acceptance suite: 65 assertions (§7)
// Pure Node built-ins, zero frameworks, zero shell pipes.
// Output: PASS n: <desc> / FAIL n: <desc> :: <actual>, ending with SUMMARY passed=x failed=y

import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARENT_DIR = path.resolve(PKG_ROOT, '..');
const BUS_BIN = path.join(PKG_ROOT, 'bin', 'bus.js');

// Isolated test workspace (self-contained: fixtures are generated, nothing outside the package is read)
const RUN_BASE = path.join(PKG_ROOT, 'var', '_accept_tmp');
const FIXTURES = path.join(RUN_BASE, 'fixtures');
const DEMO_REFS = FIXTURES;
const SPEC_MD = path.join(DEMO_REFS, 'SPEC.md');
const TELEMETRY_CSV = path.join(DEMO_REFS, 'telemetry.csv');
const POLICY_BIN = path.join(DEMO_REFS, 'policy.bin');
const OUT_DIR = path.join(RUN_BASE, 'out');

// Legacy compatibility fixtures are optional; CI sets AGENTBUS_COMPAT_DIR when available.
const LEGACY_DIR = process.env.AGENTBUS_COMPAT_DIR || null;
const LEGACY_OK_JSON = LEGACY_DIR ? path.join(LEGACY_DIR, 'tmwszbfbh8d2f.json') : null;
const LEGACY_DRIFT_JSON = LEGACY_DIR ? path.join(LEGACY_DIR, 'tmwszsmxhaa5b.json') : null;

const ROOT_MAIN = path.join(RUN_BASE, 'bus_main');
const WORK_DIR = path.join(RUN_BASE, 'work_allowed');
const OUTSIDE_DIR = path.join(RUN_BASE, 'outside_forbidden');
const ROOT_PERF = path.join(RUN_BASE, 'bus_perf');
const ROOT_COMPAT = path.join(RUN_BASE, 'bus_compat');

fs.rmSync(RUN_BASE, { recursive: true, force: true });
for (const d of [FIXTURES, OUT_DIR, ROOT_MAIN, WORK_DIR, OUTSIDE_DIR, ROOT_PERF, ROOT_COMPAT]) {
  fs.mkdirSync(d, { recursive: true });
}

// Generated fixtures (4MB binary proves the zero-copy pointer path)
{
  const rows = [
    ['pump-a', 12.5], ['pump-b', 8.25], ['fan-1', 30.75], ['fan-2', 4.5], ['comp-1', 61.2],
    ['comp-2', 19.4], ['valve-a', 2.1], ['valve-b', 3.35], ['heater-1', 88.9], ['heater-2', 47.6],
    ['chiller-1', 55.05], ['chiller-2', 21.8], ['conveyor-1', 17.45], ['conveyor-2', 9.9], ['press-1', 73.3],
    ['press-2', 34.15], ['mixer-1', 25.6], ['mixer-2', 13.0], ['dryer-1', 66.4], ['dryer-2', 29.95],
  ];
  const lines = ['# device energy log (kWh); lines starting with # are comments'];
  for (const [d, k] of rows) lines.push(`${d},${k}`);
  fs.writeFileSync(TELEMETRY_CSV, lines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(SPEC_MD, [
    '# requirement: build an energy summary report',
    '',
    'input: `telemetry.csv` (columns device,kwh; skip lines starting with #)',
    'output: `report.json` with fields count, total_kwh, top_device, policy_sha256',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(POLICY_BIN, randomBytes(4 * 1024 * 1024));
}

// Fake agent used by the thread-affinity cases: claims/completes quickly and
// prints a session id, so dispatch can record and then resume it.
const FAKE_AGENT = path.join(RUN_BASE, 'fake_agent.mjs');
fs.writeFileSync(FAKE_AGENT, [
  "import { execFileSync } from 'node:child_process';",
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "const prompt = process.argv[2] || '';",
  "const id = (prompt.match(/id=([A-Za-z0-9_-]+)/) || [])[1];",
  "const by = process.env.AGENTBUS_FAKE_BY || 'fake';",
  "const env = { ...process.env, AGENTBUS_ALLOWED_ROOTS: process.env.AGENTBUS_FAKE_ALLOWED };",
  "const run = (a) => execFileSync(process.execPath, [process.env.AGENTBUS_FAKE_BIN, ...a, '--root', process.env.AGENTBUS_FAKE_ROOT], { env, encoding: 'utf8' });",
  "const claim = JSON.parse(run(['claim', id, '--by', by]));",
  "const out = path.join(process.env.AGENTBUS_FAKE_WORK, 'fake_' + id + '.json');",
  "fs.writeFileSync(out, JSON.stringify({ ok: true, agent: by }), 'utf8');",
  "run(['done', id, '--by', by, '--lease', claim.lease_token, '--result', out]);",
  "console.log(JSON.stringify({ thread_id: process.env.AGENTBUS_FAKE_SESSION || 'fake-session-1' }));",
].join('\n'), 'utf8');

const FAIL_FAST_AGENT = path.join(RUN_BASE, 'fail_fast_agent.mjs');
fs.writeFileSync(FAIL_FAST_AGENT, [
  "console.log(JSON.stringify({ thread_id: process.env.AGENTBUS_FAKE_SESSION || 'bad-503-sess' }));",
  "console.error('503 No capacity available');",
  "process.exit(1);",
].join('\n'), 'utf8');

function fakeAdapterEnv(session = 'fake-session-1', { by = 'fake', adapterKey = 'AGENTBUS_ADAPTER_FAKE', script = FAKE_AGENT, extra = {} } = {}) {
  return {
    [adapterKey]: JSON.stringify({ command: process.execPath, args: [script, '{prompt}'] }),
    AGENTBUS_FAKE_BIN: BUS_BIN,
    AGENTBUS_FAKE_ROOT: ROOT_MAIN,
    AGENTBUS_FAKE_WORK: OUT_DIR,
    AGENTBUS_FAKE_ALLOWED: ALLOWED_MAIN,
    AGENTBUS_FAKE_SESSION: session,
    AGENTBUS_FAKE_BY: by,
    ...extra,
  };
}

const ALLOWED_MAIN = [DEMO_REFS, OUT_DIR, WORK_DIR, ROOT_MAIN].join(path.delimiter);
const ALLOWED_COMPAT = [
  DEMO_REFS, OUT_DIR, ROOT_COMPAT,
  ...(LEGACY_DIR ? [path.resolve(LEGACY_DIR, '..')] : []),
].join(path.delimiter);

let passed = 0;
let failed = 0;
let skipped = 0;

function assertCase(num, desc, ok, actual = '') {
  if (ok) {
    passed++;
    console.log(`PASS ${num}: ${desc}`);
  } else {
    failed++;
    console.log(`FAIL ${num}: ${desc} :: ${actual}`);
  }
}

function runCli(args, { root = ROOT_MAIN, allowed = ALLOWED_MAIN, envExtra = {} } = {}) {
  const res = spawnSync(process.execPath, [BUS_BIN, ...args, '--root', root], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTBUS_ALLOWED_ROOTS: allowed,
      ...envExtra,
    },
  });
  let json = null;
  if (res.stdout && res.stdout.trim()) {
    try { json = JSON.parse(res.stdout); } catch {}
  }
  return {
    rc: res.status ?? -1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    json,
  };
}

function dirSizeBytes(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) total += dirSizeBytes(p);
    else if (ent.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runMcpSession(root, allowed, requests, envExtra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUS_BIN, 'mcp', '--root', root], {
      cwd: PKG_ROOT,
      env: { ...process.env, AGENTBUS_ALLOWED_ROOTS: allowed, ...envExtra },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let outBuf = '';
    let errBuf = '';
    const responses = [];
    const expectedIds = new Set(requests.filter((r) => r.id !== undefined).map((r) => r.id));

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`MCP timeout; got ${responses.length}/${expectedIds.size}; stderr=${errBuf}`));
    }, 10000);

    child.stderr.on('data', (d) => { errBuf += d.toString('utf8'); });
    child.stdout.on('data', (d) => {
      outBuf += d.toString('utf8');
      let idx;
      while ((idx = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, idx).trim();
        outBuf = outBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          responses.push(obj);
          if (responses.length >= expectedIds.size) {
            clearTimeout(timer);
            child.stdin.end();
          }
        } catch (e) {
          clearTimeout(timer);
          child.kill();
          reject(new Error(`Non-JSON line on MCP stdout: ${line}`));
          return;
        }
      }
    });

    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ responses, stderr: errBuf });
    });

    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + '\n');
    }
  });
}

async function main() {
  try {
    // 1. All .js/.mjs pass `node --check` via spawnSync (no shell pipes)
    const jsFiles = [
      path.join(PKG_ROOT, 'bin', 'bus.js'),
      path.join(PKG_ROOT, 'src', 'db.js'),
      path.join(PKG_ROOT, 'src', 'store.js'),
      path.join(PKG_ROOT, 'src', 'tasks.js'),
      path.join(PKG_ROOT, 'src', 'mcp.js'),
      path.join(PKG_ROOT, 'src', 'setup.js'),
      path.join(PKG_ROOT, 'src', 'threads.js'),
      path.join(PKG_ROOT, 'src', 'context.js'),
      path.join(PKG_ROOT, 'src', 'agy.js'),
      path.join(PKG_ROOT, 'src', 'agents.js'),
      path.join(PKG_ROOT, 'src', 'dispatch.js'),
      path.join(PKG_ROOT, 'src', 'ui', 'server.js'),
      path.join(PKG_ROOT, 'test', 'accept.mjs'),
    ];
    const syntaxFailures = [];
    for (const f of jsFiles) {
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      if (r.status !== 0) syntaxFailures.push(`${path.basename(f)}: ${(r.stderr || '').trim()}`);
    }
    assertCase(1, '所有 .js/.mjs 通过 node --check', syntaxFailures.length === 0, syntaxFailures.join('; '));

    // 2. init creates DB file and PRAGMA journal_mode == wal
    const initRes = runCli(['init']);
    const dbFile = path.join(ROOT_MAIN, 'agentbus.db');
    let jMode = '';
    if (fs.existsSync(dbFile)) {
      const chkDb = new DatabaseSync(dbFile);
      jMode = String(chkDb.prepare('PRAGMA journal_mode').get()?.journal_mode || '').toLowerCase();
      chkDb.close();
    }
    assertCase(2, 'init 后库文件存在，PRAGMA journal_mode 为 wal',
      initRes.rc === 0 && fs.existsSync(dbFile) && jMode === 'wal',
      `rc=${initRes.rc} exists=${fs.existsSync(dbFile)} mode=${jMode}`);

    // 3. put writes 1 artifact row without copying 4MB policy.bin (dir delta < 100KB)
    const sizeBeforePut = dirSizeBytes(ROOT_MAIN);
    const putPolicy = runCli(['put', POLICY_BIN, '--by', 'hermes']);
    const sizeAfterPut = dirSizeBytes(ROOT_MAIN);
    const deltaPut = sizeAfterPut - sizeBeforePut;
    const dbCheck3 = new DatabaseSync(dbFile);
    const artCountAfter1 = Number(dbCheck3.prepare('SELECT COUNT(*) AS c FROM artifacts').get().c);
    dbCheck3.close();
    assertCase(3, 'put 登记 4MB 文件只写 artifacts 一行且不复制文件（增量 < 100KB）',
      putPolicy.rc === 0 && artCountAfter1 === 1 && deltaPut < 100 * 1024,
      `rc=${putPolicy.rc} rows=${artCountAfter1} delta=${deltaPut}`);

    // 4. Duplicate put returns same sha256, unchanged row count, reused:true
    const putPolicy2 = runCli(['put', POLICY_BIN, '--by', 'hermes']);
    const dbCheck4 = new DatabaseSync(dbFile);
    const artCountAfter2 = Number(dbCheck4.prepare('SELECT COUNT(*) AS c FROM artifacts').get().c);
    dbCheck4.close();
    assertCase(4, '同一文件 put 两次返回相同 sha、行数不变、reused:true',
      putPolicy2.rc === 0 &&
      putPolicy2.json?.sha256 === putPolicy.json?.sha256 &&
      artCountAfter2 === 1 &&
      putPolicy2.json?.reused === true,
      `rc=${putPolicy2.rc} rows=${artCountAfter2} reused=${putPolicy2.json?.reused}`);

    // 5. put non-existent path -> exit code 1
    const putMissing = runCli(['put', path.join(WORK_DIR, 'does-not-exist-xyz.txt')]);
    assertCase(5, 'put 不存在的路径退出码 1', putMissing.rc === 1, `rc=${putMissing.rc}`);

    // Register SPEC.md and telemetry.csv for subsequent tests
    const putSpec = runCli(['put', SPEC_MD, '--by', 'hermes']);
    const putCsv = runCli(['put', TELEMETRY_CSV, '--by', 'hermes']);
    const shaSpec = putSpec.json?.sha256;
    const shaCsv = putCsv.json?.sha256;
    const shaPolicy = putPolicy.json?.sha256;

    // 6. new missing --to / --goal -> exit code 1
    const newNoTo = runCli(['new', '--goal', 'only goal']);
    const newNoGoal = runCli(['new', '--to', 'codex']);
    assertCase(6, 'new 缺 --to / --goal 退出码 1',
      newNoTo.rc === 1 && newNoGoal.rc === 1,
      `noTo=${newNoTo.rc} noGoal=${newNoGoal.rc}`);

    // 7. new --ref <unregistered sha> -> exit code 1
    const fakeSha = 'a'.repeat(64);
    const newUnreg = runCli(['new', '--to', 'codex', '--goal', 'bad ref', '--ref', fakeSha]);
    assertCase(7, 'new --ref 未登记 sha 退出码 1', newUnreg.rc === 1, `rc=${newUnreg.rc}`);

    // 8. new same --key twice -> same id and dedup:true
    const newIdem1 = runCli([
      'new', '--to', 'codex', '--from', 'hermes', '--goal', '聚合能耗报告',
      '--ref', shaSpec, '--ref', shaCsv, '--ref', shaPolicy,
      '--accept', 'json=true', '--accept', 'must_contain=policy_sha256', '--accept', 'min_bytes=40',
      '--key', 'idem-energy-001',
    ]);
    const newIdem2 = runCli([
      'new', '--to', 'codex', '--from', 'hermes', '--goal', '聚合能耗报告',
      '--ref', shaSpec, '--ref', shaCsv, '--ref', shaPolicy,
      '--key', 'idem-energy-001',
    ]);
    const mainTaskId = newIdem1.json?.id;
    assertCase(8, 'new 同一 --key 两次返回同一 id 且 dedup:true',
      newIdem1.rc === 0 && newIdem2.rc === 0 &&
      Boolean(mainTaskId) && newIdem2.json?.id === mainTaskId && newIdem2.json?.dedup === true,
      `id1=${mainTaskId} id2=${newIdem2.json?.id} dedup=${newIdem2.json?.dedup}`);

    // 9. Envelope JSON has no file content: no line > 300 chars and no 40-byte substring of referenced files
    const envPath = path.join(ROOT_MAIN, 'tasks', `${mainTaskId}.json`);
    const envRaw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const maxLineLen = envRaw.split(/\r?\n/).reduce((m, l) => Math.max(m, l.length), 0);
    const specText = fs.readFileSync(SPEC_MD, 'utf8');
    const csvText = fs.readFileSync(TELEMETRY_CSV, 'utf8');
    let leakedSubstr = false;
    for (const src of [specText, csvText]) {
      for (let off = 0; off + 40 <= src.length; off += 20) {
        const chunk = src.slice(off, off + 40);
        if (envRaw.includes(chunk)) { leakedSubstr = true; break; }
      }
    }
    assertCase(9, '信封 JSON 不含资料正文（无 >300 字符行且无 40 字节引用子串）',
      fs.existsSync(envPath) && maxLineLen <= 300 && !leakedSubstr,
      `exists=${fs.existsSync(envPath)} maxLine=${maxLineLen} leaked=${leakedSubstr}`);

    // 10. show output has no `content` field; refs contain only name/uri/sha256/bytes
    const showRes = runCli(['show', mainTaskId]);
    const refsClean = Array.isArray(showRes.json?.refs) && showRes.json.refs.length === 3 &&
      showRes.json.refs.every((r) => {
        const ks = Object.keys(r).sort().join(',');
        return ks === 'bytes,name,sha256,uri';
      });
    assertCase(10, 'show 输出无 content 字段且 refs 只有 name/uri/sha256/bytes',
      showRes.rc === 0 && !('content' in (showRes.json || {})) && refsClean,
      `rc=${showRes.rc} keys=${showRes.json?.refs?.[0] ? Object.keys(showRes.json.refs[0]).join(',') : 'none'}`);

    // 11. claim by non-target agent -> exit code 2
    const wrongClaim = runCli(['claim', mainTaskId, '--by', 'other-agent']);
    assertCase(11, 'claim 由非目标 agent 发起退出码 2', wrongClaim.rc === 2, `rc=${wrongClaim.rc}`);

    // 12. claim succeeds -> state=claimed, lease_expires_at > now
    const beforeClaimMs = Date.now();
    const okClaim = runCli(['claim', mainTaskId, '--by', 'codex', '--ttl', '60']);
    const leaseToken = okClaim.json?.lease_token;
    const exp1Ms = Date.parse(okClaim.json?.lease_expires_at || '');
    assertCase(12, 'claim 成功返回 state=claimed 且 lease_expires_at > now',
      okClaim.rc === 0 && okClaim.json?.state === 'claimed' && Boolean(leaseToken) && exp1Ms > beforeClaimMs,
      `rc=${okClaim.rc} state=${okClaim.json?.state} exp=${okClaim.json?.lease_expires_at}`);

    // 13. Duplicate claim -> exit code 2
    const dupClaim = runCli(['claim', mainTaskId, '--by', 'codex']);
    assertCase(13, '重复 claim 退出码 2', dupClaim.rc === 2, `rc=${dupClaim.rc}`);

    // 14. heartbeat extends lease_expires_at
    const hbRes = runCli(['heartbeat', mainTaskId, '--by', 'codex', '--lease', leaseToken, '--ttl', '120']);
    const exp2Ms = Date.parse(hbRes.json?.lease_expires_at || '');
    assertCase(14, 'heartbeat 使 lease_expires_at 变大',
      hbRes.rc === 0 && Number.isFinite(exp2Ms) && exp2Ms > exp1Ms,
      `rc=${hbRes.rc} exp1=${exp1Ms} exp2=${exp2Ms}`);

    // 15. --ttl 1 wait 1.5s then list -> returns to open and attempt 0 -> 1
    const ttlTask = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'ttl-expiry-test']);
    const ttlId = ttlTask.json?.id;
    const ttlClaim = runCli(['claim', ttlId, '--by', 'codex', '--ttl', '1']);
    await sleep(1550);
    const listAfterTtl = runCli(['list', '--limit', '50']);
    const ttlEntry = (listAfterTtl.json || []).find((x) => x.id === ttlId);
    assertCase(15, '--ttl 1 等 1.5 秒后 list：任务回 open 且 attempt 从 0 变 1',
      ttlClaim.rc === 0 && ttlEntry?.state === 'open' && ttlEntry?.attempt === 1,
      `state=${ttlEntry?.state} attempt=${ttlEntry?.attempt}`);

    // 16. ref small file (telemetry.csv 340B) -> type=text with content
    const refSmall = runCli(['ref', mainTaskId, '--name', 'telemetry.csv']);
    assertCase(16, 'ref 小文件（340B）返回 type=text 且含正文',
      refSmall.rc === 0 && refSmall.json?.type === 'text' &&
      typeof refSmall.json?.text === 'string' && refSmall.json.text.includes('heater-1,88.9'),
      `rc=${refSmall.rc} type=${refSmall.json?.type} bytes=${refSmall.json?.bytes}`);

    // 17. ref large file (4MB policy.bin) -> type=resource_link, content[0] has no text, structuredContent.bytes=4194304
    const refLarge = runCli(['ref', mainTaskId, '--name', 'policy.bin']);
    const c0 = refLarge.json?.content?.[0];
    assertCase(17, 'ref 大文件（4MB policy.bin）返回 resource_link、content[0] 无 text、bytes=4194304',
      refLarge.rc === 0 &&
      refLarge.json?.type === 'resource_link' &&
      c0?.type === 'resource_link' &&
      !('text' in (c0 || {})) &&
      refLarge.json?.structuredContent?.bytes === 4194304,
      `rc=${refLarge.rc} type=${refLarge.json?.type} c0keys=${c0 ? Object.keys(c0).join(',') : 'none'} bytes=${refLarge.json?.structuredContent?.bytes}`);

    // 18. ref --name nonexistent -> exit code 1 (and MCP isError checked as well)
    const refMissing = runCli(['ref', mainTaskId, '--name', 'not-a-real-ref.txt']);
    assertCase(18, 'ref --name 不存在返回退出码 1', refMissing.rc === 1, `rc=${refMissing.rc}`);

    // 19. Mutated reference -> done exits 1 and error contains 'drift'
    const driftFile = path.join(WORK_DIR, 'mutable_ref.txt');
    fs.writeFileSync(driftFile, 'original-v1\n', 'utf8');
    const putDrift = runCli(['put', driftFile, '--by', 'hermes']);
    const driftTask = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'drift-check', '--ref', putDrift.json.sha256]);
    const driftClaim = runCli(['claim', driftTask.json.id, '--by', 'codex']);
    fs.writeFileSync(driftFile, 'mutated-v2!\n', 'utf8');
    const driftOut = path.join(WORK_DIR, 'drift_res.json');
    fs.writeFileSync(driftOut, '{"ok":true}', 'utf8');
    const doneDrift = runCli(['done', driftTask.json.id, '--by', 'codex', '--lease', driftClaim.json.lease_token, '--result', driftOut]);
    assertCase(19, '引用被改动后 done 退出码 1 且错误含 drift',
      doneDrift.rc === 1 && /drift/i.test(doneDrift.stderr),
      `rc=${doneDrift.rc} stderr=${doneDrift.stderr.trim()}`);

    // 20. must_contain not matched -> done exits 1 and task stays claimed
    const badResult = path.join(WORK_DIR, 'bad_report.json');
    fs.writeFileSync(badResult, JSON.stringify({ count: 20, total_kwh: 625.15, top_device: 'heater-1' }), 'utf8');
    const doneFailAcc = runCli(['done', mainTaskId, '--by', 'codex', '--lease', leaseToken, '--result', badResult]);
    const afterBadDone = runCli(['show', mainTaskId]);
    assertCase(20, 'must_contain 未命中时 done 退出码 1 且任务仍为 claimed',
      doneFailAcc.rc === 1 && afterBadDone.json?.state === 'claimed',
      `rc=${doneFailAcc.rc} state=${afterBadDone.json?.state}`);

    // 21. Valid done -> state=done, result.sha256 equals actual file SHA-256
    const goodResult = path.join(WORK_DIR, 'good_report.json');
    fs.writeFileSync(goodResult, JSON.stringify({
      count: 20,
      total_kwh: 625.15,
      top_device: 'heater-1',
      policy_sha256: shaPolicy,
    }, null, 2), 'utf8');
    const expectedResSha = sha256(goodResult);
    const doneOk = runCli([
      'done', mainTaskId, '--by', 'codex', '--lease', leaseToken, '--result', goodResult,
      '--field', 'count=20', '--field', 'top_device=heater-1',
    ]);
    assertCase(21, '正常 done 返回 state=done 且 result.sha256 与文件实测一致',
      doneOk.rc === 0 && doneOk.json?.state === 'done' && doneOk.json?.result_sha256 === expectedResSha,
      `rc=${doneOk.rc} state=${doneOk.json?.state} shaMatch=${doneOk.json?.result_sha256 === expectedResSha}`);

    // 22. Duplicate done -> exit code 2
    const dupDone = runCli(['done', mainTaskId, '--by', 'codex', '--lease', leaseToken, '--result', goodResult]);
    assertCase(22, '重复 done 退出码 2', dupDone.rc === 2, `rc=${dupDone.rc}`);

    // 23. verify clean task -> bad:0, exit code 0
    const verifyOk = runCli(['verify', '--task', mainTaskId]);
    assertCase(23, 'verify 正常任务 bad=0 且退出码 0',
      verifyOk.rc === 0 && verifyOk.json?.bad === 0,
      `rc=${verifyOk.rc} bad=${verifyOk.json?.bad}`);

    // 24. Tamper result file -> verify bad>=1, exit code 1
    fs.appendFileSync(goodResult, '\n// tampered', 'utf8');
    const verifyBad = runCli(['verify', '--task', mainTaskId]);
    assertCase(24, '篡改结果文件后 verify bad>=1 且退出码 1',
      verifyBad.rc === 1 && (verifyBad.json?.bad ?? 0) >= 1,
      `rc=${verifyBad.rc} bad=${verifyBad.json?.bad}`);

    // 25. 10 concurrent claim processes on same task -> exactly 1 gets rc=0, 9 get rc=2
    const raceTask = runCli(['new', '--to', '*', '--from', 'hermes', '--goal', 'concurrency-race-10']);
    const raceId = raceTask.json?.id;
    const raceProcs = Array.from({ length: 10 }, (_, idx) => new Promise((resolve) => {
      const p = spawn(process.execPath, [BUS_BIN, 'claim', raceId, '--by', `worker-${idx}`, '--root', ROOT_MAIN], {
        cwd: PKG_ROOT,
        env: { ...process.env, AGENTBUS_ALLOWED_ROOTS: ALLOWED_MAIN },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      p.on('exit', (code) => resolve(code ?? -1));
    }));
    const raceCodes = await Promise.all(raceProcs);
    const winners = raceCodes.filter((c) => c === 0).length;
    const rejected2 = raceCodes.filter((c) => c === 2).length;
    assertCase(25, '同一任务 10 个并发 claim 恰好 1 个成功(0)、其余 9 个退出码 2',
      winners === 1 && rejected2 === 9,
      `codes=[${raceCodes.join(',')}] winners=${winners} rc2=${rejected2}`);

    // 26. Path outside allowed_roots -> exit code 1 (both put and new --ref)
    const outsideFile = path.join(OUTSIDE_DIR, 'secret_outside.txt');
    fs.writeFileSync(outsideFile, 'outside allowed roots\n', 'utf8');
    const putOutside = runCli(['put', outsideFile]);
    const refOutside = runCli(['new', '--to', 'codex', '--goal', 'escape', '--ref', outsideFile]);
    assertCase(26, '指向 allowed_roots 之外的绝对路径退出码 1',
      putOutside.rc === 1 && refOutside.rc === 1,
      `putRc=${putOutside.rc} refRc=${refOutside.rc}`);

    // 27. Symlink / junction inside allowed_roots pointing outside allowed_roots -> exit code 1
    let linkTargetTestPath = '';
    const fileLink = path.join(WORK_DIR, 'escape_file_link.txt');
    try {
      fs.symlinkSync(outsideFile, fileLink, 'file');
      linkTargetTestPath = fileLink;
    } catch {
      // On Windows without Developer Mode, directory junction works unprivileged & tests realpathSync identically
      const dirJunction = path.join(WORK_DIR, 'escape_dir_junction');
      fs.symlinkSync(OUTSIDE_DIR, dirJunction, 'junction');
      linkTargetTestPath = path.join(dirJunction, 'secret_outside.txt');
    }
    const putLinkOutside = runCli(['put', linkTargetTestPath]);
    const refLinkOutside = runCli(['new', '--to', 'codex', '--goal', 'escape-link', '--ref', linkTargetTestPath]);
    assertCase(27, '符号链接/Junction 指向 allowed_roots 之外退出码 1（realpathSync 判定）',
      putLinkOutside.rc === 1 && refLinkOutside.rc === 1,
      `putRc=${putLinkOutside.rc} refRc=${refLinkOutside.rc}`);

    // 28, 29, 30. MCP stdio handshake, tools/list (exact 9 tools), tools/call bus_task_list
    const cliListNow = runCli(['list', '--limit', '500']);
    const mcpSession = await runMcpSession(ROOT_MAIN, ALLOWED_MAIN, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'accept', version: '1.0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bus_task_list', arguments: { limit: 500 } } },
    ]);

    const initResp = mcpSession.responses.find((r) => r.id === 1)?.result;
    assertCase(28, 'MCP initialize 握手返回 protocolVersion、serverInfo.name=agentbus、capabilities.tools',
      initResp?.protocolVersion === '2025-06-18' &&
      initResp?.serverInfo?.name === 'agentbus' &&
      Boolean(initResp?.capabilities?.tools),
      JSON.stringify(initResp));

    const pkgVersion = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
    assertCase(66, 'MCP serverInfo.version 与 package.json 一致',
      initResp?.serverInfo?.version === pkgVersion,
      `server=${initResp?.serverInfo?.version} pkg=${pkgVersion}`);

    const toolsResp = mcpSession.responses.find((r) => r.id === 2)?.result?.tools || [];
    const expectedTools = [
      'bus_register',
      'bus_task_create',
      'bus_task_claim',
      'bus_task_heartbeat',
      'bus_ref_read',
      'bus_task_complete',
      'bus_task_fail',
      'bus_task_recover',
      'bus_task_list',
      'bus_verify',
      'bus_task_dispatch',
      'bus_task_wait',
      'bus_task_run',
      'bus_task_message',
      'bus_task_inbox',
    ];
    const actualToolNames = toolsResp.map((t) => t.name);
    const exactAll = toolsResp.length === 15 &&
      expectedTools.every((n) => actualToolNames.includes(n)) &&
      toolsResp.every((t) => t.inputSchema && t.inputSchema.type === 'object');
    assertCase(29, 'MCP tools/list 恰好 15 个工具，名字完整且均有 inputSchema',
      exactAll,
      `count=${toolsResp.length} names=[${actualToolNames.join(',')}]`);

    const listCallResp = mcpSession.responses.find((r) => r.id === 3)?.result;
    const mcpList = listCallResp?.structuredContent;
    assertCase(30, 'MCP tools/call bus_task_list 返回 structuredContent 数组且条数与 CLI list 一致',
      Array.isArray(mcpList) && Array.isArray(cliListNow.json) && mcpList.length === cliListNow.json.length,
      `mcpLen=${Array.isArray(mcpList) ? mcpList.length : typeof mcpList} cliLen=${cliListNow.json?.length}`);

    // 31. Performance: insert 1000 tasks in fresh DB, then CLI `list --limit 500` < 3s
    const perfInit = runCli(['init'], { root: ROOT_PERF, allowed: ROOT_PERF });
    const perfDb = new DatabaseSync(path.join(ROOT_PERF, 'agentbus.db'));
    perfDb.exec('BEGIN IMMEDIATE');
    const ins = perfDb.prepare(
      `INSERT INTO tasks (
        id, schema, from_agent, to_agent, state, goal,
        constraints_json, refs_json, acceptance_json,
        claimed_by, lease_token, lease_expires_at, attempt,
        idempotency_key, created_at, finished_at, result_json, history_json
      ) VALUES (?, 'agentbus/task@1', 'hermes', 'codex', 'open', ?, '[]', '[]', '{}', NULL, NULL, NULL, 0, NULL, ?, NULL, NULL, '[]')`
    );
    const baseMs = Date.now() - 100000;
    for (let i = 0; i < 1000; i++) {
      const tid = `tperf${String(i).padStart(4, '0')}`;
      ins.run(tid, `perf goal #${i}`, new Date(baseMs + i).toISOString());
    }
    perfDb.exec('COMMIT');
    perfDb.close();
    const t0 = Date.now();
    const perfList = runCli(['list', '--limit', '500'], { root: ROOT_PERF, allowed: ROOT_PERF });
    const elapsedMs = Date.now() - t0;
    assertCase(31, '建 1000 个任务后 list --limit 500 耗时 < 3 秒',
      perfInit.rc === 0 && perfList.rc === 0 && Array.isArray(perfList.json) && perfList.json.length === 500 && elapsedMs < 3000,
      `rc=${perfList.rc} count=${perfList.json?.length} elapsed=${elapsedMs}ms`);

    // 32. Prototype compatibility (optional): needs AGENTBUS_COMPAT_DIR with the two legacy envelopes
    if (!LEGACY_DIR || !fs.existsSync(LEGACY_OK_JSON) || !fs.existsSync(LEGACY_DRIFT_JSON)) {
      skipped++;
      console.log('SKIP 32: legacy compatibility fixtures not provided (set AGENTBUS_COMPAT_DIR)');
    } else {
      const compatTasksDir = path.join(ROOT_COMPAT, 'tasks');
      fs.mkdirSync(compatTasksDir, { recursive: true });
      fs.copyFileSync(LEGACY_OK_JSON, path.join(compatTasksDir, 'tmwszbfbh8d2f.json'));
      fs.copyFileSync(LEGACY_DRIFT_JSON, path.join(compatTasksDir, 'tmwszsmxhaa5b.json'));

      const compatShow = runCli(['show', 'tmwszbfbh8d2f'], { root: ROOT_COMPAT, allowed: ALLOWED_COMPAT });
      const compatVerOk = runCli(['verify', '--task', 'tmwszbfbh8d2f'], { root: ROOT_COMPAT, allowed: ALLOWED_COMPAT });
      const compatVerDrift = runCli(['verify', '--task', 'tmwszsmxhaa5b'], { root: ROOT_COMPAT, allowed: ALLOWED_COMPAT });

      assertCase(32, 'legacy envelope compatibility: show ok, verify ok rc=0, verify drift rc=1',
        compatShow.rc === 0 &&
        compatShow.json?.id === 'tmwszbfbh8d2f' &&
        compatShow.json?.state === 'done' &&
        compatVerOk.rc === 0 && compatVerOk.json?.bad === 0 &&
        compatVerDrift.rc === 1 && (compatVerDrift.json?.bad ?? 0) >= 1,
        `showRc=${compatShow.rc} verOkRc=${compatVerOk.rc}(bad=${compatVerOk.json?.bad}) verDriftRc=${compatVerDrift.rc}(bad=${compatVerDrift.json?.bad})`);
    }
    // 33. `--accept k=v` 落成扁平键，done 时必须真的逐字段校验（防“零校验直接 done”）
    const accTask = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'flat-accept',
      '--accept', 'verdict=ok', '--accept', 'count=3']);
    const accId = accTask.json?.id;
    const accClaim = runCli(['claim', accId, '--by', 'codex']);
    const accLease = accClaim.json?.lease_token;
    const flatBad = path.join(WORK_DIR, 'flat_bad.json');
    fs.writeFileSync(flatBad, JSON.stringify({ verdict: 'ok', count: 4 }), 'utf8');
    const doneFlatBad = runCli(['done', accId, '--by', 'codex', '--lease', accLease, '--result', flatBad]);
    const flatGood = path.join(WORK_DIR, 'flat_good.json');
    fs.writeFileSync(flatGood, JSON.stringify({ verdict: 'ok', count: 3 }), 'utf8');
    const doneFlatGood = runCli(['done', accId, '--by', 'codex', '--lease', accLease, '--result', flatGood]);
    assertCase(33, '--accept 扁平字段在 done 时逐字段校验（不匹配拒绝、匹配放行）',
      doneFlatBad.rc !== 0 && doneFlatGood.rc === 0 && doneFlatGood.json?.state === 'done',
      `badRc=${doneFlatBad.rc} goodRc=${doneFlatGood.rc} state=${doneFlatGood.json?.state}`);

    // 34. worker 角色：只看到 9 个工具（含 recover/message/inbox），create/dispatch 被拒
    const workerSession = await runMcpSession(ROOT_MAIN, ALLOWED_MAIN, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'accept-worker', version: '1.0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bus_task_create', arguments: { to: 'codex', goal: 'blocked for workers' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bus_task_dispatch', arguments: { id: accId } } },
    ], { AGENTBUS_ROLE: 'worker' });
    const workerTools = workerSession.responses.find((r) => r.id === 2)?.result?.tools || [];
    const blockedCall = workerSession.responses.find((r) => r.id === 3)?.result;
    const blockedDispatch = workerSession.responses.find((r) => r.id === 4)?.result;
    assertCase(34, 'worker 角色恰好看到 9 个工具（含 recover/message/inbox），且 bus_task_create/dispatch 被拒',
      workerTools.length === 9 &&
      workerTools.some((t) => t.name === 'bus_task_recover') &&
      workerTools.some((t) => t.name === 'bus_task_message') &&
      workerTools.some((t) => t.name === 'bus_task_inbox') &&
      !workerTools.some((t) => t.name === 'bus_task_create') &&
      !workerTools.some((t) => t.name === 'bus_task_dispatch') &&
      blockedCall?.isError === true &&
      blockedDispatch?.isError === true,
      `count=${workerTools.length} names=[${workerTools.map((t) => t.name).join(',')}] isError=${blockedCall?.isError}/${blockedDispatch?.isError}`);

    const unknownRoleSession = await runMcpSession(ROOT_MAIN, ALLOWED_MAIN, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'accept-role-typo', version: '1.0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ], { AGENTBUS_ROLE: 'boss' });
    const unknownTools = unknownRoleSession.responses.find((r) => r.id === 2)?.result?.tools || [];
    assertCase(67, '未知 AGENTBUS_ROLE 按 worker 最小权限处理（9 工具，不泄漏 dispatch/create）',
      unknownTools.length === 9 && !unknownTools.some((t) => t.name === 'bus_task_dispatch') && !unknownTools.some((t) => t.name === 'bus_task_create'),
      `count=${unknownTools.length} names=[${unknownTools.map((t) => t.name).join(',')}]`);

    // 35. bus_task_wait 必须返回真实结果（异步处理器没 await 时这里会是空对象）
    const waitSession = await runMcpSession(ROOT_MAIN, ALLOWED_MAIN, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'accept-wait', version: '1.0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bus_task_wait', arguments: { id: accId, timeout_s: 5 } } },
    ]);
    const waitRes = waitSession.responses.find((r) => r.id === 2)?.result;
    assertCase(35, 'MCP bus_task_wait 返回真实内容（异步处理器已 await，不再是空 {}）',
      waitRes?.structuredContent?.state === 'done' && Array.isArray(waitRes?.content) && waitRes.content.length > 0,
      `state=${waitRes?.structuredContent?.state} hasContent=${Array.isArray(waitRes?.content)}`);

    // 36. 健康冷却：503 冷却期内 dispatch 直接 skipped，不启动进程
    const cdTask = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'cooldown probe']);
    const cdId = cdTask.json?.id;
    const cdDb = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    let cdDispatch;
    try {
      cdDb.prepare("INSERT INTO agent_health (agent, cooldown_until, reason, fails, updated_at) VALUES ('codex', ?, 'capacity/503', 1, ?) " +
        'ON CONFLICT(agent) DO UPDATE SET cooldown_until = excluded.cooldown_until, reason = excluded.reason')
        .run(new Date(Date.now() + 600000).toISOString(), new Date().toISOString());
      cdDispatch = runCli(['dispatch', cdId, '--allow-dispatch', '--wait', '5']);
    } finally {
      try { cdDb.prepare("UPDATE agent_health SET cooldown_until = NULL, reason = NULL WHERE agent = 'codex'").run(); } catch {}
      try { cdDb.close(); } catch {}
    }
    assertCase(36, '健康冷却：503 冷却期内 dispatch 直接 skipped、不起进程',
      cdDispatch?.json?.skipped === true && cdDispatch?.json?.reason === 'cooldown',
      `skipped=${cdDispatch?.json?.skipped} reason=${cdDispatch?.json?.reason} rc=${cdDispatch?.rc}`);

    // 37. 并发派发：一条命令派多个任务，冷却期内两个都被跳过（不启进程也能验证 fan-out 结构）
    const fanA = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'fan-a']).json?.id;
    const fanB = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'fan-b']).json?.id;
    const fanDb = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    let fanOut;
    try {
      fanDb.prepare("INSERT INTO agent_health (agent, cooldown_until, reason, fails, updated_at) VALUES ('codex', ?, 'capacity/503', 1, ?) " +
        'ON CONFLICT(agent) DO UPDATE SET cooldown_until = excluded.cooldown_until, reason = excluded.reason')
        .run(new Date(Date.now() + 600000).toISOString(), new Date().toISOString());
      fanOut = runCli(['dispatch', fanA, fanB, '--allow-dispatch', '--wait', '5']);
    } finally {
      try { fanDb.prepare("UPDATE agent_health SET cooldown_until = NULL, reason = NULL WHERE agent = 'codex'").run(); } catch {}
      try { fanDb.close(); } catch {}
    }
    assertCase(37, '并发派发：dispatch id1 id2 返回 count=2，逐个结果都在',
      fanOut?.json?.count === 2 &&
      Array.isArray(fanOut?.json?.results) &&
      fanOut.json.results.length === 2 &&
      fanOut.json.results.every((r) => r.skipped === true),
      `count=${fanOut?.json?.count} results=${fanOut?.json?.results?.length}`);

    // 38. 会话复用：同一 --thread 的第二个任务resume，不新建会话
    const thA = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'thread-a']).json?.id;
    const thB = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'thread-b']).json?.id;
    const dThA = runCli(['dispatch', thA, '--allow-dispatch', '--wait', '15', '--thread', 't-reuse'], { envExtra: fakeAdapterEnv('fake-sess-9') });
    const dThB = runCli(['dispatch', thB, '--allow-dispatch', '--wait', '15', '--thread', 't-reuse'], { envExtra: fakeAdapterEnv('fake-sess-9') });
    assertCase(38, '会话复用：同 thread 第二次 dispatch resumed=true、session 不变',
      dThA.json?.thread?.resumed === false &&
      dThB.json?.thread?.resumed === true &&
      dThB.json?.thread?.session === 'fake-sess-9',
      `first=${dThA.json?.thread?.resumed} second=${dThB.json?.thread?.resumed} session=${dThB.json?.thread?.session}`);

    // 39. 会话过期：超过 2 小时的自动换新会话（task:<id> 自动线程同样受限）
    const thC = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'thread-expired']).json?.id;
    const thDb = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    try {
      thDb.prepare("INSERT INTO threads (agent, name, session_id, created_at, uses, steps, updated_at) VALUES ('fake', ?, 'stale-sess', ?, 5, 0, ?) " +
        'ON CONFLICT(agent, name) DO UPDATE SET session_id = excluded.session_id, created_at = excluded.created_at, uses = 5, steps = 0')
        .run(`task:${thC}`, new Date(Date.now() - 3 * 3600 * 1000).toISOString(), new Date().toISOString());
    } finally {
      try { thDb.close(); } catch {}
    }
    const dThC = runCli(['dispatch', thC, '--allow-dispatch', '--wait', '15'], { envExtra: fakeAdapterEnv('fresh-sess') });
    assertCase(39, '会话过期：>2 小时的旧会话不再 resume，自动换新',
      dThC.json?.thread?.name === `task:${thC}` &&
      dThC.json?.thread?.resumed === false &&
      dThC.json?.thread?.session === 'fresh-sess',
      `name=${dThC.json?.thread?.name} resumed=${dThC.json?.thread?.resumed} session=${dThC.json?.thread?.session}`);

    // 40. cwd 变更不复用
    const cwdT1 = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'cwd-1']).json?.id;
    const cwdT2 = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'cwd-2']).json?.id;
    const dCwd1 = runCli(['dispatch', cwdT1, '--allow-dispatch', '--wait', '15', '--thread', 't-cwd', '--cwd', WORK_DIR], { envExtra: fakeAdapterEnv('sess-cwd-1') });
    const dCwd2 = runCli(['dispatch', cwdT2, '--allow-dispatch', '--wait', '15', '--thread', 't-cwd', '--cwd', OUT_DIR], { envExtra: fakeAdapterEnv('sess-cwd-2') });
    assertCase(40, 'cwd 变更不复用（同一 --thread 切换目录后生成新会话）',
      dCwd1.json?.thread?.resumed === false &&
      dCwd2.json?.thread?.resumed === false &&
      dCwd2.json?.thread?.session === 'sess-cwd-2',
      `r1=${dCwd1.json?.thread?.resumed} r2=${dCwd2.json?.thread?.resumed} s2=${dCwd2.json?.thread?.session}`);

    // 41. model 变更或 last_ok = 0 不复用
    const modT1 = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'mod-1']).json?.id;
    const modT2 = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'mod-2']).json?.id;
    const modT3 = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'mod-3']).json?.id;
    runCli(['dispatch', modT1, '--allow-dispatch', '--wait', '15', '--thread', 't-mod', '--cwd', WORK_DIR], { envExtra: fakeAdapterEnv('sess-mod-1') });
    const modDb = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    try {
      modDb.prepare("UPDATE threads SET last_ok = 0 WHERE agent = 'fake' AND name = 't-mod'").run();
    } finally { modDb.close(); }
    const dMod2 = runCli(['dispatch', modT2, '--allow-dispatch', '--wait', '15', '--thread', 't-mod', '--cwd', WORK_DIR], { envExtra: fakeAdapterEnv('sess-mod-2') });
    const modDb2 = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    try {
      modDb2.prepare("UPDATE threads SET model = 'other-model', last_ok = 1 WHERE agent = 'fake' AND name = 't-mod'").run();
    } finally { modDb2.close(); }
    const dMod3 = runCli(['dispatch', modT3, '--allow-dispatch', '--wait', '15', '--thread', 't-mod', '--cwd', WORK_DIR], { envExtra: fakeAdapterEnv('sess-mod-3') });
    assertCase(41, 'model 变更或 last_ok=0 不复用',
      dMod2.json?.thread?.resumed === false && dMod2.json?.thread?.session === 'sess-mod-2' &&
      dMod3.json?.thread?.resumed === false && dMod3.json?.thread?.session === 'sess-mod-3',
      `r2=${dMod2.json?.thread?.resumed} r3=${dMod3.json?.thread?.resumed}`);

    // 42. 首轮秒败不写入 threads 表
    const ffTask = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'fast-fail']).json?.id;
    const dFf = runCli(['dispatch', ffTask, '--allow-dispatch', '--wait', '15', '--thread', 't-fast-fail', '--cwd', WORK_DIR], {
      envExtra: fakeAdapterEnv('bad-503-sess', { script: FAIL_FAST_AGENT }),
    });
    const ffDb = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    let ffCount = -1;
    try {
      ffCount = Number(ffDb.prepare("SELECT COUNT(*) AS c FROM threads WHERE agent = 'fake' AND name = 't-fast-fail'").get().c);
      ffDb.prepare("UPDATE agent_health SET cooldown_until = NULL, reason = NULL WHERE agent = 'fake'").run();
    } finally { ffDb.close(); }
    assertCase(42, '首轮秒败（<10s 且含 503）不写入 threads 表',
      dFf.json?.state === 'open' && ffCount === 0,
      `state=${dFf.json?.state} threadRows=${ffCount}`);

    // 43. task:<id> 任务终态（done / failed）后 threads 表对应行自动清理
    const failThTask = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'fail-cleanup']).json?.id;
    const failThClaim = runCli(['claim', failThTask, '--by', 'fake']);
    const cleanDb1 = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    try {
      cleanDb1.prepare(
        "INSERT INTO threads (agent, name, session_id, created_at, uses, steps, updated_at, cwd) VALUES ('fake', ?, 'temp-fail-sess', ?, 1, 8, ?, ?)"
      ).run(`task:${failThTask}`, new Date().toISOString(), new Date().toISOString(), WORK_DIR);
    } finally { cleanDb1.close(); }
    runCli(['fail', failThTask, '--by', 'fake', '--lease', failThClaim.json?.lease_token, '--reason', 'cleanup-check']);
    const cleanDb2 = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    let doneRowCnt = -1;
    let failRowCnt = -1;
    try {
      doneRowCnt = Number(cleanDb2.prepare('SELECT COUNT(*) AS c FROM threads WHERE name = ?').get(`task:${thC}`).c);
      failRowCnt = Number(cleanDb2.prepare('SELECT COUNT(*) AS c FROM threads WHERE name = ?').get(`task:${failThTask}`).c);
    } finally { cleanDb2.close(); }
    assertCase(43, 'task:<id> 任务 done / failed 后对应 threads 行自动清理',
      doneRowCnt === 0 && failRowCnt === 0,
      `doneRows=${doneRowCnt} failRows=${failRowCnt}`);

    // 44. steps 非零降级：fake 无会话库连续复用 2 次后 steps === 16 且 step_source === 'fallback_uses'
    const st1 = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'steps-1']).json?.id;
    const st2 = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'steps-2']).json?.id;
    runCli(['dispatch', st1, '--allow-dispatch', '--wait', '15', '--thread', 't-steps', '--cwd', WORK_DIR], { envExtra: fakeAdapterEnv('sess-st-1') });
    runCli(['dispatch', st2, '--allow-dispatch', '--wait', '15', '--thread', 't-steps', '--cwd', WORK_DIR], { envExtra: fakeAdapterEnv('sess-st-1') });
    const stDb = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    let stRow;
    try {
      stRow = stDb.prepare("SELECT steps, step_source, uses FROM threads WHERE agent = 'fake' AND name = 't-steps'").get();
    } finally { stDb.close(); }
    assertCase(44, 'steps 非零降级：连续复用 2 次后 steps=16 且 step_source=fallback_uses',
      Number(stRow?.steps) === 16 && stRow?.step_source === 'fallback_uses' && Number(stRow?.uses) === 2,
      JSON.stringify(stRow));

    // 45. 分端超限换新 + 快照接力：max_uses=2 时第 3 次 dispatch 换新并记 thread_rotated + context@1 ref
    const st3 = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'steps-3']).json?.id;
    const dSt3 = runCli(['dispatch', st3, '--allow-dispatch', '--wait', '15', '--thread', 't-steps', '--cwd', WORK_DIR], {
      envExtra: fakeAdapterEnv('sess-st-2', {
        extra: { AGENTBUS_THREAD_LIMITS_JSON: JSON.stringify({ fake: { max_uses: 2 } }) },
      }),
    });
    const stShow3 = runCli(['show', st3]);
    const rotDb = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    let rotEvents = 0;
    try {
      rotEvents = Number(rotDb.prepare("SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND event = 'thread_rotated'").get(st3).c);
    } finally { rotDb.close(); }
    const ledgerStepsPath = path.join(ROOT_MAIN, 'contexts', 't-steps.json');
    assertCase(45, '分端超限换新 + 快照接力：max_uses=2 第 3 次换新、events 含 thread_rotated 且生成 context@1',
      dSt3.json?.thread?.resumed === false &&
      dSt3.json?.thread?.session === 'sess-st-2' &&
      rotEvents >= 1 &&
      fs.existsSync(ledgerStepsPath) &&
      (stShow3.json?.refs || []).some((r) => r.name === 'thread_context.json'),
      `resumed=${dSt3.json?.thread?.resumed} rotEvents=${rotEvents} ledger=${fs.existsSync(ledgerStepsPath)}`);

    // 46. Codex 沙盒约束门控：constraints 含 sandbox:strict 时不走 resume
    const sbx1 = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'sbx-1']).json?.id;
    const sbx2 = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'sbx-2', '--constraint', 'sandbox:strict']).json?.id;
    const dSbx1 = runCli(['dispatch', sbx1, '--allow-dispatch', '--wait', '15', '--thread', 't-sbx', '--cwd', WORK_DIR], {
      envExtra: fakeAdapterEnv('codex-sess-1', { by: 'codex', adapterKey: 'AGENTBUS_ADAPTER_CODEX' }),
    });
    const dSbx2 = runCli(['dispatch', sbx2, '--allow-dispatch', '--wait', '15', '--thread', 't-sbx', '--cwd', WORK_DIR], {
      envExtra: fakeAdapterEnv('codex-sess-2', { by: 'codex', adapterKey: 'AGENTBUS_ADAPTER_CODEX' }),
    });
    assertCase(46, 'Codex 沙盒约束门控：constraints 含 sandbox:strict 时拒绝 resume',
      dSbx1.json?.state === 'done' && dSbx2.json?.thread?.resumed === false && dSbx2.json?.thread?.session === 'codex-sess-2',
      `r2=${dSbx2.json?.thread?.resumed} s2=${dSbx2.json?.thread?.session}`);

    // 47. context@1 写入与 8KB 裁剪（含 supersedes 清理）
    const { openBus } = await import('../src/db.js');
    const { initContextLedger, saveAndRegisterContext, contextLedgerPath, loadContextLedger, proposeDecision } = await import('../src/context.js');
    const { resolveClientPolicy } = await import('../src/threads.js');
    const ctxBus = openBus({ rootOverride: ROOT_MAIN });
    let ledger47Path;
    let ledger47Doc;
    try {
      const doc47 = initContextLedger('t-compact-test', { cwd: WORK_DIR });
      for (let idx = 0; idx < 25; idx++) {
        doc47.decisions.push({
          id: `dec-${idx}`,
          statement: `Decision ${idx}: ` + 'x'.repeat(210),
          supersedes: idx > 0 && idx % 5 === 0 ? `dec-${idx - 1}` : null,
          status: 'confirmed',
          proposed_by: 'hermes',
          confirmed_by: 'codex',
          confirmed_at: new Date().toISOString(),
          evidence_sha256: null,
          task_id: `t-${idx}`,
          pinned: false,
          at: new Date().toISOString(),
        });
      }
      saveAndRegisterContext(ctxBus, 't-compact-test', doc47);
      ledger47Path = contextLedgerPath(ROOT_MAIN, 't-compact-test');
      ledger47Doc = loadContextLedger(ctxBus, 't-compact-test');
    } finally {
      ctxBus.close();
    }
    const ledger47Size = fs.statSync(ledger47Path).size;
    const hasSuperseded = (ledger47Doc?.decisions || []).some((d) => ['dec-4', 'dec-9', 'dec-14', 'dec-19'].includes(d.id));
    assertCase(47, 'context@1 写入与 <=8KB 确定性裁剪（且已清理被 supersedes 覆盖条目）',
      ledger47Size <= 8192 && !hasSuperseded && (ledger47Doc?.decisions || []).length <= 12,
      `size=${ledger47Size} count=${ledger47Doc?.decisions?.length} hasSuperseded=${hasSuperseded}`);

    // 48. 失败隔离：任务 fail 后，错误原因仅进入 avoid[]，decisions 与 latest_artifacts 原样未变
    const isoSeed = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'iso-seed', '--thread', 't-iso']).json?.id;
    const isoSeedClaim = runCli(['claim', isoSeed, '--by', 'fake']);
    const isoSeedOut = path.join(OUT_DIR, 'iso_seed.json');
    fs.writeFileSync(isoSeedOut, JSON.stringify({ ok: true }), 'utf8');
    runCli(['done', isoSeed, '--by', 'fake', '--lease', isoSeedClaim.json?.lease_token, '--result', isoSeedOut]);
    const isoBus = openBus({ rootOverride: ROOT_MAIN });
    let propInfo;
    try {
      propInfo = proposeDecision(isoBus, 't-iso', { statement: 'Keep API v1', proposedBy: 'fake', taskId: isoSeed, cwd: WORK_DIR });
    } finally { isoBus.close(); }
    const beforeFail = runCli(['context', 't-iso']).json;
    const isoFailTask = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'iso-fail', '--thread', 't-iso']).json?.id;
    const isoFailClaim = runCli(['claim', isoFailTask, '--by', 'fake']);
    runCli(['fail', isoFailTask, '--by', 'fake', '--lease', isoFailClaim.json?.lease_token, '--reason', 'broken approach xyz']);
    const afterFail = runCli(['context', 't-iso']).json;
    assertCase(48, '失败隔离：fail 后原因仅入 avoid[]，decisions 与 latest_artifacts 未变',
      (afterFail?.avoid || []).some((a) => a.task_id === isoFailTask && a.reason.includes('broken approach xyz')) &&
      JSON.stringify(afterFail?.decisions) === JSON.stringify(beforeFail?.decisions) &&
      JSON.stringify(afterFail?.latest_artifacts) === JSON.stringify(beforeFail?.latest_artifacts),
      `avoidLen=${afterFail?.avoid?.length}`);

    // 49. 双人确认门控：同 agent 被拒（exit 1），异 agent 确认后 status === 'confirmed'
    const sameConfirm = runCli(['context', 'confirm', 't-iso', propInfo.decision_id, '--by', 'fake']);
    const diffConfirm = runCli(['context', 'confirm', 't-iso', propInfo.decision_id, '--by', 'hermes']);
    const afterConfirm = runCli(['context', 't-iso']).json;
    const confirmedDec = (afterConfirm?.decisions || []).find((d) => d.id === propInfo.decision_id);
    assertCase(49, '双人确认门控：同 agent 被拒(rc=1)、异 agent 确认后 status=confirmed',
      sameConfirm.rc === 1 && diffConfirm.rc === 0 && confirmedDec?.status === 'confirmed' && confirmedDec?.confirmed_by === 'hermes',
      `sameRc=${sameConfirm.rc} diffRc=${diffConfirm.rc} status=${confirmedDec?.status}`);

    // 50. 挂载 context@1 不破坏信封不变量（单行 <=300、无 40B 决策/避坑正文泄漏、show 无 content）
    const uniqueMarker50 = 'UNIQUE_LEDGER_DECISION_PAYLOAD_' + 'Z'.repeat(30);
    const isoBus50 = openBus({ rootOverride: ROOT_MAIN });
    try {
      proposeDecision(isoBus50, 't-iso', { statement: uniqueMarker50, proposedBy: 'fake', taskId: isoSeed, cwd: WORK_DIR });
    } finally { isoBus50.close(); }
    const envCheckTask = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'env-invariant', '--thread', 't-iso']).json?.id;
    const envRaw50 = fs.readFileSync(path.join(ROOT_MAIN, 'tasks', `${envCheckTask}.json`), 'utf8');
    const ledgerDoc50 = JSON.parse(fs.readFileSync(path.join(ROOT_MAIN, 'contexts', 't-iso.json'), 'utf8'));
    const maxEnvLine = Math.max(...envRaw50.split(/\r?\n/).map((l) => l.length));
    const secretPayloadText50 = JSON.stringify({ decisions: ledgerDoc50.decisions, avoid: ledgerDoc50.avoid });
    let leaked50 = envRaw50.includes(uniqueMarker50);
    if (!leaked50) {
      for (let i = 0; i <= uniqueMarker50.length - 40; i += 10) {
        if (envRaw50.includes(uniqueMarker50.slice(i, i + 40))) { leaked50 = true; break; }
      }
    }
    const envShow50 = runCli(['show', envCheckTask]);
    const hasCtxRef50 = (envShow50.json?.refs || []).some((r) => r.name === 'thread_context.json');
    const noContent50 = envShow50.json && !('content' in envShow50.json);
    assertCase(50, '挂载 context@1 不破坏信封不变量（行<=300、零正文泄漏、show 无 content）',
      hasCtxRef50 && maxEnvLine <= 300 && !leaked50 && noContent50 && secretPayloadText50.includes(uniqueMarker50),
      `hasCtx=${hasCtxRef50} maxLine=${maxEnvLine} leaked=${leaked50}`);

    // 51. bus_ref_read 审计落库：读 telemetry.csv (inline_text) 与 policy.bin (resource_link)
    const auditDb = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    let refReadRows = [];
    try {
      refReadRows = auditDb.prepare("SELECT payload_json FROM events WHERE task_id = ? AND event = 'ref_read' ORDER BY seq ASC")
        .all(mainTaskId)
        .map((r) => JSON.parse(r.payload_json));
    } finally { auditDb.close(); }
    assertCase(51, 'bus_ref_read 审计落库：events 记有 inline_text 与 resource_link 的 ref_read 事件',
      refReadRows.some((p) => p.name === 'telemetry.csv' && p.mode === 'inline_text' && p.sha256) &&
      refReadRows.some((p) => p.name === 'policy.bin' && p.mode === 'resource_link' && p.sha256),
      JSON.stringify(refReadRows));

    // 52. 默认 warn 模式放行：#21 mainTaskId 未读 SPEC.md 直接 done，记 complete_audit_warning 且 warnings 含 completed_without_bus_ref_read
    const warnDb = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    let warnEvent = null;
    try {
      const r = warnDb.prepare("SELECT payload_json FROM events WHERE task_id = ? AND event = 'complete_audit_warning'").get(mainTaskId);
      if (r) warnEvent = JSON.parse(r.payload_json);
    } finally { warnDb.close(); }
    assertCase(52, '默认 warn 模式放行：未读全部 ref 仍 done，返回 warning 并写 complete_audit_warning',
      (doneOk.json?.warnings || []).includes('completed_without_bus_ref_read') &&
      (warnEvent?.missing_refs || []).includes('SPEC.md'),
      `warnings=${JSON.stringify(doneOk.json?.warnings)} event=${JSON.stringify(warnEvent)}`);

    // 53. strict 模式强拦截：--accept require_ref_read=true 未读 ref 拒收(rc=1, claimed, complete_audit_rejected)，补读后放行(rc=0)
    const putCsv53 = runCli(['put', TELEMETRY_CSV, '--by', 'hermes']);
    const strictTask = runCli([
      'new', '--to', 'codex', '--from', 'hermes', '--goal', 'strict-audit',
      '--ref', putCsv53.json?.sha256, '--accept', 'require_ref_read=true',
    ]).json?.id;
    const strictClaim = runCli(['claim', strictTask, '--by', 'codex']);
    const strictOut = path.join(WORK_DIR, 'strict_plain.txt');
    fs.writeFileSync(strictOut, 'plain text output without json', 'utf8');
    const strictReject = runCli(['done', strictTask, '--by', 'codex', '--lease', strictClaim.json?.lease_token, '--result', strictOut]);
    const strictAfterRej = runCli(['show', strictTask]);
    const strictDb = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    let rejEventCount = 0;
    try {
      rejEventCount = Number(strictDb.prepare("SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND event = 'complete_audit_rejected'").get(strictTask).c);
    } finally { strictDb.close(); }
    const strictRead = runCli(['ref', strictTask, '--name', 'telemetry.csv', '--by', 'codex']);
    const strictAccept = runCli(['done', strictTask, '--by', 'codex', '--lease', strictClaim.json?.lease_token, '--result', strictOut]);
    assertCase(53, 'strict 模式强拦截 + RESERVED 放行非 JSON 产物：未读拒收(rc=1, claimed)、补读后 done(rc=0)',
      strictReject.rc === 1 &&
      strictAfterRej.json?.state === 'claimed' &&
      rejEventCount === 1 &&
      strictRead.rc === 0 &&
      strictAccept.rc === 0 &&
      strictAccept.json?.state === 'done',
      `rejRc=${strictReject.rc} stateAfterRej=${strictAfterRej.json?.state} rejEvents=${rejEventCount} accRc=${strictAccept.rc}`);

    // 54. archive 端口不通明确报错（含 "需以 --remote-debugging-port"）且不得假装成功
    const deadPort = 59871;
    const archDead = runCli(['archive', 'conv-dead', '--port', String(deadPort), '--force']);
    assertCase(54, 'archive 端口不通明确报错（含 --remote-debugging-port 提示）且退出码 1',
      archDead.rc === 1 && archDead.stderr.includes('需以 --remote-debugging-port'),
      `rc=${archDead.rc} stderr=${archDead.stderr.slice(0, 160)}`);

    // 55 & 56. archive --dry-run 与命中/未命中（仅连接测试内本地 mock CDP 服务，绝不触碰真实 Antigravity）
    const httpMod = await import('node:http');
    let mockMode = 'match';
    const mockCdpServer = httpMod.default.createServer((req, res) => {
      if (req.url === '/json') {
        const port = mockCdpServer.address().port;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { type: 'page', title: 'data:text/html,noise', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/noise` },
          { type: 'page', title: 'Antigravity - Mock', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` },
        ]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    mockCdpServer.on('upgrade', (req, socket) => {
      socket.on('error', () => {});
      const key = req.headers['sec-websocket-key'];
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      let acc = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        while (acc.length >= 2) {
          const opcode = acc[0] & 0x0f;
          const len = acc[1] & 0x7f;
          let offset = 2;
          let payloadLen = len;
          if (len === 126) {
            if (acc.length < 4) return;
            payloadLen = acc.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (acc.length < 10) return;
            payloadLen = Number(acc.readBigUInt64BE(2));
            offset = 10;
          }
          const masked = (acc[1] & 0x80) !== 0;
          const totalLen = offset + (masked ? 4 : 0) + payloadLen;
          if (acc.length < totalLen) return;
          const mask = masked ? acc.subarray(offset, offset + 4) : null;
          const dataStart = masked ? offset + 4 : offset;
          const data = Buffer.from(acc.subarray(dataStart, dataStart + payloadLen));
          acc = acc.subarray(totalLen);
          if (mask) {
            for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
          }
          if (opcode === 0x8) {
            try { socket.end(); } catch {}
            return;
          }
          let reqMsg;
          try { reqMsg = JSON.parse(data.toString('utf8')); } catch { continue; }
          const expr = reqMsg?.params?.expression || '';
          const isDry = expr.includes('const dryRun = true');
          let value;
          if (mockMode === 'miss') {
            value = { ok: false, archived: false, conversation_id: 'conv-missing', reason: 'row_not_found' };
          } else if (isDry) {
            value = { ok: true, archived: false, dry_run: true, conversation_id: 'conv-mock-1', row_text: 'agentbus 11-24 t123' };
          } else {
            value = { ok: true, archived: true, conversation_id: 'conv-mock-1', row_text: 'agentbus 11-24 t123' };
          }
          const respBuf = Buffer.from(JSON.stringify({ id: reqMsg.id, result: { result: { value } } }), 'utf8');
          const header = respBuf.length < 126
            ? Buffer.from([0x81, respBuf.length])
            : Buffer.from([0x81, 126, (respBuf.length >> 8) & 0xff, respBuf.length & 0xff]);
          socket.write(Buffer.concat([header, respBuf]));
        }
      });
    });
    await new Promise((r) => mockCdpServer.listen(0, '127.0.0.1', r));
    const mockPort = mockCdpServer.address().port;
    const runCliAsync = (args) => new Promise((resolve) => {
      const p = spawn(process.execPath, [BUS_BIN, ...args, '--root', ROOT_MAIN], {
        cwd: PKG_ROOT,
        env: { ...process.env, AGENTBUS_ALLOWED_ROOTS: ALLOWED_MAIN },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      p.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      p.on('exit', (code) => {
        let json = null;
        try { if (stdout.trim()) json = JSON.parse(stdout); } catch {}
        resolve({ rc: code ?? -1, stdout, stderr, json });
      });
    });
    try {
      const dryRes = await runCliAsync(['archive', 'conv-mock-1', '--port', String(mockPort), '--title-prefix', 'agentbus 11-24', '--dry-run']);
      assertCase(55, 'archive --dry-run 只做匹配不点击，返回 archived=false, dry_run=true, would_archive=false',
        dryRes.rc === 0 && dryRes.json?.ok === true && dryRes.json?.archived === false && dryRes.json?.dry_run === true && dryRes.json?.would_archive === false,
        `rc=${dryRes.rc} json=${JSON.stringify(dryRes.json)} err=${dryRes.stderr}`);

      mockMode = 'miss';
      const missRes = await runCliAsync(['archive', 'conv-missing', '--port', String(mockPort), '--force']);
      mockMode = 'match';
      const hitRes = await runCliAsync(['archive', 'conv-mock-1', '--port', String(mockPort), '--force']);
      assertCase(56, 'archive 未命中返回 row_not_found(rc=1)，命中返回 archived=true(rc=0) 且 --force 带 forced=true',
        missRes.rc === 1 && missRes.json?.ok === false && missRes.json?.reason === 'row_not_found' &&
        hitRes.rc === 0 && hitRes.json?.ok === true && hitRes.json?.archived === true && hitRes.json?.forced === true,
        `miss=${JSON.stringify(missRes.json)} hit=${JSON.stringify(hitRes.json)}`);
    } finally {
      mockCdpServer.close();
    }

    // 57. 分客户端默认策略核验：antigravity (20/3600/1800/3/false) 与 codex (60/7200/1800/6/true)
    const agyPol = resolveClientPolicy('antigravity', ROOT_MAIN, {});
    const cdxPol = resolveClientPolicy('codex', ROOT_MAIN, {});
    assertCase(57, '分客户端默认策略：antigravity(20/1h/30m/3/禁跨任务) 与 codex(60/2h/30m/6/允跨任务)',
      agyPol.max_steps === 20 && agyPol.max_age_s === 3600 && agyPol.max_idle_s === 1800 && agyPol.max_uses === 3 && agyPol.allow_cross_task === false &&
      cdxPol.max_steps === 60 && cdxPol.max_age_s === 7200 && cdxPol.max_idle_s === 1800 && cdxPol.max_uses === 6 && cdxPol.allow_cross_task === true,
      `agy=${JSON.stringify(agyPol)} codex=${JSON.stringify(cdxPol)}`);

    // 58. antigravity --thread 语义：禁止跨任务复用旧会话，改走新会话 + context@1 账本接力
    const agyT1 = runCli(['new', '--to', 'antigravity', '--from', 'hermes', '--goal', 'agy-relay-1']).json?.id;
    const agyT2 = runCli(['new', '--to', 'antigravity', '--from', 'hermes', '--goal', 'agy-relay-2']).json?.id;
    const dAgy1 = runCli(['dispatch', agyT1, '--allow-dispatch', '--wait', '15', '--thread', 't-agy-relay', '--cwd', WORK_DIR], {
      envExtra: fakeAdapterEnv('agy-sess-1', { by: 'antigravity', adapterKey: 'AGENTBUS_ADAPTER_ANTIGRAVITY' }),
    });
    const dAgy2 = runCli(['dispatch', agyT2, '--allow-dispatch', '--wait', '15', '--thread', 't-agy-relay', '--cwd', WORK_DIR], {
      envExtra: fakeAdapterEnv('agy-sess-2', { by: 'antigravity', adapterKey: 'AGENTBUS_ADAPTER_ANTIGRAVITY' }),
    });
    const agyShow2 = runCli(['show', agyT2]);
    assertCase(58, 'antigravity --thread 禁跨任务复用：第 2 轮开新会话(resumed=false)且挂载 context@1 账本指针',
      dAgy1.json?.state === 'done' &&
      dAgy2.json?.state === 'done' &&
      dAgy2.json?.thread?.resumed === false &&
      dAgy2.json?.thread?.session === 'agy-sess-2' &&
      (agyShow2.json?.refs || []).some((r) => r.name === 'thread_context.json'),
      `r2=${dAgy2.json?.thread?.resumed} s2=${dAgy2.json?.thread?.session} refs=${JSON.stringify((agyShow2.json?.refs || []).map((r) => r.name))}`);

    // 59. 降级循环 i > 0 不串号：i=0 模型失败产出旧 session 后，i=1 无 session 输出时不得沿用 i=0 的旧 sessionId
    const FALLBACK_TEST_AGENT = path.join(RUN_BASE, 'fallback_iso_agent.mjs');
    fs.writeFileSync(FALLBACK_TEST_AGENT, [
      "import { execFileSync } from 'node:child_process';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const countFile = process.env.AGENTBUS_FB_COUNT_FILE;",
      "const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(countFile, String(n), 'utf8');",
      "if (n === 1) {",
      "  console.log(JSON.stringify({ thread_id: 'poisoned-i0-sess' }));",
      "  console.error('503 No capacity available');",
      "  process.exit(1);",
      "}",
      "const prompt = process.argv[2] || '';",
      "const id = (prompt.match(/id=([A-Za-z0-9_-]+)/) || [])[1];",
      "const env = { ...process.env, AGENTBUS_ALLOWED_ROOTS: process.env.AGENTBUS_FAKE_ALLOWED };",
      "const run = (a) => execFileSync(process.execPath, [process.env.AGENTBUS_FAKE_BIN, ...a, '--root', process.env.AGENTBUS_FAKE_ROOT], { env, encoding: 'utf8' });",
      "const claim = JSON.parse(run(['claim', id, '--by', 'antigravity']));",
      "const out = path.join(process.env.AGENTBUS_FAKE_WORK, 'fb_' + id + '.json');",
      "fs.writeFileSync(out, JSON.stringify({ ok: true }), 'utf8');",
      "run(['done', id, '--by', 'antigravity', '--lease', claim.lease_token, '--result', out]);",
    ].join('\n'), 'utf8');
    const fbCountFile = path.join(RUN_BASE, 'fb_count.txt');
    const fbTask = runCli(['new', '--to', 'antigravity', '--from', 'hermes', '--goal', 'fallback-no-leak']).json?.id;
    const dFb = runCli(['dispatch', fbTask, '--allow-dispatch', '--wait', '20', '--thread', 't-fb-iso', '--cwd', WORK_DIR], {
      envExtra: fakeAdapterEnv('unused', {
        by: 'antigravity',
        adapterKey: 'AGENTBUS_ADAPTER_ANTIGRAVITY',
        script: FALLBACK_TEST_AGENT,
        extra: { AGENTBUS_FB_COUNT_FILE: fbCountFile },
      }),
    });
    assertCase(59, '降级循环 i>0 不串号：i=1 未输出新 session 时不继承 i=0 失败会话 ID',
      dFb.json?.state === 'done' && dFb.json?.thread?.resumed === false && dFb.json?.thread?.session === null,
      `state=${dFb.json?.state} session=${dFb.json?.thread?.session} attempts=${JSON.stringify(dFb.json?.attempts)}`);

    // 60. detectAgents 发现顺序（env 覆盖 > PATH > 常见安装目录）+ 含空格与中文路径 + .cmd/.bat/.exe
    const { detectAgents, resolveAgentBin } = await import('../src/agents.js');
    const { setupClients, doctor: runDoctor } = await import('../src/setup.js');
    const discBase = path.join(RUN_BASE, '探测 测试');
    const envDir60 = path.join(discBase, 'env 覆盖');
    const pathDir60 = path.join(discBase, 'path 目录');
    const homeWin60 = path.join(discBase, 'win home 中文');
    const scoopDir60 = path.join(homeWin60, 'scoop', 'shims');
    const localBin60 = path.join(homeWin60, '.local', 'bin');
    const npmDir60 = path.join(homeWin60, 'AppData', 'Roaming', 'npm');
    const agyBinDir60 = path.join(homeWin60, '.gemini', 'antigravity', 'bin');
    for (const d of [envDir60, pathDir60, scoopDir60, localBin60, npmDir60, agyBinDir60]) {
      fs.mkdirSync(d, { recursive: true });
    }
    const envCodexBin = path.join(envDir60, 'codex.exe');
    fs.writeFileSync(envCodexBin, 'dummy-exe', 'utf8');
    fs.writeFileSync(path.join(pathDir60, 'codex.cmd'), '@echo off\n', 'utf8');
    fs.writeFileSync(path.join(scoopDir60, 'codex.bat'), '@echo off\n', 'utf8');
    // Put extensionless POSIX shim in pathDir60 to ensure Windows prefers .cmd over extensionless shim
    fs.writeFileSync(path.join(pathDir60, 'claude'), '#!/bin/sh\n', 'utf8');
    fs.writeFileSync(path.join(pathDir60, 'claude.cmd'), '@echo off\n', 'utf8');
    fs.writeFileSync(path.join(localBin60, 'claude.exe'), 'dummy-exe', 'utf8');
    fs.writeFileSync(path.join(npmDir60, 'gemini.cmd'), '@echo off\n', 'utf8');
    fs.writeFileSync(path.join(agyBinDir60, 'agentapi.bat'), '@echo off\n', 'utf8');

    const det60 = detectAgents(homeWin60, {
      platform: 'win32',
      explicitHome: true,
      env: {
        AGENTBUS_CODEX_BIN: envCodexBin,
        PATH: pathDir60,
      },
    });
    const map60 = Object.fromEntries(det60.map((a) => [a.id, a]));
    assertCase(60, 'detectAgents 发现顺序(env > PATH > 常见目录) + 空格中文路径 + .cmd/.bat/.exe',
      map60.codex?.bin === path.resolve(envCodexBin) && map60.codex?.bin_source === 'env' &&
      map60.claude?.bin === path.join(pathDir60, 'claude.cmd') && map60.claude?.bin_source === 'path' &&
      map60.gemini?.bin === path.join(npmDir60, 'gemini.cmd') && map60.gemini?.bin_source === 'common_dir' &&
      map60.antigravity?.bin === path.join(agyBinDir60, 'agentapi.bat') && map60.antigravity?.bin_source === 'common_dir',
      JSON.stringify({ codex: map60.codex?.bin, claude: map60.claude?.bin, gemini: map60.gemini?.bin, agy: map60.antigravity?.bin }));

    // 61. nvm / scoop / volta 布局在 Windows / macOS / Linux 下发现正确
    const layoutBase = path.join(RUN_BASE, '布局 测试');
    const winHome61 = path.join(layoutBase, 'win 用户');
    const macHome61 = path.join(layoutBase, 'mac 用户');
    const linHome61 = path.join(layoutBase, 'lin 用户');
    // Windows: scoop + volta + nvm-windows (v22 > v20)
    fs.mkdirSync(path.join(winHome61, 'scoop', 'shims'), { recursive: true });
    fs.mkdirSync(path.join(winHome61, '.volta', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(winHome61, 'AppData', 'Roaming', 'nvm', 'v20.10.0'), { recursive: true });
    fs.mkdirSync(path.join(winHome61, 'AppData', 'Roaming', 'nvm', 'v22.14.0'), { recursive: true });
    fs.writeFileSync(path.join(winHome61, 'scoop', 'shims', 'codex.cmd'), '@echo off\n', 'utf8');
    fs.writeFileSync(path.join(winHome61, '.volta', 'bin', 'claude.exe'), 'exe', 'utf8');
    fs.writeFileSync(path.join(winHome61, 'AppData', 'Roaming', 'nvm', 'v20.10.0', 'gemini.cmd'), '@echo off\n', 'utf8');
    fs.writeFileSync(path.join(winHome61, 'AppData', 'Roaming', 'nvm', 'v22.14.0', 'gemini.cmd'), '@echo off\n', 'utf8');
    // macOS: nvm + volta + npm-global + Antigravity.app
    fs.mkdirSync(path.join(macHome61, '.nvm', 'versions', 'node', 'v18.19.0', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(macHome61, '.nvm', 'versions', 'node', 'v22.14.0', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(macHome61, '.volta', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(macHome61, '.npm-global', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(macHome61, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin'), { recursive: true });
    for (const f of [
      path.join(macHome61, '.nvm', 'versions', 'node', 'v18.19.0', 'bin', 'codex'),
      path.join(macHome61, '.nvm', 'versions', 'node', 'v22.14.0', 'bin', 'codex'),
      path.join(macHome61, '.volta', 'bin', 'claude'),
      path.join(macHome61, '.npm-global', 'bin', 'gemini'),
      path.join(macHome61, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin', 'agentapi'),
    ]) { fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 }); }
    // Linux: nvm + .local/bin + pnpm + .local/share/Antigravity/bin
    fs.mkdirSync(path.join(linHome61, '.nvm', 'versions', 'node', 'v22.14.0', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(linHome61, '.local', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(linHome61, '.local', 'share', 'pnpm'), { recursive: true });
    fs.mkdirSync(path.join(linHome61, '.local', 'share', 'Antigravity', 'bin'), { recursive: true });
    for (const f of [
      path.join(linHome61, '.nvm', 'versions', 'node', 'v22.14.0', 'bin', 'codex'),
      path.join(linHome61, '.local', 'bin', 'claude'),
      path.join(linHome61, '.local', 'share', 'pnpm', 'gemini'),
      path.join(linHome61, '.local', 'share', 'Antigravity', 'bin', 'agentapi'),
    ]) { fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 }); }

    const win61 = Object.fromEntries(detectAgents(winHome61, { platform: 'win32', explicitHome: true, env: { PATH: '' } }).map((a) => [a.id, a.bin]));
    const mac61 = Object.fromEntries(detectAgents(macHome61, { platform: 'darwin', explicitHome: true, env: { PATH: '' } }).map((a) => [a.id, a.bin]));
    const lin61 = Object.fromEntries(detectAgents(linHome61, { platform: 'linux', explicitHome: true, env: { PATH: '' } }).map((a) => [a.id, a.bin]));
    assertCase(61, 'nvm / scoop / volta 布局在 Windows / macOS / Linux 下探测正确',
      win61.codex === path.join(winHome61, 'scoop', 'shims', 'codex.cmd') &&
      win61.claude === path.join(winHome61, '.volta', 'bin', 'claude.exe') &&
      win61.gemini === path.join(winHome61, 'AppData', 'Roaming', 'nvm', 'v22.14.0', 'gemini.cmd') &&
      mac61.codex === path.join(macHome61, '.nvm', 'versions', 'node', 'v22.14.0', 'bin', 'codex') &&
      mac61.claude === path.join(macHome61, '.volta', 'bin', 'claude') &&
      mac61.gemini === path.join(macHome61, '.npm-global', 'bin', 'gemini') &&
      mac61.antigravity === path.join(macHome61, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin', 'agentapi') &&
      lin61.codex === path.join(linHome61, '.nvm', 'versions', 'node', 'v22.14.0', 'bin', 'codex') &&
      lin61.claude === path.join(linHome61, '.local', 'bin', 'claude') &&
      lin61.gemini === path.join(linHome61, '.local', 'share', 'pnpm', 'gemini') &&
      lin61.antigravity === path.join(linHome61, '.local', 'share', 'Antigravity', 'bin', 'agentapi'),
      JSON.stringify({ win61, mac61, lin61 }));

    // 62. setup 保留已有其他 server 与字段 + 写前备份 + 重复执行幂等（仅用临时 HOME）
    const home62 = path.join(RUN_BASE, 'setup home 测试');
    const root62 = path.join(RUN_BASE, 'setup root 测试');
    const allow62 = path.join(RUN_BASE, 'setup allow 测试');
    fs.mkdirSync(allow62, { recursive: true });
    // Seed existing configs for codex, claude, gemini, antigravity, cursor, opencode, claude-desktop
    const codexCfg62 = path.join(home62, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(codexCfg62), { recursive: true });
    const origCodexToml = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.other]',
      'command = "npx"',
      'args = ["-y", "other-mcp"]',
      '',
      '[mcp_servers.agentbus]',
      'command = "old"',
      '',
      '[[projects]]',
      'path = "C:\\\\keep-me"',
      '',
    ].join('\n');
    fs.writeFileSync(codexCfg62, origCodexToml, 'utf8');

    const jsonSeedFiles = [
      [path.join(home62, '.claude.json'), { theme: 'dark', mcpServers: { keepMe: { command: 'echo', args: ['1'] } } }],
      [path.join(home62, '.gemini', 'settings.json'), { selectedAuthType: 'oauth', mcpServers: { keepMe: { command: 'echo', args: ['2'] } } }],
      [path.join(home62, '.gemini', 'config', 'mcp_config.json'), { custom: 1, mcpServers: { keepMe: { command: 'echo', args: ['3'] } } }],
      [path.join(home62, '.cursor', 'mcp.json'), { mcpServers: { keepMe: { command: 'echo', args: ['4'] } } }],
      [path.join(home62, '.config', 'opencode', 'opencode.json'), { model: 'x', mcp: { keepMe: { type: 'local', command: ['echo'] } } }],
      [
        process.platform === 'win32'
          ? path.join(home62, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
          : process.platform === 'darwin'
            ? path.join(home62, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
            : path.join(home62, '.config', 'Claude', 'claude_desktop_config.json'),
        { globalShortcut: 'Ctrl+K', mcpServers: { keepMe: { command: 'echo', args: ['5'] } } },
      ],
    ];
    for (const [f, obj] of jsonSeedFiles) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    }

    const setupRun1 = runCli(['setup', '--home', home62, '--allow', allow62], { root: root62, allowed: allow62 });
    const setupRun2 = runCli(['setup', '--home', home62, '--allow', allow62], { root: root62, allowed: allow62 });
    const codexAfter62 = fs.readFileSync(codexCfg62, 'utf8');
    const allBackupsOk = (setupRun1.json?.results || []).every((r) => r.ok && r.changed === true && r.backup && fs.existsSync(r.backup));
    const allIdempotent = (setupRun2.json?.results || []).every((r) => r.ok && r.changed === false && r.backup === null);
    const jsonPreserved = jsonSeedFiles.every(([f, orig]) => {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (f.endsWith('opencode.json')) return parsed.model === 'x' && parsed.mcp?.keepMe?.command?.[0] === 'echo' && Boolean(parsed.mcp?.agentbus);
      return parsed.mcpServers?.keepMe && Boolean(parsed.mcpServers?.agentbus) && Object.keys(orig).every((k) => k in parsed);
    });
    const tomlPreserved = codexAfter62.includes('model = "gpt-5"') &&
      codexAfter62.includes('[mcp_servers.other]') &&
      codexAfter62.includes('[[projects]]') &&
      codexAfter62.includes('[mcp_servers.agentbus]');
    assertCase(62, 'setup 保留原有其他 server/字段 + 写前备份 + 重复执行幂等（不重复写/不重复备份）',
      setupRun1.rc === 0 && setupRun2.rc === 0 && allBackupsOk && allIdempotent && jsonPreserved && tomlPreserved,
      `rc1=${setupRun1.rc} rc2=${setupRun2.rc} baks=${allBackupsOk} idem=${allIdempotent} jsonOk=${jsonPreserved} tomlOk=${tomlPreserved}`);

    // 63. JSON 损坏时明确报错且绝不覆盖、不写备份；doctor 亦能诊断损坏配置
    const home63 = path.join(RUN_BASE, 'corrupt home');
    const claudeCfg63 = path.join(home63, '.claude.json');
    const brokenRaw63 = '{ "mcpServers": { "keep": 1, broken_json ';
    fs.mkdirSync(home63, { recursive: true });
    fs.writeFileSync(claudeCfg63, brokenRaw63, 'utf8');
    const setupCorrupt = runCli(['setup', '--client', 'claude', '--home', home63], { root: root62, allowed: allow62 });
    const docCorrupt = runCli(['doctor', '--home', home63], { root: root62, allowed: allow62 });
    const claudeClientDoc63 = (docCorrupt.json?.clients || []).find((c) => c.id === 'claude');
    const baks63 = fs.readdirSync(home63).filter((n) => n.includes('.bak-'));
    assertCase(63, 'JSON 损坏时 setup 明确报错(rc=1)且绝不覆盖原文件/不生成备份',
      setupCorrupt.rc === 1 &&
      setupCorrupt.json?.results?.[0]?.error_code === 'corrupted_config' &&
      fs.readFileSync(claudeCfg63, 'utf8') === brokenRaw63 &&
      baks63.length === 0 &&
      (claudeClientDoc63?.issues || []).some((i) => i.code === 'corrupted_config'),
      `rc=${setupCorrupt.rc} code=${setupCorrupt.json?.results?.[0]?.error_code} baks=${baks63.length}`);

    // 64. --home / --root / AGENTBUS_ALLOWED_ROOTS 含空格与中文路径端到端（含 onboard --home 隔离 & MCP stdio 实测）
    const cnSpaceBase = path.join(RUN_BASE, '中文 空格 沙盒');
    const cnHome = path.join(cnSpaceBase, '用户 目录');
    const cnRoot = path.join(cnSpaceBase, '总线 根目录');
    const cnAllow = path.join(cnSpaceBase, '项目 资料');
    const cnBinDir = path.join(cnSpaceBase, 'bin 目录');
    fs.mkdirSync(cnAllow, { recursive: true });
    fs.mkdirSync(cnBinDir, { recursive: true });
    const cnCodexBin = path.join(cnBinDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    fs.writeFileSync(cnCodexBin, process.platform === 'win32' ? '@echo off\n' : '#!/bin/sh\n', { mode: 0o755 });
    const cnSampleFile = path.join(cnAllow, '需求 说明.txt');
    fs.writeFileSync(cnSampleFile, 'hello 中文 空格 path\n', 'utf8');

    const onboardCn = runCli([
      'onboard', '--home', cnHome, '--allow', cnAllow, '--conductor', 'codex', '--yes',
    ], {
      root: cnRoot,
      allowed: cnAllow,
      envExtra: {
        AGENTBUS_CODEX_BIN: cnCodexBin,
        AGENTBUS_CLAUDE_BIN: '',
        AGENTBUS_GEMINI_BIN: '',
        AGENTBUS_ANTIGRAVITY_BIN: '',
        AGENTBUS_OPENCODE_BIN: '',
        PATH: cnBinDir,
      },
    });
    const cnSetupCfg = runCli(['setup', '--client', 'gemini', '--home', cnHome, '--allow', cnAllow], { root: cnRoot, allowed: cnAllow });
    const gemWritten = JSON.parse(fs.readFileSync(path.join(cnHome, '.gemini', 'settings.json'), 'utf8'));
    const gemSpec = gemWritten.mcpServers?.agentbus;
    const mcpCnSession = await runMcpSession(
      cnRoot,
      gemSpec?.env?.AGENTBUS_ALLOWED_ROOTS || cnAllow,
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cn-test', version: '1.0' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bus_register', arguments: { path: cnSampleFile, by: 'codex' } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bus_task_list', arguments: { limit: 10 } } },
      ],
    );
    const cnRegRes = mcpCnSession.responses.find((r) => r.id === 2)?.result;
    assertCase(64, '--home / --root / AGENTBUS_ALLOWED_ROOTS 在含空格与中文路径下 onboard/setup/MCP 全链路可用',
      onboardCn.rc === 0 &&
      onboardCn.json?.home === path.resolve(cnHome) &&
      fs.existsSync(path.join(cnHome, '.codex', 'config.toml')) &&
      fs.existsSync(path.join(cnRoot, 'agents.json')) &&
      cnSetupCfg.rc === 0 &&
      gemSpec?.env?.AGENTBUS_ALLOWED_ROOTS === path.resolve(cnAllow) &&
      cnRegRes?.isError !== true &&
      Boolean(cnRegRes?.structuredContent?.sha256),
      `onboardRc=${onboardCn.rc} setupRc=${cnSetupCfg.rc} regSha=${cnRegRes?.structuredContent?.sha256}`);

    // 65. 失败可诊断：缺二进制（含 env 覆盖失效）、缺配置目录、权限不足均给出可执行的下一步
    const diagHome = path.join(RUN_BASE, 'diag home');
    const diagRoot = path.join(RUN_BASE, 'diag root');
    fs.mkdirSync(diagHome, { recursive: true });
    // 65a & 65b: missing binary + broken env override + missing config dir in doctor & setup --require-config-dir
    const docMissing = runCli(['doctor', '--home', diagHome], {
      root: diagRoot,
      allowed: diagRoot,
      envExtra: {
        PATH: '',
        SCOOP: '',
        VOLTA_HOME: '',
        NVM_HOME: '',
        NVM_SYMLINK: '',
        NVM_DIR: '',
        npm_config_prefix: '',
        AGENTBUS_CODEX_BIN: path.join(RUN_BASE, 'does-not-exist-codex.exe'),
        AGENTBUS_CLAUDE_BIN: '',
        AGENTBUS_GEMINI_BIN: '',
        AGENTBUS_ANTIGRAVITY_BIN: '',
        AGENTBUS_OPENCODE_BIN: '',
      },
    });
    const docCodex65 = (docMissing.json?.clients || []).find((c) => c.id === 'codex');
    const docClaude65 = (docMissing.json?.clients || []).find((c) => c.id === 'claude');
    const setupReqDir = runCli(['setup', '--client', 'codex', '--home', diagHome, '--require-config-dir'], { root: diagRoot, allowed: diagRoot });

    // 65c: permission denied (read-only config file)
    const roCfg = path.join(diagHome, '.claude.json');
    fs.writeFileSync(roCfg, JSON.stringify({ mcpServers: {} }) + '\n', 'utf8');
    let setupPerm;
    let docPerm;
    try {
      fs.chmodSync(roCfg, 0o444);
      setupPerm = runCli(['setup', '--client', 'claude', '--home', diagHome], { root: diagRoot, allowed: diagRoot });
      docPerm = runCli(['doctor', '--home', diagHome], { root: diagRoot, allowed: diagRoot });
    } finally {
      try { fs.chmodSync(roCfg, 0o666); } catch {}
    }
    const docPermClaude = (docPerm?.json?.clients || []).find((c) => c.id === 'claude');
    const codexHasEnvErr = (docCodex65?.issues || []).some((i) => i.code === 'env_bin_not_found' && Boolean(i.next));
    const codexHasMissingDir = (docCodex65?.issues || []).some((i) => i.code === 'missing_config_dir' && String(i.next || '').includes('setup --client codex'));
    const claudeHasMissingBin = (docClaude65?.issues || []).some((i) => i.code === 'missing_binary' && String(i.next || '').includes('AGENTBUS_CLAUDE_BIN'));
    const reqDirFailed = setupReqDir.rc === 1 && setupReqDir.json?.results?.[0]?.error_code === 'missing_config_dir' && Boolean(setupReqDir.json?.results?.[0]?.next);
    const permSetupFailed = setupPerm?.rc === 1 && setupPerm?.json?.results?.[0]?.error_code === 'permission_denied' && Boolean(setupPerm?.json?.results?.[0]?.next);
    const permDocDetected = docPermClaude?.writable === false && (docPermClaude?.issues || []).some((i) => i.code === 'permission_denied' && Boolean(i.next));
    assertCase(65, '失败可诊断：缺二进制 / 缺配置目录 / 权限不足均返回明确 error_code 与可执行 next',
      codexHasEnvErr && codexHasMissingDir && claudeHasMissingBin && reqDirFailed && permSetupFailed && permDocDetected,
      JSON.stringify({ codexHasEnvErr, codexHasMissingDir, claudeHasMissingBin, reqDirFailed, permSetupFailed, permDocDetected }));

    // 68. claim 返回完整任务信封（goal 原文逐字一致，含双引号/反斜杠/换行/中文/${} + constraints/refs/acceptance）
    const nastyGoal = [
      '修复 "Clash Verge" 规则解析：',
      '路径 C:\\Users\\test\\规则\\config.yaml',
      '模板变量 ${HTTP_PORT} 与反引号 `echo ok`',
      '第二行：保持兼容性。',
    ].join('\n');
    const goalRefFile = path.join(WORK_DIR, 'goal_ref_68.txt');
    fs.writeFileSync(goalRefFile, 'secret ref content should not appear in claim\n', 'utf8');
    const putRef68 = runCli(['put', goalRefFile, '--by', 'hermes']);
    const t68Cli = runCli([
      'new', '--to', 'codex', '--from', 'hermes', '--goal', nastyGoal,
      '--ref', `${putRef68.json?.sha256}:spec note`,
      '--constraint', 'no external network', '--accept', 'json=true',
    ]);
    const t68CliId = t68Cli.json?.id;
    const claim68Cli = runCli(['claim', t68CliId, '--by', 'codex']);
    const t68Mcp = runCli([
      'new', '--to', 'antigravity', '--from', 'hermes', '--goal', nastyGoal,
      '--ref', putRef68.json?.sha256, '--constraint', 'keep order', '--accept', 'min_bytes=2',
    ]);
    const t68McpId = t68Mcp.json?.id;
    const mcpClaimSess = await runMcpSession(ROOT_MAIN, ALLOWED_MAIN, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claim68', version: '1.0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bus_task_claim', arguments: { id: t68McpId, by: 'antigravity' } } },
    ], { AGENTBUS_ROLE: 'worker' });
    const claim68Mcp = mcpClaimSess.responses.find((r) => r.id === 2)?.result?.structuredContent;
    const db68 = new DatabaseSync(path.join(ROOT_MAIN, 'agentbus.db'));
    let dbGoal68 = '';
    try { dbGoal68 = db68.prepare('SELECT goal FROM tasks WHERE id = ?').get(t68CliId)?.goal || ''; } finally { db68.close(); }
    const refs68Clean = Array.isArray(claim68Mcp?.refs) && claim68Mcp.refs.length === 1 &&
      !('content' in claim68Mcp.refs[0]) && Boolean(claim68Mcp.refs[0].sha256);
    assertCase(68, 'claim（CLI 与 MCP）返回完整任务信封，goal 含引号/反斜杠/换行/中文/${} 与 DB 逐字一致',
      claim68Cli.rc === 0 &&
      claim68Cli.json?.goal === dbGoal68 &&
      claim68Cli.json?.goal === nastyGoal &&
      claim68Mcp?.goal === nastyGoal &&
      claim68Mcp?.from === 'hermes' &&
      Boolean(claim68Mcp?.created_at) &&
      typeof claim68Mcp?.attempt === 'number' &&
      Array.isArray(claim68Mcp?.constraints) && claim68Mcp.constraints[0] === 'keep order' &&
      claim68Mcp?.acceptance?.min_bytes === '2' &&
      refs68Clean,
      `cliMatch=${claim68Cli.json?.goal === nastyGoal} mcpMatch=${claim68Mcp?.goal === nastyGoal} refsClean=${refs68Clean}`);

    // 69. dispatch prompt 为短指针（不含 goal 正文、长度受控）+ fake agentapi 完整接收 argv 不截断
    const { buildPrompt, dispatchTask, waitForTask } = await import('../src/dispatch.js');
    const shortPrompt = buildPrompt(t68McpId, 'antigravity', WORK_DIR);
    const agyBase69 = path.join(RUN_BASE, 'fake_agy_69');
    fs.mkdirSync(agyBase69, { recursive: true });
    const agyArgvOut69 = path.join(agyBase69, 'captured_argv.json');
    const agyHelperJs69 = path.join(agyBase69, 'fake_agentapi_impl.mjs');
    fs.writeFileSync(agyHelperJs69, [
      "import { execFileSync } from 'node:child_process';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const argv = process.argv.slice(2);",
      "const sub = argv[0];",
      "if (sub === 'new-conversation') {",
      "  fs.writeFileSync(process.env.FAKE_AGY_ARGV_OUT, JSON.stringify(argv), 'utf8');",
      "  const promptArg = argv[argv.length - 1] || '';",
      "  const tid = (promptArg.match(/id=([A-Za-z0-9_-]+)/) || [])[1];",
      "  const env = { ...process.env, AGENTBUS_ALLOWED_ROOTS: process.env.AGENTBUS_FAKE_ALLOWED };",
      "  const run = (a) => execFileSync(process.execPath, [process.env.AGENTBUS_FAKE_BIN, ...a, '--root', process.env.AGENTBUS_FAKE_ROOT], { env, encoding: 'utf8' });",
      "  const claim = JSON.parse(run(['claim', tid, '--by', 'antigravity']));",
      "  const out = path.join(process.env.AGENTBUS_FAKE_WORK, 'agy69_' + tid + '.json');",
      "  fs.writeFileSync(out, JSON.stringify({ goal_len: claim.goal.length, got_clash: claim.goal.includes('Clash Verge') }), 'utf8');",
      "  run(['done', tid, '--by', 'antigravity', '--lease', claim.lease_token, '--result', out]);",
      "  console.log(JSON.stringify({ conversationId: 'conv-69-ok' }));",
      "} else if (sub === 'send-message') {",
      "  console.log(JSON.stringify({ ok: true }));",
      "}",
    ].join('\n'), 'utf8');
    const agyBin69 = path.join(agyBase69, process.platform === 'win32' ? 'agentapi.bat' : 'agentapi');
    if (process.platform === 'win32') {
      fs.writeFileSync(agyBin69, `@echo off\r\n"${process.execPath}" "%~dp0fake_agentapi_impl.mjs" %*\r\n`, 'utf8');
    } else {
      fs.writeFileSync(agyBin69, `#!/bin/sh\nexec "${process.execPath}" "${agyHelperJs69}" "$@"\n`, { mode: 0o755 });
    }
    const agySess69 = path.join(agyBase69, 'antigravity-session.json');
    fs.writeFileSync(agySess69, JSON.stringify({ ls_address: 'http://127.0.0.1:19999', csrf_token: 'tok-69' }), 'utf8');
    const t69Id = runCli(['new', '--to', 'antigravity', '--from', 'hermes', '--goal', nastyGoal]).json?.id;
    const d69 = runCli(['dispatch', t69Id, '--allow-dispatch', '--wait', '15', '--cwd', WORK_DIR], {
      envExtra: {
        AGENTBUS_ANTIGRAVITY_BIN: agyBin69,
        AGENTBUS_AGY_SESSION: agySess69,
        FAKE_AGY_ARGV_OUT: agyArgvOut69,
        AGENTBUS_FAKE_BIN: BUS_BIN,
        AGENTBUS_FAKE_ROOT: ROOT_MAIN,
        AGENTBUS_FAKE_WORK: OUT_DIR,
        AGENTBUS_FAKE_ALLOWED: ALLOWED_MAIN,
      },
    });
    const capturedArgv69 = fs.existsSync(agyArgvOut69) ? JSON.parse(fs.readFileSync(agyArgvOut69, 'utf8')) : [];
    const sentPrompt69 = String(capturedArgv69[capturedArgv69.length - 1] || '');
    assertCase(69, 'dispatch prompt 为短指针且不含 goal 正文；fake agentapi.bat 完整接收 argv 不截断',
      shortPrompt.length <= 600 &&
      shortPrompt.includes(t68McpId) &&
      shortPrompt.includes('bus_task_claim') &&
      !shortPrompt.includes('Clash Verge') &&
      !shortPrompt.includes('`') &&
      d69.rc === 0 &&
      d69.json?.state === 'done' &&
      Array.isArray(capturedArgv69) && capturedArgv69[0] === 'new-conversation' &&
      sentPrompt69.includes(`id=${t69Id}`) &&
      sentPrompt69.includes('bus_task_claim') &&
      !sentPrompt69.includes('Clash Verge') &&
      !sentPrompt69.includes('`') &&
      Array.isArray(d69.json?.messages) &&
      typeof d69.json?.blocked === 'boolean',
      `len=${shortPrompt.length} d69=${d69.json?.state} argv0=${capturedArgv69[0]} prompt=${sentPrompt69.slice(0, 120)}`);

    // 70. 双向消息闭环：worker blocked(需 lease) -> show/list 反映 -> master answer(无需 lease) -> unblock -> inbox/mark_read
    const t70Id = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'msg-roundtrip']).json?.id;
    const claim70 = runCli(['claim', t70Id, '--by', 'codex']);
    const lease70 = claim70.json?.lease_token;
    const noLeaseMsg = runCli(['message', t70Id, '--by', 'codex', '--kind', 'blocked', '--body', 'no lease attempt']);
    const msgSess = await runMcpSession(ROOT_MAIN, ALLOWED_MAIN, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'msg70', version: '1.0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bus_task_message', arguments: { id: t70Id, by: 'codex', kind: 'blocked', body: 'need port config', lease_token: lease70 } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bus_task_inbox', arguments: { id: t70Id, for_agent: 'codex' } } },
    ], { AGENTBUS_ROLE: 'worker' });
    const blkRes70 = msgSess.responses.find((r) => r.id === 2)?.result?.structuredContent;
    const workerSelfInbox70 = msgSess.responses.find((r) => r.id === 3)?.result?.structuredContent;
    const showBlocked70 = runCli(['show', t70Id]);
    const listBlocked70 = runCli(['list', '--limit', '20']);
    const listEntry70 = (listBlocked70.json || []).find((x) => x.id === t70Id);
    const ansRes70 = runCli(['message', t70Id, '--by', 'hermes', '--kind', 'answer', '--body', 'use port 7890']);
    const workerInboxAfterAns = runCli(['inbox', t70Id, '--for', 'codex', '--mark-read']);
    const workerInboxSince = runCli(['inbox', t70Id, '--for', 'codex', '--since', String(workerInboxAfterAns.json?.last_seq || 0)]);
    const conductorInboxAll = runCli(['inbox', t70Id]);
    const envRaw70 = fs.readFileSync(path.join(ROOT_MAIN, 'tasks', `${t70Id}.json`), 'utf8');
    assertCase(70, '双向消息闭环：worker blocked 需 lease -> show/list 反映 -> master answer 解阻 -> inbox 过滤与 mark_read',
      noLeaseMsg.rc === 2 &&
      blkRes70?.blocked === true && Boolean(blkRes70?.blocked_at) &&
      (workerSelfInbox70?.messages || []).length === 0 &&
      showBlocked70.json?.blocked === true && Boolean(showBlocked70.json?.blocked_at) &&
      showBlocked70.json?.last_message?.kind === 'blocked' &&
      listEntry70?.blocked === true && listEntry70?.last_message?.body?.includes('need port config') &&
      ansRes70.rc === 0 && ansRes70.json?.blocked === false && ansRes70.json?.blocked_at === null &&
      (workerInboxAfterAns.json?.messages || []).length === 1 &&
      workerInboxAfterAns.json.messages[0].body === 'use port 7890' &&
      Boolean(workerInboxAfterAns.json.messages[0].read_at) &&
      (workerInboxSince.json?.messages || []).length === 0 &&
      (conductorInboxAll.json?.messages || []).length === 2 &&
      !envRaw70.includes('need port config'),
      `noLeaseRc=${noLeaseMsg.rc} blk=${blkRes70?.blocked} ansBlk=${ansRes70.json?.blocked} wInbox=${workerInboxAfterAns.json?.messages?.length} cInbox=${conductorInboxAll.json?.messages?.length}`);

    // 71. bus_task_wait 在新 question 消息出现时提前返回（不等满 timeout）
    const t71Id = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'wait-early-return']).json?.id;
    const claim71 = runCli(['claim', t71Id, '--by', 'codex']);
    const waitBus71 = openBus({ rootOverride: ROOT_MAIN });
    let waitRes71;
    const waitStart71 = Date.now();
    try {
      setTimeout(() => {
        runCli(['message', t71Id, '--by', 'codex', '--kind', 'question', '--body', 'which branch?', '--lease', claim71.json?.lease_token]);
      }, 250);
      waitRes71 = await waitForTask(waitBus71, t71Id, 10, 100);
    } finally {
      waitBus71.close();
    }
    const waitElapsed71 = Date.now() - waitStart71;
    assertCase(71, 'bus_task_wait 在新 question 消息出现时提前返回（needs_attention=true, blocked=true）',
      waitElapsed71 < 5000 &&
      waitRes71?.needs_attention === true &&
      waitRes71?.blocked === true &&
      waitRes71?.state === 'claimed' &&
      (waitRes71?.messages || []).some((m) => m.kind === 'question' && m.body === 'which branch?'),
      `elapsed=${waitElapsed71}ms attention=${waitRes71?.needs_attention} blocked=${waitRes71?.blocked} state=${waitRes71?.state}`);

    // 72. bus_task_fail 写入 error 消息；dispatch 非零退出写入 error 消息并保留 stderr_tail
    const t72FailId = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'fail-feedback']).json?.id;
    const claim72 = runCli(['claim', t72FailId, '--by', 'codex']);
    const failRes72 = runCli(['fail', t72FailId, '--by', 'codex', '--lease', claim72.json?.lease_token, '--reason', 'dependency missing xyz']);
    const failInbox72 = runCli(['inbox', t72FailId]);
    const crashAgent72 = path.join(RUN_BASE, 'crash_agent_72.mjs');
    fs.writeFileSync(crashAgent72, "console.error('boom fatal crash 72'); process.exit(2);\n", 'utf8');
    const t72DispId = runCli(['new', '--to', 'fake', '--from', 'hermes', '--goal', 'dispatch-fail-feedback']).json?.id;
    const dispBus72 = openBus({ rootOverride: ROOT_MAIN });
    let d72;
    try {
      d72 = await dispatchTask(dispBus72, {
        id: t72DispId,
        cwd: WORK_DIR,
        wait_s: 5,
        env: fakeAdapterEnv('unused', { script: crashAgent72 }),
      });
      dispBus72.db.prepare("UPDATE agent_health SET cooldown_until = NULL, reason = NULL WHERE agent = 'fake'").run();
    } finally {
      dispBus72.close();
    }
    const dispInbox72 = runCli(['inbox', t72DispId]);
    assertCase(72, 'bus_task_fail 与 dispatch 非零退出均写入 kind=error 消息并保留 stderr_tail',
      failRes72.rc === 0 &&
      (failInbox72.json?.messages || []).some((m) => m.kind === 'error' && m.body.includes('dependency missing xyz')) &&
      d72?.dispatched === true &&
      d72?.blocked === true &&
      String(d72?.stderr_tail || '').includes('boom fatal crash 72') &&
      (d72?.messages || []).some((m) => m.kind === 'error' && m.body.includes('boom fatal crash 72')) &&
      (dispInbox72.json?.messages || []).some((m) => m.kind === 'error'),
      `failMsgs=${failInbox72.json?.messages?.length} d72Blk=${d72?.blocked} d72Msgs=${d72?.messages?.length}`);

    // 73. 旧库迁移：无 task_messages 表与 blocked_at/last_message_at 列的旧库可自动迁移并正常读写
    const migRoot = path.join(RUN_BASE, 'legacy_migrate_73');
    fs.mkdirSync(migRoot, { recursive: true });
    const legacyDbPath = path.join(migRoot, 'agentbus.db');
    const oldDb = new DatabaseSync(legacyDbPath);
    oldDb.exec(`
      CREATE TABLE artifacts (sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL, uri TEXT NOT NULL, name TEXT NOT NULL, mime TEXT, registered_by TEXT NOT NULL, registered_at TEXT NOT NULL, mtime TEXT NOT NULL);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, schema TEXT NOT NULL DEFAULT 'agentbus/task@1', from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
        state TEXT NOT NULL, goal TEXT NOT NULL, constraints_json TEXT NOT NULL, refs_json TEXT NOT NULL, acceptance_json TEXT NOT NULL,
        claimed_by TEXT, lease_token TEXT, lease_expires_at TEXT, attempt INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT,
        created_at TEXT NOT NULL, finished_at TEXT, result_json TEXT, history_json TEXT NOT NULL
      );
      CREATE TABLE threads (agent TEXT NOT NULL, name TEXT NOT NULL, session_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (agent, name));
      CREATE TABLE agent_health (agent TEXT PRIMARY KEY, cooldown_until TEXT, reason TEXT, fails INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, task_id TEXT, event TEXT NOT NULL, payload_json TEXT NOT NULL);
      INSERT INTO tasks VALUES ('tlegacy73', 'agentbus/task@1', 'hermes', 'codex', 'open', 'legacy goal "quoted"', '[]', '[]', '{}', NULL, NULL, NULL, 0, NULL, '2026-11-24T00:00:00.000Z', NULL, NULL, '[]');
    `);
    oldDb.close();
    const migList = runCli(['list', '--limit', '10'], { root: migRoot, allowed: migRoot });
    const migClaim = runCli(['claim', 'tlegacy73', '--by', 'codex'], { root: migRoot, allowed: migRoot });
    const migMsg = runCli(['message', 'tlegacy73', '--by', 'codex', '--kind', 'progress', '--body', 'migrated ok', '--lease', migClaim.json?.lease_token], { root: migRoot, allowed: migRoot });
    const migInbox = runCli(['inbox', 'tlegacy73'], { root: migRoot, allowed: migRoot });
    assertCase(73, '旧库自动迁移：缺失 task_messages 与 blocked_at/last_message_at 列可无缝迁移并操作',
      migList.rc === 0 && migList.json?.length === 1 &&
      migClaim.rc === 0 && migClaim.json?.goal === 'legacy goal "quoted"' &&
      migMsg.rc === 0 && (migInbox.json?.messages || []).length === 1,
      `listRc=${migList.rc} claimRc=${migClaim.rc} msgRc=${migMsg.rc} inbox=${migInbox.json?.messages?.length}`);

    // 74. DSH YAML 块插入/幂等/保留其他内容/结构解析通过 + --role/--allow-dispatch
    const dshHome74 = path.join(RUN_BASE, 'dsh_home_74');
    const dshAllow74 = path.join(RUN_BASE, 'dsh allow 74');
    const dshRoot74 = path.join(RUN_BASE, 'dsh root 74');
    fs.mkdirSync(dshAllow74, { recursive: true });
    const dshCfg74 = path.join(dshHome74, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
    fs.mkdirSync(path.dirname(dshCfg74), { recursive: true });
    const dshSeed74 = [
      '# user custom comment',
      '- insert:',
      '    - id: keep-plugin',
      "      name: '@example/keep-plugin'",
      '      config:',
      '        enabled: true',
      '',
    ].join('\n');
    fs.writeFileSync(dshCfg74, dshSeed74, 'utf8');

    const dshRun1 = runCli([
      'setup', '--client', 'dsh', '--home', dshHome74, '--allow', dshAllow74,
      '--role', 'conductor', '--allow-dispatch',
    ], { root: dshRoot74, allowed: dshAllow74 });
    const dshRun2 = runCli([
      'setup', '--client', 'dsh', '--home', dshHome74, '--allow', dshAllow74,
      '--role', 'conductor', '--allow-dispatch',
    ], { root: dshRoot74, allowed: dshAllow74 });
    const dshText74 = fs.readFileSync(dshCfg74, 'utf8');

    // Strict self-contained YAML validator for Cordis patch sequence
    function parseCordisPatchYaml(yamlText) {
      const lines = yamlText.replace(/\r\n/g, '\n').split('\n');
      const items = [];
      let curInsert = null;
      let curNode = null;
      let inConfig = false;
      let inEnv = false;
      const parseScalar = (raw) => {
        const s = raw.trim();
        if (s === 'true') return true;
        if (s === 'false') return false;
        if (s.startsWith('"')) return JSON.parse(s);
        if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1);
        if (s.startsWith('[') && s.endsWith(']')) return JSON.parse(s);
        return s;
      };
      for (let idx = 0; idx < lines.length; idx++) {
        const raw = lines[idx];
        if (!raw.trim() || raw.trim().startsWith('#')) continue;
        if (raw.includes('\t')) throw new Error(`Tab indent on line ${idx + 1}`);
        const indent = raw.length - raw.trimStart().length;
        const t = raw.trim();
        if (indent === 0 && t === '- insert:') {
          curInsert = [];
          items.push({ insert: curInsert });
          curNode = null;
          inConfig = false;
          inEnv = false;
          continue;
        }
        if (indent === 4 && t.startsWith('- id:') && curInsert) {
          curNode = { id: parseScalar(t.slice(5)), config: {} };
          curInsert.push(curNode);
          inConfig = false;
          inEnv = false;
          continue;
        }
        if (indent === 6 && curNode) {
          const ci = t.indexOf(':');
          if (ci < 1) throw new Error(`Invalid line ${idx + 1}: ${raw}`);
          const k = t.slice(0, ci).trim();
          const v = t.slice(ci + 1).trim();
          if (k === 'config' && !v) { inConfig = true; inEnv = false; }
          else { curNode[k] = parseScalar(v); inConfig = false; inEnv = false; }
          continue;
        }
        if (indent === 8 && curNode && inConfig) {
          const ci = t.indexOf(':');
          if (ci < 1) throw new Error(`Invalid config line ${idx + 1}: ${raw}`);
          const k = t.slice(0, ci).trim();
          const v = t.slice(ci + 1).trim();
          if (k === 'env' && !v) { curNode.config.env = {}; inEnv = true; }
          else { curNode.config[k] = parseScalar(v); inEnv = false; }
          continue;
        }
        if (indent === 10 && curNode && inConfig && inEnv) {
          const ci = t.indexOf(':');
          if (ci < 1) throw new Error(`Invalid env line ${idx + 1}: ${raw}`);
          const k = t.slice(0, ci).trim();
          const v = t.slice(ci + 1).trim();
          curNode.config.env[k] = parseScalar(v);
          continue;
        }
        throw new Error(`Unexpected YAML structure at line ${idx + 1} (indent=${indent}): ${raw}`);
      }
      return items;
    }

    let dshParsed74 = [];
    let dshYamlOk = false;
    try {
      dshParsed74 = parseCordisPatchYaml(dshText74);
      dshYamlOk = true;
    } catch { dshYamlOk = false; }
    const dshAllNodes = dshParsed74.flatMap((x) => x.insert || []);
    const dshKeepNode = dshAllNodes.find((n) => n.id === 'keep-plugin');
    const dshBusNode = dshAllNodes.find((n) => n.id === 'agentbus-mcp');

    // Also test unknown role falls back to worker & dispatch=0
    const dshUnknownRole = runCli([
      'setup', '--client', 'dsh', '--home', dshHome74, '--allow', dshAllow74, '--role', 'superadmin',
    ], { root: dshRoot74, allowed: dshAllow74 });
    const dshParsedFallback = parseCordisPatchYaml(fs.readFileSync(dshCfg74, 'utf8'));
    const dshFallbackBus = dshParsedFallback.flatMap((x) => x.insert || []).find((n) => n.id === 'agentbus-mcp');

    assertCase(74, 'DSH YAML 块插入/幂等/保留已有插件/结构解析通过 + --role/--allow-dispatch 回落校验',
      dshRun1.rc === 0 &&
      dshRun1.json?.results?.[0]?.changed === true &&
      dshRun1.json?.results?.[0]?.restart_required === true &&
      Boolean(dshRun1.json?.results?.[0]?.backup && fs.existsSync(dshRun1.json.results[0].backup)) &&
      dshRun2.rc === 0 &&
      dshRun2.json?.results?.[0]?.changed === false &&
      dshRun2.json?.results?.[0]?.backup === null &&
      dshYamlOk &&
      dshText74.includes('# user custom comment') &&
      dshText74.includes('# BEGIN agentbus-managed') &&
      dshText74.includes('# END agentbus-managed') &&
      dshKeepNode?.name === '@example/keep-plugin' &&
      dshKeepNode?.config?.enabled === true &&
      dshBusNode?.name === '@deepseek-ai/dsh-mcp-client' &&
      dshBusNode?.config?.transport === 'stdio' &&
      dshBusNode?.config?.serverName === 'agentbus' &&
      Array.isArray(dshBusNode?.config?.args) &&
      dshBusNode?.config?.env?.AGENTBUS_ROOT === path.resolve(dshRoot74) &&
      dshBusNode?.config?.env?.AGENTBUS_ALLOWED_ROOTS === path.resolve(dshAllow74) &&
      dshBusNode?.config?.env?.AGENTBUS_ROLE === 'conductor' &&
      dshBusNode?.config?.env?.AGENTBUS_ENABLE_DISPATCH === '1' &&
      dshUnknownRole.rc === 0 &&
      dshFallbackBus?.config?.env?.AGENTBUS_ROLE === 'worker' &&
      dshFallbackBus?.config?.env?.AGENTBUS_ENABLE_DISPATCH === '0',
      `r1=${dshRun1.rc}/${dshRun1.json?.results?.[0]?.changed} r2=${dshRun2.rc}/${dshRun2.json?.results?.[0]?.changed} yamlOk=${dshYamlOk}`);

    // 75. Hermes mock CLI：参数顺序/stdin y\n/HERMES_HOME 隔离/mcp list 校验/已存在跳过/失败回滚
    const hermesBase75 = path.join(RUN_BASE, 'hermes_test_75');
    fs.mkdirSync(hermesBase75, { recursive: true });
    const fakeHermesJs = path.join(hermesBase75, 'fake_hermes.mjs');
    const hermesCallLog = path.join(hermesBase75, 'calls.jsonl');
    fs.writeFileSync(fakeHermesJs, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const argv = process.argv.slice(2);",
      "const stdinData = fs.readFileSync(0, 'utf8');",
      "const hHome = process.env.HERMES_HOME || '';",
      "const logPath = process.env.FAKE_HERMES_LOG;",
      "fs.appendFileSync(logPath, JSON.stringify({ argv, hermesHome: hHome, stdin: stdinData }) + '\\n', 'utf8');",
      "const mode = process.env.FAKE_HERMES_MODE || 'ok';",
      "const cfgPath = path.join(hHome, 'config.yaml');",
      "if (argv[0] === 'mcp' && argv[1] === 'add') {",
      "  if (mode === 'fail') {",
      "    fs.mkdirSync(hHome, { recursive: true });",
      "    fs.writeFileSync(cfgPath, 'corrupted_partial: true\\n', 'utf8');",
      "    console.error('simulated hermes add failure');",
      "    process.exit(1);",
      "  }",
      "  if (mode === 'cancel') {",
      "    console.log('Cancelled.');",
      "    process.exit(0);",
      "  }",
      "  if (!stdinData.includes('y')) {",
      "    console.log('Cancelled.');",
      "    process.exit(0);",
      "  }",
      "  fs.mkdirSync(hHome, { recursive: true });",
      "  const prev = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';",
      "  const next = (prev ? prev.trimEnd() + '\\n' : '') + 'mcp_servers:\\n  agentbus:\\n    command: node\\n';",
      "  fs.writeFileSync(cfgPath, next, 'utf8');",
      "  console.log('Added agentbus');",
      "  process.exit(0);",
      "}",
      "if (argv[0] === 'mcp' && argv[1] === 'list') {",
      "  if (mode === 'miss_list') {",
      "    console.log('No MCP servers');",
      "    process.exit(0);",
      "  }",
      "  const txt = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';",
      "  if (/\\bagentbus\\s*:/.test(txt)) console.log('agentbus (stdio)');",
      "  else console.log('No MCP servers');",
      "  process.exit(0);",
      "}",
      "process.exit(1);",
    ].join('\n'), 'utf8');
    const fakeHermesBin = path.join(hermesBase75, process.platform === 'win32' ? 'hermes.cmd' : 'hermes');
    if (process.platform === 'win32') {
      fs.writeFileSync(fakeHermesBin, `@echo off\r\n"${process.execPath}" "%~dp0fake_hermes.mjs" %*\r\n`, 'utf8');
    } else {
      fs.writeFileSync(fakeHermesBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeHermesJs}" "$@"\n`, { mode: 0o755 });
    }
    const hermesHome75a = path.join(hermesBase75, 'fake home 75a');
    const hermesHome75b = path.join(hermesBase75, 'fake home 75b');
    const hermesRoot75 = path.join(hermesBase75, 'root75');
    const hermesAllow75 = path.join(hermesBase75, 'allow75');
    fs.mkdirSync(hermesAllow75, { recursive: true });

    const hermesAddRes = runCli([
      'setup', '--client', 'hermes', '--home', hermesHome75a, '--allow', hermesAllow75,
    ], {
      root: hermesRoot75,
      allowed: hermesAllow75,
      envExtra: { AGENTBUS_HERMES_BIN: fakeHermesBin, FAKE_HERMES_LOG: hermesCallLog },
    });
    const hermesSkipRes = runCli([
      'setup', '--client', 'hermes', '--home', hermesHome75a, '--allow', hermesAllow75,
    ], {
      root: hermesRoot75,
      allowed: hermesAllow75,
      envExtra: { AGENTBUS_HERMES_BIN: fakeHermesBin, FAKE_HERMES_LOG: hermesCallLog },
    });

    // Rollback test on pre-existing config.yaml
    const hermesSeedDir75b = path.join(hermesHome75b, '.hermes');
    fs.mkdirSync(hermesSeedDir75b, { recursive: true });
    const hermesCfg75b = path.join(hermesSeedDir75b, 'config.yaml');
    const hermesOrig75b = 'mcp_servers:\n  keep_other:\n    command: echo\n';
    fs.writeFileSync(hermesCfg75b, hermesOrig75b, 'utf8');
    const hermesFailRes = runCli([
      'setup', '--client', 'hermes', '--home', hermesHome75b, '--allow', hermesAllow75,
    ], {
      root: hermesRoot75,
      allowed: hermesAllow75,
      envExtra: { AGENTBUS_HERMES_BIN: fakeHermesBin, FAKE_HERMES_LOG: hermesCallLog, FAKE_HERMES_MODE: 'fail' },
    });

    const hermesCalls = fs.existsSync(hermesCallLog)
      ? fs.readFileSync(hermesCallLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const addCalls75a = hermesCalls.filter((c) => c.argv[0] === 'mcp' && c.argv[1] === 'add' && c.hermesHome === path.join(hermesHome75a, '.hermes'));
    const listCalls75a = hermesCalls.filter((c) => c.argv[0] === 'mcp' && c.argv[1] === 'list' && c.hermesHome === path.join(hermesHome75a, '.hermes'));
    const firstAddArgv = addCalls75a[0]?.argv || [];
    const argsFlagIdx = firstAddArgv.indexOf('--args');
    const cmdFlagIdx = firstAddArgv.indexOf('--command');
    const envFlagIdx = firstAddArgv.indexOf('--env');

    assertCase(75, 'Hermes mock CLI：参数/--args 末位/stdin y\\n/HERMES_HOME 隔离/mcp list 校验/已存在跳过/失败回滚',
      hermesAddRes.rc === 0 &&
      hermesAddRes.json?.results?.[0]?.changed === true &&
      hermesAddRes.json?.results?.[0]?.verified_by === 'hermes mcp list' &&
      addCalls75a.length === 1 &&
      listCalls75a.length >= 1 &&
      firstAddArgv[2] === 'agentbus' &&
      envFlagIdx >= 0 && cmdFlagIdx > envFlagIdx && argsFlagIdx > cmdFlagIdx &&
      firstAddArgv.slice(argsFlagIdx + 1).includes('mcp') &&
      addCalls75a[0]?.stdin === 'y\n' &&
      hermesSkipRes.rc === 0 &&
      hermesSkipRes.json?.results?.[0]?.changed === false &&
      hermesFailRes.rc === 1 &&
      hermesFailRes.json?.results?.[0]?.error_code === 'hermes_cli_failed' &&
      fs.readFileSync(hermesCfg75b, 'utf8') === hermesOrig75b,
      `addRc=${hermesAddRes.rc} addCnt=${addCalls75a.length} listCnt=${listCalls75a.length} skipChg=${hermesSkipRes.json?.results?.[0]?.changed} failCode=${hermesFailRes.json?.results?.[0]?.error_code}`);

    // 76. 至少 4 个 JSON 客户端（windsurf/kiro/lmstudio/cline）路径与合并幂等 + Cline VS Code globalStorage
    const jsonHome76 = path.join(RUN_BASE, 'json_clients_76');
    const jsonRoot76 = path.join(RUN_BASE, 'json_root_76');
    const jsonAllow76 = path.join(RUN_BASE, 'json_allow_76');
    fs.mkdirSync(jsonAllow76, { recursive: true });
    const jsonSeeds76 = [
      ['windsurf', path.join(jsonHome76, '.codeium', 'windsurf', 'mcp_config.json')],
      ['kiro', path.join(jsonHome76, '.kiro', 'settings', 'mcp.json')],
      ['lmstudio', path.join(jsonHome76, '.lmstudio', 'mcp.json')],
      ['cline', path.join(jsonHome76, '.cline', 'data', 'settings', 'cline_mcp_settings.json')],
    ];
    for (const [cid, fp] of jsonSeeds76) {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, JSON.stringify({
        keepFlag: cid,
        mcpServers: { existingServer: { command: 'echo', args: [cid] } },
      }, null, 2) + '\n', 'utf8');
    }
    const jsonRun1 = runCli([
      'setup', '--client', 'windsurf', '--client', 'kiro', '--client', 'lmstudio', '--client', 'cline',
      '--home', jsonHome76, '--allow', jsonAllow76,
    ], { root: jsonRoot76, allowed: jsonAllow76 });
    const jsonRun2 = runCli([
      'setup', '--client', 'windsurf', '--client', 'kiro', '--client', 'lmstudio', '--client', 'cline',
      '--home', jsonHome76, '--allow', jsonAllow76,
    ], { root: jsonRoot76, allowed: jsonAllow76 });
    const jsonMergedOk = jsonSeeds76.every(([cid, fp]) => {
      const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const ab = d.mcpServers?.agentbus;
      return d.keepFlag === cid &&
        d.mcpServers?.existingServer?.command === 'echo' &&
        Boolean(ab?.command) &&
        Array.isArray(ab?.args) &&
        ab?.env?.AGENTBUS_ROOT === path.resolve(jsonRoot76) &&
        ab?.env?.AGENTBUS_ROLE === 'worker' &&
        ab?.env?.AGENTBUS_ENABLE_DISPATCH === '0';
    });
    const clineVscHome = path.join(RUN_BASE, 'cline_vsc_76');
    const clineVscExtDir = process.platform === 'win32'
      ? path.join(clineVscHome, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
      : process.platform === 'darwin'
        ? path.join(clineVscHome, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
        : path.join(clineVscHome, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
    fs.mkdirSync(clineVscExtDir, { recursive: true });
    const clineVscDesc = runCli(['setup', '--list', '--home', clineVscHome]).json?.clients?.find((c) => c.id === 'cline');
    assertCase(76, '4 个 JSON 客户端(windsurf/kiro/lmstudio/cline)路径、合并幂等与 Cline VS Code globalStorage 探测',
      jsonRun1.rc === 0 &&
      (jsonRun1.json?.results || []).length === 4 &&
      (jsonRun1.json?.results || []).every((r) => r.ok && r.changed === true && r.backup && fs.existsSync(r.backup)) &&
      jsonRun2.rc === 0 &&
      (jsonRun2.json?.results || []).every((r) => r.ok && r.changed === false && r.backup === null) &&
      jsonMergedOk &&
      clineVscDesc?.installed === true &&
      clineVscDesc?.config === path.join(clineVscExtDir, 'settings', 'cline_mcp_settings.json'),
      `r1=${jsonRun1.rc} r2=${jsonRun2.rc} merged=${jsonMergedOk} clineCfg=${clineVscDesc?.config}`);

    // 77. 未安装可选客户端不创建目录 + doctor 不报致命错误只给 next_steps
    const emptyHome77 = path.join(RUN_BASE, 'empty_optional_77');
    const root77 = path.join(RUN_BASE, 'root_77');
    const allow77 = path.join(RUN_BASE, 'allow_77');
    fs.mkdirSync(emptyHome77, { recursive: true });
    fs.mkdirSync(allow77, { recursive: true });
    const setupEmpty77 = runCli(['setup', '--home', emptyHome77, '--allow', allow77], { root: root77, allowed: allow77 });
    const docEmpty77 = runCli(['doctor', '--home', emptyHome77], { root: root77, allowed: allow77 });
    const optDirs = ['.codeium', '.kiro', '.lmstudio', '.cline', '.dsh', '.hermes'];
    const noOptDirsCreated = optDirs.every((d) => !fs.existsSync(path.join(emptyHome77, d)));
    const optIds77 = ['windsurf', 'kiro', 'lmstudio', 'cline', 'dsh', 'hermes'];
    const docOptOk = optIds77.every((id) => {
      const c = (docEmpty77.json?.clients || []).find((x) => x.id === id);
      const hasDiag = (docEmpty77.json?.diagnostics || []).some((d) => d.target === id);
      const hasNext = (docEmpty77.json?.next_steps || []).some((s) => s.includes(`--client ${id}`));
      return c?.skipped === true && c?.installed === false && (c?.issues || []).length === 0 && !hasDiag && hasNext;
    });
    assertCase(77, '未安装可选客户端 setup 不建目录且跳过，doctor 不报致命错误只给 next_steps',
      setupEmpty77.rc === 0 &&
      noOptDirsCreated &&
      optIds77.every((id) => (setupEmpty77.json?.skipped_optional || []).includes(id)) &&
      docEmpty77.rc === 0 &&
      docOptOk,
      `noDirs=${noOptDirsCreated} skipped=${JSON.stringify(setupEmpty77.json?.skipped_optional)} docOpt=${docOptOk}`);

    // 78. setup --list 只读（目录树与文件 sha256 前后一致）且包含全部 13 个客户端与完整字段
    const listHome78 = path.join(RUN_BASE, 'list_readonly_78');
    fs.mkdirSync(path.join(listHome78, '.kiro', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(listHome78, '.kiro', 'settings', 'mcp.json'), '{"mcpServers":{}}\n', 'utf8');
    const snapTree = (dir) => {
      const out = [];
      const walk = (cur) => {
        for (const ent of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(cur, ent.name);
          if (ent.isDirectory()) { out.push(`D:${path.relative(dir, full)}`); walk(full); }
          else { out.push(`F:${path.relative(dir, full)}:${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`); }
        }
      };
      walk(dir);
      return out.join('\n');
    };
    const snapBefore78 = snapTree(listHome78);
    const listRes78 = runCli(['setup', '--list', '--home', listHome78]);
    const snapAfter78 = snapTree(listHome78);
    const listedClients = listRes78.json?.clients || [];
    const expectedIds78 = ['codex', 'claude', 'gemini', 'antigravity', 'cursor', 'opencode', 'claude-desktop', 'windsurf', 'kiro', 'lmstudio', 'cline', 'dsh', 'hermes'];
    const allFields78 = listedClients.every((c) =>
      typeof c.id === 'string' && typeof c.label === 'string' && typeof c.format === 'string' &&
      typeof c.config === 'string' && typeof c.installed === 'boolean' && typeof c.optional === 'boolean'
    );
    const kiroEntry78 = listedClients.find((c) => c.id === 'kiro');
    const dshEntry78 = listedClients.find((c) => c.id === 'dsh');
    assertCase(78, 'setup --list 严格只读（树与 sha256 前后完全一致）且包含 dsh/hermes/windsurf/kiro/lmstudio/cline',
      listRes78.rc === 0 &&
      snapBefore78 === snapAfter78 &&
      expectedIds78.every((id) => listedClients.some((c) => c.id === id)) &&
      allFields78 &&
      kiroEntry78?.optional === true && kiroEntry78?.installed === true &&
      dshEntry78?.optional === true && dshEntry78?.installed === false,
      `rc=${listRes78.rc} same=${snapBefore78 === snapAfter78} count=${listedClients.length}`);

    // 79. 旧 7 客户端不回归 + 文档完整性校验
    const coreIds79 = ['codex', 'claude', 'gemini', 'antigravity', 'cursor', 'opencode', 'claude-desktop'];
    const coreSetupIds79 = (setupEmpty77.json?.results || []).map((r) => r.client);
    const coreAllConfigured79 = coreIds79.every((id) => {
      const c = (docEmpty77.json?.clients || []).find((x) => x.id === id);
      return c?.configured === true && !c?.config_error;
    });
    const docFiles79 = [
      path.join(PKG_ROOT, 'docs', 'CLIENTS.md'),
      path.join(PKG_ROOT, 'docs', 'PROTOCOL.md'),
      path.join(PKG_ROOT, 'README.md'),
      path.join(PKG_ROOT, 'README.zh-CN.md'),
    ];
    const allDocsExist79 = docFiles79.every((f) => fs.existsSync(f));
    const docContents79 = allDocsExist79 ? docFiles79.map((f) => fs.readFileSync(f, 'utf8')) : [];
    const clientsDoc79 = docContents79[0] || '';
    const protoDoc79 = docContents79[1] || '';
    const readmeEn79 = docContents79[2] || '';
    const readmeZh79 = docContents79[3] || '';
    const noPersonalPref79 = docContents79.every((t) => !/gpt6\.2sol|极高|sk-[A-Za-z0-9]{20,}/.test(t));
    assertCase(79, '旧 7 客户端不回归 + 文档完整性（docs/CLIENTS.md、PROTOCOL.md、README 中英无偏好/密钥泄漏）',
      coreIds79.every((id) => coreSetupIds79.includes(id)) &&
      coreSetupIds79.length === 7 &&
      coreAllConfigured79 &&
      allDocsExist79 &&
      ['dsh', 'hermes', 'windsurf', 'kiro', 'lmstudio', 'cline', 'Trae', 'Qoder', 'CodeBuddy', 'VS Code', 'Zed', 'OpenClaw'].every((k) => clientsDoc79.includes(k)) &&
      clientsDoc79.includes('hermes mcp list') &&
      clientsDoc79.includes('cordis.patch.yml') &&
      protoDoc79.includes('bus_task_message') &&
      protoDoc79.includes('bus_task_inbox') &&
      readmeEn79.includes('docs/CLIENTS.md') &&
      readmeZh79.includes('docs/CLIENTS.md') &&
      noPersonalPref79,
      `setupIds=${JSON.stringify(coreSetupIds79)} configured=${coreAllConfigured79} docs=${allDocsExist79} noPref=${noPersonalPref79}`);

    // 80. Hermes 默认路径解析（Windows AppData/Local/hermes/config.yaml + 回退 .hermes + setup --list）
    const { hermesPaths: resolveHermesPaths, clientConfigFile: resolveCfgFile } = await import('../src/agents.js');
    const { describeClients: describeSetupClients } = await import('../src/setup.js');
    const hermesWin80 = path.join(RUN_BASE, 'hermes_win_80');
    const hermesWinCfg80 = path.join(hermesWin80, 'AppData', 'Local', 'hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(hermesWinCfg80), { recursive: true });
    fs.writeFileSync(hermesWinCfg80, 'mcp_servers:\n  keep: {}\n', 'utf8');

    const hermesEmpty80 = path.join(RUN_BASE, 'hermes_empty_80');
    fs.mkdirSync(hermesEmpty80, { recursive: true });

    const envNoHermes80 = { ...process.env };
    delete envNoHermes80.HERMES_HOME;

    // Direct cross-platform path resolution checks (unified src/agents.js + src/setup.js)
    const winLocalRes80 = resolveHermesPaths(hermesWin80, {
      platform: 'win32',
      explicitHome: false,
      env: { LOCALAPPDATA: path.join(hermesWin80, 'AppData', 'Local') },
    });
    const winCfgFile80 = resolveCfgFile('hermes', hermesWin80, 'win32', {
      explicitHome: false,
      env: { LOCALAPPDATA: path.join(hermesWin80, 'AppData', 'Local') },
    });
    const winFallbackRes80 = resolveHermesPaths(hermesEmpty80, {
      platform: 'win32',
      explicitHome: false,
      env: { LOCALAPPDATA: path.join(hermesEmpty80, 'AppData', 'Local') },
    });
    const posixRes80 = resolveHermesPaths(hermesWin80, { platform: 'linux', explicitHome: false, env: {} });
    const winDescribe80 = describeSetupClients({
      home: hermesWin80,
      platform: 'win32',
      env: {},
    }).find((c) => c.id === 'hermes');

    // CLI setup --list without HERMES_HOME (using --home fake home with AppData/Local/hermes/config.yaml)
    const cliListHome80 = spawnSync(process.execPath, [BUS_BIN, 'setup', '--list', '--home', hermesWin80], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
      env: envNoHermes80,
    });
    let listHomeJson80 = null;
    try { listHomeJson80 = JSON.parse(cliListHome80.stdout); } catch {}
    const listHermesHome80 = listHomeJson80?.clients?.find((c) => c.id === 'hermes');

    let cliEnvDefaultOk80 = true;
    let cliEnvDefaultDetail80 = 'skipped-non-win32';
    if (process.platform === 'win32') {
      const envWinDef80 = {
        ...envNoHermes80,
        HOME: hermesWin80,
        USERPROFILE: hermesWin80,
        LOCALAPPDATA: path.join(hermesWin80, 'AppData', 'Local'),
      };
      const cliListDef80 = spawnSync(process.execPath, [BUS_BIN, 'setup', '--list'], {
        cwd: PKG_ROOT,
        encoding: 'utf8',
        env: envWinDef80,
      });
      let listDefJson80 = null;
      try { listDefJson80 = JSON.parse(cliListDef80.stdout); } catch {}
      const listDefHermes80 = listDefJson80?.clients?.find((c) => c.id === 'hermes');
      cliEnvDefaultOk80 = cliListDef80.status === 0 &&
        listDefHermes80?.installed === true &&
        listDefHermes80?.config === hermesWinCfg80 &&
        listHermesHome80?.installed === true &&
        listHermesHome80?.config === hermesWinCfg80;
      cliEnvDefaultDetail80 = `defInst=${listDefHermes80?.installed} defCfg=${listDefHermes80?.config} homeInst=${listHermesHome80?.installed} homeCfg=${listHermesHome80?.config}`;
    }

    assertCase(80, 'Hermes 默认路径（Windows AppData/Local/hermes/config.yaml + 回退 .hermes + 无 HERMES_HOME setup --list）',
      winLocalRes80.file === hermesWinCfg80 &&
      winCfgFile80 === hermesWinCfg80 &&
      winFallbackRes80.file === path.join(hermesEmpty80, '.hermes', 'config.yaml') &&
      posixRes80.file === path.join(hermesWin80, '.hermes', 'config.yaml') &&
      winDescribe80?.installed === true &&
      winDescribe80?.config === hermesWinCfg80 &&
      cliListHome80.status === 0 &&
      cliEnvDefaultOk80,
      `winFile=${winLocalRes80.file} fallback=${winFallbackRes80.file} desc=${winDescribe80?.installed}:${winDescribe80?.config} ${cliEnvDefaultDetail80}`);

    // 81. Hermes --home 隔离不变（不读写真实配置 sha256，覆盖 HERMES_HOME）且默认不强行注入 HERMES_HOME
    const realHermesCandidates81 = [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'hermes', 'config.yaml') : null,
      path.join(os.homedir(), '.hermes', 'config.yaml'),
      process.env.HERMES_HOME ? path.join(process.env.HERMES_HOME, 'config.yaml') : null,
    ].filter(Boolean);
    const realHashesBefore81 = realHermesCandidates81.map((p) => [p, fs.existsSync(p) ? sha256(p) : null]);

    const hermesTrap81 = path.join(RUN_BASE, 'hermes_trap_81');
    const hermesTrapCfg81 = path.join(hermesTrap81, 'config.yaml');
    fs.mkdirSync(hermesTrap81, { recursive: true });
    const trapOrig81 = 'mcp_servers:\n  trap_only:\n    command: echo\n';
    fs.writeFileSync(hermesTrapCfg81, trapOrig81, 'utf8');

    const hermesIso81 = path.join(RUN_BASE, 'hermes_iso_81');
    const hermesIsoRoot81 = path.join(RUN_BASE, 'hermes_iso_root_81');
    const hermesIsoAllow81 = path.join(RUN_BASE, 'hermes_iso_allow_81');
    fs.mkdirSync(hermesIsoAllow81, { recursive: true });
    if (process.platform === 'win32') {
      const isoLocalCfg81 = path.join(hermesIso81, 'AppData', 'Local', 'hermes', 'config.yaml');
      fs.mkdirSync(path.dirname(isoLocalCfg81), { recursive: true });
      fs.writeFileSync(isoLocalCfg81, 'mcp_servers:\n  keep: {}\n', 'utf8');
    }

    // --home must override HERMES_HOME trap and leave real configs untouched
    const isoList81 = runCli(['setup', '--list', '--home', hermesIso81], {
      root: hermesIsoRoot81,
      allowed: hermesIsoAllow81,
      envExtra: { HERMES_HOME: hermesTrap81 },
    });
    const isoSetup81 = runCli(['setup', '--client', 'hermes', '--home', hermesIso81, '--allow', hermesIsoAllow81], {
      root: hermesIsoRoot81,
      allowed: hermesIsoAllow81,
      envExtra: { HERMES_HOME: hermesTrap81, AGENTBUS_HERMES_BIN: fakeHermesBin, FAKE_HERMES_LOG: hermesCallLog },
    });
    const isoListHermes81 = isoList81.json?.clients?.find((c) => c.id === 'hermes');
    const isoSetupRes81 = isoSetup81.json?.results?.[0];
    const expectedIsoCfg81 = process.platform === 'win32'
      ? path.join(hermesIso81, 'AppData', 'Local', 'hermes', 'config.yaml')
      : path.join(hermesIso81, '.hermes', 'config.yaml');

    // Non---home applyHermes must NOT inject HERMES_HOME into child process env
    const hermesNoHomeBase81 = path.join(RUN_BASE, 'hermes_no_home_81');
    const hermesNoHomeCfg81 = process.platform === 'win32'
      ? path.join(hermesNoHomeBase81, 'AppData', 'Local', 'hermes', 'config.yaml')
      : path.join(hermesNoHomeBase81, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(hermesNoHomeCfg81), { recursive: true });
    fs.writeFileSync(hermesNoHomeCfg81, 'mcp_servers:\n  existing:\n    command: echo\n', 'utf8');
    const noHomeProbeLog81 = path.join(RUN_BASE, 'hermes_no_home_probe_81.jsonl');
    const fakeHermesNoHomeJs81 = path.join(RUN_BASE, 'fake_hermes_nohome_81.mjs');
    fs.writeFileSync(fakeHermesNoHomeJs81, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const argv = process.argv.slice(2);",
      "const hasHermesHome = Object.prototype.hasOwnProperty.call(process.env, 'HERMES_HOME');",
      "fs.appendFileSync(process.env.NOHOME_LOG, JSON.stringify({ argv, hasHermesHome }) + '\\n', 'utf8');",
      "const cfg = process.env.TARGET_CFG_81;",
      "if (argv[0] === 'mcp' && argv[1] === 'add') {",
      "  const prev = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';",
      "  fs.writeFileSync(cfg, prev.trimEnd() + '\\n  agentbus:\\n    command: node\\n', 'utf8');",
      "  process.exit(0);",
      "}",
      "if (argv[0] === 'mcp' && argv[1] === 'list') {",
      "  const txt = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';",
      "  console.log(/\\bagentbus\\s*:/.test(txt) ? 'agentbus (stdio)' : 'No MCP servers');",
      "  process.exit(0);",
      "}",
      "process.exit(1);",
    ].join('\n'), 'utf8');
    const fakeHermesNoHomeBin81 = path.join(RUN_BASE, process.platform === 'win32' ? 'hermes_nohome_81.cmd' : 'hermes_nohome_81');
    if (process.platform === 'win32') {
      fs.writeFileSync(fakeHermesNoHomeBin81, `@echo off\r\n"${process.execPath}" "%~dp0fake_hermes_nohome_81.mjs" %*\r\n`, 'utf8');
    } else {
      fs.writeFileSync(fakeHermesNoHomeBin81, `#!/bin/sh\nexec "${process.execPath}" "${fakeHermesNoHomeJs81}" "$@"\n`, { mode: 0o755 });
    }
    const envNoHome81 = {
      ...process.env,
      HOME: hermesNoHomeBase81,
      USERPROFILE: hermesNoHomeBase81,
      LOCALAPPDATA: path.join(hermesNoHomeBase81, 'AppData', 'Local'),
      AGENTBUS_ALLOWED_ROOTS: hermesIsoAllow81,
      AGENTBUS_HERMES_BIN: fakeHermesNoHomeBin81,
      NOHOME_LOG: noHomeProbeLog81,
      TARGET_CFG_81: hermesNoHomeCfg81,
    };
    delete envNoHome81.HERMES_HOME;
    const noHomeSetup81 = spawnSync(process.execPath, [
      BUS_BIN, 'setup', '--client', 'hermes', '--root', hermesIsoRoot81, '--allow', hermesIsoAllow81,
    ], { cwd: PKG_ROOT, encoding: 'utf8', env: envNoHome81 });
    let noHomeJson81 = null;
    try { noHomeJson81 = JSON.parse(noHomeSetup81.stdout); } catch {}
    const noHomeCalls81 = fs.existsSync(noHomeProbeLog81)
      ? fs.readFileSync(noHomeProbeLog81, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const realHashesUnchanged81 = realHashesBefore81.every(([p, h]) => (fs.existsSync(p) ? sha256(p) : null) === h);

    assertCase(81, 'Hermes --home 隔离（真实配置 sha256 不变且覆盖 HERMES_HOME）与非 --home 不强行注入 HERMES_HOME',
      isoList81.rc === 0 &&
      isoListHermes81?.config === expectedIsoCfg81 &&
      isoSetup81.rc === 0 &&
      isoSetupRes81?.ok === true &&
      isoSetupRes81?.file === expectedIsoCfg81 &&
      fs.readFileSync(hermesTrapCfg81, 'utf8') === trapOrig81 &&
      noHomeSetup81.status === 0 &&
      noHomeJson81?.results?.[0]?.file === hermesNoHomeCfg81 &&
      noHomeJson81?.results?.[0]?.backup && fs.existsSync(noHomeJson81.results[0].backup) &&
      noHomeCalls81.length >= 2 &&
      noHomeCalls81.every((c) => c.hasHermesHome === false) &&
      realHashesUnchanged81,
      `isoCfg=${isoSetupRes81?.file} noHomeRc=${noHomeSetup81.status} noHomeCalls=${JSON.stringify(noHomeCalls81)} realUnchanged=${realHashesUnchanged81}`);

    // 82-83. archive 任务状态闸门：未完成拒绝(rc=2, 不碰 CDP)、dry-run 只读预览、done 放行、--force 才放行批量/ID、自动归档仅限 done
    const tOpen82 = runCli(['new', '--to', 'antigravity', '--from', 'hermes', '--goal', 'archive-guard-open']).json?.id;
    const tClaimed82 = runCli(['new', '--to', 'antigravity', '--from', 'hermes', '--goal', 'archive-guard-claimed']).json?.id;
    runCli(['claim', tClaimed82, '--by', 'antigravity']);
    const tDone83 = runCli(['new', '--to', 'antigravity', '--from', 'hermes', '--goal', 'archive-guard-done']).json?.id;
    const cDone83 = runCli(['claim', tDone83, '--by', 'antigravity']).json;
    const doneResult83 = path.join(OUT_DIR, 'archive_guard_done_83.json');
    fs.writeFileSync(doneResult83, JSON.stringify({ ok: true }), 'utf8');
    runCli(['done', tDone83, '--by', 'antigravity', '--lease', cDone83.lease_token, '--result', doneResult83]);

    let guardCdpRequests = 0;
    let guardCdpClicks = 0;
    const guardCdpServer = httpMod.default.createServer((req, res) => {
      guardCdpRequests += 1;
      if (req.url === '/json') {
        const port = guardCdpServer.address().port;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { type: 'page', title: 'Antigravity - GuardMock', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` },
        ]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    guardCdpServer.on('upgrade', (req, socket) => {
      socket.on('error', () => {});
      const key = req.headers['sec-websocket-key'];
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      let acc = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        while (acc.length >= 2) {
          const opcode = acc[0] & 0x0f;
          const len = acc[1] & 0x7f;
          let offset = 2;
          let payloadLen = len;
          if (len === 126) {
            if (acc.length < 4) return;
            payloadLen = acc.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (acc.length < 10) return;
            payloadLen = Number(acc.readBigUInt64BE(2));
            offset = 10;
          }
          const masked = (acc[1] & 0x80) !== 0;
          const totalLen = offset + (masked ? 4 : 0) + payloadLen;
          if (acc.length < totalLen) return;
          const mask = masked ? acc.subarray(offset, offset + 4) : null;
          const dataStart = masked ? offset + 4 : offset;
          const data = Buffer.from(acc.subarray(dataStart, dataStart + payloadLen));
          acc = acc.subarray(totalLen);
          if (mask) {
            for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
          }
          if (opcode === 0x8) {
            try { socket.end(); } catch {}
            return;
          }
          let reqMsg;
          try { reqMsg = JSON.parse(data.toString('utf8')); } catch { continue; }
          const expr = reqMsg?.params?.expression || '';
          const isDry = expr.includes('const dryRun = true');
          if (!isDry) guardCdpClicks += 1;
          const value = isDry
            ? { ok: true, archived: false, dry_run: true, conversation_id: null, row_text: `agentbus 11-25 ${tDone83}` }
            : { ok: true, archived: true, conversation_id: null, row_text: `agentbus 11-25 ${tDone83}` };
          const respBuf = Buffer.from(JSON.stringify({ id: reqMsg.id, result: { result: { value } } }), 'utf8');
          const header = respBuf.length < 126
            ? Buffer.from([0x81, respBuf.length])
            : Buffer.from([0x81, 126, (respBuf.length >> 8) & 0xff, respBuf.length & 0xff]);
          socket.write(Buffer.concat([header, respBuf]));
        }
      });
    });
    await new Promise((r) => guardCdpServer.listen(0, '127.0.0.1', r));
    const guardMockPort = guardCdpServer.address().port;
    try {
      const openBlockRes = await runCliAsync(['archive', '--title-contains', tOpen82, '--port', String(guardMockPort)]);
      const claimedBlockRes = await runCliAsync(['archive', '--title-contains', tClaimed82, '--port', String(guardMockPort)]);
      const notTaskBlockRes = await runCliAsync(['archive', '--title-contains', 'nonexistent-task-xyz', '--port', String(guardMockPort)]);
      const reqsAfterBlocks = guardCdpRequests;
      const dryOfflineRes = await runCliAsync(['archive', '--title-contains', tClaimed82, '--dry-run']);
      const dryMockRes = await runCliAsync(['archive', '--title-contains', tClaimed82, '--port', String(guardMockPort), '--dry-run']);
      const clicksAfterDry = guardCdpClicks;

      assertCase(82, 'archive 拒绝未完成任务(rc=2, reason=task_not_done, 不碰 CDP)且 --dry-run 可预览并标 would_archive=false',
        openBlockRes.rc === 2 &&
        openBlockRes.json?.ok === false &&
        openBlockRes.json?.archived === false &&
        openBlockRes.json?.reason === 'task_not_done' &&
        openBlockRes.json?.task_id === tOpen82 &&
        openBlockRes.json?.state === 'open' &&
        claimedBlockRes.rc === 2 &&
        claimedBlockRes.json?.reason === 'task_not_done' &&
        claimedBlockRes.json?.task_id === tClaimed82 &&
        claimedBlockRes.json?.state === 'claimed' &&
        claimedBlockRes.stderr.includes('task_not_done') &&
        notTaskBlockRes.rc === 1 &&
        notTaskBlockRes.json?.reason === 'not_a_task' &&
        reqsAfterBlocks === 0 &&
        dryOfflineRes.rc === 0 &&
        dryOfflineRes.json?.ok === true &&
        dryOfflineRes.json?.dry_run === true &&
        dryOfflineRes.json?.would_archive === false &&
        dryOfflineRes.json?.task_id === tClaimed82 &&
        dryOfflineRes.json?.task_state === 'claimed' &&
        dryOfflineRes.json?.reason === 'task_not_done' &&
        dryMockRes.rc === 0 &&
        dryMockRes.json?.would_archive === false &&
        clicksAfterDry === 0,
        `open=${JSON.stringify(openBlockRes.json)} claimed=${JSON.stringify(claimedBlockRes.json)} notTask=${JSON.stringify(notTaskBlockRes.json)} reqs=${reqsAfterBlocks} dry=${JSON.stringify(dryOfflineRes.json)} clicks=${clicksAfterDry}`);

      const doneRes83 = await runCliAsync(['archive', '--title-contains', tDone83, '--port', String(guardMockPort)]);
      const clicksAfterDone = guardCdpClicks;
      const prefixBlocked83 = await runCliAsync(['archive', '--title-prefix', 'agentbus 11-25', '--port', String(guardMockPort)]);
      const convBlocked83 = await runCliAsync(['archive', 'conv-guard-83', '--port', String(guardMockPort)]);
      const clicksAfterForcedBlocks = guardCdpClicks;
      const prefixForced83 = await runCliAsync(['archive', '--title-prefix', 'agentbus 11-25', '--port', String(guardMockPort), '--force']);
      const notTaskForced83 = await runCliAsync(['archive', '--title-contains', 'nonexistent-task-xyz', '--port', String(guardMockPort), '--force']);

      const { maybeArchiveTask } = await import('../src/dispatch.js');
      const bus83 = openBus({ rootOverride: ROOT_MAIN });
      const prevArchEnv83 = process.env.AGENTBUS_ARCHIVE_ON_DONE;
      process.env.AGENTBUS_ARCHIVE_ON_DONE = '1';
      let autoRes83 = 'not-null';
      let autoEvtCount83 = -1;
      try {
        autoRes83 = await maybeArchiveTask(bus83, tClaimed82);
        autoEvtCount83 = bus83.db.prepare(
          "SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND event = 'archive_on_done'"
        ).get(tClaimed82)?.c ?? -1;
      } finally {
        if (prevArchEnv83 === undefined) delete process.env.AGENTBUS_ARCHIVE_ON_DONE;
        else process.env.AGENTBUS_ARCHIVE_ON_DONE = prevArchEnv83;
        bus83.close();
      }

      assertCase(83, 'done 允许归档；--title-prefix/conversation-id 需 --force；maybeArchiveTask 对 claimed 返回 null 且不写事件',
        doneRes83.rc === 0 &&
        doneRes83.json?.ok === true &&
        doneRes83.json?.archived === true &&
        doneRes83.json?.task_id === tDone83 &&
        doneRes83.json?.task_state === 'done' &&
        clicksAfterDone === 1 &&
        prefixBlocked83.rc === 1 &&
        prefixBlocked83.json?.ok === false &&
        prefixBlocked83.json?.reason === 'title_prefix_requires_force' &&
        convBlocked83.rc === 1 &&
        convBlocked83.json?.ok === false &&
        convBlocked83.json?.reason === 'conversation_id_requires_force' &&
        clicksAfterForcedBlocks === 1 &&
        prefixForced83.rc === 0 &&
        prefixForced83.json?.ok === true &&
        prefixForced83.json?.archived === true &&
        prefixForced83.json?.forced === true &&
        notTaskForced83.rc === 0 &&
        notTaskForced83.json?.archived === true &&
        notTaskForced83.json?.forced === true &&
        autoRes83 === null &&
        autoEvtCount83 === 0,
        `done=${JSON.stringify(doneRes83.json)} pfxBlk=${JSON.stringify(prefixBlocked83.json)} convBlk=${JSON.stringify(convBlocked83.json)} pfxFrc=${JSON.stringify(prefixForced83.json)} auto=${JSON.stringify(autoRes83)}:${autoEvtCount83}`);
    } finally {
      guardCdpServer.close();
    }

    // 84-93. Reliability & Recovery suite
    const relRoot = path.join(RUN_BASE, 'rel_bus');
    const relWork = path.join(RUN_BASE, 'rel_work');
    fs.mkdirSync(relRoot, { recursive: true });
    fs.mkdirSync(relWork, { recursive: true });
    const relAllowed = [relRoot, relWork, DEMO_REFS].join(path.delimiter);
    runCli(['init'], { root: relRoot, allowed: relAllowed });

    // 84. recover retry & release
    const t84Id = runCli(['new', '--to', 'antigravity', '--from', 'hermes', '--goal', 'recover-retry-test'], { root: relRoot, allowed: relAllowed }).json?.id;
    const c84 = runCli(['claim', t84Id, '--by', 'antigravity'], { root: relRoot, allowed: relAllowed }).json;
    runCli(['message', t84Id, '--by', 'antigravity', '--kind', 'blocked', '--body', 'stuck on step 1', '--lease', c84.lease_token], { root: relRoot, allowed: relAllowed });
    const retry84 = runCli(['recover', t84Id, '--by', 'hermes', '--action', 'retry', '--reason', 'clear stuck lease'], { root: relRoot, allowed: relAllowed });
    const showAfterRetry84 = runCli(['show', t84Id], { root: relRoot, allowed: relAllowed }).json;
    const inboxAfterRetry84 = runCli(['inbox', t84Id], { root: relRoot, allowed: relAllowed }).json;
    const reclaim84 = runCli(['claim', t84Id, '--by', 'antigravity'], { root: relRoot, allowed: relAllowed });
    const release84 = runCli(['recover', t84Id, '--by', 'hermes', '--action', 'release', '--reason', 'park for later'], { root: relRoot, allowed: relAllowed });
    const relDb84 = new DatabaseSync(path.join(relRoot, 'agentbus.db'));
    const evtRetry84 = relDb84.prepare("SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND event = 'recover_retry'").get(t84Id)?.c ?? 0;
    relDb84.close();
    assertCase(84, 'recover retry/release: claimed+blocked 回 open、清 blocked_at、retry 加 attempt 且 release 不加、可重新 claim',
      retry84.rc === 0 &&
      retry84.json?.state === 'open' &&
      retry84.json?.attempt === 1 &&
      showAfterRetry84?.state === 'open' &&
      showAfterRetry84?.blocked === false &&
      showAfterRetry84?.blocked_at === null &&
      showAfterRetry84?.to === 'antigravity' &&
      (inboxAfterRetry84?.messages || []).some((m) => m.body.includes('recovered_by=hermes') && m.body.includes('action=retry') && m.body.includes('clear stuck lease')) &&
      evtRetry84 >= 1 &&
      reclaim84.rc === 0 &&
      reclaim84.json?.state === 'claimed' &&
      release84.rc === 0 &&
      release84.json?.state === 'open' &&
      release84.json?.attempt === 1,
      `retry=${JSON.stringify(retry84.json)} show=${showAfterRetry84?.state}/${showAfterRetry84?.blocked_at} reclaim=${reclaim84.rc} release=${JSON.stringify(release84.json)}`);

    // 85. recover fail
    const t85Id = runCli(['new', '--to', 'antigravity', '--from', 'hermes', '--goal', 'recover-fail-test'], { root: relRoot, allowed: relAllowed }).json?.id;
    runCli(['claim', t85Id, '--by', 'antigravity'], { root: relRoot, allowed: relAllowed });
    const fail85 = runCli(['recover', t85Id, '--by', 'hermes', '--action', 'fail', '--reason', 'manual abort'], { root: relRoot, allowed: relAllowed });
    const show85 = runCli(['show', t85Id], { root: relRoot, allowed: relAllowed }).json;
    const inbox85 = runCli(['inbox', t85Id], { root: relRoot, allowed: relAllowed }).json;
    assertCase(85, 'recover fail: 无需 lease 直接置 failed、清 blocked_at、写 kind=error 消息',
      fail85.rc === 0 &&
      fail85.json?.state === 'failed' &&
      show85?.state === 'failed' &&
      Boolean(show85?.finished_at) &&
      show85?.blocked_at === null &&
      (inbox85?.messages || []).some((m) => m.kind === 'error' && m.body.includes('action=fail') && m.body.includes('manual abort')),
      `fail=${JSON.stringify(fail85.json)} show=${show85?.state}/${show85?.finished_at}`);

    // 86. recover reassign
    const t86Id = runCli(['new', '--to', 'antigravity', '--from', 'hermes', '--goal', 'recover-reassign-test'], { root: relRoot, allowed: relAllowed }).json?.id;
    runCli(['claim', t86Id, '--by', 'antigravity'], { root: relRoot, allowed: relAllowed });
    const reas86 = runCli(['recover', t86Id, '--by', 'hermes', '--action', 'reassign', '--to', 'codex', '--reason', 'hand over'], { root: relRoot, allowed: relAllowed });
    const oldClaim86 = runCli(['claim', t86Id, '--by', 'antigravity'], { root: relRoot, allowed: relAllowed });
    const newClaim86 = runCli(['claim', t86Id, '--by', 'codex'], { root: relRoot, allowed: relAllowed });
    assertCase(86, 'recover reassign: 修改 to_agent 为新 agent、原 agent claim 遭拒(rc=2)、新 agent 可 claim',
      reas86.rc === 0 &&
      reas86.json?.state === 'open' &&
      reas86.json?.to === 'codex' &&
      oldClaim86.rc === 2 &&
      newClaim86.rc === 0 &&
      newClaim86.json?.claimed_by === 'codex',
      `reas=${JSON.stringify(reas86.json)} oldRc=${oldClaim86.rc} newRc=${newClaim86.rc}`);

    // 87. recover adopt
    const ref87File = path.join(relWork, 'ref87.txt');
    fs.writeFileSync(ref87File, 'initial-ref-87', 'utf8');
    const put87 = runCli(['put', ref87File, '--by', 'hermes'], { root: relRoot, allowed: relAllowed }).json;
    const t87Id = runCli(['new', '--to', 'antigravity', '--from', 'hermes', '--goal', 'recover-adopt-test', '--ref', put87.sha256, '--accept', 'json=true', '--accept', 'status=ok'], { root: relRoot, allowed: relAllowed }).json?.id;
    const c87 = runCli(['claim', t87Id, '--by', 'antigravity'], { root: relRoot, allowed: relAllowed }).json;
    runCli(['message', t87Id, '--by', 'antigravity', '--kind', 'blocked', '--body', 'finished but ref drifted', '--lease', c87.lease_token], { root: relRoot, allowed: relAllowed });
    // Release back to open (while keeping blocked_at manually set in DB to simulate open+blocked)
    const relDb87 = new DatabaseSync(path.join(relRoot, 'agentbus.db'));
    relDb87.prepare("UPDATE tasks SET state = 'open', claimed_by = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id = ?").run(t87Id);
    relDb87.close();
    // Mutate ref to simulate drift
    fs.writeFileSync(ref87File, 'modified-ref-87', 'utf8');
    const adoptMissing87 = runCli(['recover', t87Id, '--by', 'hermes', '--action', 'adopt', '--result', path.join(relWork, 'nonexistent_87.json'), '--allow-drift'], { root: relRoot, allowed: relAllowed });
    const badAcc87 = path.join(relWork, 'bad_acc_87.json');
    fs.writeFileSync(badAcc87, JSON.stringify({ status: 'nope' }), 'utf8');
    const adoptBadAcc87 = runCli(['recover', t87Id, '--by', 'hermes', '--action', 'adopt', '--result', badAcc87, '--allow-drift'], { root: relRoot, allowed: relAllowed });
    const goodRes87 = path.join(relWork, 'good_res_87.json');
    fs.writeFileSync(goodRes87, JSON.stringify({ status: 'ok' }), 'utf8');
    const adoptStrictDrift87 = runCli(['recover', t87Id, '--by', 'hermes', '--action', 'adopt', '--result', goodRes87], { root: relRoot, allowed: relAllowed });
    const adoptOk87 = runCli(['recover', t87Id, '--by', 'hermes', '--action', 'adopt', '--result', goodRes87, '--allow-drift', '--reason', 'accepted with drift'], { root: relRoot, allowed: relAllowed });
    const relDb87b = new DatabaseSync(path.join(relRoot, 'agentbus.db'));
    const evtAdopt87 = relDb87b.prepare("SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND event = 'recover_adopt'").get(t87Id)?.c ?? 0;
    relDb87b.close();
    assertCase(87, 'recover adopt: open+blocked 凭合格结果文件转 done、不存在路径/不满足验收/默认drift均拒绝、--allow-drift 放行并记 recover_adopt',
      adoptMissing87.rc === 1 &&
      adoptBadAcc87.rc === 1 &&
      adoptStrictDrift87.rc === 1 &&
      adoptOk87.rc === 0 &&
      adoptOk87.json?.state === 'done' &&
      adoptOk87.json?.blocked === false &&
      evtAdopt87 >= 1,
      `miss=${adoptMissing87.rc} acc=${adoptBadAcc87.rc} strict=${adoptStrictDrift87.rc} ok=${JSON.stringify(adoptOk87.json)} evt=${evtAdopt87}`);

    // 88. lease 过期自动回收后 blocked_at 为空，并出现 lease_expired error 消息
    const t88Id = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'reap-clears-blocked'], { root: relRoot, allowed: relAllowed }).json?.id;
    const c88 = runCli(['claim', t88Id, '--by', 'codex', '--ttl', '1'], { root: relRoot, allowed: relAllowed }).json;
    runCli(['message', t88Id, '--by', 'codex', '--kind', 'blocked', '--body', 'before expiry', '--lease', c88.lease_token], { root: relRoot, allowed: relAllowed });
    await sleep(1400);
    const show88 = runCli(['show', t88Id], { root: relRoot, allowed: relAllowed }).json;
    const inbox88 = runCli(['inbox', t88Id], { root: relRoot, allowed: relAllowed }).json;
    assertCase(88, 'lease 过期自动回收后 blocked_at 为空，并出现 lease_expired kind=error 消息',
      show88?.state === 'open' &&
      show88?.attempt === 1 &&
      show88?.blocked === false &&
      show88?.blocked_at === null &&
      (inbox88?.messages || []).some((m) => m.kind === 'error' && m.body.includes('lease_expired') && m.body.includes('codex')),
      `show=${JSON.stringify(show88)} msgs=${JSON.stringify(inbox88?.messages)}`);

    // 89. waitForTask 在租约过期回到 open 时立即返回 stalled=true；buildPrompt 含第 0 步且 claim 含 heartbeat_hint
    const t89Id = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'wait-stalled-test'], { root: relRoot, allowed: relAllowed }).json?.id;
    const c89 = runCli(['claim', t89Id, '--by', 'codex', '--ttl', '1'], { root: relRoot, allowed: relAllowed }).json;
    const prompt89 = buildPrompt(t89Id, 'codex', relWork);
    const waitBus89 = openBus({ rootOverride: relRoot });
    let waitRes89;
    const waitStart89 = Date.now();
    try {
      waitRes89 = await waitForTask(waitBus89, t89Id, 15, 100);
    } finally {
      waitBus89.close();
    }
    const waitElapsed89 = Date.now() - waitStart89;
    assertCase(89, 'waitForTask 在租约过期回到 open 时立即返回 stalled=true；buildPrompt 含 heartbeat 第 0 步且 claim 含 heartbeat_hint',
      waitElapsed89 < 6000 &&
      waitRes89?.needs_attention === true &&
      waitRes89?.stalled === true &&
      waitRes89?.reason === 'lease_expired' &&
      Boolean(waitRes89?.recover_hint) &&
      prompt89.includes('bus_task_heartbeat') &&
      Boolean(c89?.heartbeat_hint),
      `elapsed=${waitElapsed89}ms wait=${JSON.stringify(waitRes89)} hbHint=${c89?.heartbeat_hint}`);

    // 90. completeTask drift/acceptance 失败写 kind=error 消息与 blocked_at；allow_ref_drift=true 时允许并带 warning
    const ref90File = path.join(relWork, 'ref90.txt');
    fs.writeFileSync(ref90File, 'v1', 'utf8');
    const put90 = runCli(['put', ref90File, '--by', 'hermes'], { root: relRoot, allowed: relAllowed }).json;
    const t90StrictId = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'complete-error-trace', '--ref', put90.sha256], { root: relRoot, allowed: relAllowed }).json?.id;
    const c90Strict = runCli(['claim', t90StrictId, '--by', 'codex'], { root: relRoot, allowed: relAllowed }).json;
    const res90 = path.join(relWork, 'res90.json');
    fs.writeFileSync(res90, JSON.stringify({ ok: true }), 'utf8');
    fs.writeFileSync(ref90File, 'v2-drifted', 'utf8');
    const doneFail90 = runCli(['done', t90StrictId, '--by', 'codex', '--lease', c90Strict.lease_token, '--result', res90], { root: relRoot, allowed: relAllowed });
    const showFail90 = runCli(['show', t90StrictId], { root: relRoot, allowed: relAllowed }).json;
    const inboxFail90 = runCli(['inbox', t90StrictId], { root: relRoot, allowed: relAllowed }).json;

    const t90AllowId = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'allow-drift-ok', '--ref', put90.sha256, '--accept', 'allow_ref_drift=true', '--accept', 'json=true'], { root: relRoot, allowed: relAllowed }).json?.id;
    const c90Allow = runCli(['claim', t90AllowId, '--by', 'codex'], { root: relRoot, allowed: relAllowed }).json;
    const doneAllow90 = runCli(['done', t90AllowId, '--by', 'codex', '--lease', c90Allow.lease_token, '--result', res90], { root: relRoot, allowed: relAllowed });
    const relDb90 = new DatabaseSync(path.join(relRoot, 'agentbus.db'));
    const evtDrift90 = relDb90.prepare("SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND event = 'complete_with_ref_drift'").get(t90AllowId)?.c ?? 0;
    relDb90.close();
    assertCase(90, 'completeTask drift 默认拒绝并写 error 消息与 blocked_at；allow_ref_drift=true 时放行并带 warning 与事件',
      doneFail90.rc === 1 &&
      showFail90?.state === 'claimed' &&
      showFail90?.blocked === true &&
      (inboxFail90?.messages || []).some((m) => m.kind === 'error' && /drift|漂移/.test(m.body)) &&
      doneAllow90.rc === 0 &&
      doneAllow90.json?.state === 'done' &&
      Array.isArray(doneAllow90.json?.warnings) &&
      doneAllow90.json.warnings.includes('completed_with_ref_drift') &&
      evtDrift90 >= 1,
      `failRc=${doneFail90.rc} blk=${showFail90?.blocked} allow=${JSON.stringify(doneAllow90.json)} evt=${evtDrift90}`);

    // 91. MCP worker 角色包含 bus_task_recover，不能 recover 无关任务，可 recover 自己参与的任务
    const t91OtherId = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'worker-recover-auth-other'], { root: relRoot, allowed: relAllowed }).json?.id;
    const t91MineId = runCli(['new', '--to', 'antigravity', '--from', 'hermes', '--goal', 'worker-recover-auth-mine'], { root: relRoot, allowed: relAllowed }).json?.id;
    runCli(['claim', t91MineId, '--by', 'antigravity'], { root: relRoot, allowed: relAllowed });
    const workerRec91 = await runMcpSession(relRoot, relAllowed, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'w91', version: '1.0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bus_task_recover', arguments: { id: t91OtherId, by: 'antigravity', action: 'fail', reason: 'cross-agent' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bus_task_recover', arguments: { id: t91MineId, by: 'antigravity', action: 'retry', reason: 'self-retry' } } },
    ], { AGENTBUS_ROLE: 'worker' });
    const wTools91 = workerRec91.responses.find((r) => r.id === 2)?.result?.tools || [];
    const wOther91 = workerRec91.responses.find((r) => r.id === 3)?.result;
    const wMine91 = workerRec91.responses.find((r) => r.id === 4)?.result;
    assertCase(91, 'worker MCP tools/list 包含 bus_task_recover（9 工具），禁止 recover 无关任务，允许 recover 自身任务',
      wTools91.length === 9 &&
      wTools91.some((t) => t.name === 'bus_task_recover') &&
      wOther91?.isError === true &&
      wMine91?.isError !== true &&
      wMine91?.structuredContent?.state === 'open',
      `count=${wTools91.length} otherErr=${wOther91?.isError} mine=${JSON.stringify(wMine91?.structuredContent)}`);

    const isolatedNoBinEnv = {
      PATH: '',
      Path: '',
      SCOOP: '',
      SCOOP_GLOBAL: '',
      VOLTA_HOME: '',
      NVM_HOME: '',
      NVM_SYMLINK: '',
      NVM_DIR: '',
      npm_config_prefix: '',
      AGENTBUS_CODEX_BIN: '',
      AGENTBUS_CLAUDE_BIN: '',
      AGENTBUS_GEMINI_BIN: '',
      AGENTBUS_ANTIGRAVITY_BIN: '',
      AGENTBUS_OPENCODE_BIN: '',
      AGENTBUS_HERMES_BIN: '',
      AGENTBUS_DSH_BIN: '',
    };
    const makeFakeBin = (dir, name) => {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
      if (process.platform === 'win32') {
        fs.writeFileSync(file, '@echo off\r\nexit /b 0\r\n', 'utf8');
      } else {
        fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      }
      return file;
    };

    // 92. doctor --fix 恢复被删掉的 codex 与 antigravity 条目，保留已有其他配置与多行 TOML 数组，第二次 changed=false
    const fixHome92 = path.join(RUN_BASE, 'fix_home_92');
    const fixRoot92 = path.join(RUN_BASE, 'fix_root_92');
    const fixAllow92 = path.join(RUN_BASE, 'fix_allow_92');
    fs.mkdirSync(path.join(fixHome92, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(fixHome92, '.gemini', 'config'), { recursive: true });
    fs.mkdirSync(fixAllow92, { recursive: true });
    const codexCfg92 = path.join(fixHome92, '.codex', 'config.toml');
    const agyCfg92 = path.join(fixHome92, '.gemini', 'config', 'mcp_config.json');
    fs.writeFileSync(
      codexCfg92,
      '# user comment\nmodel = "gpt-5"\n\n[mcp_servers.other_tool]\ncommand = "echo"\nargs = [\n  "--flag",\n  "val",\n]\n',
      'utf8',
    );
    fs.writeFileSync(agyCfg92, JSON.stringify({ mcpServers: { keep_me: { command: 'node', args: ['x.js'] } } }, null, 2) + '\n', 'utf8');
    const fakeCodex92 = makeFakeBin(path.join(RUN_BASE, 'bins92'), 'codex');
    const fakeAgy92 = makeFakeBin(path.join(RUN_BASE, 'bins92'), 'agentapi');
    const fixEnv92 = {
      ...isolatedNoBinEnv,
      AGENTBUS_CODEX_BIN: fakeCodex92,
      AGENTBUS_ANTIGRAVITY_BIN: fakeAgy92,
    };

    const fixRun1_92 = runCli(['doctor', '--fix', '--home', fixHome92, '--allow', fixAllow92, '--json'], { root: fixRoot92, allowed: fixAllow92, envExtra: fixEnv92 });
    const fixRun2_92 = runCli(['doctor', '--fix', '--home', fixHome92, '--allow', fixAllow92, '--json'], { root: fixRoot92, allowed: fixAllow92, envExtra: fixEnv92 });
    const codexAfter92 = fs.readFileSync(codexCfg92, 'utf8');
    const agyAfter92 = JSON.parse(fs.readFileSync(agyCfg92, 'utf8'));
    const noUninstalledDirs92 = ['.dsh', '.hermes', '.codeium', '.kiro', '.lmstudio', '.cline'].every((d) => !fs.existsSync(path.join(fixHome92, d)));
    assertCase(92, 'doctor --fix 在临时 home 恢复被删的 codex(TOML 含多行数组) 与 antigravity(JSON) 条目，保留原有配置，第二次 changed=false 且不建未安装目录',
      fixRun1_92.rc === 0 &&
      fixRun1_92.json?.changed === true &&
      (fixRun1_92.json?.repaired || []).some((r) => r.client === 'codex' && r.config === codexCfg92 && r.backup && fs.existsSync(r.backup)) &&
      (fixRun1_92.json?.repaired || []).some((r) => r.client === 'antigravity' && r.config === agyCfg92 && r.backup && fs.existsSync(r.backup)) &&
      codexAfter92.includes('# user comment') &&
      codexAfter92.includes('[mcp_servers.other_tool]') &&
      codexAfter92.includes('"--flag"') &&
      codexAfter92.includes('[mcp_servers.agentbus]') &&
      Boolean(agyAfter92?.mcpServers?.keep_me) &&
      Boolean(agyAfter92?.mcpServers?.agentbus) &&
      fixRun2_92.rc === 0 &&
      fixRun2_92.json?.changed === false &&
      (fixRun2_92.json?.repaired || []).length === 0 &&
      noUninstalledDirs92,
      `r1=${JSON.stringify(fixRun1_92.json)} r2Changed=${fixRun2_92.json?.changed} noExtra=${noUninstalledDirs92}`);

    // 93. doctor --fix 对损坏 JSON/TOML 不覆盖并报告 manual/skipped；DSH 与 Hermes 幂等恢复
    const fixHome93 = path.join(RUN_BASE, 'fix_home_93');
    const fixRoot93 = path.join(RUN_BASE, 'fix_root_93');
    const fixAllow93 = path.join(RUN_BASE, 'fix_allow_93');
    fs.mkdirSync(path.join(fixHome93, '.gemini'), { recursive: true });
    fs.mkdirSync(path.join(fixHome93, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(fixHome93, '.dsh', 'profiles', 'desktop'), { recursive: true });
    const hermesCfgDir93 = process.platform === 'win32'
      ? path.join(fixHome93, 'AppData', 'Local', 'hermes')
      : path.join(fixHome93, '.hermes');
    fs.mkdirSync(hermesCfgDir93, { recursive: true });
    fs.mkdirSync(fixAllow93, { recursive: true });

    const brokenJson93 = '{ "mcpServers": { broken';
    const brokenToml93 = '[unclosed_section\nfoo = "bar"\n';
    const geminiCfg93 = path.join(fixHome93, '.gemini', 'settings.json');
    const codexCfg93 = path.join(fixHome93, '.codex', 'config.toml');
    const dshCfg93 = path.join(fixHome93, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
    const hermesCfg93 = path.join(hermesCfgDir93, 'config.yaml');
    fs.writeFileSync(geminiCfg93, brokenJson93, 'utf8');
    fs.writeFileSync(codexCfg93, brokenToml93, 'utf8');
    fs.writeFileSync(dshCfg93, '- insert:\n    - id: other-plugin\n      name: other\n', 'utf8');
    fs.writeFileSync(hermesCfg93, 'mcp_servers:\n  other_srv:\n    command: echo\n', 'utf8');

    const fakeCodex93 = makeFakeBin(path.join(RUN_BASE, 'bins93'), 'codex');
    const fakeHermesJs93 = path.join(RUN_BASE, 'fake_hermes_93.mjs');
    fs.writeFileSync(fakeHermesJs93, [
      "import fs from 'node:fs';",
      "const argv = process.argv.slice(2);",
      "const cfg = process.env.TARGET_HERMES_CFG_93;",
      "if (argv[0] === 'mcp' && argv[1] === 'add') {",
      "  const prev = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';",
      "  if (!/\\bagentbus\\s*:/.test(prev)) fs.writeFileSync(cfg, prev.trimEnd() + '\\n  agentbus:\\n    command: node\\n', 'utf8');",
      "  process.exit(0);",
      "}",
      "if (argv[0] === 'mcp' && argv[1] === 'list') {",
      "  const txt = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';",
      "  console.log(/\\bagentbus\\s*:/.test(txt) ? 'agentbus (stdio)' : 'No MCP servers');",
      "  process.exit(0);",
      "}",
      "process.exit(1);",
    ].join('\n'), 'utf8');
    const fakeHermesBin93 = path.join(RUN_BASE, process.platform === 'win32' ? 'hermes_93.cmd' : 'hermes_93');
    if (process.platform === 'win32') {
      fs.writeFileSync(fakeHermesBin93, `@echo off\r\n"${process.execPath}" "%~dp0fake_hermes_93.mjs" %*\r\n`, 'utf8');
    } else {
      fs.writeFileSync(fakeHermesBin93, `#!/bin/sh\nexec "${process.execPath}" "${fakeHermesJs93}" "$@"\n`, { mode: 0o755 });
    }

    const fixEnv93 = {
      ...isolatedNoBinEnv,
      AGENTBUS_CODEX_BIN: fakeCodex93,
      AGENTBUS_HERMES_BIN: fakeHermesBin93,
      TARGET_HERMES_CFG_93: hermesCfg93,
    };
    const fixRun1_93 = runCli(['doctor', '--fix', '--home', fixHome93, '--allow', fixAllow93, '--json'], { root: fixRoot93, allowed: fixAllow93, envExtra: fixEnv93 });
    const fixRun2_93 = runCli(['doctor', '--fix', '--home', fixHome93, '--allow', fixAllow93, '--json'], { root: fixRoot93, allowed: fixAllow93, envExtra: fixEnv93 });
    const dshAfter93 = fs.readFileSync(dshCfg93, 'utf8');
    const hermesAfter93 = fs.readFileSync(hermesCfg93, 'utf8');
    const codexManual93 = (fixRun1_93.json?.issues || []).find((i) => i.client === 'codex');
    assertCase(93, 'doctor --fix 对损坏 TOML 先备份不覆盖并报 manual； Gemini 等未授权客户端不自动改写；DSH 与 Hermes 幂等恢复',
      fs.readFileSync(geminiCfg93, 'utf8') === brokenJson93 &&
      fs.readFileSync(codexCfg93, 'utf8') === brokenToml93 &&
      (fixRun1_93.json?.skipped || []).some((s) => s.client === 'gemini' && s.result === 'out_of_scope') &&
      codexManual93?.result === 'manual' &&
      Boolean(codexManual93?.backup && fs.existsSync(codexManual93.backup)) &&
      (fixRun1_93.json?.repaired || []).some((r) => r.client === 'dsh') &&
      (fixRun1_93.json?.repaired || []).some((r) => r.client === 'hermes') &&
      dshAfter93.includes('id: other-plugin') &&
      dshAfter93.includes('id: agentbus-mcp') &&
      hermesAfter93.includes('other_srv:') &&
      hermesAfter93.includes('agentbus:') &&
      fixRun2_93.json?.changed === false &&
      !(fixRun2_93.json?.repaired || []).some((r) => r.client === 'dsh' || r.client === 'hermes'),
      `r1=${JSON.stringify(fixRun1_93.json)} r2=${JSON.stringify(fixRun2_93.json)}`);

    // 94. MCP bus_task_wait 返回 stalled/reason/recover_hint + setup --repair 别名 + MCP 只读自检拦截不可写 DB
    const t94Id = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'mcp-wait-stalled-94'], { root: relRoot, allowed: relAllowed }).json?.id;
    runCli(['claim', t94Id, '--by', 'codex', '--ttl', '1'], { root: relRoot, allowed: relAllowed });
    await sleep(1300);
    const mcpWait94 = await runMcpSession(relRoot, relAllowed, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wait94', version: '1.0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bus_task_wait', arguments: { id: t94Id, timeout_s: 10 } } },
    ]);
    const waitPayload94 = mcpWait94.responses.find((r) => r.id === 2)?.result?.structuredContent;

    const repairHome94 = path.join(RUN_BASE, 'repair_home_94');
    const repairRoot94 = path.join(RUN_BASE, 'repair_root_94');
    const repairAllow94 = path.join(RUN_BASE, 'repair_allow_94');
    fs.mkdirSync(path.join(repairHome94, '.codex'), { recursive: true });
    fs.mkdirSync(repairAllow94, { recursive: true });
    const fakeCodex94 = makeFakeBin(path.join(RUN_BASE, 'bins94'), 'codex');
    const repairAlias94 = runCli(['setup', '--repair', '--home', repairHome94, '--allow', repairAllow94], {
      root: repairRoot94,
      allowed: repairAllow94,
      envExtra: { ...isolatedNoBinEnv, AGENTBUS_CODEX_BIN: fakeCodex94 },
    });

    const roRoot94 = path.join(RUN_BASE, 'ro_root_94');
    runCli(['init'], { root: roRoot94, allowed: roRoot94 });
    const roDb94 = path.join(roRoot94, 'agentbus.db');
    let roMcpRes94 = null;
    try {
      fs.chmodSync(roDb94, 0o444);
      roMcpRes94 = runCli(['mcp'], { root: roRoot94, allowed: roRoot94 });
    } finally {
      try { fs.chmodSync(roDb94, 0o666); } catch {}
    }

    assertCase(94, 'MCP bus_task_wait 同步 stalled/reason/recover_hint；setup --repair 等价可用；MCP 启动对不可写库报清晰错误',
      waitPayload94?.stalled === true &&
      waitPayload94?.needs_attention === true &&
      waitPayload94?.reason === 'lease_expired' &&
      Boolean(waitPayload94?.recover_hint) &&
      repairAlias94.rc === 0 &&
      repairAlias94.json?.changed === true &&
      (repairAlias94.json?.repaired || []).some((r) => r.client === 'codex') &&
      roMcpRes94?.rc === 1 &&
      /不可写|readonly|permission/i.test(roMcpRes94?.stderr || ''),
      `wait=${JSON.stringify(waitPayload94)} repair=${JSON.stringify(repairAlias94.json)} roMcp=${roMcpRes94?.rc}:${roMcpRes94?.stderr?.slice(0, 160)}`);

    // 95. doctor --fix 安全边界：只有配置目录或配置残留且无二进制的客户端报 not_installed 且不创建/修改任何文件；非白名单客户端即使有二进制也不自动写入
    const dirOnlyHome95 = path.join(RUN_BASE, 'dir_only_home_95');
    const dirOnlyRoot95 = path.join(RUN_BASE, 'dir_only_root_95');
    const dirOnlyAllow95 = path.join(RUN_BASE, 'dir_only_allow_95');
    fs.mkdirSync(dirOnlyAllow95, { recursive: true });
    // Empty config directories only (no binaries, no files)
    for (const relDir of [
      '.codex',
      path.join('.gemini', 'config'),
      path.join('.gemini', 'antigravity'),
      path.join('.dsh', 'profiles', 'desktop'),
      '.hermes',
      path.join('AppData', 'Local', 'hermes'),
      '.cursor',
      path.join('.config', 'opencode'),
      path.join('AppData', 'Roaming', 'Claude'),
    ]) {
      fs.mkdirSync(path.join(dirOnlyHome95, relDir), { recursive: true });
    }
    const dirOnlyRun95 = runCli(['doctor', '--fix', '--home', dirOnlyHome95, '--allow', dirOnlyAllow95, '--json'], {
      root: dirOnlyRoot95,
      allowed: dirOnlyAllow95,
      envExtra: isolatedNoBinEnv,
    });
    const noFilesCreated95 = [
      path.join(dirOnlyHome95, '.codex', 'config.toml'),
      path.join(dirOnlyHome95, '.gemini', 'config', 'mcp_config.json'),
      path.join(dirOnlyHome95, '.gemini', 'antigravity', 'mcp_config.json'),
      path.join(dirOnlyHome95, '.gemini', 'settings.json'),
      path.join(dirOnlyHome95, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
      path.join(dirOnlyHome95, '.hermes', 'config.yaml'),
      path.join(dirOnlyHome95, 'AppData', 'Local', 'hermes', 'config.yaml'),
      path.join(dirOnlyHome95, '.cursor', 'mcp.json'),
      path.join(dirOnlyHome95, '.config', 'opencode', 'opencode.json'),
      path.join(dirOnlyHome95, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    ].every((f) => !fs.existsSync(f));
    const fourNotInstalled95 = ['codex', 'antigravity', 'dsh', 'hermes'].every((id) =>
      (dirOnlyRun95.json?.skipped || []).some((s) => s.client === id && s.result === 'not_installed')
    );

    // Leftover config files without binaries + non-whitelisted clients WITH binaries
    const leftoverHome95 = path.join(RUN_BASE, 'leftover_home_95');
    const leftoverRoot95 = path.join(RUN_BASE, 'leftover_root_95');
    const leftoverAllow95 = path.join(RUN_BASE, 'leftover_allow_95');
    fs.mkdirSync(leftoverAllow95, { recursive: true });
    const loCodex95 = path.join(leftoverHome95, '.codex', 'config.toml');
    const loAgy95 = path.join(leftoverHome95, '.gemini', 'config', 'mcp_config.json');
    const loHermes95 = process.platform === 'win32'
      ? path.join(leftoverHome95, 'AppData', 'Local', 'hermes', 'config.yaml')
      : path.join(leftoverHome95, '.hermes', 'config.yaml');
    const loGemini95 = path.join(leftoverHome95, '.gemini', 'settings.json');
    const loCursor95 = path.join(leftoverHome95, '.cursor', 'mcp.json');
    const loOpencode95 = path.join(leftoverHome95, '.config', 'opencode', 'opencode.json');
    const loClaudeDesktop95 = process.platform === 'win32'
      ? path.join(leftoverHome95, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
      : process.platform === 'darwin'
        ? path.join(leftoverHome95, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(leftoverHome95, '.config', 'Claude', 'claude_desktop_config.json');
    const loSeeds95 = [
      [loCodex95, 'model = "leftover"\n'],
      [loAgy95, '{"mcpServers":{}}\n'],
      [loHermes95, 'mcp_servers: {}\n'],
      [loGemini95, '{"mcpServers":{}}\n'],
      [loCursor95, '{"mcpServers":{}}\n'],
      [loOpencode95, '{"mcp":{}}\n'],
      [loClaudeDesktop95, '{"mcpServers":{}}\n'],
    ];
    for (const [fp, content] of loSeeds95) {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content, 'utf8');
    }
    const fakeBins95 = path.join(RUN_BASE, 'bins95');
    const loRun95 = runCli(['doctor', '--fix', '--home', leftoverHome95, '--allow', leftoverAllow95, '--json'], {
      root: leftoverRoot95,
      allowed: leftoverAllow95,
      envExtra: {
        ...isolatedNoBinEnv,
        AGENTBUS_GEMINI_BIN: makeFakeBin(fakeBins95, 'gemini'),
        AGENTBUS_CLAUDE_BIN: makeFakeBin(fakeBins95, 'claude'),
        AGENTBUS_OPENCODE_BIN: makeFakeBin(fakeBins95, 'opencode'),
      },
    });
    const loTargetedGemini95 = runCli(['doctor', '--fix', '--client', 'gemini', '--home', leftoverHome95, '--allow', leftoverAllow95, '--json'], {
      root: leftoverRoot95,
      allowed: leftoverAllow95,
      envExtra: {
        ...isolatedNoBinEnv,
        AGENTBUS_GEMINI_BIN: makeFakeBin(fakeBins95, 'gemini'),
      },
    });
    const loAllUntouched95 = loSeeds95.every(([fp, content]) => fs.readFileSync(fp, 'utf8') === content);
    const loNoBackups95 = loSeeds95.every(([fp]) =>
      !fs.readdirSync(path.dirname(fp)).some((n) => n.startsWith(`${path.basename(fp)}.bak-`))
    );
    const loOutOfScope95 = ['claude', 'gemini', 'cursor', 'opencode', 'claude-desktop'].every((id) =>
      (loRun95.json?.skipped || []).some((s) => s.client === id && s.result === 'out_of_scope')
    );
    const loLeftoverNotInst95 = ['codex', 'antigravity', 'dsh', 'hermes'].every((id) =>
      (loRun95.json?.skipped || []).some((s) => s.client === id && s.result === 'not_installed')
    );

    assertCase(95, 'doctor --fix 仅有配置目录/残留配置且无二进制报 not_installed 且不创建文件；非白名单客户端即使有二进制/指定 --client 也不写入',
      dirOnlyRun95.rc === 0 &&
      dirOnlyRun95.json?.changed === false &&
      (dirOnlyRun95.json?.repaired || []).length === 0 &&
      fourNotInstalled95 &&
      noFilesCreated95 &&
      loRun95.rc === 0 &&
      loRun95.json?.changed === false &&
      (loRun95.json?.repaired || []).length === 0 &&
      loTargetedGemini95.json?.changed === false &&
      (loTargetedGemini95.json?.skipped || []).some((s) => s.client === 'gemini' && s.result === 'out_of_scope') &&
      loAllUntouched95 &&
      loNoBackups95 &&
      loOutOfScope95 &&
      loLeftoverNotInst95,
      `dirOnly=${JSON.stringify(dirOnlyRun95.json)} noFiles=${noFilesCreated95} loUntouched=${loAllUntouched95} loNoBak=${loNoBackups95} outScope=${loOutOfScope95}`);

    // 96. 全量 4 白名单客户端在单次临时 home 恢复与幂等 + DSH/Hermes 损坏配置只备份报 manual + recoverTask 权限/终态防重防越权
    const all4Home96 = path.join(RUN_BASE, 'all4_home_96');
    const all4Root96 = path.join(RUN_BASE, 'all4_root_96');
    const all4Allow96 = path.join(RUN_BASE, 'all4_allow_96');
    fs.mkdirSync(all4Allow96, { recursive: true });
    fs.mkdirSync(path.join(all4Home96, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(all4Home96, '.gemini', 'config'), { recursive: true });
    fs.mkdirSync(path.join(all4Home96, '.dsh', 'profiles', 'desktop'), { recursive: true });
    const hermesDir96 = process.platform === 'win32'
      ? path.join(all4Home96, 'AppData', 'Local', 'hermes')
      : path.join(all4Home96, '.hermes');
    fs.mkdirSync(hermesDir96, { recursive: true });

    const codexCfg96 = path.join(all4Home96, '.codex', 'config.toml');
    const agyCfg96 = path.join(all4Home96, '.gemini', 'config', 'mcp_config.json');
    const dshCfg96 = path.join(all4Home96, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
    const hermesCfg96 = path.join(hermesDir96, 'config.yaml');
    fs.writeFileSync(codexCfg96, '# keep\nmodel = "gpt-5"\n', 'utf8');
    fs.writeFileSync(agyCfg96, '{"mcpServers":{"other":{"command":"echo"}}}\n', 'utf8');
    fs.writeFileSync(dshCfg96, '- insert:\n    - id: keep-96\n      name: keep\n', 'utf8');
    fs.writeFileSync(hermesCfg96, 'mcp_servers:\n  keep_96:\n    command: echo\n', 'utf8');

    const bins96 = path.join(RUN_BASE, 'bins96');
    fs.mkdirSync(bins96, { recursive: true });
    const fakeHermesJs96 = path.join(RUN_BASE, 'fake_hermes_96.mjs');
    fs.writeFileSync(fakeHermesJs96, [
      "import fs from 'node:fs';",
      "const argv = process.argv.slice(2);",
      "const cfg = process.env.TARGET_HERMES_CFG_96;",
      "if (argv[0] === 'mcp' && argv[1] === 'add') {",
      "  const prev = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';",
      "  if (!/\\bagentbus\\s*:/.test(prev)) fs.writeFileSync(cfg, prev.trimEnd() + '\\n  agentbus:\\n    command: node\\n', 'utf8');",
      "  process.exit(0);",
      "}",
      "if (argv[0] === 'mcp' && argv[1] === 'list') {",
      "  const txt = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';",
      "  console.log(/\\bagentbus\\s*:/.test(txt) ? 'agentbus (stdio)' : 'No MCP servers');",
      "  process.exit(0);",
      "}",
      "process.exit(1);",
    ].join('\n'), 'utf8');
    const fakeHermesBin96 = path.join(bins96, process.platform === 'win32' ? 'hermes.cmd' : 'hermes');
    if (process.platform === 'win32') {
      fs.writeFileSync(fakeHermesBin96, `@echo off\r\n"${process.execPath}" "%~dp0..\\fake_hermes_96.mjs" %*\r\n`, 'utf8');
    } else {
      fs.writeFileSync(fakeHermesBin96, `#!/bin/sh\nexec "${process.execPath}" "${fakeHermesJs96}" "$@"\n`, { mode: 0o755 });
    }
    const env96 = {
      ...isolatedNoBinEnv,
      AGENTBUS_CODEX_BIN: makeFakeBin(bins96, 'codex'),
      AGENTBUS_ANTIGRAVITY_BIN: makeFakeBin(bins96, 'agentapi'),
      AGENTBUS_HERMES_BIN: fakeHermesBin96,
      TARGET_HERMES_CFG_96: hermesCfg96,
    };
    const all4Run1_96 = runCli(['doctor', '--fix', '--home', all4Home96, '--allow', all4Allow96, '--json'], { root: all4Root96, allowed: all4Allow96, envExtra: env96 });
    const all4Run2_96 = runCli(['doctor', '--fix', '--home', all4Home96, '--allow', all4Allow96, '--json'], { root: all4Root96, allowed: all4Allow96, envExtra: env96 });
    const all4RepairedIds96 = new Set((all4Run1_96.json?.repaired || []).map((r) => r.client));
    const all4BothOk96 = ['codex', 'antigravity', 'dsh', 'hermes'].every((id) => all4RepairedIds96.has(id));

    // Corrupted DSH + Corrupted Hermes YAML backup & manual without overwrite
    const badYamlHome96 = path.join(RUN_BASE, 'bad_yaml_home_96');
    const badYamlRoot96 = path.join(RUN_BASE, 'bad_yaml_root_96');
    const badYamlAllow96 = path.join(RUN_BASE, 'bad_yaml_allow_96');
    fs.mkdirSync(badYamlAllow96, { recursive: true });
    const badDshCfg96 = path.join(badYamlHome96, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
    const badHermesDir96 = process.platform === 'win32'
      ? path.join(badYamlHome96, 'AppData', 'Local', 'hermes')
      : path.join(badYamlHome96, '.hermes');
    const badHermesCfg96 = path.join(badHermesDir96, 'config.yaml');
    fs.mkdirSync(path.dirname(badDshCfg96), { recursive: true });
    fs.mkdirSync(badHermesDir96, { recursive: true });
    const badDshContent96 = 'not_a_list: true\n';
    const badHermesContent96 = 'mcp_servers: "broken_scalar"\n';
    fs.writeFileSync(badDshCfg96, badDshContent96, 'utf8');
    fs.writeFileSync(badHermesCfg96, badHermesContent96, 'utf8');
    const badYamlRun96 = runCli(['doctor', '--fix', '--home', badYamlHome96, '--allow', badYamlAllow96, '--json'], {
      root: badYamlRoot96,
      allowed: badYamlAllow96,
      envExtra: { ...isolatedNoBinEnv, AGENTBUS_HERMES_BIN: fakeHermesBin96 },
    });
    const dshManual96 = (badYamlRun96.json?.issues || []).find((i) => i.client === 'dsh');
    const hermesManual96 = (badYamlRun96.json?.issues || []).find((i) => i.client === 'hermes');

    // recoverTask security & duplicate recovery check
    const ref96 = path.join(relWork, 'ref96.txt');
    fs.writeFileSync(ref96, 'orig-96', 'utf8');
    const put96 = runCli(['put', ref96, '--by', 'hermes'], { root: relRoot, allowed: relAllowed }).json;
    const t96Id = runCli(['new', '--to', 'antigravity', '--from', 'hermes', '--goal', 'worker-recover-sec', '--ref', put96.sha256], { root: relRoot, allowed: relAllowed }).json?.id;
    const res96 = path.join(relWork, 'res96.json');
    fs.writeFileSync(res96, '{"ok":true}', 'utf8');
    fs.writeFileSync(ref96, 'drifted-96', 'utf8');
    const workerDriftCli96 = runCli(['recover', t96Id, '--by', 'antigravity', '--action', 'adopt', '--result', res96, '--allow-drift'], {
      root: relRoot,
      allowed: relAllowed,
      envExtra: { AGENTBUS_ROLE: 'worker', AGENTBUS_AGENT: 'antigravity' },
    });
    const workerCrossCli96 = runCli(['recover', t96Id, '--by', 'codex', '--action', 'fail', '--reason', 'hijack'], {
      root: relRoot,
      allowed: relAllowed,
      envExtra: { AGENTBUS_ROLE: 'worker', AGENTBUS_AGENT: 'codex' },
    });
    const conductorAdopt96 = runCli(['recover', t96Id, '--by', 'hermes', '--action', 'adopt', '--result', res96, '--allow-drift'], {
      root: relRoot,
      allowed: relAllowed,
      envExtra: { AGENTBUS_ROLE: 'conductor' },
    });
    const dupRecover96 = runCli(['recover', t96Id, '--by', 'hermes', '--action', 'retry', '--reason', 'dup'], {
      root: relRoot,
      allowed: relAllowed,
    });

    assertCase(96, '4 白名单客户端在临时 home 全部恢复且二次幂等；损坏 DSH/Hermes 只备份报 manual；worker recover 防越权防漂移绕过与终态防重',
      all4Run1_96.rc === 0 &&
      all4Run1_96.json?.changed === true &&
      all4BothOk96 &&
      all4Run2_96.rc === 0 &&
      all4Run2_96.json?.changed === false &&
      (all4Run2_96.json?.repaired || []).length === 0 &&
      dshManual96?.result === 'manual' &&
      Boolean(dshManual96?.backup && fs.existsSync(dshManual96.backup)) &&
      fs.readFileSync(badDshCfg96, 'utf8') === badDshContent96 &&
      hermesManual96?.result === 'manual' &&
      Boolean(hermesManual96?.backup && fs.existsSync(hermesManual96.backup)) &&
      fs.readFileSync(badHermesCfg96, 'utf8') === badHermesContent96 &&
      workerDriftCli96.rc === 2 &&
      workerCrossCli96.rc === 2 &&
      conductorAdopt96.rc === 0 &&
      conductorAdopt96.json?.state === 'done' &&
      dupRecover96.rc === 2,
      `all4=${[...all4RepairedIds96].join(',')} r2=${all4Run2_96.json?.changed} dshM=${dshManual96?.result} hrmM=${hermesManual96?.result} wDrift=${workerDriftCli96.rc} wCross=${workerCrossCli96.rc} cAdopt=${conductorAdopt96.rc} dup=${dupRecover96.rc}`);

    // 97. 回归：Windows 大写 COMSPEC / 缺失 ComSpec 且 PATH='' 时，hermes.cmd 与 doctor --fix 仍正常调用且二次幂等
    const hermesEnvHome97 = path.join(RUN_BASE, 'hermes_env_home_97');
    const hermesEnvRoot97 = path.join(RUN_BASE, 'hermes_env_root_97');
    const hermesEnvAllow97 = path.join(RUN_BASE, 'hermes_env_allow_97');
    fs.mkdirSync(hermesEnvAllow97, { recursive: true });
    const hermesDir97 = process.platform === 'win32'
      ? path.join(hermesEnvHome97, 'AppData', 'Local', 'hermes')
      : path.join(hermesEnvHome97, '.hermes');
    fs.mkdirSync(hermesDir97, { recursive: true });
    const hermesCfg97 = path.join(hermesDir97, 'config.yaml');
    fs.writeFileSync(hermesCfg97, 'mcp_servers:\n  keep_97:\n    command: echo\n', 'utf8');
    const env97 = {
      ...isolatedNoBinEnv,
      ComSpec: '',
      COMSPEC: '',
      AGENTBUS_HERMES_BIN: fakeHermesBin96,
      TARGET_HERMES_CFG_96: hermesCfg97,
    };
    const run1_97 = runCli(['doctor', '--fix', '--home', hermesEnvHome97, '--allow', hermesEnvAllow97, '--json'], { root: hermesEnvRoot97, allowed: hermesEnvAllow97, envExtra: env97 });
    const run2_97 = runCli(['doctor', '--fix', '--home', hermesEnvHome97, '--allow', hermesEnvAllow97, '--json'], { root: hermesEnvRoot97, allowed: hermesEnvAllow97, envExtra: env97 });
    const hermesAfter97 = fs.readFileSync(hermesCfg97, 'utf8');
    assertCase(97, '缺失 ComSpec / PATH 为空时 Hermes doctor --fix 不报 cmd.exe ENOENT 且二次幂等',
      run1_97.rc === 0 &&
      run1_97.json?.changed === true &&
      (run1_97.json?.repaired || []).some((r) => r.client === 'hermes') &&
      hermesAfter97.includes('keep_97:') &&
      hermesAfter97.includes('agentbus:') &&
      run2_97.rc === 0 &&
      run2_97.json?.changed === false &&
      (run2_97.json?.repaired || []).length === 0,
      `r1=${JSON.stringify(run1_97.json)} r2=${JSON.stringify(run2_97.json)}`);

    // 98. 去硬编码路径 + daemonDirs 三平台解析 + AGENTBUS_AGY_DAEMON_DIR 优先级与导出提示
    const { resolveDaemonDirs, discoverAgySession, exportAgySession } = await import('../src/agy.js');
    const sourceFiles98 = [
      ...fs.readdirSync(path.join(PKG_ROOT, 'src')).filter((f) => f.endsWith('.js')).map((f) => path.join(PKG_ROOT, 'src', f)),
      ...fs.readdirSync(path.join(PKG_ROOT, 'bin')).filter((f) => f.endsWith('.js')).map((f) => path.join(PKG_ROOT, 'bin', f)),
    ];
    const hardcodedHits98 = [];
    for (const sf of sourceFiles98) {
      const txt = fs.readFileSync(sf, 'utf8');
      if (/E:\/ai|E:\\ai|C:\/Users\/|C:\\Users\\/i.test(txt)) {
        hardcodedHits98.push(path.basename(sf));
      }
    }

    const agyBase98 = path.join(RUN_BASE, 'agy_98');
    const agyOv1_98 = path.join(agyBase98, 'override1');
    const agyOv2_98 = path.join(agyBase98, 'override2');
    const agyWinHome98 = path.join(agyBase98, 'win_home');
    const agyWinAppData98 = path.join(agyBase98, 'win_appdata');
    const agyMacHome98 = path.join(agyBase98, 'mac_home');
    const agyLinHome98 = path.join(agyBase98, 'lin_home');
    for (const d of [
      agyOv1_98,
      agyOv2_98,
      path.join(agyWinHome98, '.gemini', 'antigravity', 'daemon'),
      path.join(agyWinAppData98, 'Antigravity', 'daemon'),
      path.join(agyMacHome98, '.gemini', 'antigravity', 'daemon'),
      path.join(agyMacHome98, 'Library', 'Application Support', 'Antigravity', 'daemon'),
      path.join(agyLinHome98, '.gemini', 'antigravity', 'daemon'),
      path.join(agyLinHome98, '.config', 'Antigravity', 'daemon'),
    ]) fs.mkdirSync(d, { recursive: true });

    const dirsWin98 = resolveDaemonDirs({
      home: agyWinHome98,
      platform: 'win32',
      env: {
        AGENTBUS_AGY_DAEMON_DIR: [agyOv1_98, agyOv2_98].join(path.delimiter),
        APPDATA: agyWinAppData98,
      },
    });
    const dirsMac98 = resolveDaemonDirs({
      home: agyMacHome98,
      platform: 'darwin',
      env: { AGENTBUS_AGY_DAEMON_DIR: agyOv1_98 },
    });
    const dirsLin98 = resolveDaemonDirs({
      home: agyLinHome98,
      platform: 'linux',
      env: {},
    });

    const hubFile98 = path.join(agyOv2_98, 'hub_12345.json');
    fs.writeFileSync(hubFile98, JSON.stringify({ httpPort: 45678, csrfToken: 'tok-98', pid: 12345 }), 'utf8');
    const foundSess98 = discoverAgySession({
      home: agyWinHome98,
      platform: 'win32',
      env: { AGENTBUS_AGY_DAEMON_DIR: [agyOv1_98, agyOv2_98].join(path.delimiter), APPDATA: agyWinAppData98 },
    });
    let missingSessErr98 = '';
    const emptyAgyHome98 = path.join(agyBase98, 'empty_home');
    fs.mkdirSync(emptyAgyHome98, { recursive: true });
    const prevEnvAgy98 = {
      ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
      ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
      AGENTBUS_AGY_DAEMON_DIR: process.env.AGENTBUS_AGY_DAEMON_DIR,
      APPDATA: process.env.APPDATA,
      USERPROFILE: process.env.USERPROFILE,
      HOME: process.env.HOME,
    };
    try {
      delete process.env.ANTIGRAVITY_LS_ADDRESS;
      delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      delete process.env.AGENTBUS_AGY_DAEMON_DIR;
      process.env.APPDATA = path.join(emptyAgyHome98, 'AppData', 'Roaming');
      process.env.USERPROFILE = emptyAgyHome98;
      process.env.HOME = emptyAgyHome98;
      exportAgySession(path.join(agyBase98, 'out_sess.json'));
    } catch (err) {
      missingSessErr98 = String(err?.message || err);
    } finally {
      for (const [k, v] of Object.entries(prevEnvAgy98)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    assertCase(98, 'src/bin 无本机硬编码路径；daemonDirs 支持三平台与 AGENTBUS_AGY_DAEMON_DIR 多路径；缺失会话清晰报错',
      hardcodedHits98.length === 0 &&
      dirsWin98[0] === path.resolve(agyOv1_98) &&
      dirsWin98[1] === path.resolve(agyOv2_98) &&
      dirsWin98.includes(path.join(agyWinHome98, '.gemini', 'antigravity', 'daemon')) &&
      dirsWin98.includes(path.join(agyWinAppData98, 'Antigravity', 'daemon')) &&
      dirsMac98[0] === path.resolve(agyOv1_98) &&
      dirsMac98.includes(path.join(agyMacHome98, '.gemini', 'antigravity', 'daemon')) &&
      dirsLin98[0] === path.join(agyLinHome98, '.gemini', 'antigravity', 'daemon') &&
      foundSess98?.ls_address === 'http://127.0.0.1:45678' &&
      foundSess98?.csrf_token === 'tok-98' &&
      /集成终端/.test(missingSessErr98),
      `hits=${hardcodedHits98.join(',')} win=${JSON.stringify(dirsWin98)} err=${missingSessErr98}`);

    // 99. watch 立即退出语义：done(0)、blocked(1)、failed(1)、stalled/lease_expired(1)，单行 JSON 且无 history
    const watchRoot99 = path.join(RUN_BASE, 'watch_root_99');
    const watchWork99 = path.join(RUN_BASE, 'watch_work_99');
    fs.mkdirSync(watchWork99, { recursive: true });
    const watchAllow99 = [watchRoot99, watchWork99, DEMO_REFS].join(path.delimiter);
    runCli(['init'], { root: watchRoot99, allowed: watchAllow99 });
    const refFile99 = path.join(watchWork99, 'ref99.txt');
    fs.writeFileSync(refFile99, 'watch-99', 'utf8');
    const put99 = runCli(['put', refFile99, '--by', 'hermes'], { root: watchRoot99, allowed: watchAllow99 }).json;
    const res99 = path.join(watchWork99, 'res99.json');
    fs.writeFileSync(res99, JSON.stringify({ ok: true, tag: 'watch-99' }), 'utf8');

    // 99a: already done
    const tDone99 = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'watch-done', '--ref', put99.sha256], { root: watchRoot99, allowed: watchAllow99 }).json.id;
    const clDone99 = runCli(['claim', tDone99, '--by', 'codex'], { root: watchRoot99, allowed: watchAllow99 }).json;
    runCli(['done', tDone99, '--by', 'codex', '--lease', clDone99.lease_token, '--result', res99], { root: watchRoot99, allowed: watchAllow99 });
    const wDone99 = runCli(['watch', tDone99, '--json'], { root: watchRoot99, allowed: watchAllow99 });
    const wDoneLines99 = wDone99.stdout.trim().split(/\r?\n/);

    // 99b: blocked
    const tBlk99 = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'watch-blocked', '--ref', put99.sha256], { root: watchRoot99, allowed: watchAllow99 }).json.id;
    const clBlk99 = runCli(['claim', tBlk99, '--by', 'codex'], { root: watchRoot99, allowed: watchAllow99 }).json;
    runCli(['message', tBlk99, '--by', 'codex', '--lease', clBlk99.lease_token, '--kind', 'blocked', '--body', 'need input'], { root: watchRoot99, allowed: watchAllow99 });
    const wBlk99 = runCli(['watch', tBlk99, '--json'], { root: watchRoot99, allowed: watchAllow99 });

    // 99c: failed
    const tFail99 = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'watch-failed', '--ref', put99.sha256], { root: watchRoot99, allowed: watchAllow99 }).json.id;
    const clFail99 = runCli(['claim', tFail99, '--by', 'codex'], { root: watchRoot99, allowed: watchAllow99 }).json;
    runCli(['fail', tFail99, '--by', 'codex', '--lease', clFail99.lease_token, '--reason', 'boom'], { root: watchRoot99, allowed: watchAllow99 });
    const wFail99 = runCli(['watch', tFail99, '--json'], { root: watchRoot99, allowed: watchAllow99 });

    // 99d: stalled (unreaped expired lease detected read-only)
    const tStall99 = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'watch-stalled', '--ref', put99.sha256], { root: watchRoot99, allowed: watchAllow99 }).json.id;
    runCli(['claim', tStall99, '--by', 'codex', '--ttl', '1'], { root: watchRoot99, allowed: watchAllow99 });
    const stallDb99 = new DatabaseSync(path.join(watchRoot99, 'agentbus.db'));
    stallDb99.prepare('UPDATE tasks SET lease_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 5000).toISOString(), tStall99);
    stallDb99.close();
    const wStall99 = runCli(['watch', tStall99, '--json'], { root: watchRoot99, allowed: watchAllow99 });

    assertCase(99, 'watch 立即检查：done(0) 输出 result 且无 history；blocked/failed/stalled 立即 exit 1',
      wDone99.rc === 0 &&
      wDoneLines99.length === 1 &&
      wDone99.json?.id === tDone99 &&
      wDone99.json?.state === 'done' &&
      Boolean(wDone99.json?.finished_at) &&
      wDone99.json?.result?.bytes > 0 &&
      wDone99.json?.stalled === false &&
      wDone99.json?.waited_s !== undefined &&
      !('history' in (wDone99.json || {})) &&
      wBlk99.rc === 1 &&
      wBlk99.json?.blocked === true &&
      Boolean(wBlk99.json?.blocked_at) &&
      wFail99.rc === 1 &&
      wFail99.json?.state === 'failed' &&
      wStall99.rc === 1 &&
      wStall99.json?.stalled === true,
      `done=${wDone99.rc}:${JSON.stringify(wDone99.json)} blk=${wBlk99.rc} fail=${wFail99.rc} stall=${wStall99.rc}:${JSON.stringify(wStall99.json)}`);

    // 100. watch 轮询 open/claimed -> done（含 fake DB 与非 TTY stdin 关闭），超时 exit 3，非法 interval exit 1
    const fakeWatchDb100 = path.join(RUN_BASE, 'fake_watch_100.db');
    {
      const fdb = new DatabaseSync(fakeWatchDb100);
      fdb.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, attempt INTEGER DEFAULT 0, lease_expires_at TEXT, blocked_at TEXT, finished_at TEXT, result_json TEXT, history_json TEXT)');
      fdb.prepare("INSERT INTO tasks (id, state, attempt, history_json) VALUES (?, 'open', 0, '[]')").run('tfake100');
      fdb.close();
    }
    const fakeWatchDir100 = path.join(RUN_BASE, 'fake_watch_root_100');
    fs.mkdirSync(fakeWatchDir100, { recursive: true });
    fs.copyFileSync(fakeWatchDb100, path.join(fakeWatchDir100, 'agentbus.db'));
    const childWatch100 = spawn(process.execPath, [BUS_BIN, 'watch', 'tfake100', '--root', fakeWatchDir100, '--interval', '2', '--timeout', '15', '--json'], {
      cwd: PKG_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let cwOut100 = '';
    let cwErr100 = '';
    childWatch100.stdout.on('data', (d) => { cwOut100 += d.toString('utf8'); });
    childWatch100.stderr.on('data', (d) => { cwErr100 += d.toString('utf8'); });
    setTimeout(() => {
      const fdb2 = new DatabaseSync(path.join(fakeWatchDir100, 'agentbus.db'));
      fdb2.prepare("UPDATE tasks SET state = 'claimed' WHERE id = 'tfake100'").run();
      fdb2.close();
    }, 300);
    setTimeout(() => {
      const fdb3 = new DatabaseSync(path.join(fakeWatchDir100, 'agentbus.db'));
      fdb3.prepare("UPDATE tasks SET state = 'done', finished_at = ?, result_json = ? WHERE id = 'tfake100'")
        .run(new Date().toISOString(), JSON.stringify({ ok: true, from: 'fake-db' }));
      fdb3.close();
    }, 800);
    const cwCode100 = await new Promise((resolve) => childWatch100.on('exit', resolve));
    const cwJson100 = (() => { try { return JSON.parse(cwOut100); } catch { return null; } })();

    // Timeout exit 3 & invalid interval exit 1
    const tOpen100 = runCli(['new', '--to', 'codex', '--from', 'hermes', '--goal', 'watch-timeout', '--ref', put99.sha256], { root: watchRoot99, allowed: watchAllow99 }).json.id;
    const wTimeout100 = runCli(['watch', tOpen100, '--interval', '2', '--timeout', '1', '--json'], { root: watchRoot99, allowed: watchAllow99 });
    const wBadInt100 = runCli(['watch', tOpen100, '--interval', '1'], { root: watchRoot99, allowed: watchAllow99 });

    assertCase(100, 'watch 在非 TTY(stdin=ignore) 下轮询 fake DB 到 done(rc=0)；超时 exit 3；非法 interval exit 1',
      cwCode100 === 0 &&
      !/tty/i.test(cwErr100) &&
      cwJson100?.state === 'done' &&
      cwJson100?.result?.from === 'fake-db' &&
      cwJson100?.waited_s >= 1 &&
      cwJson100?.waited_s <= 6 &&
      wTimeout100.rc === 3 &&
      wTimeout100.json?.timed_out === true &&
      wBadInt100.rc === 1,
      `cw=${cwCode100}:${cwOut100}:${cwErr100} timeout=${wTimeout100.rc}:${JSON.stringify(wTimeout100.json)} badInt=${wBadInt100.rc}`);

    // 101. dispatch 默认返回值不变；dispatch --watch 在异步 adapter 后继续等待至 done(0) 与 timeout(3)
    const asyncAdapter101 = path.join(RUN_BASE, 'async_adapter_101.mjs');
    fs.writeFileSync(asyncAdapter101, [
      "console.log(JSON.stringify({ conversationId: 'async-conv-101' }));",
      "process.exit(0);",
    ].join('\n'), 'utf8');
    const envDisp101 = {
      AGENTBUS_ENABLE_DISPATCH: '1',
      AGENTBUS_ADAPTER_ASYNCFAKE: JSON.stringify({ command: process.execPath, args: [asyncAdapter101, '{prompt}'] }),
    };
    const tDispDef101 = runCli(['new', '--to', 'asyncfake', '--from', 'hermes', '--goal', 'disp-default', '--ref', put99.sha256], { root: watchRoot99, allowed: watchAllow99 }).json.id;
    const resDef101 = runCli(['dispatch', tDispDef101, '--cwd', watchWork99, '--wait', '1'], { root: watchRoot99, allowed: watchAllow99, envExtra: envDisp101 });

    const tDispWatch101 = runCli(['new', '--to', 'asyncfake', '--from', 'hermes', '--goal', 'disp-watch-ok', '--ref', put99.sha256], { root: watchRoot99, allowed: watchAllow99 }).json.id;
    const childDispWatch101 = spawn(process.execPath, [
      BUS_BIN, 'dispatch', tDispWatch101, '--root', watchRoot99, '--cwd', watchWork99, '--wait', '1', '--force', '--watch', '--interval', '2', '--timeout', '15',
    ], {
      cwd: PKG_ROOT,
      env: { ...process.env, AGENTBUS_ALLOWED_ROOTS: watchAllow99, ...envDisp101 },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let dwOut101 = '';
    childDispWatch101.stdout.on('data', (d) => { dwOut101 += d.toString('utf8'); });
    setTimeout(() => {
      const cl = runCli(['claim', tDispWatch101, '--by', 'asyncfake'], { root: watchRoot99, allowed: watchAllow99 }).json;
      if (cl?.lease_token) {
        runCli(['done', tDispWatch101, '--by', 'asyncfake', '--lease', cl.lease_token, '--result', res99], { root: watchRoot99, allowed: watchAllow99 });
      }
    }, 5800);
    const dwCode101 = await new Promise((resolve) => childDispWatch101.on('exit', resolve));
    const dwJson101 = (() => { try { return JSON.parse(dwOut101); } catch { return null; } })();

    const tDispTo101 = runCli(['new', '--to', 'asyncfake', '--from', 'hermes', '--goal', 'disp-watch-timeout', '--ref', put99.sha256], { root: watchRoot99, allowed: watchAllow99 }).json.id;
    const dwTo101 = runCli(['dispatch', tDispTo101, '--cwd', watchWork99, '--wait', '1', '--force', '--watch', '--interval', '2', '--timeout', '1'], {
      root: watchRoot99, allowed: watchAllow99, envExtra: envDisp101,
    });

    assertCase(101, 'dispatch 默认行为/返回值字段不变；dispatch --watch 等到 done(0) 与超时(3)',
      resDef101.rc === 1 &&
      resDef101.json?.state === 'open' &&
      !('watch' in (resDef101.json || {})) &&
      !('timed_out' in (resDef101.json || {})) &&
      Boolean(resDef101.json?.hint) &&
      dwCode101 === 0 &&
      dwJson101?.state === 'done' &&
      dwJson101?.dispatched === true &&
      dwJson101?.watch?.state === 'done' &&
      dwTo101.rc === 3 &&
      dwTo101.json?.timed_out === true,
      `def=${JSON.stringify(resDef101.json)} dw=${dwCode101}:${dwOut101.slice(0, 200)} dwTo=${dwTo101.rc}`);

    // 102. doctorBootstrap 纯函数：node_sqlite、allowed_roots、agents_json
    const {
      doctorBootstrap,
      checkNodeSqlite,
      evaluateAllowedRoots,
      evaluateAgentsJson,
      evaluateStaleMcp,
    } = await import('../src/setup.js');

    const nsOk102 = await checkNodeSqlite({ nodeVersion: 'v22.13.0', sqliteAvailable: true });
    const ns23Ok102 = await checkNodeSqlite({ nodeVersion: 'v23.4.0', sqliteAvailable: true });
    const nsLowVer102 = await checkNodeSqlite({ nodeVersion: 'v20.18.0', sqliteAvailable: true });
    const nsNoSqlite102 = await checkNodeSqlite({ nodeVersion: 'v22.12.0', sqliteAvailable: false });

    const arBase102 = path.join(RUN_BASE, 'ar_102');
    const arSub102 = path.join(arBase102, 'proj');
    const arOut102 = path.join(RUN_BASE, 'ar_outside_102');
    fs.mkdirSync(arSub102, { recursive: true });
    fs.mkdirSync(arOut102, { recursive: true });
    const arPass102 = evaluateAllowedRoots({ allowedRoots: [arBase102], cwd: arSub102 });
    const arFail102 = evaluateAllowedRoots({ allowedRoots: [arBase102], cwd: arOut102 });

    const agDirMissing102 = path.join(RUN_BASE, 'ag_missing_102');
    const agDirEmpty102 = path.join(RUN_BASE, 'ag_empty_102');
    const agDirBad102 = path.join(RUN_BASE, 'ag_bad_102');
    const agDirOk102 = path.join(RUN_BASE, 'ag_ok_102');
    for (const d of [agDirMissing102, agDirEmpty102, agDirBad102, agDirOk102]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(agDirEmpty102, 'agents.json'), JSON.stringify({ conductor: 'hermes', models: { codex: '' } }), 'utf8');
    fs.writeFileSync(path.join(agDirBad102, 'agents.json'), '{broken json', 'utf8');
    fs.writeFileSync(path.join(agDirOk102, 'agents.json'), JSON.stringify({ conductor: 'hermes', models: { codex: 'gpt-5' }, archive_on_done: false }), 'utf8');

    const agMiss102 = evaluateAgentsJson({ root: agDirMissing102, env: {} });
    const agEmp102 = evaluateAgentsJson({ root: agDirEmpty102, env: {} });
    const agBad102 = evaluateAgentsJson({ root: agDirBad102, env: {} });
    const agOk102 = evaluateAgentsJson({ root: agDirOk102, env: {} });

    assertCase(102, 'doctorBootstrap 纯函数：node_sqlite 版本/sqlite、allowed_roots、agents_json(缺/空模型/损坏/正常)',
      nsOk102.status === 'pass' &&
      ns23Ok102.status === 'pass' &&
      nsLowVer102.status === 'fail' &&
      nsNoSqlite102.status === 'fail' &&
      arPass102.status === 'pass' &&
      arFail102.status === 'fail' &&
      agMiss102.status === 'warn' &&
      agEmp102.status === 'warn' &&
      agBad102.status === 'fail' &&
      agOk102.status === 'pass',
      JSON.stringify({ nsLowVer102, arFail102, agMiss102, agEmp102, agBad102, agOk102 }));

    // 103. doctorBootstrap 纯函数：clients(无客户端warn)、archive_cdp、stale_mcp(mock进程)
    const bsHomeEmpty103 = path.join(RUN_BASE, 'bs_home_empty_103');
    const bsRootOk103 = path.join(RUN_BASE, 'bs_root_ok_103');
    const bsWork103 = path.join(RUN_BASE, 'bs_work_103');
    fs.mkdirSync(bsHomeEmpty103, { recursive: true });
    fs.mkdirSync(bsWork103, { recursive: true });
    runCli(['init'], { root: bsRootOk103, allowed: bsWork103 });
    fs.writeFileSync(path.join(bsRootOk103, 'agents.json'), JSON.stringify({ conductor: 'hermes', models: { codex: 'gpt-5' }, archive_on_done: false }), 'utf8');

    const bsClean103 = await doctorBootstrap({
      root: bsRootOk103,
      home: bsHomeEmpty103,
      cwd: bsWork103,
      env: { PATH: '', AGENTBUS_ALLOWED_ROOTS: bsWork103 },
      processes: [],
      codeMtimeMs: 1000,
    });
    const mapClean103 = Object.fromEntries(bsClean103.checks.map((c) => [c.id, c]));

    const bsCheckArchiveFail103 = await doctorBootstrap({
      root: bsRootOk103,
      home: bsHomeEmpty103,
      cwd: bsWork103,
      env: { PATH: '', AGENTBUS_ALLOWED_ROOTS: bsWork103 },
      checkArchive: true,
      probeCdp: async () => ({ reachable: false, hasAntigravityPage: false, error: 'ECONNREFUSED' }),
      processes: [],
    });

    const bsArchiveWarn103 = await doctorBootstrap({
      root: bsRootOk103,
      home: bsHomeEmpty103,
      cwd: bsWork103,
      env: { PATH: '', AGENTBUS_ALLOWED_ROOTS: bsWork103, AGENTBUS_ARCHIVE_ON_DONE: '1' },
      probeCdp: async () => ({ reachable: false, hasAntigravityPage: false, error: 'ECONNREFUSED' }),
      processes: [],
    });

    const bsStaleFail103 = await doctorBootstrap({
      root: bsRootOk103,
      home: bsHomeEmpty103,
      cwd: bsWork103,
      env: { PATH: '', AGENTBUS_ALLOWED_ROOTS: bsWork103 },
      processes: [{ pid: 99999, createdAtMs: 500, commandLine: 'node /app/bin/bus.js mcp --root /var' }],
      codeMtimeMs: 1000,
    });
    const staleFresh103 = evaluateStaleMcp({
      processes: [{ pid: 99998, createdAtMs: 1500, commandLine: 'node /app/bin/bus.js mcp --root /var' }],
      codeMtimeMs: 1000,
    });
    const staleErr103 = evaluateStaleMcp({ probeError: 'ps failed' });

    assertCase(103, 'doctorBootstrap 纯函数：无客户端标 warn 不 fail；archive_cdp 仅开启/--check-archive 探测；stale_mcp 准确判定',
      bsClean103.ok === true &&
      mapClean103.clients?.status === 'warn' &&
      mapClean103.archive_cdp?.status === 'pass' &&
      mapClean103.stale_mcp?.status === 'pass' &&
      bsCheckArchiveFail103.ok === false &&
      bsCheckArchiveFail103.checks.find((c) => c.id === 'archive_cdp')?.status === 'fail' &&
      bsArchiveWarn103.ok === true &&
      bsArchiveWarn103.checks.find((c) => c.id === 'archive_cdp')?.status === 'warn' &&
      bsStaleFail103.ok === false &&
      bsStaleFail103.checks.find((c) => c.id === 'stale_mcp')?.status === 'fail' &&
      staleFresh103.status === 'pass' &&
      staleErr103.status === 'warn',
      `clean=${JSON.stringify(bsClean103.summary)} archFail=${bsCheckArchiveFail103.ok} staleFail=${bsStaleFail103.ok}`);

    // 104. doctor --bootstrap CLI 端到端：7 项 id 齐全、只读不建文件、只读 DB / 越界 cwd exit 1、非法参数 exit 2
    const bsCliHome104 = path.join(RUN_BASE, 'bs_cli_home_104');
    const bsCliUninit104 = path.join(RUN_BASE, 'bs_cli_uninit_104');
    fs.mkdirSync(bsCliHome104, { recursive: true });
    const bsCliRun104 = runCli(['doctor', '--bootstrap', '--root', bsCliUninit104, '--home', bsCliHome104, '--cwd', bsWork103, '--json'], {
      root: bsCliUninit104,
      allowed: bsWork103,
      envExtra: isolatedNoBinEnv,
    });
    const bsIds104 = (bsCliRun104.json?.checks || []).map((c) => c.id);
    const expectedIds104 = ['node_sqlite', 'bus_root', 'allowed_roots', 'agents_json', 'clients', 'archive_cdp', 'stale_mcp'];
    const idsMatch104 = JSON.stringify(bsIds104) === JSON.stringify(expectedIds104);
    const allValidStatus104 = (bsCliRun104.json?.checks || []).every((c) => ['pass', 'warn', 'fail'].includes(c.status) && 'detail' in c && 'fix' in c);
    const nothingCreated104 = !fs.existsSync(bsCliUninit104) && fs.readdirSync(bsCliHome104).length === 0;

    // Read-only DB -> bus_root fail & exit 1
    const bsRoRoot104 = path.join(RUN_BASE, 'bs_ro_root_104');
    runCli(['init'], { root: bsRoRoot104, allowed: bsWork103 });
    const bsRoDb104 = path.join(bsRoRoot104, 'agentbus.db');
    let bsRoRun104 = null;
    try {
      fs.chmodSync(bsRoDb104, 0o444);
      bsRoRun104 = runCli(['doctor', '--bootstrap', '--root', bsRoRoot104, '--home', bsCliHome104, '--cwd', bsWork103, '--json'], {
        root: bsRoRoot104,
        allowed: bsWork103,
      });
    } finally {
      try { fs.chmodSync(bsRoDb104, 0o666); } catch {}
    }

    // Invalid flag -> exit 2
    const bsBadCmd104 = runCli(['doctor', '--bootstrap', '--port', 'notaport'], { root: bsRootOk103, allowed: bsWork103 });

    assertCase(104, 'doctor --bootstrap CLI：输出 7 项检查、严格只读不建文件、只读 DB exit 1、命令异常 exit 2',
      (bsCliRun104.rc === 0 || bsCliRun104.rc === 1) &&
      idsMatch104 &&
      allValidStatus104 &&
      nothingCreated104 &&
      bsRoRun104?.rc === 1 &&
      bsRoRun104?.json?.ok === false &&
      bsRoRun104?.json?.checks?.find((c) => c.id === 'bus_root')?.status === 'fail' &&
      bsBadCmd104.rc === 2,
      `rc=${bsCliRun104.rc} ids=${bsIds104.join(',')} created=${!nothingCreated104} ro=${bsRoRun104?.rc} bad=${bsBadCmd104.rc}`);

    // 105. UI 模块清单完整性、无个人模型硬编码、从本地 agents.json 动态解析或显示未配置
    const uiModulesRaw105 = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'src', 'ui', 'modules.json'), 'utf8'));
    const uiHtml105 = fs.readFileSync(path.join(PKG_ROOT, 'src', 'ui', 'index.html'), 'utf8');
    const uiDoc105 = fs.readFileSync(path.join(PKG_ROOT, 'docs', 'UI.md'), 'utf8');
    const reqModIds105 = ['db', 'tasks', 'store', 'dispatch', 'agy', 'setup', 'agents', 'context', 'threads', 'mcp', 'bin', 'docs', 'tests', 'ui'];
    const modFieldsOk105 = Array.isArray(uiModulesRaw105) &&
      reqModIds105.every((id) => uiModulesRaw105.some((m) => m.id === id)) &&
      uiModulesRaw105.every((m) => (
        m.id && m.label && m.layer && Array.isArray(m.paths) && m.paths.length > 0 &&
        m.owner_agent && m.owner_model && m.summary && m.status
      ));
    const uiEntry105 = uiModulesRaw105.find((m) => m.id === 'ui');
    const uiSources105 = [
      JSON.stringify(uiModulesRaw105),
      uiHtml105,
      uiDoc105,
      fs.readFileSync(path.join(PKG_ROOT, 'src', 'ui', 'server.js'), 'utf8'),
    ].join('\n');
    const noPersonalLeak105 = !/gpt-?6\.2-?sol|gpt-?6\.1-?terra|Neon\s*高|极高|sk-[A-Za-z0-9]{20,}/i.test(uiSources105);
    const noCdnInHtml105 = !/https?:\/\/cdn\.|fonts\.googleapis\.com|<script[^>]+src=["']https?:/i.test(uiHtml105);

    const { loadModulesCatalog, startUiServer } = await import('../src/ui/server.js');
    const uiEmptyRoot105 = path.join(RUN_BASE, 'ui_empty_105');
    const uiCfgRoot105 = path.join(RUN_BASE, 'ui_cfg_105');
    fs.mkdirSync(uiCfgRoot105, { recursive: true });
    fs.writeFileSync(path.join(uiCfgRoot105, 'agents.json'), JSON.stringify({
      conductor: 'hermes',
      models: { antigravity: 'gemini-4-neon', codex: 'gpt-5-codex' },
    }), 'utf8');

    const prevAgyModel105 = process.env.AGENTBUS_AGY_MODEL;
    const prevAgentsCfg105 = process.env.AGENTBUS_AGENTS_CONFIG;
    let catEmpty105;
    let catCfg105;
    try {
      delete process.env.AGENTBUS_AGY_MODEL;
      delete process.env.AGENTBUS_AGENTS_CONFIG;
      catEmpty105 = loadModulesCatalog({ rootDir: uiEmptyRoot105, pkgRoot: PKG_ROOT });
      catCfg105 = loadModulesCatalog({ rootDir: uiCfgRoot105, pkgRoot: PKG_ROOT });
    } finally {
      if (prevAgyModel105 === undefined) delete process.env.AGENTBUS_AGY_MODEL;
      else process.env.AGENTBUS_AGY_MODEL = prevAgyModel105;
      if (prevAgentsCfg105 === undefined) delete process.env.AGENTBUS_AGENTS_CONFIG;
      else process.env.AGENTBUS_AGENTS_CONFIG = prevAgentsCfg105;
    }

    assertCase(105, 'UI 模块清单覆盖 14 核心模块、字段完整、无个人模型硬编码、按 agents.json 动态解析或显示未配置',
      modFieldsOk105 &&
      uiEntry105?.owner_agent === 'antigravity' &&
      noPersonalLeak105 &&
      noCdnInHtml105 &&
      catEmpty105.modules.every((m) => m.owner_model === '未配置') &&
      catCfg105.modules.find((m) => m.id === 'ui')?.owner_model === 'gemini-4-neon' &&
      catCfg105.modules.find((m) => m.id === 'db')?.owner_model === 'gpt-5-codex',
      `fields=${modFieldsOk105} leak=${!noPersonalLeak105} cdn=${!noCdnInHtml105} uiModel=${catCfg105.modules.find((m) => m.id === 'ui')?.owner_model}`);

    // 106. agentbus ui CLI 真实进程在临时端口启动、GET 严格只读、拒绝非 loopback 绑定
    const uiCliRoot106 = path.join(RUN_BASE, 'ui_cli_ro_106');
    const uiChildEnv106 = { ...process.env, AGENTBUS_ALLOWED_ROOTS: WORK_DIR };
    delete uiChildEnv106.AGENTBUS_AGY_MODEL;
    delete uiChildEnv106.AGENTBUS_AGENTS_CONFIG;

    const badHost106 = runCli(['ui', '--host', '0.0.0.0', '--port', '0', '--no-open'], {
      root: uiCliRoot106,
      allowed: WORK_DIR,
      envExtra: uiChildEnv106,
    });

    const uiProc106 = spawn(process.execPath, [BUS_BIN, 'ui', '--port', '0', '--no-open', '--root', uiCliRoot106], {
      cwd: PKG_ROOT,
      env: uiChildEnv106,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let uiCliInfo106 = null;
    let uiCliHtml106 = '';
    let uiCliMods106 = null;
    let uiCliAgents106 = null;
    let uiCliTasks106 = null;
    let uiCliRoAfterGet106 = false;
    try {
      uiCliInfo106 = await new Promise((resolve, reject) => {
        let out = '';
        let err = '';
        const timer = setTimeout(() => reject(new Error(`ui start timeout; out=${out}; err=${err}`)), 8000);
        uiProc106.stderr.on('data', (d) => { err += d.toString('utf8'); });
        uiProc106.stdout.on('data', (d) => {
          out += d.toString('utf8');
          const nl = out.indexOf('\n');
          if (nl >= 0) {
            clearTimeout(timer);
            try { resolve(JSON.parse(out.slice(0, nl))); } catch (e) { reject(e); }
          }
        });
        uiProc106.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`ui exited early (${code}): ${err}`));
        });
      });

      const rHtml106 = await fetch(`${uiCliInfo106.url}/`);
      uiCliHtml106 = await rHtml106.text();
      const rMods106 = await fetch(`${uiCliInfo106.url}/api/modules`);
      uiCliMods106 = await rMods106.json();
      const rAgents106 = await fetch(`${uiCliInfo106.url}/api/agents`);
      uiCliAgents106 = await rAgents106.json();
      const rTasks106 = await fetch(`${uiCliInfo106.url}/api/tasks`);
      uiCliTasks106 = await rTasks106.json();
      uiCliRoAfterGet106 = !fs.existsSync(uiCliRoot106);
    } finally {
      try { uiProc106.kill(); } catch {}
    }

    assertCase(106, 'agentbus ui 真实子进程绑定 loopback、打印 URL、GET 严格只读不建库、拒绝 0.0.0.0',
      badHost106.rc === 1 &&
      Boolean(uiCliInfo106?.ok && /^http:\/\/127\.0\.0\.1:\d+$/.test(uiCliInfo106?.url || '')) &&
      uiCliHtml106.includes('agentbus 模块可视化调度面板') &&
      uiCliMods106?.ok === true &&
      uiCliMods106?.module_count >= 14 &&
      uiCliAgents106?.ok === true &&
      uiCliTasks106?.ok === true &&
      uiCliTasks106?.db_exists === false &&
      uiCliRoAfterGet106,
      `badHost=${badHost106.rc} url=${uiCliInfo106?.url} ro=${uiCliRoAfterGet106}`);

    // 107. POST /api/requests 创建真实 conductor 任务（临时 root，不写配置，默认不 dispatch）
    const uiReqRoot107 = path.join(RUN_BASE, 'ui_req_107');
    fs.mkdirSync(uiReqRoot107, { recursive: true });
    fs.writeFileSync(path.join(uiReqRoot107, 'agents.json'), JSON.stringify({
      conductor: 'hermes',
      models: { hermes: 'hermes-pro', antigravity: 'gemini-4-neon', codex: 'gpt-5-codex' },
    }), 'utf8');

    let dispatchCalls107 = 0;
    const prevAgy107 = process.env.AGENTBUS_AGY_MODEL;
    const prevCfg107 = process.env.AGENTBUS_AGENTS_CONFIG;
    delete process.env.AGENTBUS_AGY_MODEL;
    delete process.env.AGENTBUS_AGENTS_CONFIG;

    const srv107 = await startUiServer({
      rootOverride: uiReqRoot107,
      host: '127.0.0.1',
      port: 0,
      dispatch: false,
      dispatchFn: async () => {
        dispatchCalls107++;
        return { state: 'done' };
      },
      pkgRoot: PKG_ROOT,
    });

    let post107Json = null;
    let post107Status = 0;
    let shown107 = null;
    let tasksAfter107 = null;
    try {
      const rPost107 = await fetch(`${srv107.url}/api/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module_ids: ['db', 'ui'],
          action: 'optimize',
          target_agent: 'antigravity',
          target_model: 'gemini-4-neon',
          notes: '审计只读连接与索引性能',
        }),
      });
      post107Status = rPost107.status;
      post107Json = await rPost107.json();
      shown107 = runCli(['show', post107Json.task_id], { root: uiReqRoot107, allowed: WORK_DIR }).json;
      tasksAfter107 = await (await fetch(`${srv107.url}/api/tasks`)).json();

      // 108. 非法模块 id / 非法 agent / 非法 model / 超长 body / 错误方法返回稳定 JSON + createTask 幂等清洗
      const rBadMod108 = await fetch(`${srv107.url}/api/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module_ids: ['../evil'], action: 'optimize' }),
      });
      const jBadMod108 = await rBadMod108.json();

      const rBadAgent108 = await fetch(`${srv107.url}/api/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module_ids: ['ui'], action: 'optimize', target_agent: 'unconfigured_bot' }),
      });
      const jBadAgent108 = await rBadAgent108.json();

      const rBadModel108 = await fetch(`${srv107.url}/api/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module_ids: ['ui'], action: 'adjust_model', target_agent: 'antigravity', target_model: 'nonexistent-model' }),
      });
      const jBadModel108 = await rBadModel108.json();

      const rBig108 = await fetch(`${srv107.url}/api/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module_ids: ['ui'], action: 'inspect', notes: 'x'.repeat(40000) }),
      });
      const jBig108 = await rBig108.json();

      const r404_108 = await fetch(`${srv107.url}/api/nope`);
      const j404_108 = await r404_108.json();
      const r405_108 = await fetch(`${srv107.url}/api/requests`, { method: 'GET' });
      const j405_108 = await r405_108.json();

      // Whitespace-only idempotency_key must not collide
      const wsKeyA108 = runCli(['new', '--to', 'codex', '--goal', 'ws-a', '--key', '   '], { root: uiReqRoot107, allowed: WORK_DIR });
      const wsKeyB108 = runCli(['new', '--to', 'codex', '--goal', 'ws-b', '--key', '   '], { root: uiReqRoot107, allowed: WORK_DIR });

      assertCase(107, 'POST /api/requests 写入发给 conductor 的真实任务，goal 含模块/路径/动作/模型且默认不 dispatch',
        post107Status === 201 &&
        post107Json?.ok === true &&
        post107Json?.to === 'hermes' &&
        post107Json?.dispatched === false &&
        dispatchCalls107 === 0 &&
        Boolean(post107Json?.dispatch_command) &&
        shown107?.to === 'hermes' &&
        shown107?.state === 'open' &&
        shown107?.goal?.includes('db') &&
        shown107?.goal?.includes('src/db.js') &&
        shown107?.goal?.includes('ui') &&
        shown107?.goal?.includes('src/ui/server.js') &&
        shown107?.goal?.includes('optimize') &&
        shown107?.goal?.includes('gemini-4-neon') &&
        shown107?.goal?.includes('审计只读连接与索引性能') &&
        tasksAfter107?.tasks?.some((t) => t.id === post107Json.task_id),
        `status=${post107Status} disp=${dispatchCalls107} to=${shown107?.to}`);

      assertCase(108, 'POST /api/requests 拒绝非法模块/agent/model/超长 body/未知路由且均返回 JSON；空白 key 不碰撞',
        rBadMod108.status === 400 && jBadMod108.code === 'invalid_module_id' &&
        rBadAgent108.status === 400 && jBadAgent108.code === 'invalid_agent' &&
        rBadModel108.status === 400 && jBadModel108.code === 'invalid_model' &&
        rBig108.status === 413 && jBig108.code === 'payload_too_large' &&
        r404_108.status === 404 && j404_108.ok === false &&
        r405_108.status === 405 && j405_108.ok === false &&
        wsKeyA108.rc === 0 && wsKeyB108.rc === 0 &&
        wsKeyA108.json?.id !== wsKeyB108.json?.id &&
        wsKeyB108.json?.dedup === false,
        `mod=${rBadMod108.status} ag=${rBadAgent108.status} mdl=${rBadModel108.status} big=${rBig108.status} ws=${wsKeyA108.json?.id}:${wsKeyB108.json?.id}`);

      // 109. 显式 dispatch:true 才走 dispatch 路径（mock），dispatch 异常仍返回 JSON + task_id；MCP 工具数不退化
      const dispatchedIds109 = [];
      const srvDisp109 = await startUiServer({
        rootOverride: uiReqRoot107,
        host: '127.0.0.1',
        port: 0,
        dispatch: false,
        dispatchFn: async (_bus, opts) => {
          dispatchedIds109.push(opts.id);
          if (dispatchedIds109.length === 2) {
            throw new Error('simulated dispatch failure');
          }
          return { id: opts.id, state: 'done', dispatched: true };
        },
        pkgRoot: PKG_ROOT,
      });
      let rDispOk109;
      let jDispOk109;
      let rDispErr109;
      let jDispErr109;
      try {
        rDispOk109 = await fetch(`${srvDisp109.url}/api/requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ module_ids: ['ui'], action: 'inspect', dispatch: true }),
        });
        jDispOk109 = await rDispOk109.json();

        rDispErr109 = await fetch(`${srvDisp109.url}/api/requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ module_ids: ['db'], action: 'inspect', dispatch: true }),
        });
        jDispErr109 = await rDispErr109.json();
      } finally {
        await srvDisp109.close();
      }

      const mcpCheckCond109 = await runMcpSession(uiReqRoot107, WORK_DIR, [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      ], { AGENTBUS_ROLE: 'conductor' });
      const mcpCheckWork109 = await runMcpSession(uiReqRoot107, WORK_DIR, [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      ], { AGENTBUS_ROLE: 'worker' });
      const condToolCount109 = mcpCheckCond109.responses.find((r) => r.id === 2)?.result?.tools?.length;
      const workToolCount109 = mcpCheckWork109.responses.find((r) => r.id === 2)?.result?.tools?.length;

      assertCase(109, '显式 dispatch:true 走 dispatch 路径、异常返回结构化 JSON，且 MCP 15/9 工具列表完整未破坏',
        rDispOk109.status === 201 &&
        jDispOk109.dispatched === true &&
        jDispOk109.state === 'done' &&
        dispatchedIds109[0] === jDispOk109.task_id &&
        rDispErr109.status === 201 &&
        Boolean(jDispErr109.task_id) &&
        jDispErr109.dispatched === false &&
        String(jDispErr109.dispatch_error || '').includes('simulated dispatch failure') &&
        condToolCount109 === 15 &&
        workToolCount109 === 9,
        `ok=${JSON.stringify(jDispOk109)} err=${JSON.stringify(jDispErr109)} tools=${condToolCount109}/${workToolCount109}`);
    } finally {
      await srv107.close();
      if (prevAgy107 === undefined) delete process.env.AGENTBUS_AGY_MODEL;
      else process.env.AGENTBUS_AGY_MODEL = prevAgy107;
      if (prevCfg107 === undefined) delete process.env.AGENTBUS_AGENTS_CONFIG;
      else process.env.AGENTBUS_AGENTS_CONFIG = prevCfg107;
    }

    // 110. Antigravity 导出 session 失效保护：pid 死亡或 hub 版本/端口不匹配时自动回退到 live hub_*.json
    const { resolveAgySession, exportAgySession: exportAgy110 } = await import('../src/agy.js');
    const agyBase110 = path.join(RUN_BASE, 'agy_stale_110');
    const daemonDir110 = path.join(agyBase110, 'daemon');
    fs.mkdirSync(daemonDir110, { recursive: true });
    const liveHub110 = path.join(daemonDir110, `hub_${process.pid}.json`);
    const oldHub110 = path.join(daemonDir110, 'hub_999999.json');
    fs.writeFileSync(oldHub110, JSON.stringify({ httpPort: 54818, csrfToken: 'secret-old-tok', pid: 999999, version: '2.30.0' }), 'utf8');
    fs.writeFileSync(liveHub110, JSON.stringify({ httpPort: 59123, csrfToken: 'secret-live-tok', pid: process.pid, version: '2.35.1' }), 'utf8');

    const exportedFile110 = path.join(agyBase110, 'antigravity-session.json');
    // Case A: stale pid in exported session -> falls back to live hub
    fs.writeFileSync(exportedFile110, JSON.stringify({
      kind: 'antigravity-session',
      ls_address: 'http://127.0.0.1:54818',
      csrf_token: 'secret-old-tok',
      pid: 999999,
      version: '2.30.0',
    }), 'utf8');
    const resDeadPid110 = resolveAgySession({
      sessionFile: exportedFile110,
      daemonOpts: { env: { AGENTBUS_AGY_DAEMON_DIR: daemonDir110 } },
    });

    // Case B: live pid in exported file (or no pid), but hub port/version mismatches live hub -> falls back to live hub
    fs.writeFileSync(exportedFile110, JSON.stringify({
      kind: 'antigravity-session',
      ls_address: 'http://127.0.0.1:54818',
      csrf_token: 'secret-old-tok',
      version: '2.34.0',
    }), 'utf8');
    const resMismatch110 = resolveAgySession({
      sessionFile: exportedFile110,
      daemonOpts: { env: { AGENTBUS_AGY_DAEMON_DIR: daemonDir110 } },
    });

    // Case C: exportAgySession stores pid & does not print token
    const freshExport110 = path.join(agyBase110, 'fresh-session.json');
    const emptyHome110 = path.join(RUN_BASE, 'agy_empty_home_110');
    fs.mkdirSync(emptyHome110, { recursive: true });
    const expMeta110 = exportAgy110(freshExport110, {
      home: emptyHome110,
      platform: 'linux',
      env: { AGENTBUS_AGY_DAEMON_DIR: daemonDir110, HOME: emptyHome110 },
    });
    const expJson110 = JSON.parse(fs.readFileSync(freshExport110, 'utf8'));
    const expMetaStr110 = JSON.stringify(expMeta110);

    // Case D: dead pid & no live hub -> clear error without leaking token
    const emptyDaemon110 = path.join(RUN_BASE, 'agy_empty_daemon_110');
    fs.mkdirSync(emptyDaemon110, { recursive: true });
    fs.writeFileSync(exportedFile110, JSON.stringify({
      kind: 'antigravity-session',
      ls_address: 'http://127.0.0.1:54818',
      csrf_token: 'secret-old-tok',
      pid: 999999,
    }), 'utf8');
    let deadNoHubErr110 = '';
    try {
      resolveAgySession({
        sessionFile: exportedFile110,
        daemonOpts: {
          home: emptyHome110,
          platform: 'linux',
          env: { AGENTBUS_AGY_DAEMON_DIR: emptyDaemon110, HOME: emptyHome110 },
        },
        isPidAlive: () => false,
      });
    } catch (err) {
      deadNoHubErr110 = String(err?.message || err);
    }

    assertCase(110, 'agy session 失效保护：pid 不存活或 hub 版本/端口不匹配自动回退 live hub_*.json 且不泄漏 token',
      resDeadPid110.ls_address === 'http://127.0.0.1:59123' &&
      resDeadPid110.fallback === true &&
      resDeadPid110.stale_reason === 'pid_not_alive' &&
      resMismatch110.ls_address === 'http://127.0.0.1:59123' &&
      resMismatch110.fallback === true &&
      (resMismatch110.stale_reason === 'hub_version_mismatch' || resMismatch110.stale_reason === 'hub_port_mismatch') &&
      expMeta110.pid === process.pid &&
      expJson110.pid === process.pid &&
      !expMetaStr110.includes('secret-live-tok') &&
      /已退出|agy-session/.test(deadNoHubErr110) &&
      !deadNoHubErr110.includes('secret-old-tok'),
      `dead=${JSON.stringify({ addr: resDeadPid110.ls_address, r: resDeadPid110.stale_reason })} mismatch=${JSON.stringify({ addr: resMismatch110.ls_address, r: resMismatch110.stale_reason })} err=${deadNoHubErr110}`);
  } finally {
    try { fs.rmSync(RUN_BASE, { recursive: true, force: true }); } catch {}
  }

  console.log(`SUMMARY passed=${passed} failed=${failed} skipped=${skipped}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL in accept.mjs:', err);
  console.log(`SUMMARY passed=${passed} failed=${failed + 1}`);
  process.exit(1);
});
