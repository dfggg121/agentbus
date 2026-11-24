#!/usr/bin/env node
// agentbus self-acceptance suite: 39 assertions (§7)
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
  "const env = { ...process.env, AGENTBUS_ALLOWED_ROOTS: process.env.AGENTBUS_FAKE_ALLOWED };",
  "const run = (a) => execFileSync(process.execPath, [process.env.AGENTBUS_FAKE_BIN, ...a, '--root', process.env.AGENTBUS_FAKE_ROOT], { env, encoding: 'utf8' });",
  "const claim = JSON.parse(run(['claim', id, '--by', 'fake']));",
  "const out = path.join(process.env.AGENTBUS_FAKE_WORK, 'fake_' + id + '.json');",
  "fs.writeFileSync(out, JSON.stringify({ ok: true, agent: 'fake' }), 'utf8');",
  "run(['done', id, '--by', 'fake', '--lease', claim.lease_token, '--result', out]);",
  "console.log(JSON.stringify({ thread_id: process.env.AGENTBUS_FAKE_SESSION || 'fake-session-1' }));",
].join('\n'), 'utf8');

function fakeAdapterEnv(session = 'fake-session-1') {
  return {
    AGENTBUS_ADAPTER_FAKE: JSON.stringify({ command: process.execPath, args: [FAKE_AGENT, '{prompt}'] }),
    AGENTBUS_FAKE_BIN: BUS_BIN,
    AGENTBUS_FAKE_ROOT: ROOT_MAIN,
    AGENTBUS_FAKE_WORK: OUT_DIR,
    AGENTBUS_FAKE_ALLOWED: ALLOWED_MAIN,
    AGENTBUS_FAKE_SESSION: session,
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
