// Agent Design Tournament (V6): bounded proposal -> blind rubric scoring -> 1-round debate -> decision & gated implementation task.
// Zero third-party dependencies. Strictly enforces allowed_roots, SHA-256 pointer verification, no self-vote, and read-only GETs.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PKG_ROOT, openBus, openBusReadOnly } from '../db.js';
import { dispatchTask } from '../dispatch.js';
import { listClients } from '../setup.js';
import { getArtifact, registerArtifact, resolveAndValidatePath, sha256File, verifyRefIntegrity } from '../store.js';
import { addTaskMessage, createTask } from '../tasks.js';
import { detectClientSetup } from './client.js';
import {
  assertAllowedKeys,
  isAgentDispatchable,
  isPlainObject,
  makeHttpError,
  readProjectsStore,
  readTasksByIdsReadOnly,
  resolveProjectDevMaterialsDir,
  runUiDispatch,
  validateAgentAndModel,
  writeAtomicJson,
} from './project.js';

export const MEETING_SCHEMA = 'agentbus/meeting@1';
export const PROPOSAL_SCHEMA = 'agentbus/proposal@1';
export const VOTE_SCHEMA = 'agentbus/vote@1';
export const DECISION_SCHEMA = 'agentbus/decision@1';
export const DEBATE_SCHEMA = 'agentbus/meeting-debate@1';

export const RUBRIC_DIMENSIONS = ['creativity', 'feasibility', 'reliability', 'cost'];
export const DEFAULT_RUBRIC_WEIGHTS = {
  creativity: 30,
  feasibility: 30,
  reliability: 30,
  cost: 10,
};

const SAFE_MEETING_ID_RE = /^mtg_[a-zA-Z0-9_-]{4,64}$/;
const SAFE_PROJECT_ID_RE = /^p_[a-zA-Z0-9_-]{4,64}$/;
const SAFE_PROPOSAL_ID_RE = /^prop_[a-zA-Z0-9_-]{3,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;

const ALLOWED_CREATE_MEETING_KEYS = new Set([
  'project_id',
  'title',
  'brief_ref',
  'brief_path',
  'brief_text',
  'rubric',
  'proposers',
  'judges',
  'quorum',
  'tie_threshold',
  'anonymity',
  'created_by',
  'auto_start',
  'auto_dispatch',
  'wait_s',
]);

const ALLOWED_START_MEETING_KEYS = new Set(['auto_dispatch', 'wait_s']);
const ALLOWED_SYNC_MEETING_KEYS = new Set(['auto_dispatch', 'wait_s']);
const ALLOWED_VOTE_KEYS = new Set(['proposal_id', 'judge', 'scores', 'rationale', 'weighted_score']);
const ALLOWED_DEBATE_KEYS = new Set([
  'action',
  'author',
  'proposal_id',
  'message',
  'evidence_ref',
  'timeout_s',
  'summary',
  'auto_dispatch',
  'wait_s',
]);
const ALLOWED_DECIDE_KEYS = new Set([
  'winner_proposal_id',
  'rationale',
  'dissent',
  'human_approved',
  'high_impact',
  'irreversible',
  'decided_by',
  'auto_dispatch',
  'wait_s',
]);

function meetingsBaseDir(rootDir) {
  return path.join(rootDir, 'meetings');
}

function meetingDir(rootDir, meetingId) {
  return path.join(meetingsBaseDir(rootDir), meetingId);
}

function meetingFilePath(rootDir, meetingId) {
  return path.join(meetingDir(rootDir, meetingId), 'meeting.json');
}

function proposalSlotWorkDir(rootDir, meetingId, proposalId) {
  return path.join(meetingDir(rootDir, meetingId), 'proposals', proposalId);
}

function votesBaseDir(rootDir, meetingId) {
  return path.join(meetingDir(rootDir, meetingId), 'votes');
}

function debateFilePath(rootDir, meetingId) {
  return path.join(meetingDir(rootDir, meetingId), 'debate.json');
}

function decisionFilePath(rootDir, meetingId) {
  return path.join(meetingDir(rootDir, meetingId), 'decision.json');
}

function readJsonFileSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeTieThreshold(raw) {
  if (raw === undefined || raw === null || raw === '') return 0.08;
  let num;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.endsWith('%')) {
      const pct = Number(trimmed.slice(0, -1).trim());
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        throw makeHttpError(400, 'invalid_tie_threshold', `tie_threshold 非法: ${raw}`);
      }
      return Number((pct / 100).toFixed(4));
    }
    num = Number(trimmed);
  } else {
    num = Number(raw);
  }
  if (!Number.isFinite(num) || num < 0 || num > 100) {
    throw makeHttpError(400, 'invalid_tie_threshold', `tie_threshold 必须是 0-1 小数或 0-100 百分比: ${raw}`);
  }
  return num > 1 ? Number((num / 100).toFixed(4)) : Number(num.toFixed(4));
}

function normalizeRubric(rawRubric) {
  if (rawRubric === undefined || rawRubric === null) {
    return {
      dimensions: [...RUBRIC_DIMENSIONS],
      scale: { min: 0, max: 5 },
      weights: { ...DEFAULT_RUBRIC_WEIGHTS },
    };
  }
  if (!isPlainObject(rawRubric)) {
    throw makeHttpError(400, 'invalid_rubric', 'rubric 必须是 JSON 对象');
  }
  const rawWeights = isPlainObject(rawRubric.weights) ? rawRubric.weights : rawRubric;
  const weights = {};
  let total = 0;
  for (const dim of RUBRIC_DIMENSIONS) {
    const val = rawWeights[dim] === undefined ? DEFAULT_RUBRIC_WEIGHTS[dim] : Number(rawWeights[dim]);
    if (!Number.isFinite(val) || val < 0 || val > 1000) {
      throw makeHttpError(400, 'invalid_rubric', `rubric 权重 ${dim} 必须是非负有限数字`);
    }
    weights[dim] = val;
    total += val;
  }
  if (total <= 0) {
    throw makeHttpError(400, 'invalid_rubric', 'rubric 权重总和必须大于 0');
  }
  return {
    dimensions: [...RUBRIC_DIMENSIONS],
    scale: { min: 0, max: 5 },
    weights,
  };
}

export function computeWeightedScore(scores, rubric) {
  const weights = rubric?.weights || DEFAULT_RUBRIC_WEIGHTS;
  let sum = 0;
  let totalWeight = 0;
  for (const dim of RUBRIC_DIMENSIONS) {
    const w = Number(weights[dim] ?? DEFAULT_RUBRIC_WEIGHTS[dim]);
    const s = Number(scores[dim]);
    sum += s * w;
    totalWeight += w;
  }
  if (totalWeight <= 0) return 0;
  return Number((sum / totalWeight).toFixed(4));
}

function normalizeParticipantList(rawList, roleName, { clientById, knownSet }) {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw makeHttpError(400, `missing_${roleName}`, `${roleName} 必须是非空数组`);
  }
  if (rawList.length > 10) {
    throw makeHttpError(400, `too_many_${roleName}`, `${roleName} 最多允许 10 个`);
  }
  const out = [];
  for (const item of rawList) {
    let rawAgent = '';
    let rawModel = '';
    if (typeof item === 'string') {
      rawAgent = item.trim();
    } else if (isPlainObject(item)) {
      rawAgent = typeof item.agent === 'string' ? item.agent.trim() : '';
      rawModel = typeof item.model === 'string' ? item.model.trim() : '';
    } else {
      throw makeHttpError(400, `invalid_${roleName}`, `${roleName} 元素必须是字符串或 {agent, model} 对象`);
    }
    const validated = validateAgentAndModel({
      agent: rawAgent,
      model: rawModel,
      clientById,
      knownSet,
      allowEmptyAgent: false,
    });
    out.push({ agent: validated.agent, model: validated.model || '' });
  }
  return out;
}

function resolveAndRegisterBriefRef(bus, { brief_ref, brief_path, brief_text, meetingId, createdBy }) {
  if (brief_ref !== undefined && brief_ref !== null) {
    if (typeof brief_ref === 'string') {
      const sha = brief_ref.trim().toLowerCase();
      if (!SHA256_RE.test(sha)) {
        throw makeHttpError(400, 'invalid_brief_ref', 'brief_ref 字符串必须是已登记的 64 位 sha256');
      }
      const art = getArtifact(bus, sha);
      if (!art) {
        throw makeHttpError(400, 'invalid_brief_ref', `未找到已登记的 brief_ref sha256: ${sha.slice(0, 16)}...`);
      }
      const check = verifyRefIntegrity({ name: art.name, uri: art.uri, sha256: art.sha256 }, bus.config);
      if (!check.ok) {
        throw makeHttpError(400, 'invalid_brief_ref', `brief_ref 校验失败: ${check.reason}`);
      }
      return { name: art.name, uri: art.uri, sha256: art.sha256, bytes: art.bytes };
    }
    if (!isPlainObject(brief_ref)) {
      throw makeHttpError(400, 'invalid_brief_ref', 'brief_ref 必须是 {uri, sha256} 对象或 64 位 sha256');
    }
    const rawSha = typeof brief_ref.sha256 === 'string' ? brief_ref.sha256.trim().toLowerCase() : '';
    if (!SHA256_RE.test(rawSha)) {
      throw makeHttpError(400, 'invalid_brief_ref', 'brief_ref 必须包含有效的 64 位 sha256');
    }
    if (brief_ref.uri && typeof brief_ref.uri === 'string') {
      let validated;
      try {
        validated = resolveAndValidatePath(brief_ref.uri, bus.config, { checkSize: true });
      } catch (err) {
        throw makeHttpError(400, 'invalid_brief_ref', `brief_ref 路径无效: ${err.message}`);
      }
      const actualSha = sha256File(validated.fsPath);
      if (actualSha !== rawSha) {
        throw makeHttpError(400, 'brief_ref_hash_mismatch', 'brief_ref sha256 与磁盘文件内容不匹配');
      }
      const reg = registerArtifact(bus, {
        filePath: validated.fsPath,
        name: typeof brief_ref.name === 'string' && brief_ref.name.trim() ? brief_ref.name.trim() : null,
        by: createdBy,
      });
      return { name: reg.name, uri: reg.uri, sha256: reg.sha256, bytes: reg.bytes };
    }
    const art = getArtifact(bus, rawSha);
    if (!art) {
      throw makeHttpError(400, 'invalid_brief_ref', `未找到已登记的 brief_ref sha256: ${rawSha.slice(0, 16)}...`);
    }
    const check = verifyRefIntegrity({ name: art.name, uri: art.uri, sha256: art.sha256 }, bus.config);
    if (!check.ok) {
      throw makeHttpError(400, 'invalid_brief_ref', `brief_ref 校验失败: ${check.reason}`);
    }
    return { name: art.name, uri: art.uri, sha256: art.sha256, bytes: art.bytes };
  }

  if (typeof brief_path === 'string' && brief_path.trim()) {
    try {
      const reg = registerArtifact(bus, {
        filePath: brief_path.trim(),
        name: 'brief.md',
        by: createdBy,
      });
      return { name: reg.name, uri: reg.uri, sha256: reg.sha256, bytes: reg.bytes };
    } catch (err) {
      throw makeHttpError(400, 'invalid_brief_ref', `brief_path 注册失败: ${err.message}`);
    }
  }

  if (typeof brief_text === 'string' && brief_text.trim()) {
    const trimmed = brief_text.trim();
    if (trimmed.length > 16000) {
      throw makeHttpError(400, 'invalid_brief_ref', 'brief_text 不能超过 16000 字符');
    }
    const mDir = meetingDir(bus.config.rootDir, meetingId);
    fs.mkdirSync(mDir, { recursive: true });
    const briefFile = path.join(mDir, 'brief.md');
    fs.writeFileSync(briefFile, trimmed + '\n', 'utf8');
    const reg = registerArtifact(bus, {
      filePath: briefFile,
      name: 'brief.md',
      by: createdBy,
    });
    return { name: reg.name, uri: reg.uri, sha256: reg.sha256, bytes: reg.bytes };
  }

  throw makeHttpError(400, 'missing_brief_ref', '创建方案会议必须提供 brief_ref（或 brief_path / brief_text）');
}

