#!/usr/bin/env node
// agentbus self-acceptance suite: 65 assertions (§7)
// Pure Node built-ins, zero frameworks, zero shell pipes.
// Output: PASS n: <desc> / FAIL n: <desc> :: <actual>, ending with SUMMARY passed=x failed=y

import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
      'bus_task_list',
      'bus_verify',
      'bus_task_dispatch',
      'bus_task_wait',
      'bus_task_run',
    ];
    const actualToolNames = toolsResp.map((t) => t.name);
    const exactNine = toolsResp.length === 12 &&
      expectedTools.every((n) => actualToolNames.includes(n)) &&
      toolsResp.every((t) => t.inputSchema && t.inputSchema.type === 'object');
    assertCase(29, 'MCP tools/list 恰好 12 个工具，名字与 §4.1 一致且均有 inputSchema',
      exactNine,
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

    // 34. worker 角色：只看到 6 个工具，create/dispatch 被拒
    const workerSession = await runMcpSession(ROOT_MAIN, ALLOWED_MAIN, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'accept-worker', version: '1.0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bus_task_create', arguments: { to: 'codex', goal: 'blocked for workers' } } },
    ], { AGENTBUS_ROLE: 'worker' });
    const workerTools = workerSession.responses.find((r) => r.id === 2)?.result?.tools || [];
    const blockedCall = workerSession.responses.find((r) => r.id === 3)?.result;
    assertCase(34, 'worker 角色只看到 6 个工具，且 bus_task_create 被拒',
      workerTools.length === 6 &&
      !workerTools.some((t) => t.name === 'bus_task_create') &&
      blockedCall?.isError === true,
      `count=${workerTools.length} names=[${workerTools.map((t) => t.name).join(',')}] isError=${blockedCall?.isError}`);

    const unknownRoleSession = await runMcpSession(ROOT_MAIN, ALLOWED_MAIN, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'accept-role-typo', version: '1.0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ], { AGENTBUS_ROLE: 'boss' });
    const unknownTools = unknownRoleSession.responses.find((r) => r.id === 2)?.result?.tools || [];
    assertCase(67, '未知 AGENTBUS_ROLE 按 worker 最小权限处理（不泄漏 dispatch/create）',
      unknownTools.length === 6 && !unknownTools.some((t) => t.name === 'bus_task_dispatch'),
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
    const archDead = runCli(['archive', 'conv-dead', '--port', String(deadPort)]);
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
      assertCase(55, 'archive --dry-run 只做匹配不点击，返回 archived=false, dry_run=true',
        dryRes.rc === 0 && dryRes.json?.ok === true && dryRes.json?.archived === false && dryRes.json?.dry_run === true,
        `rc=${dryRes.rc} json=${JSON.stringify(dryRes.json)} err=${dryRes.stderr}`);

      mockMode = 'miss';
      const missRes = await runCliAsync(['archive', 'conv-missing', '--port', String(mockPort)]);
      mockMode = 'match';
      const hitRes = await runCliAsync(['archive', 'conv-mock-1', '--port', String(mockPort)]);
      assertCase(56, 'archive 未命中返回 row_not_found(rc=1)，命中返回 archived=true(rc=0)',
        missRes.rc === 1 && missRes.json?.ok === false && missRes.json?.reason === 'row_not_found' &&
        hitRes.rc === 0 && hitRes.json?.ok === true && hitRes.json?.archived === true,
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