function validateRefPointer(refObj, config, { label = 'ref' } = {}) {
  if (!isPlainObject(refObj)) {
    return { ok: false, error: `${label} 必须是包含 uri 与 sha256 的对象` };
  }
  const sha = typeof refObj.sha256 === 'string' ? refObj.sha256.trim().toLowerCase() : '';
  if (!SHA256_RE.test(sha)) {
    return { ok: false, error: `${label} 缺少有效的 64 位 sha256` };
  }
  const rawUri = typeof refObj.uri === 'string' ? refObj.uri.trim() : '';
  if (!rawUri) {
    return { ok: false, error: `${label} 缺少 uri` };
  }
  let validated;
  try {
    validated = resolveAndValidatePath(rawUri, config, { checkSize: true });
  } catch (err) {
    return { ok: false, error: `${label} 路径校验失败: ${err.message}` };
  }
  const actualSha = sha256File(validated.fsPath);
  if (actualSha !== sha) {
    return { ok: false, error: `${label} SHA-256 校验失败 (drift: expected=${sha.slice(0, 12)}, actual=${actualSha.slice(0, 12)})` };
  }
  return {
    ok: true,
    fsPath: validated.fsPath,
    ref: {
      name: typeof refObj.name === 'string' && refObj.name.trim() ? refObj.name.trim() : path.basename(validated.fsPath),
      uri: validated.uri,
      sha256: sha,
      bytes: validated.stat.size,
    },
  };
}

function isSubPathOrSame(parentDir, childPath) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function validateProposalTaskOutput(meeting, slot, task, config) {
  if (!task) return { status: slot.status || 'pending', proposal: slot.proposal || null, error: slot.error || null };
  if (slot.status === 'valid' && slot.proposal) {
    return { status: 'valid', proposal: slot.proposal, error: null };
  }
  if (slot.status === 'failed') {
    return { status: 'failed', proposal: null, error: slot.error || '提案校验失败' };
  }
  if (task.state === 'failed') {
    const errText = task.last_message?.body || task.history?.[task.history.length - 1]?.reason || '提案任务失败';
    return { status: 'failed', proposal: null, error: errText };
  }
  if (task.state !== 'done') {
    return { status: 'pending', proposal: null, error: null };
  }

  // Task is done: validate result file integrity & schema
  if (!task.result?.uri || !task.result?.sha256) {
    return { status: 'failed', proposal: null, error: '提案任务已完成但缺少 result uri/sha256' };
  }
  const resCheck = validateRefPointer(task.result, config, { label: 'proposal_result' });
  if (!resCheck.ok) {
    return { status: 'failed', proposal: null, error: resCheck.error };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resCheck.fsPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    return { status: 'failed', proposal: null, error: `提案结果不是合法 JSON: ${err.message}` };
  }
  if (!isPlainObject(raw)) {
    return { status: 'failed', proposal: null, error: '提案结果必须是 JSON 对象' };
  }
  if (raw.schema !== PROPOSAL_SCHEMA) {
    return { status: 'failed', proposal: null, error: `提案 schema 不匹配：期望 ${PROPOSAL_SCHEMA}，实际 ${String(raw.schema ?? '')}` };
  }
  if (raw.meeting_id !== meeting.id) {
    return { status: 'failed', proposal: null, error: `提案 meeting_id 不匹配：期望 ${meeting.id}` };
  }
  if (raw.proposal_id !== undefined && raw.proposal_id !== null && String(raw.proposal_id).trim() !== slot.proposal_id) {
    return { status: 'failed', proposal: null, error: `提案 proposal_id 不匹配：期望 ${slot.proposal_id}` };
  }

  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary || summary.length > 4000) {
    return { status: 'failed', proposal: null, error: '提案缺少有效 summary（或超过 4000 字符）' };
  }
  if (!Array.isArray(raw.risks)) {
    return { status: 'failed', proposal: null, error: '提案缺少 risks 数组' };
  }
  const risks = raw.risks.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 30);
  if (!Array.isArray(raw.tests)) {
    return { status: 'failed', proposal: null, error: '提案缺少 tests 数组' };
  }
  const tests = raw.tests.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 30);
  const costEst = raw.cost_estimate;
  if (costEst === undefined || costEst === null || (typeof costEst === 'string' && !costEst.trim()) || (typeof costEst === 'number' && !Number.isFinite(costEst))) {
    return { status: 'failed', proposal: null, error: '提案缺少有效的 cost_estimate' };
  }

  const designCheck = validateRefPointer(raw.design_ref, config, { label: 'design_ref' });
  if (!designCheck.ok) {
    return { status: 'failed', proposal: null, error: designCheck.error };
  }

  // Isolation check: design_ref must not point into another proposer's isolated directory
  for (const other of meeting.proposal_slots || []) {
    if (other.proposal_id !== slot.proposal_id && other.work_dir && fs.existsSync(other.work_dir)) {
      try {
        const realOther = fs.realpathSync(other.work_dir);
        if (isSubPathOrSame(realOther, designCheck.fsPath)) {
          return { status: 'failed', proposal: null, error: `安全拒绝：design_ref 指向其他提案者隔离目录 (${other.proposal_id})` };
        }
      } catch {}
    }
  }

  return {
    status: 'valid',
    error: null,
    proposal: {
      schema: PROPOSAL_SCHEMA,
      proposal_id: slot.proposal_id,
      alias: slot.alias,
      meeting_id: meeting.id,
      author: slot.agent,
      model: slot.model || '',
      design_ref: designCheck.ref,
      summary,
      risks,
      tests,
      cost_estimate: costEst,
      created_at: typeof raw.created_at === 'string' && raw.created_at.trim() ? raw.created_at.trim() : (task.finished_at || new Date().toISOString()),
    },
  };
}

function readVotesFromDisk(rootDir, meetingId) {
  const dir = votesBaseDir(rootDir, meetingId);
  if (!fs.existsSync(dir)) return [];
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const votes = [];
  for (const f of files) {
    const parsed = readJsonFileSafe(path.join(dir, f));
    if (parsed && parsed.schema === VOTE_SCHEMA && parsed.meeting_id === meetingId) {
      votes.push(parsed);
    }
  }
  votes.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return votes;
}

function collectMeetingTaskIds(meetings) {
  const ids = [];
  for (const m of meetings || []) {
    for (const s of m.proposal_slots || []) {
      if (s?.task_id) ids.push(s.task_id);
    }
    for (const jt of m.judge_tasks || []) {
      if (jt?.task_id) ids.push(jt.task_id);
    }
    if (m._debate?.task_id) ids.push(m._debate.task_id);
    if (m._decision?.implementation_task_id) ids.push(m._decision.implementation_task_id);
  }
  return ids;
}

function evaluateMeetingScoresAndStatus(meeting, hydratedSlots, votes, debate, decision) {
  const validSlots = hydratedSlots.filter((s) => s.status === 'valid' && s.proposal);
  const failedSlots = hydratedSlots.filter((s) => s.status === 'failed');
  const pendingSlots = hydratedSlots.filter((s) => s.status === 'pending');

  const votesByProposal = new Map();
  for (const s of validSlots) {
    votesByProposal.set(s.proposal_id, []);
  }
  for (const v of votes) {
    if (votesByProposal.has(v.proposal_id)) {
      votesByProposal.get(v.proposal_id).push(v);
    }
  }

  const scoreBoard = validSlots.map((s) => {
    const pVotes = votesByProposal.get(s.proposal_id) || [];
    const voteCount = pVotes.length;
    const avgWeighted = voteCount > 0
      ? Number((pVotes.reduce((acc, v) => acc + Number(v.weighted_score || 0), 0) / voteCount).toFixed(4))
      : null;
    const dimAvg = {};
    for (const dim of RUBRIC_DIMENSIONS) {
      dimAvg[dim] = voteCount > 0
        ? Number((pVotes.reduce((acc, v) => acc + Number(v.scores?.[dim] || 0), 0) / voteCount).toFixed(4))
        : null;
    }
    return {
      proposal_id: s.proposal_id,
      alias: s.alias,
      author: s.agent,
      vote_count: voteCount,
      avg_weighted_score: avgWeighted,
      dimension_averages: dimAvg,
    };
  });

  scoreBoard.sort((a, b) => {
    if (a.avg_weighted_score === null && b.avg_weighted_score === null) return 0;
    if (a.avg_weighted_score === null) return 1;
    if (b.avg_weighted_score === null) return -1;
    return b.avg_weighted_score - a.avg_weighted_score;
  });

  const quorum = Number(meeting.quorum || 2);
  const quorumMet = validSlots.length >= 1 && scoreBoard.every((row) => row.vote_count >= quorum);
  const totalRequiredVotes = validSlots.length * quorum;
  const totalCastVotes = scoreBoard.reduce((acc, r) => acc + r.vote_count, 0);

  const scoredRows = scoreBoard.filter((r) => r.avg_weighted_score !== null);
  let tieCheck = {
    evaluated: false,
    tied_top: false,
    within_tie_threshold: false,
    high_score_insufficient_quorum: false,
    should_debate: false,
    reason: null,
    top_score: scoredRows[0]?.avg_weighted_score ?? null,
    second_score: scoredRows[1]?.avg_weighted_score ?? null,
    score_gap: null,
    score_gap_ratio: null,
  };

  if (scoredRows.length >= 2) {
    const top1 = scoredRows[0].avg_weighted_score;
    const top2 = scoredRows[1].avg_weighted_score;
    const gap = Number((top1 - top2).toFixed(4));
    const gapRatio = Number((gap / 5).toFixed(4));
    const tiedTop = Math.abs(gap) < 1e-9;
    const withinThreshold = gapRatio < Number(meeting.tie_threshold ?? 0.08);
    const highInsufficient = !quorumMet && top1 >= 3.0 && top2 >= 3.0;
    const shouldDebate = (quorumMet && (tiedTop || withinThreshold)) || highInsufficient;
    let reason = null;
    if (tiedTop) reason = 'tied_top';
    else if (quorumMet && withinThreshold) reason = 'tie_threshold';
    else if (highInsufficient) reason = 'insufficient_quorum_high_scores';

    tieCheck = {
      evaluated: true,
      tied_top: tiedTop,
      within_tie_threshold: withinThreshold,
      high_score_insufficient_quorum: highInsufficient,
      should_debate: shouldDebate,
      reason,
      top_score: top1,
      second_score: top2,
      score_gap: gap,
      score_gap_ratio: gapRatio,
    };
  }

  let effectiveDebate = debate ? { ...debate } : null;
  if (effectiveDebate && effectiveDebate.status === 'active' && effectiveDebate.expires_at) {
    if (Date.now() >= Date.parse(effectiveDebate.expires_at)) {
      effectiveDebate.status = 'timed_out';
    }
  }

  let effectiveStatus = meeting.status || 'draft';
  if (decision) {
    effectiveStatus = 'decided';
  } else if (effectiveDebate) {
    effectiveStatus = 'debating';
  } else if (effectiveStatus === 'proposing') {
    if (pendingSlots.length === 0) {
      effectiveStatus = validSlots.length === 0 ? 'failed' : 'judging';
    }
  }
  if (effectiveStatus === 'judging' && quorumMet && (tieCheck.tied_top || tieCheck.within_tie_threshold) && !effectiveDebate) {
    effectiveStatus = 'debating';
  }

  return {
    effectiveStatus,
    effectiveDebate,
    scoreBoard,
    quorumMet,
    tieCheck,
    validSlots,
    failedSlots,
    pendingSlots,
    totalCastVotes,
    totalRequiredVotes,
  };
}

function hydrateMeetingRecord(rawMeeting, { rootDir, taskMap, env = process.env, config }) {
  const votes = readVotesFromDisk(rootDir, rawMeeting.id);
  const diskDebate = readJsonFileSafe(debateFilePath(rootDir, rawMeeting.id));
  const diskDecision = readJsonFileSafe(decisionFilePath(rootDir, rawMeeting.id));

  const hydratedSlots = (rawMeeting.proposal_slots || []).map((slot) => {
    const pTask = slot.task_id ? (taskMap.get(slot.task_id) || null) : null;
    const validated = validateProposalTaskOutput(rawMeeting, slot, pTask, config);
    const taskState = pTask ? pTask.state : (slot.task_id ? 'missing' : 'none');
    const awaitingMainAgent = Boolean(
      slot.task_id &&
      !isAgentDispatchable(pTask?.to || slot.agent, env) &&
      (taskState === 'open' || taskState === 'claimed')
    );
    return {
      ...slot,
      status: validated.status,
      error: validated.error,
      proposal: validated.proposal,
      task: pTask
        ? {
            id: pTask.id,
            to: pTask.to,
            state: pTask.state,
            claimed_by: pTask.claimed_by,
            blocked: pTask.blocked,
            finished_at: pTask.finished_at,
            result: pTask.result,
            awaiting_main_agent: awaitingMainAgent,
            dispatched: Boolean(slot.dispatched),
            dispatch_error: slot.dispatch_error || null,
            dispatch_command: `node bin/bus.js dispatch ${pTask.id} --allow-dispatch --root "${rootDir}"`,
          }
        : null,
    };
  });

  const hydratedJudgeTasks = (rawMeeting.judge_tasks || []).map((jt) => {
    const jTask = jt.task_id ? (taskMap.get(jt.task_id) || null) : null;
    const taskState = jTask ? jTask.state : (jt.task_id ? 'missing' : 'none');
    return {
      ...jt,
      state: taskState,
      awaiting_main_agent: Boolean(
        jt.task_id &&
        !isAgentDispatchable(jTask?.to || jt.agent, env) &&
        (taskState === 'open' || taskState === 'claimed')
      ),
      dispatch_command: jt.task_id
        ? `node bin/bus.js dispatch ${jt.task_id} --allow-dispatch --root "${rootDir}"`
        : null,
    };
  });

  const evalRes = evaluateMeetingScoresAndStatus(rawMeeting, hydratedSlots, votes, diskDebate, diskDecision);

  let hydratedDebate = evalRes.effectiveDebate;
  if (hydratedDebate?.task_id) {
    const dTask = taskMap.get(hydratedDebate.task_id) || null;
    hydratedDebate = {
      ...hydratedDebate,
      task_state: dTask?.state || 'missing',
      awaiting_main_agent: Boolean(
        dTask &&
        !isAgentDispatchable(dTask.to, env) &&
        (dTask.state === 'open' || dTask.state === 'claimed')
      ),
      dispatch_command: `node bin/bus.js dispatch ${hydratedDebate.task_id} --allow-dispatch --root "${rootDir}"`,
    };
  }

  let hydratedDecision = diskDecision ? { ...diskDecision } : null;
  if (hydratedDecision?.implementation_task_id) {
    const impTask = taskMap.get(hydratedDecision.implementation_task_id) || null;
    hydratedDecision.implementation_task = impTask
      ? {
          id: impTask.id,
          to: impTask.to,
          state: impTask.state,
          claimed_by: impTask.claimed_by,
          finished_at: impTask.finished_at,
          awaiting_main_agent: !isAgentDispatchable(impTask.to, env) && (impTask.state === 'open' || impTask.state === 'claimed'),
          dispatch_command: `node bin/bus.js dispatch ${impTask.id} --allow-dispatch --root "${rootDir}"`,
        }
      : null;
  }

  const awaitingHumanApproval = Boolean(hydratedDecision && hydratedDecision.human_approved !== true);
  const awaitingMainAgent = Boolean(
    hydratedSlots.some((s) => s.task?.awaiting_main_agent) ||
    hydratedJudgeTasks.some((j) => j.awaiting_main_agent) ||
    hydratedDebate?.awaiting_main_agent ||
    hydratedDecision?.implementation_task?.awaiting_main_agent
  );

  return {
    schema: MEETING_SCHEMA,
    id: rawMeeting.id,
    project_id: rawMeeting.project_id,
    title: rawMeeting.title,
    brief_ref: rawMeeting.brief_ref,
    rubric: rawMeeting.rubric,
    proposers: rawMeeting.proposers,
    judges: rawMeeting.judges,
    status: evalRes.effectiveStatus,
    anonymity: rawMeeting.anonymity !== false,
    quorum: rawMeeting.quorum,
    tie_threshold: rawMeeting.tie_threshold,
    max_rounds: 1,
    created_by: rawMeeting.created_by || '',
    created_at: rawMeeting.created_at,
    updated_at: rawMeeting.updated_at,
    started_at: rawMeeting.started_at || null,
    decided_at: hydratedDecision?.decided_at || rawMeeting.decided_at || null,
    decision_id: hydratedDecision?.decision_id || rawMeeting.decision_id || null,
    decision_ref: rawMeeting.decision_ref || null,
    awaiting_human_approval: awaitingHumanApproval,
    awaiting_main_agent: awaitingMainAgent,
    proposal_count: hydratedSlots.length,
    valid_proposal_count: evalRes.validSlots.length,
    failed_proposal_count: evalRes.failedSlots.length,
    pending_proposal_count: evalRes.pendingSlots.length,
    quorum_met: evalRes.quorumMet,
    voting_progress: {
      cast_votes: evalRes.totalCastVotes,
      required_votes: evalRes.totalRequiredVotes,
      quorum: rawMeeting.quorum,
      quorum_met: evalRes.quorumMet,
    },
    highest_score: evalRes.scoreBoard[0]?.avg_weighted_score ?? null,
    tie_check: evalRes.tieCheck,
    proposal_slots: hydratedSlots,
    proposals: evalRes.validSlots.map((s) => s.proposal),
    judge_tasks: hydratedJudgeTasks,
    votes,
    score_board: evalRes.scoreBoard,
    debate: hydratedDebate,
    decision: hydratedDecision,
  };
}

export function buildAnonymousMeetingView(hydrated) {
  const aliasByProposalId = new Map((hydrated.proposal_slots || []).map((s) => [s.proposal_id, s.alias]));
  return {
    schema: hydrated.schema,
    id: hydrated.id,
    project_id: hydrated.project_id,
    title: hydrated.title,
    brief_ref: hydrated.brief_ref,
    rubric: hydrated.rubric,
    status: hydrated.status,
    anonymity: hydrated.anonymity,
    quorum: hydrated.quorum,
    tie_threshold: hydrated.tie_threshold,
    max_rounds: hydrated.max_rounds,
    created_at: hydrated.created_at,
    updated_at: hydrated.updated_at,
    started_at: hydrated.started_at,
    decided_at: hydrated.decided_at,
    decision_id: hydrated.decision_id,
    decision_ref: hydrated.decision_ref,
    awaiting_human_approval: hydrated.awaiting_human_approval,
    proposal_count: hydrated.proposal_count,
    valid_proposal_count: hydrated.valid_proposal_count,
    failed_proposal_count: hydrated.failed_proposal_count,
    pending_proposal_count: hydrated.pending_proposal_count,
    quorum_met: hydrated.quorum_met,
    voting_progress: hydrated.voting_progress,
    highest_score: hydrated.highest_score,
    tie_check: hydrated.tie_check,
    judges: (hydrated.judges || []).map((j) => ({ agent: j.agent, model: j.model || '' })),
    proposal_slots: (hydrated.proposal_slots || []).map((s) => ({
      proposal_id: s.proposal_id,
      alias: s.alias,
      status: s.status,
      error: s.error || null,
    })),
    proposals: (hydrated.proposals || []).map((p) => ({
      schema: p.schema,
      proposal_id: p.proposal_id,
      alias: p.alias || aliasByProposalId.get(p.proposal_id) || p.proposal_id,
      meeting_id: p.meeting_id,
      design_ref: p.design_ref,
      summary: p.summary,
      risks: p.risks,
      tests: p.tests,
      cost_estimate: p.cost_estimate,
      created_at: p.created_at,
    })),
    votes: hydrated.votes,
    score_board: (hydrated.score_board || []).map((row) => ({
      proposal_id: row.proposal_id,
      alias: row.alias,
      vote_count: row.vote_count,
      avg_weighted_score: row.avg_weighted_score,
      dimension_averages: row.dimension_averages,
    })),
    debate: hydrated.debate
      ? {
          schema: hydrated.debate.schema,
          debate_id: hydrated.debate.debate_id,
          meeting_id: hydrated.debate.meeting_id,
          round: hydrated.debate.round,
          max_rounds: hydrated.debate.max_rounds,
          status: hydrated.debate.status,
          reason: hydrated.debate.reason,
          participants: (hydrated.debate.participants || []).map((pt) => ({
            proposal_id: pt.proposal_id,
            alias: pt.alias,
          })),
          critiques: (hydrated.debate.critiques || []).map((c) => ({
            proposal_id: c.proposal_id,
            alias: c.alias || aliasByProposalId.get(c.proposal_id) || c.proposal_id,
            message: c.message,
            evidence_ref: c.evidence_ref || null,
            created_at: c.created_at,
          })),
          summary: hydrated.debate.summary || null,
          timeout_s: hydrated.debate.timeout_s,
          expires_at: hydrated.debate.expires_at,
          started_at: hydrated.debate.started_at,
          closed_at: hydrated.debate.closed_at || null,
        }
      : null,
  };
}

export function buildInternalMeetingView(hydrated) {
  return hydrated;
}

function readAllRawMeetings(rootDir) {
  const base = meetingsBaseDir(rootDir);
  if (!fs.existsSync(base)) return [];
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || !SAFE_MEETING_ID_RE.test(ent.name)) continue;
    const raw = readJsonFileSafe(meetingFilePath(rootDir, ent.name));
    if (!raw || raw.schema !== MEETING_SCHEMA || raw.id !== ent.name) continue;
    const diskDebate = readJsonFileSafe(debateFilePath(rootDir, ent.name));
    const diskDecision = readJsonFileSafe(decisionFilePath(rootDir, ent.name));
    out.push({ ...raw, _debate: diskDebate, _decision: diskDecision });
  }
  out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return out;
}

function loadRawMeetingOrThrow(rootDir, meetingId) {
  if (!SAFE_MEETING_ID_RE.test(String(meetingId || ''))) {
    throw makeHttpError(400, 'invalid_meeting_id', `非法 meeting id: ${meetingId}`);
  }
  const raw = readJsonFileSafe(meetingFilePath(rootDir, meetingId));
  if (!raw || raw.schema !== MEETING_SCHEMA) {
    throw makeHttpError(404, 'meeting_not_found', `找不到方案会议: ${meetingId}`);
  }
  return raw;
}

function saveMeetingFile(rootDir, rawMeeting) {
  writeAtomicJson(meetingFilePath(rootDir, rawMeeting.id), rawMeeting);
}

function reconcileMeetingStateOnDisk(rawMeeting, { config, taskMap }) {
  let changed = false;
  const nextSlots = (rawMeeting.proposal_slots || []).map((slot) => {
    const task = slot.task_id ? taskMap.get(slot.task_id) : null;
    if (!task) return slot;
    const res = validateProposalTaskOutput(rawMeeting, slot, task, config);
    if (res.status !== slot.status || res.error !== slot.error) {
      changed = true;
      const updatedSlot = {
        ...slot,
        status: res.status,
        error: res.error,
        proposal: res.proposal,
      };
      if (res.status === 'valid' && res.proposal) {
        fs.mkdirSync(slot.work_dir, { recursive: true });
        writeAtomicJson(path.join(slot.work_dir, 'validated_proposal.json'), res.proposal);
      }
      return updatedSlot;
    }
    return slot;
  });

  const votes = readVotesFromDisk(config.rootDir, rawMeeting.id);
  const diskDebate = readJsonFileSafe(debateFilePath(config.rootDir, rawMeeting.id));
  const diskDecision = readJsonFileSafe(decisionFilePath(config.rootDir, rawMeeting.id));

  if (diskDebate && diskDebate.status === 'active' && diskDebate.expires_at && Date.now() >= Date.parse(diskDebate.expires_at)) {
    diskDebate.status = 'timed_out';
    diskDebate.closed_at = new Date().toISOString();
    writeAtomicJson(debateFilePath(config.rootDir, rawMeeting.id), diskDebate);
  }

  const evalRes = evaluateMeetingScoresAndStatus(rawMeeting, nextSlots, votes, diskDebate, diskDecision);
  if (evalRes.effectiveStatus !== rawMeeting.status) {
    changed = true;
  }

  const nextMeeting = {
    ...rawMeeting,
    proposal_slots: nextSlots,
    status: evalRes.effectiveStatus,
    ...(changed ? { updated_at: new Date().toISOString() } : {}),
  };
  if (changed) {
    saveMeetingFile(config.rootDir, nextMeeting);
  }
  return { nextMeeting, votes, debate: diskDebate, decision: diskDecision, evalRes };
}

function buildProposalTaskGoal({ meeting, slot }) {
  const weights = meeting.rubric?.weights || DEFAULT_RUBRIC_WEIGHTS;
  const outJsonPath = path.join(slot.work_dir, 'proposal.json');
  const outDesignPath = path.join(slot.work_dir, 'design.md');
  const example = JSON.stringify({
    schema: PROPOSAL_SCHEMA,
    proposal_id: slot.proposal_id,
    meeting_id: meeting.id,
    author: slot.agent,
    design_ref: {
      uri: pathToFileURL(outDesignPath).href,
      sha256: '<64-hex-sha256-of-design.md>',
    },
    summary: '一句话方案概述与核心权衡',
    risks: ['主要技术或交付风险'],
    tests: ['可验证测试与回归策略'],
    cost_estimate: 'medium (约 2 人日)',
    created_at: new Date().toISOString(),
  }, null, 2);

  return [
    `# 方案擂台独立提案任务：${meeting.title}`,
    '',
    `- meeting_id: \`${meeting.id}\``,
    `- project_id: \`${meeting.project_id}\``,
    `- proposal_id: \`${slot.proposal_id}\``,
    `- 你的身份: \`${slot.agent}\`${slot.model ? ` (model=${slot.model})` : ''}`,
    `- 设计 brief 指针: \`${meeting.brief_ref.name}\` | uri=\`${meeting.brief_ref.uri}\` | sha256=\`${meeting.brief_ref.sha256}\`（请用 \`bus_ref_read\` 读取）`,
    `- 隔离工作与输出目录: \`${slot.work_dir}\``,
    `- 评分维度与权重: creativity=${weights.creativity}%, feasibility=${weights.feasibility}%, reliability=${weights.reliability}%, cost=${weights.cost}% (每维 0-5 分)`,
    '',
    '## 严格隔离约束（必须遵守）',
    '1. 禁止读取其他提案者的方案目录、临时文件或共享工作区；必须独立构思并提交方案。',
    `2. 将你的详细设计文档写入 \`${outDesignPath}\`，计算其 SHA-256，并在 \`${outJsonPath}\` 写入合法 \`${PROPOSAL_SCHEMA}\` JSON。`,
    `3. 调用 \`bus_task_complete\` 时将 \`result_path\` 指向 \`${outJsonPath}\`。`,
    '',
    '## 提案输出 JSON 契约 (`agentbus/proposal@1`)',
    '```json',
    example,
    '```',
  ].join('\n');
}

function buildJudgeTaskGoal({ meeting, judge, validProposals }) {
  const weights = meeting.rubric?.weights || DEFAULT_RUBRIC_WEIGHTS;
  const proposalLines = validProposals.map((p) =>
    `- \`${p.proposal_id}\` (${p.alias}): design_ref uri=\`${p.design_ref.uri}\`, sha256=\`${p.design_ref.sha256}\` | summary: ${p.summary.slice(0, 120)}`
  );
  return [
    `# 方案擂台匿名评审任务：${meeting.title}`,
    '',
    `- meeting_id: \`${meeting.id}\``,
    `- project_id: \`${meeting.project_id}\``,
    `- 评审 Agent: \`${judge.agent}\``,
    `- 匿名模式: ${meeting.anonymity !== false ? '开启（禁止猜测或泄露作者）' : '关闭'}`,
    `- brief 指针: \`${meeting.brief_ref.name}\` | uri=\`${meeting.brief_ref.uri}\` | sha256=\`${meeting.brief_ref.sha256}\``,
    `- Rubric (0-5 分): creativity(${weights.creativity}%), feasibility(${weights.feasibility}%), reliability(${weights.reliability}%), cost(${weights.cost}%)`,
    '',
    '## 待评审匿名方案（仅指针与摘要，不含作者）',
    ...proposalLines,
    '',
    '## 评审要求',
    '- 严禁自评；每个方案仅提交 1 次评分（通过 `POST /api/meetings/' + meeting.id + '/votes` 或提交 vote JSON）。',
    '- `weighted_score` 由后端统一计算，不得自行伪造。',
  ].join('\n');
}

function buildDebateTaskGoal({ meeting, debate, participants }) {
  const partLines = participants.map((p) =>
    `- \`${p.proposal_id}\` (${p.alias}, author=${p.agent}): design_ref uri=\`${p.design_ref.uri}\`, sha256=\`${p.design_ref.sha256}\``
  );
  return [
    `# 方案擂台一轮答辩任务：${meeting.title}`,
    '',
    `- meeting_id: \`${meeting.id}\``,
    `- debate_id: \`${debate.debate_id}\``,
    `- round: 1 / 1（严格一轮，禁止新增提案，禁止评审聊天）`,
    `- timeout_s: ${debate.timeout_s}s (expires_at=${debate.expires_at})`,
    `- brief 指针: uri=\`${meeting.brief_ref.uri}\`, sha256=\`${meeting.brief_ref.sha256}\``,
    '',
    '## 参与答辩方案（高分接近或并列）',
    ...partLines,
    '',
    '## 答辩规则',
    '1. 仅交换 `bus_task_message` 与 `uri + sha256` 指针，禁止把设计全文塞进消息正文。',
    '2. 每个参与者最多提交 1 条 critique（<=1000 字）；主 Agent 最多提交 1 条总结。',
    '3. 超时后由主 Agent 与人工共同裁决。',
  ].join('\n');
}

function buildImplementationTaskGoal({ project, meeting, winnerProposal, decisionRef, decision }) {
  return [
    `# 方案擂台胜出方案实现任务：${project.name} / ${meeting.title}`,
    '',
    `- project_id: \`${project.id}\``,
    `- meeting_id: \`${meeting.id}\``,
    `- decision_id: \`${decision.decision_id}\``,
    `- winner_proposal_id: \`${winnerProposal.proposal_id}\` (${winnerProposal.alias})`,
    `- 执行 Agent (winner): \`${winnerProposal.author}\``,
    `- 胜出方案指针 (design_ref): \`${winnerProposal.design_ref.name}\` | uri=\`${winnerProposal.design_ref.uri}\` | sha256=\`${winnerProposal.design_ref.sha256}\``,
    `- 决策记录指针 (decision_ref): \`${decisionRef.name}\` | uri=\`${decisionRef.uri}\` | sha256=\`${decisionRef.sha256}\``,
    `- brief 指针: \`${meeting.brief_ref.name}\` | uri=\`${meeting.brief_ref.uri}\` | sha256=\`${meeting.brief_ref.sha256}\``,
    '',
    '## 交付要求',
    '- 请通过 `bus_ref_read` 读取胜出方案与决策指针后开展实现（本任务仅传指针，不复制设计正文）。',
    '- 完成后运行相关测试并通过 `bus_task_complete` 提交合法结果 JSON。',
  ].join('\n');
}

export function listMeetingsHydrated({
  projectId = null,
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  if (projectId && !SAFE_PROJECT_ID_RE.test(String(projectId))) {
    throw makeHttpError(400, 'invalid_project_id', `非法项目 id: ${projectId}`);
  }
  const allRaw = readAllRawMeetings(config.rootDir);
  const filtered = projectId ? allRaw.filter((m) => m.project_id === projectId) : allRaw;
  const taskMap = readTasksByIdsReadOnly(config, collectMeetingTaskIds(filtered));
  const meetings = filtered.map((m) => {
    const hydrated = hydrateMeetingRecord(m, { rootDir: config.rootDir, taskMap, env, config });
    const anon = buildAnonymousMeetingView(hydrated);
    const shouldMask = hydrated.anonymity !== false && hydrated.status !== 'decided';
    return {
      ...(shouldMask ? anon : hydrated),
      anonymous_view: anon,
      internal_view: hydrated,
    };
  });

  return {
    ok: true,
    root: config.rootDir,
    project_id: projectId || null,
    meetings,
  };
}

export function getMeetingHydrated(meetingId, {
  view = null,
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  const raw = loadRawMeetingOrThrow(config.rootDir, meetingId);
  const diskDebate = readJsonFileSafe(debateFilePath(config.rootDir, raw.id));
  const diskDecision = readJsonFileSafe(decisionFilePath(config.rootDir, raw.id));
  const taskMap = readTasksByIdsReadOnly(config, collectMeetingTaskIds([{ ...raw, _debate: diskDebate, _decision: diskDecision }]));
  const hydrated = hydrateMeetingRecord(raw, { rootDir: config.rootDir, taskMap, env, config });
  const anon = buildAnonymousMeetingView(hydrated);
  const internal = buildInternalMeetingView(hydrated);

  const normalizedView = typeof view === 'string' ? view.trim().toLowerCase() : '';
  if (normalizedView === 'anonymous' || normalizedView === 'judge' || normalizedView === 'blind') {
    return {
      ok: true,
      view: 'anonymous',
      meeting: anon,
    };
  }
  if (normalizedView === 'internal') {
    return {
      ok: true,
      view: 'internal',
      meeting: internal,
    };
  }

  const shouldMaskTop = hydrated.anonymity !== false && hydrated.status !== 'decided';
  return {
    ok: true,
    view: 'split',
    meeting: shouldMaskTop ? anon : internal,
    anonymous_view: anon,
    internal_view: internal,
  };
}

export async function createMeeting({
  body,
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body, ALLOWED_CREATE_MEETING_KEYS, '创建方案会议请求体');

  const projectId = typeof body.project_id === 'string' ? body.project_id.trim() : '';
  if (!SAFE_PROJECT_ID_RE.test(projectId)) {
    throw makeHttpError(400, 'invalid_project_id', `非法 project_id: ${projectId || '(空)'}`);
  }
  const store = readProjectsStore(config.rootDir);
  if (store.broken) {
    throw makeHttpError(422, 'corrupted_projects_config', store.error);
  }
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) {
    throw makeHttpError(404, 'project_not_found', `找不到项目: ${projectId}`);
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 160 || /[\r\n\0]/.test(title)) {
    throw makeHttpError(400, 'invalid_meeting_title', '会议标题必填且不超过 160 字符');
  }

  const setup = detectClientSetup({ rootDir: config.rootDir, home, platform, env });
  const knownSet = new Set(listClients());
  const clientById = new Map((setup.clients || []).map((c) => [c.id, c]));

  const proposers = normalizeParticipantList(body.proposers, 'proposers', { clientById, knownSet });
  const judges = normalizeParticipantList(body.judges, 'judges', { clientById, knownSet });

  const proposerAgentSet = new Set(proposers.map((p) => p.agent));
  const seenJudges = new Set();
  for (const j of judges) {
    if (seenJudges.has(j.agent)) {
      throw makeHttpError(400, 'duplicate_judge', `评委列表存在重复 agent: ${j.agent}`);
    }
    seenJudges.add(j.agent);
    if (proposerAgentSet.has(j.agent)) {
      throw makeHttpError(400, 'proposer_judge_overlap', `提案者与评审不得重叠: ${j.agent}`);
    }
  }

  let quorum = 2;
  if (body.quorum !== undefined && body.quorum !== null && body.quorum !== '') {
    const q = Number(body.quorum);
    if (!Number.isInteger(q) || q < 1 || q > 20) {
      throw makeHttpError(400, 'invalid_quorum', 'quorum 必须是 1 到 20 的整数');
    }
    quorum = q;
  }

  const tieThreshold = normalizeTieThreshold(body.tie_threshold);
  const rubric = normalizeRubric(body.rubric);
  if (body.anonymity !== undefined && typeof body.anonymity !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'anonymity 必须是布尔值');
  }
  const anonymity = body.anonymity !== false;
  const createdBy = typeof body.created_by === 'string' && body.created_by.trim()
    ? body.created_by.trim()
    : (project.main_agent || 'ui');

  const meetingId = `mtg_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const bus = openBus({ config });
  let briefRef;
  try {
    briefRef = resolveAndRegisterBriefRef(bus, {
      brief_ref: body.brief_ref,
      brief_path: body.brief_path,
      brief_text: body.brief_text,
      meetingId,
      createdBy,
    });
  } finally {
    bus.close();
  }

  const now = new Date().toISOString();
  const proposalSlots = proposers.map((p, idx) => {
    const proposalId = `prop_${randomBytes(4).toString('hex')}`;
    const aliasLetter = String.fromCharCode(65 + (idx % 26));
    const alias = idx < 26 ? `方案 ${aliasLetter}` : `方案 ${idx + 1}`;
    return {
      proposal_id: proposalId,
      alias,
      agent: p.agent,
      model: p.model || '',
      work_dir: proposalSlotWorkDir(config.rootDir, meetingId, proposalId),
      task_id: null,
      dispatch_requested: false,
      dispatched: false,
      dispatch_error: null,
      awaiting_main_agent: false,
      status: 'pending',
      error: null,
      proposal: null,
    };
  });

  const meetingRecord = {
    schema: MEETING_SCHEMA,
    id: meetingId,
    project_id: projectId,
    title,
    brief_ref: briefRef,
    rubric,
    proposers,
    judges,
    status: 'draft',
    anonymity,
    quorum,
    tie_threshold: tieThreshold,
    max_rounds: 1,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    started_at: null,
    decided_at: null,
    decision_id: null,
    decision_ref: null,
    proposal_slots: proposalSlots,
    judge_tasks: [],
  };

  saveMeetingFile(config.rootDir, meetingRecord);

  if (body.auto_start === true) {
    return startMeeting({
      meetingId,
      body: {
        ...(body.auto_dispatch !== undefined ? { auto_dispatch: body.auto_dispatch } : {}),
        ...(body.wait_s !== undefined ? { wait_s: body.wait_s } : {}),
      },
      config,
      pkgRoot,
      home,
      platform,
      env,
      dispatchFn,
    });
  }

  const hydrated = hydrateMeetingRecord(meetingRecord, { rootDir: config.rootDir, taskMap: new Map(), env, config });
  return {
    ok: true,
    created: true,
    meeting: hydrated,
    anonymous_view: buildAnonymousMeetingView(hydrated),
    internal_view: hydrated,
  };
}

export async function startMeeting({
  meetingId,
  body = {},
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body || {}, ALLOWED_START_MEETING_KEYS, '启动方案会议请求体');
  if (body?.auto_dispatch !== undefined && typeof body.auto_dispatch !== 'boolean') {
    throw makeHttpError(400, 'invalid_field', 'auto_dispatch 必须是布尔值');
  }
  const autoDispatch = body?.auto_dispatch !== false;
  const explicitWaitS = body?.wait_s !== undefined && body?.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS ? Math.max(1, Math.min(600, Number(body.wait_s))) : 3;

  const rawMeeting = loadRawMeetingOrThrow(config.rootDir, meetingId);
  if (rawMeeting.status !== 'draft') {
    const taskMap = readTasksByIdsReadOnly(config, collectMeetingTaskIds([rawMeeting]));
    const hydrated = hydrateMeetingRecord(rawMeeting, { rootDir: config.rootDir, taskMap, env, config });
    return {
      ok: true,
      idempotent: true,
      created: false,
      awaiting_main_agent: hydrated.awaiting_main_agent,
      meeting: hydrated,
      anonymous_view: buildAnonymousMeetingView(hydrated),
      internal_view: hydrated,
    };
  }

  if (!Array.isArray(rawMeeting.proposers) || rawMeeting.proposers.length < 2) {
    throw makeHttpError(400, 'insufficient_proposers', '至少需要 2 个提案者才能启动方案擂台');
  }
  if (!Array.isArray(rawMeeting.judges) || rawMeeting.judges.length < Number(rawMeeting.quorum || 2)) {
    throw makeHttpError(400, 'insufficient_judges', `评委数量 (${rawMeeting.judges?.length || 0}) 少于 quorum (${rawMeeting.quorum})，拒绝启动`);
  }
  const propAgents = new Set(rawMeeting.proposers.map((p) => p.agent));
  for (const j of rawMeeting.judges) {
    if (propAgents.has(j.agent)) {
      throw makeHttpError(400, 'proposer_judge_overlap', `提案者与评审不得重叠: ${j.agent}`);
    }
  }

  const briefCheck = verifyRefIntegrity(rawMeeting.brief_ref, config);
  if (!briefCheck.ok) {
    throw makeHttpError(400, 'invalid_brief_ref', `brief_ref 校验失败: ${briefCheck.reason}`);
  }

  const store = readProjectsStore(config.rootDir);
  const project = store.projects.find((p) => p.id === rawMeeting.project_id) || null;
  const workCwd = project?.workspace_dir || pkgRoot;

  const bus = openBus({ config });
  const updatedSlots = [];
  let createdTasksCount = 0;
  try {
    // Re-ensure brief_ref artifact is present in artifacts table
    const briefValidated = resolveAndValidatePath(rawMeeting.brief_ref.uri, config, { checkSize: false });
    registerArtifact(bus, { filePath: briefValidated.fsPath, name: rawMeeting.brief_ref.name, by: rawMeeting.created_by || 'ui' });

    for (const slot of rawMeeting.proposal_slots || []) {
      fs.mkdirSync(slot.work_dir, { recursive: true });
      const goal = buildProposalTaskGoal({ meeting: rawMeeting, slot });
      const created = createTask(bus, {
        to: slot.agent,
        from: rawMeeting.created_by || 'ui',
        goal,
        refs: [{ sha256: rawMeeting.brief_ref.sha256, note: 'meeting-brief' }],
        constraints: [
          '独立提交方案：严禁读取其他提案者的方案目录或共享工作区。',
          `只能使用自己的隔离目录 ${slot.work_dir} 写入设计文件与 proposal.json。`,
          `结果必须为合法 ${PROPOSAL_SCHEMA} JSON，且 design_ref 指向真实存在且 SHA-256 一致的文件。`,
        ],
        acceptance: {
          json: 'true',
          schema: PROPOSAL_SCHEMA,
          meeting_id: rawMeeting.id,
        },
        idempotency_key: `mtg:${rawMeeting.id}:prop:${slot.proposal_id}`,
      });
      if (!created.dedup) createdTasksCount += 1;

      const dispatchable = isAgentDispatchable(slot.agent, env);
      let disp = { dispatchResult: null, dispatchError: null, dispatched: false };
      if (autoDispatch && dispatchable) {
        disp = await runUiDispatch({
          bus,
          config,
          dispatchFn,
          taskId: created.id,
          toAgent: slot.agent,
          cwd: slot.work_dir || workCwd,
          waitS,
          explicitWaitS,
          env,
        });
      }

      updatedSlots.push({
        ...slot,
        task_id: created.id,
        dispatch_requested: autoDispatch && dispatchable,
        dispatched: disp.dispatched,
        dispatch_error: disp.dispatchError,
        awaiting_main_agent: !dispatchable,
      });
    }
  } finally {
    bus.close();
  }

  const now = new Date().toISOString();
  const nextMeeting = {
    ...rawMeeting,
    status: 'proposing',
    started_at: now,
    updated_at: now,
    proposal_slots: updatedSlots,
  };
  saveMeetingFile(config.rootDir, nextMeeting);

  const taskMap = readTasksByIdsReadOnly(config, collectMeetingTaskIds([nextMeeting]));
  const hydrated = hydrateMeetingRecord(nextMeeting, { rootDir: config.rootDir, taskMap, env, config });
  return {
    ok: true,
    idempotent: false,
    created: createdTasksCount > 0,
    awaiting_main_agent: hydrated.awaiting_main_agent,
    meeting: hydrated,
    anonymous_view: buildAnonymousMeetingView(hydrated),
    internal_view: hydrated,
  };
}

async function ensureJudgeTasksCreated(rawMeeting, validProposals, { config, pkgRoot, env, dispatchFn, autoDispatch = true, waitS = 3, explicitWaitS = false }) {
  if (validProposals.length === 0) return rawMeeting;
  const existingByJudge = new Map((rawMeeting.judge_tasks || []).map((j) => [j.agent, j]));
  const store = readProjectsStore(config.rootDir);
  const project = store.projects.find((p) => p.id === rawMeeting.project_id) || null;
  const workCwd = project?.workspace_dir || pkgRoot;

  const missingJudges = (rawMeeting.judges || []).filter((j) => !existingByJudge.get(j.agent)?.task_id);
  if (missingJudges.length === 0) return rawMeeting;

  const bus = openBus({ config });
  const nextJudgeTasks = [...(rawMeeting.judge_tasks || [])];
  try {
    const refs = [{ sha256: rawMeeting.brief_ref.sha256, note: 'meeting-brief' }];
    for (const vp of validProposals) {
      const check = validateRefPointer(vp.design_ref, config, { label: `proposal ${vp.proposal_id} design_ref` });
      if (check.ok) {
        const reg = registerArtifact(bus, { filePath: check.fsPath, name: `${vp.proposal_id}_${check.ref.name}`, by: 'ui' });
        refs.push({ sha256: reg.sha256, note: vp.proposal_id });
      }
    }

    for (const judge of missingJudges) {
      const goal = buildJudgeTaskGoal({ meeting: rawMeeting, judge, validProposals });
      const created = createTask(bus, {
        to: judge.agent,
        from: rawMeeting.created_by || 'ui',
        goal,
        refs,
        constraints: [
          '匿名评审：不得询问或推断提案作者，禁止自评。',
          'weighted_score 由后端计算，不得伪造分数。',
        ],
        acceptance: { json: 'true' },
        idempotency_key: `mtg:${rawMeeting.id}:judge:${judge.agent}`,
      });

      const dispatchable = isAgentDispatchable(judge.agent, env);
      let disp = { dispatchResult: null, dispatchError: null, dispatched: false };
      if (autoDispatch && dispatchable) {
        disp = await runUiDispatch({
          bus,
          config,
          dispatchFn,
          taskId: created.id,
          toAgent: judge.agent,
          cwd: workCwd,
          waitS,
          explicitWaitS,
          env,
        });
      }

      const idx = nextJudgeTasks.findIndex((x) => x.agent === judge.agent);
      const entry = {
        agent: judge.agent,
        model: judge.model || '',
        task_id: created.id,
        dispatch_requested: autoDispatch && dispatchable,
        dispatched: disp.dispatched,
        dispatch_error: disp.dispatchError,
        awaiting_main_agent: !dispatchable,
      };
      if (idx >= 0) nextJudgeTasks[idx] = entry;
      else nextJudgeTasks.push(entry);
    }
  } finally {
    bus.close();
  }

  const nextMeeting = {
    ...rawMeeting,
    judge_tasks: nextJudgeTasks,
    updated_at: new Date().toISOString(),
  };
  saveMeetingFile(config.rootDir, nextMeeting);
  return nextMeeting;
}

export async function syncMeeting({
  meetingId,
  body = {},
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body || {}, ALLOWED_SYNC_MEETING_KEYS, '同步方案会议请求体');
  const autoDispatch = body?.auto_dispatch !== false;
  const explicitWaitS = body?.wait_s !== undefined && body?.wait_s !== null && Number.isFinite(Number(body.wait_s));
  const waitS = explicitWaitS ? Math.max(1, Math.min(600, Number(body.wait_s))) : 3;

  const rawMeeting = loadRawMeetingOrThrow(config.rootDir, meetingId);
  const taskMapBefore = readTasksByIdsReadOnly(config, collectMeetingTaskIds([rawMeeting]));
  let { nextMeeting, evalRes } = reconcileMeetingStateOnDisk(rawMeeting, { config, taskMap: taskMapBefore });

  if ((nextMeeting.status === 'judging' || nextMeeting.status === 'debating') && evalRes.validSlots.length >= 1) {
    nextMeeting = await ensureJudgeTasksCreated(
      nextMeeting,
      evalRes.validSlots.map((s) => s.proposal),
      { config, pkgRoot, env, dispatchFn, autoDispatch, waitS, explicitWaitS }
    );
  }

  const taskMapAfter = readTasksByIdsReadOnly(config, collectMeetingTaskIds([nextMeeting]));
  const hydrated = hydrateMeetingRecord(nextMeeting, { rootDir: config.rootDir, taskMap: taskMapAfter, env, config });
  return {
    ok: true,
    meeting: hydrated,
    anonymous_view: buildAnonymousMeetingView(hydrated),
    internal_view: hydrated,
  };
}

export async function submitMeetingVote({
  meetingId,
  body,
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}) {
  assertAllowedKeys(body, ALLOWED_VOTE_KEYS, '提交评审投票请求体');

  if (body.weighted_score !== undefined) {
    throw makeHttpError(400, 'forged_weighted_score', '禁止客户端传入 weighted_score，必须由后端根据 rubric 权重计算');
  }

  const rawMeeting = loadRawMeetingOrThrow(config.rootDir, meetingId);
  const taskMap = readTasksByIdsReadOnly(config, collectMeetingTaskIds([rawMeeting]));
  const { nextMeeting, evalRes } = reconcileMeetingStateOnDisk(rawMeeting, { config, taskMap });

  if (nextMeeting.status === 'draft') {
    throw makeHttpError(409, 'meeting_not_started', '会议尚未启动，不能评审打分');
  }
  if (nextMeeting.status === 'decided' || nextMeeting.status === 'failed') {
    throw makeHttpError(409, 'meeting_closed', `会议已处于终态 (${nextMeeting.status})，不能继续评分`);
  }
  if (nextMeeting.status === 'proposing') {
    throw makeHttpError(409, 'proposals_not_ready', '提案阶段尚未结束，请等待全部提案提交完成后再评分');
  }

  const judge = typeof body.judge === 'string' ? body.judge.trim() : '';
  if (!judge) {
    throw makeHttpError(400, 'missing_judge', '必须指定评审 agent (judge)');
  }
  const proposerSet = new Set((nextMeeting.proposers || []).map((p) => p.agent));
  if (proposerSet.has(judge)) {
    throw makeHttpError(403, 'self_vote_forbidden', `禁止自评：提案者 ${judge} 不得参与评审打分`);
  }
  const judgeSet = new Set((nextMeeting.judges || []).map((j) => j.agent));
  if (!judgeSet.has(judge)) {
    throw makeHttpError(403, 'judge_not_authorized', `${judge} 不在本次会议评委名单中`);
  }

  const proposalId = typeof body.proposal_id === 'string' ? body.proposal_id.trim() : '';
  if (!SAFE_PROPOSAL_ID_RE.test(proposalId)) {
    throw makeHttpError(400, 'invalid_proposal', `非法 proposal_id: ${proposalId}`);
  }
  const targetSlot = (nextMeeting.proposal_slots || []).find((s) => s.proposal_id === proposalId);
  if (!targetSlot) {
    throw makeHttpError(404, 'proposal_not_found', `找不到提案: ${proposalId}`);
  }
  if (targetSlot.status !== 'valid' || !targetSlot.proposal) {
    throw makeHttpError(400, 'invalid_proposal', `提案 ${proposalId} 状态为 ${targetSlot.status}，无效提案禁止进入评分`);
  }

  const existingVotes = readVotesFromDisk(config.rootDir, nextMeeting.id);
  if (existingVotes.some((v) => v.judge === judge && v.proposal_id === proposalId)) {
    throw makeHttpError(409, 'duplicate_vote', `评委 ${judge} 已对提案 ${proposalId} 提交过评分，禁止重复投票`);
  }

  if (!isPlainObject(body.scores)) {
    throw makeHttpError(400, 'invalid_scores', 'scores 必须是包含四维分数的对象');
  }
  for (const key of Object.keys(body.scores)) {
    if (!RUBRIC_DIMENSIONS.includes(key)) {
      throw makeHttpError(400, 'invalid_scores', `未知评分维度: ${key}（固定四维: ${RUBRIC_DIMENSIONS.join(', ')}）`);
    }
  }
  const cleanScores = {};
  for (const dim of RUBRIC_DIMENSIONS) {
    const rawVal = body.scores[dim];
    const val = Number(rawVal);
    if (rawVal === undefined || rawVal === null || rawVal === '' || !Number.isFinite(val) || val < 0 || val > 5) {
      throw makeHttpError(400, 'invalid_scores', `维度 ${dim} 分数必须是 0-5 之间的数字`);
    }
    cleanScores[dim] = Number(val.toFixed(4));
  }

  const rationale = body.rationale === undefined || body.rationale === null ? '' : String(body.rationale).trim();
  if (rationale.length > 4000) {
    throw makeHttpError(400, 'invalid_rationale', 'rationale 不能超过 4000 字符');
  }

  const weightedScore = computeWeightedScore(cleanScores, nextMeeting.rubric);
  const now = new Date().toISOString();
  const voteId = `vote_${randomBytes(4).toString('hex')}`;
  const voteRecord = {
    schema: VOTE_SCHEMA,
    vote_id: voteId,
    meeting_id: nextMeeting.id,
    proposal_id: proposalId,
    judge,
    scores: cleanScores,
    weighted_score: weightedScore,
    rationale,
    created_at: now,
  };

  fs.mkdirSync(votesBaseDir(config.rootDir, nextMeeting.id), { recursive: true });
  writeAtomicJson(path.join(votesBaseDir(config.rootDir, nextMeeting.id), `${voteId}.json`), voteRecord);

  // Re-evaluate quorum & tie_threshold after saving vote
  const allVotes = [...existingVotes, voteRecord];
  const diskDebate = readJsonFileSafe(debateFilePath(config.rootDir, nextMeeting.id));
  const diskDecision = readJsonFileSafe(decisionFilePath(config.rootDir, nextMeeting.id));
  const afterEval = evaluateMeetingScoresAndStatus(nextMeeting, nextMeeting.proposal_slots, allVotes, diskDebate, diskDecision);

  const savedMeeting = {
    ...nextMeeting,
    status: afterEval.effectiveStatus,
    updated_at: now,
  };
  saveMeetingFile(config.rootDir, savedMeeting);

  const hydrated = hydrateMeetingRecord(savedMeeting, { rootDir: config.rootDir, taskMap, env, config });
  return {
    ok: true,
    vote: voteRecord,
    meeting: hydrated,
    anonymous_view: buildAnonymousMeetingView(hydrated),
    internal_view: hydrated,
  };
}

export async function runMeetingDebate({
  meetingId,
  body = {},
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body || {}, ALLOWED_DEBATE_KEYS, '方案答辩请求体');
  const action = typeof body?.action === 'string' && body.action.trim()
    ? body.action.trim().toLowerCase()
    : 'start';

  if (!new Set(['start', 'critique', 'summarize', 'timeout']).has(action)) {
    throw makeHttpError(400, 'invalid_debate_action', `非法答辩 action: ${action}（可选: start, critique, summarize, timeout）`);
  }

  const rawMeeting = loadRawMeetingOrThrow(config.rootDir, meetingId);
  const taskMap = readTasksByIdsReadOnly(config, collectMeetingTaskIds([rawMeeting]));
  const { nextMeeting, debate: diskDebate, evalRes } = reconcileMeetingStateOnDisk(rawMeeting, { config, taskMap });

  if (nextMeeting.status === 'decided' || nextMeeting.status === 'failed') {
    throw makeHttpError(409, 'meeting_closed', `会议已处于终态 (${nextMeeting.status})，禁止答辩操作`);
  }
  if (nextMeeting.status === 'draft' || nextMeeting.status === 'proposing') {
    throw makeHttpError(409, 'meeting_not_judging', '会议尚未进入评审阶段，无法答辩');
  }

  const store = readProjectsStore(config.rootDir);
  const project = store.projects.find((p) => p.id === nextMeeting.project_id) || null;
  const mainAgent = project?.main_agent || nextMeeting.created_by || 'ui';
  const workCwd = project?.workspace_dir || pkgRoot;
  const now = new Date().toISOString();

  if (action === 'start') {
    if (diskDebate) {
      throw makeHttpError(409, 'max_rounds_exceeded', '答辩只允许一轮 (max_rounds=1)，禁止开启第二轮答辩');
    }
    if (!evalRes.tieCheck.should_debate) {
      throw makeHttpError(400, 'debate_not_needed', '当前最高分差已超过阈值且未并列，无需进入答辩');
    }

    const topScore = evalRes.scoreBoard[0]?.avg_weighted_score;
    const participantRows = evalRes.scoreBoard.filter((row) => {
      if (row.avg_weighted_score === null) return false;
      if (evalRes.tieCheck.high_score_insufficient_quorum) {
        return row.avg_weighted_score >= 3.0;
      }
      return ((topScore - row.avg_weighted_score) / 5) < nextMeeting.tie_threshold + 1e-9;
    });
    const chosenRows = participantRows.length >= 2
      ? participantRows
      : evalRes.scoreBoard.filter((r) => r.avg_weighted_score !== null).slice(0, 2);

    const participants = chosenRows.map((row) => {
      const slot = nextMeeting.proposal_slots.find((s) => s.proposal_id === row.proposal_id);
      return {
        proposal_id: row.proposal_id,
        alias: row.alias,
        agent: slot.agent,
        design_ref: slot.proposal.design_ref,
        avg_weighted_score: row.avg_weighted_score,
      };
    });

    const timeoutS = body.timeout_s !== undefined && body.timeout_s !== null
      ? Number(body.timeout_s)
      : 600;
    if (!Number.isFinite(timeoutS) || timeoutS <= 0 || timeoutS > 3600) {
      throw makeHttpError(400, 'invalid_timeout', 'timeout_s 必须是 1 到 3600 秒之间的数字');
    }

    const debateId = `deb_${randomBytes(4).toString('hex')}`;
    const expiresAt = new Date(Date.now() + timeoutS * 1000).toISOString();
    const debateRecord = {
      schema: DEBATE_SCHEMA,
      debate_id: debateId,
      meeting_id: nextMeeting.id,
      round: 1,
      max_rounds: 1,
      status: 'active',
      reason: evalRes.tieCheck.reason || 'tie_threshold',
      participants: participants.map((p) => ({
        proposal_id: p.proposal_id,
        alias: p.alias,
        agent: p.agent,
        avg_weighted_score: p.avg_weighted_score,
      })),
      task_id: null,
      timeout_s: timeoutS,
      expires_at: expiresAt,
      max_messages_per_participant: 1,
      critiques: [],
      summary: null,
      started_at: now,
      closed_at: null,
    };

    const autoDispatch = body?.auto_dispatch !== false;
    const explicitWaitS = body?.wait_s !== undefined && body?.wait_s !== null && Number.isFinite(Number(body.wait_s));
    const waitS = explicitWaitS ? Math.max(1, Math.min(600, Number(body.wait_s))) : 3;

    const bus = openBus({ config });
    try {
      const refs = [{ sha256: nextMeeting.brief_ref.sha256, note: 'meeting-brief' }];
      for (const p of participants) {
        const reg = registerArtifact(bus, {
          filePath: resolveAndValidatePath(p.design_ref.uri, config, { checkSize: false }).fsPath,
          name: `${p.proposal_id}_${p.design_ref.name}`,
          by: mainAgent,
        });
        refs.push({ sha256: reg.sha256, note: p.proposal_id });
      }
      const created = createTask(bus, {
        to: mainAgent,
        from: 'ui',
        goal: buildDebateTaskGoal({ meeting: nextMeeting, debate: debateRecord, participants }),
        refs,
        constraints: [
          '答辩只允许一轮，禁止新增提案，禁止评审互相聊天。',
          '只交换 bus_task_message 和 uri+sha256 指针，禁止将全文塞进消息。',
        ],
        acceptance: { json: 'true' },
        thread: `mtg:${nextMeeting.id}:debate`,
        idempotency_key: `mtg:${nextMeeting.id}:debate:r1`,
      });
      debateRecord.task_id = created.id;

      const dispatchable = isAgentDispatchable(mainAgent, env);
      if (autoDispatch && dispatchable) {
        await runUiDispatch({
          bus,
          config,
          dispatchFn,
          taskId: created.id,
          toAgent: mainAgent,
          cwd: workCwd,
          waitS,
          explicitWaitS,
          env,
        });
      }
    } finally {
      bus.close();
    }

    writeAtomicJson(debateFilePath(config.rootDir, nextMeeting.id), debateRecord);
    const saved = { ...nextMeeting, status: 'debating', updated_at: now };
    saveMeetingFile(config.rootDir, saved);

    const taskMapAfter = readTasksByIdsReadOnly(config, collectMeetingTaskIds([{ ...saved, _debate: debateRecord }]));
    const hydrated = hydrateMeetingRecord(saved, { rootDir: config.rootDir, taskMap: taskMapAfter, env, config });
    return {
      ok: true,
      debate: hydrated.debate,
      meeting: hydrated,
      anonymous_view: buildAnonymousMeetingView(hydrated),
      internal_view: hydrated,
    };
  }

  // Subsequent actions require existing debate
  if (!diskDebate) {
    throw makeHttpError(409, 'debate_not_started', '尚未启动一轮答辩，请先 start 答辩');
  }

  if (action === 'timeout') {
    if (diskDebate.status === 'closed') {
      throw makeHttpError(409, 'debate_already_closed', '答辩已总结关闭');
    }
    const updatedDebate = {
      ...diskDebate,
      status: 'timed_out',
      closed_at: diskDebate.closed_at || now,
    };
    writeAtomicJson(debateFilePath(config.rootDir, nextMeeting.id), updatedDebate);
    const taskMapAfter = readTasksByIdsReadOnly(config, collectMeetingTaskIds([{ ...nextMeeting, _debate: updatedDebate }]));
    const hydrated = hydrateMeetingRecord(nextMeeting, { rootDir: config.rootDir, taskMap: taskMapAfter, env, config });
    return {
      ok: true,
      debate: hydrated.debate,
      meeting: hydrated,
      anonymous_view: buildAnonymousMeetingView(hydrated),
      internal_view: hydrated,
    };
  }

  if (action === 'critique') {
    if (diskDebate.status === 'timed_out' || (diskDebate.expires_at && Date.now() >= Date.parse(diskDebate.expires_at))) {
      const timedOutDebate = { ...diskDebate, status: 'timed_out', closed_at: diskDebate.closed_at || now };
      writeAtomicJson(debateFilePath(config.rootDir, nextMeeting.id), timedOutDebate);
      throw makeHttpError(409, 'debate_timed_out', '答辩已超时，请由主 Agent 与人工进行裁决');
    }
    if (diskDebate.status !== 'active') {
      throw makeHttpError(409, 'debate_closed', `答辩已结束 (${diskDebate.status})`);
    }

    const reqAuthor = typeof body.author === 'string' ? body.author.trim() : '';
    const reqPropId = typeof body.proposal_id === 'string' ? body.proposal_id.trim() : '';

    // Judges cannot chat in debate
    if (reqAuthor && (nextMeeting.judges || []).some((j) => j.agent === reqAuthor)) {
      throw makeHttpError(403, 'judge_cannot_debate', '答辩禁止评审互相聊天或发言');
    }

    const participant = (diskDebate.participants || []).find((p) =>
      (reqPropId && p.proposal_id === reqPropId) || (!reqPropId && reqAuthor && p.agent === reqAuthor)
    );
    if (!participant) {
      throw makeHttpError(403, 'not_debate_participant', '仅最高分/并列方案作者可参与一轮答辩');
    }
    if ((diskDebate.critiques || []).some((c) => c.proposal_id === participant.proposal_id)) {
      throw makeHttpError(409, 'critique_limit_reached', `参与者 ${participant.alias} 在本轮答辩中最多提交 1 条 critique`);
    }

    const msg = typeof body.message === 'string' ? body.message.trim() : '';
    if (!msg) {
      throw makeHttpError(400, 'missing_message', 'critique 消息不能为空');
    }
    if (msg.length > 1000) {
      throw makeHttpError(400, 'message_too_long', '答辩消息不得超过 1000 字符（请仅传递摘要与 uri+sha256 指针）');
    }

    let evidenceRef = null;
    if (body.evidence_ref !== undefined && body.evidence_ref !== null) {
      const evCheck = validateRefPointer(body.evidence_ref, config, { label: 'evidence_ref' });
      if (!evCheck.ok) {
        throw makeHttpError(400, 'invalid_evidence_ref', evCheck.error);
      }
      evidenceRef = evCheck.ref;
    }

    const critiqueEntry = {
      proposal_id: participant.proposal_id,
      alias: participant.alias,
      author: participant.agent,
      message: msg,
      evidence_ref: evidenceRef,
      created_at: now,
    };

    if (diskDebate.task_id) {
      const bus = openBus({ config });
      try {
        const busBody = `[critique ${participant.proposal_id}] ${msg}${evidenceRef ? ` | ref=${evidenceRef.uri} sha256=${evidenceRef.sha256}` : ''}`;
        addTaskMessage(bus, {
          id: diskDebate.task_id,
          from: participant.agent,
          to: mainAgent,
          kind: 'note',
          body: busBody.slice(0, 2000),
          role: 'conductor',
        });
      } finally {
        bus.close();
      }
    }

    const updatedDebate = {
      ...diskDebate,
      critiques: [...(diskDebate.critiques || []), critiqueEntry],
    };
    writeAtomicJson(debateFilePath(config.rootDir, nextMeeting.id), updatedDebate);
    const saved = { ...nextMeeting, updated_at: now };
    saveMeetingFile(config.rootDir, saved);

    const taskMapAfter = readTasksByIdsReadOnly(config, collectMeetingTaskIds([{ ...saved, _debate: updatedDebate }]));
    const hydrated = hydrateMeetingRecord(saved, { rootDir: config.rootDir, taskMap: taskMapAfter, env, config });
    return {
      ok: true,
      critique: critiqueEntry,
      debate: hydrated.debate,
      meeting: hydrated,
      anonymous_view: buildAnonymousMeetingView(hydrated),
      internal_view: hydrated,
    };
  }

  // action === 'summarize'
  if (diskDebate.summary) {
    throw makeHttpError(409, 'summary_limit_reached', '主 Agent 最多提交 1 条答辩总结');
  }
  const summaryText = typeof (body.summary ?? body.message) === 'string'
    ? String(body.summary ?? body.message).trim()
    : '';
  if (!summaryText) {
    throw makeHttpError(400, 'missing_summary', '答辩总结 summary 不能为空');
  }
  if (summaryText.length > 2000) {
    throw makeHttpError(400, 'summary_too_long', '答辩总结不能超过 2000 字符');
  }

  if (diskDebate.task_id) {
    const bus = openBus({ config });
    try {
      addTaskMessage(bus, {
        id: diskDebate.task_id,
        from: mainAgent,
        kind: 'note',
        body: `[debate-summary] ${summaryText}`.slice(0, 2000),
        role: 'conductor',
      });
    } finally {
      bus.close();
    }
  }

  const closedDebate = {
    ...diskDebate,
    status: 'closed',
    summary: {
      by: mainAgent,
      text: summaryText,
      created_at: now,
    },
    closed_at: now,
  };
  writeAtomicJson(debateFilePath(config.rootDir, nextMeeting.id), closedDebate);
  const saved = { ...nextMeeting, updated_at: now };
  saveMeetingFile(config.rootDir, saved);

  const taskMapAfter = readTasksByIdsReadOnly(config, collectMeetingTaskIds([{ ...saved, _debate: closedDebate }]));
  const hydrated = hydrateMeetingRecord(saved, { rootDir: config.rootDir, taskMap: taskMapAfter, env, config });
  return {
    ok: true,
    debate: hydrated.debate,
    meeting: hydrated,
    anonymous_view: buildAnonymousMeetingView(hydrated),
    internal_view: hydrated,
  };
}

function archiveMeetingMaterials({ project, meeting, decision, votes, debate, winnerProposalId, config, pkgRoot }) {
  const devMaterialsDir = resolveProjectDevMaterialsDir(project, { config, pkgRoot });
  const archiveDir = path.join(devMaterialsDir, 'meetings', meeting.id);
  const proposalsArchiveDir = path.join(archiveDir, 'proposals');
  const votesArchiveDir = path.join(archiveDir, 'votes');
  fs.mkdirSync(proposalsArchiveDir, { recursive: true });
  fs.mkdirSync(votesArchiveDir, { recursive: true });

  const archivedProposals = [];
  for (const slot of meeting.proposal_slots || []) {
    const isWinner = slot.proposal_id === winnerProposalId;
    const metaPath = path.join(proposalsArchiveDir, `${slot.proposal_id}.json`);
    writeAtomicJson(metaPath, {
      proposal_id: slot.proposal_id,
      alias: slot.alias,
      author: slot.agent,
      status: slot.status,
      winner: isWinner,
      error: slot.error || null,
      design_ref: slot.proposal?.design_ref || null,
      summary: slot.proposal?.summary || null,
      risks: slot.proposal?.risks || [],
      tests: slot.proposal?.tests || [],
      cost_estimate: slot.proposal?.cost_estimate ?? null,
    });
    archivedProposals.push({
      proposal_id: slot.proposal_id,
      alias: slot.alias,
      author: slot.agent,
      status: slot.status,
      winner: isWinner,
      design_ref: slot.proposal?.design_ref || null,
      archive_meta_path: metaPath,
    });
  }

  for (const v of votes || []) {
    writeAtomicJson(path.join(votesArchiveDir, `${v.vote_id}.json`), v);
  }
  if (debate) {
    writeAtomicJson(path.join(archiveDir, 'debate.json'), debate);
  }
  writeAtomicJson(path.join(archiveDir, 'decision.json'), decision);
  writeAtomicJson(path.join(archiveDir, 'report.json'), {
    schema: 'agentbus/meeting-archive@1',
    meeting_id: meeting.id,
    project_id: project.id,
    title: meeting.title,
    brief_ref: meeting.brief_ref,
    decision_id: decision.decision_id,
    winner_proposal_id: decision.winner_proposal_id,
    human_approved: decision.human_approved,
    scores: decision.scores,
    proposals: archivedProposals,
    vote_count: (votes || []).length,
    debate_status: debate?.status || null,
    archived_at: new Date().toISOString(),
    formal_files_unchanged: true,
  });

  return archiveDir;
}

export async function decideMeeting({
  meetingId,
  body,
  config,
  pkgRoot = PKG_ROOT,
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  dispatchFn = dispatchTask,
}) {
  assertAllowedKeys(body, ALLOWED_DECIDE_KEYS, '方案决策请求体');

  const rawMeeting = loadRawMeetingOrThrow(config.rootDir, meetingId);
  const taskMap = readTasksByIdsReadOnly(config, collectMeetingTaskIds([rawMeeting]));
  const { nextMeeting, votes, debate: diskDebate, decision: existingDecision, evalRes } = reconcileMeetingStateOnDisk(rawMeeting, { config, taskMap });

  if (nextMeeting.status === 'draft' || nextMeeting.status === 'proposing' || nextMeeting.status === 'failed') {
    throw makeHttpError(409, 'invalid_meeting_state', `会议当前状态为 ${nextMeeting.status}，不能裁决`);
  }

  const store = readProjectsStore(config.rootDir);
  const project = store.projects.find((p) => p.id === nextMeeting.project_id);
  if (!project) {
    throw makeHttpError(404, 'project_not_found', `找不到关联项目: ${nextMeeting.project_id}`);
  }

  const humanApproved = body.human_approved === true;
  const highImpact = body.high_impact === true || body.irreversible === true;

  // If a decision already exists and awaits human approval, allow approving it
  if (existingDecision) {
    if (existingDecision.human_approved === true) {
      const hydrated = hydrateMeetingRecord(nextMeeting, { rootDir: config.rootDir, taskMap, env, config });
      return {
        ok: true,
        idempotent: true,
        awaiting_human_approval: false,
        decision: hydrated.decision,
        implementation_task_id: hydrated.decision?.implementation_task_id || null,
        meeting: hydrated,
        anonymous_view: buildAnonymousMeetingView(hydrated),
        internal_view: hydrated,
      };
    }
    if (!humanApproved) {
      const hydrated = hydrateMeetingRecord(nextMeeting, { rootDir: config.rootDir, taskMap, env, config });
      return {
        ok: true,
        idempotent: true,
        awaiting_human_approval: true,
        decision: hydrated.decision,
        implementation_task_id: null,
        meeting: hydrated,
        anonymous_view: buildAnonymousMeetingView(hydrated),
        internal_view: hydrated,
      };
    }
  }

  if (!existingDecision) {
    if (diskDebate && diskDebate.status === 'active') {
      throw makeHttpError(409, 'debate_in_progress', '一轮答辩尚在进行中，请先总结结束或等待超时后再裁决');
    }
    const allowTimedOutHumanDecision = Boolean(diskDebate && diskDebate.status === 'timed_out' && humanApproved);
    if (!evalRes.quorumMet && !allowTimedOutHumanDecision) {
      throw makeHttpError(409, 'quorum_not_met', `评审票数尚未达到 quorum (${nextMeeting.quorum})，禁止提前裁决`);
    }
  }

  const winnerProposalId = existingDecision
    ? existingDecision.winner_proposal_id
    : (typeof body.winner_proposal_id === 'string' ? body.winner_proposal_id.trim() : '');
  if (!winnerProposalId) {
    throw makeHttpError(400, 'missing_winner', '必须指定 winner_proposal_id（或 "no_winner"）');
  }

  let winnerSlot = null;
  if (winnerProposalId !== 'no_winner') {
    winnerSlot = (nextMeeting.proposal_slots || []).find((s) => s.proposal_id === winnerProposalId) || null;
    if (!winnerSlot || winnerSlot.status !== 'valid' || !winnerSlot.proposal) {
      throw makeHttpError(400, 'invalid_winner', `胜出方案 ${winnerProposalId} 不存在或校验失败`);
    }
  }

  const rationale = existingDecision && body.rationale === undefined
    ? existingDecision.rationale
    : (typeof body.rationale === 'string' ? body.rationale.trim() : '');
  if (!rationale || rationale.length > 4000) {
    throw makeHttpError(400, 'invalid_rationale', '决策理由 rationale 必填且不超过 4000 字符');
  }

  let dissent = existingDecision ? (existingDecision.dissent || []) : [];
  if (body.dissent !== undefined) {
    if (!Array.isArray(body.dissent)) {
      throw makeHttpError(400, 'invalid_dissent', 'dissent 必须是字符串数组');
    }
    dissent = body.dissent.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 30);
  }

  const decidedBy = typeof body.decided_by === 'string' && body.decided_by.trim()
    ? body.decided_by.trim()
    : (project.main_agent || nextMeeting.created_by || 'ui');
  const now = new Date().toISOString();
  const decisionId = existingDecision?.decision_id || `dec_${randomBytes(4).toString('hex')}`;

  const decisionRecord = {
    schema: DECISION_SCHEMA,
    decision_id: decisionId,
    meeting_id: nextMeeting.id,
    winner_proposal_id: winnerProposalId,
    scores: evalRes.scoreBoard,
    rationale,
    dissent,
    human_approved: humanApproved,
    high_impact: highImpact || Boolean(existingDecision?.high_impact),
    decided_by: decidedBy,
    decided_at: existingDecision?.decided_at || now,
    implementation_task_id: existingDecision?.implementation_task_id || null,
    archived_dir: existingDecision?.archived_dir || null,
  };

  const decPath = decisionFilePath(config.rootDir, nextMeeting.id);
  const decSnapshotPath = path.join(meetingDir(config.rootDir, nextMeeting.id), 'decision_approved.json');
  writeAtomicJson(decPath, decisionRecord);

  const bus = openBus({ config });
  let decisionRef;
  let implTaskId = decisionRecord.implementation_task_id;
  let implAwaitingMainAgent = false;
  try {
    // Human approval gate: only generate implementation task when human_approved === true!
    if (humanApproved && winnerSlot && !implTaskId) {
      const winnerDesignCheck = validateRefPointer(winnerSlot.proposal.design_ref, config, { label: 'winner design_ref' });
      if (!winnerDesignCheck.ok) {
        throw makeHttpError(400, 'invalid_winner_ref', winnerDesignCheck.error);
      }
      const regWinnerDesign = registerArtifact(bus, {
        filePath: winnerDesignCheck.fsPath,
        name: winnerSlot.proposal.design_ref.name,
        by: decidedBy,
      });

      // Immutable approval snapshot referenced by the implementation task so decision.json can record implementation_task_id without causing SHA-256 drift.
      writeAtomicJson(decSnapshotPath, decisionRecord);
      const regApprovalSnapshot = registerArtifact(bus, {
        filePath: decSnapshotPath,
        name: 'decision_approved.json',
        by: decidedBy,
      });
      const snapshotRef = {
        name: regApprovalSnapshot.name,
        uri: regApprovalSnapshot.uri,
        sha256: regApprovalSnapshot.sha256,
        bytes: regApprovalSnapshot.bytes,
      };

      const goal = buildImplementationTaskGoal({
        project,
        meeting: nextMeeting,
        winnerProposal: winnerSlot.proposal,
        decisionRef: snapshotRef,
        decision: decisionRecord,
      });

      const createdImpl = createTask(bus, {
        to: winnerSlot.agent,
        from: decidedBy,
        goal,
        refs: [
          { sha256: regWinnerDesign.sha256, note: 'winner-design' },
          { sha256: snapshotRef.sha256, note: 'meeting-decision' },
          { sha256: nextMeeting.brief_ref.sha256, note: 'meeting-brief' },
        ],
        constraints: [
          '严格依据 winner design_ref 与 decision_ref 指针文件开展实现。',
          '不得擅自修改其他未中选方案文件；完成后运行验收测试并提交结果 JSON。',
        ],
        acceptance: { json: 'true' },
        idempotency_key: `mtg:${nextMeeting.id}:implement:${winnerProposalId}`,
      });
      implTaskId = createdImpl.id;

      const autoDispatch = body.auto_dispatch !== false;
      const explicitWaitS = body.wait_s !== undefined && body.wait_s !== null && Number.isFinite(Number(body.wait_s));
      const waitS = explicitWaitS ? Math.max(1, Math.min(600, Number(body.wait_s))) : 3;
      const dispatchable = isAgentDispatchable(winnerSlot.agent, env);
      implAwaitingMainAgent = !dispatchable;
      if (autoDispatch && dispatchable) {
        await runUiDispatch({
          bus,
          config,
          dispatchFn,
          taskId: createdImpl.id,
          toAgent: winnerSlot.agent,
          cwd: project.workspace_dir || pkgRoot,
          waitS,
          explicitWaitS,
          env,
        });
      }
    }
  } finally {
    bus.close();
  }

  // Re-write decisionRecord with implementation_task_id & archived_dir
  decisionRecord.implementation_task_id = implTaskId;
  const archiveDir = archiveMeetingMaterials({
    project,
    meeting: nextMeeting,
    decision: decisionRecord,
    votes,
    debate: diskDebate,
    winnerProposalId,
    config,
    pkgRoot,
  });
  decisionRecord.archived_dir = archiveDir;
  writeAtomicJson(decPath, decisionRecord);

  // Register final decision.json so meeting.decision_ref matches exact disk SHA-256!
  const bus2 = openBus({ config });
  try {
    const regFinal = registerArtifact(bus2, {
      filePath: decPath,
      name: 'decision.json',
      by: decidedBy,
    });
    decisionRef = {
      name: regFinal.name,
      uri: regFinal.uri,
      sha256: regFinal.sha256,
      bytes: regFinal.bytes,
    };
  } finally {
    bus2.close();
  }

  const finalMeeting = {
    ...nextMeeting,
    status: 'decided',
    decided_at: decisionRecord.decided_at,
    decision_id: decisionRecord.decision_id,
    decision_ref: decisionRef,
    updated_at: now,
  };
  saveMeetingFile(config.rootDir, finalMeeting);

  const taskMapAfter = readTasksByIdsReadOnly(config, collectMeetingTaskIds([{ ...finalMeeting, _debate: diskDebate, _decision: decisionRecord }]));
  const hydrated = hydrateMeetingRecord(finalMeeting, { rootDir: config.rootDir, taskMap: taskMapAfter, env, config });

  return {
    ok: true,
    awaiting_human_approval: !humanApproved,
    awaiting_main_agent: implAwaitingMainAgent || hydrated.awaiting_main_agent,
    decision: hydrated.decision,
    decision_ref: decisionRef,
    implementation_task_id: implTaskId,
    archived_dir: archiveDir,
    meeting: hydrated,
    anonymous_view: buildAnonymousMeetingView(hydrated),
    internal_view: hydrated,
  };
}
