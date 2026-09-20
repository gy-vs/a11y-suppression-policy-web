import {
  emptyStats,
  type IssueDecision,
  type Outcome,
  type RankedRule,
  type RevisionPins,
  type RuleRevision,
  type Snapshot,
  type SnapshotDecision,
} from '../shared/model';
import { compareRules, issueTarget, ruleState, scopeMatches, specificity, coverageWhy } from '../shared/matcher';

/** 不可变的规则视图：ruleId -> 已固化的某份 revision 文档 */
export type RuleSet = ReadonlyMap<string, RuleRevision>;

/**
 * 按固化的 revision 选择规则文档。pin 缺失（该规则在评估时点尚不存在）则跳过，
 * 这正是历史回放能忠实还原“当时有哪些规则”的关键。
 */
export function freezeRules(current: RuleRevision[], pins?: RevisionPins): RuleSet {
  const byId = new Map<string, RuleRevision>();
  // current 是各 ruleId 的“最新”文档；历史文档需从 store 的完整历史按 pins 取。
  // 本函数只处理“已解析好的文档集合”，按 pins 过滤/校验版本。
  for (const doc of current) {
    if (pins && pins[doc.ruleId] !== undefined && doc.revision !== pins[doc.ruleId]) continue;
    byId.set(doc.ruleId, doc);
  }
  return byId;
}

function evaluateIssue(snapshot: Snapshot, issue: (typeof snapshot.issues)[number], rules: RuleSet, nowMs: number): IssueDecision {
  const target = issueTarget(snapshot, issue);
  const nodeId = issue.nodeId;
  const fingerprint = target?.fingerprint ?? '';
  const path = snapshot.path;

  // 1) 作用域命中的全部规则（含过期/禁用/非法），按服务端优先级排序
  const matched = [...rules.values()]
    .filter((r) => target && scopeMatches(r, target))
    .sort(compareRules);

  // 2) 只有“可生效”的规则（合法 + 启用 + 未过期）能真正抑制
  const effective = matched.filter((r) => ruleState(r, nowMs) === 'active');
  const winner = effective[0];

  const candidates: RankedRule[] = matched.map((r, i) => {
    const state = ruleState(r, nowMs);
    const spec = specificity(r);
    const base: RankedRule = {
      ruleId: r.ruleId,
      revision: r.revision,
      createdSeq: r.createdSeq,
      scope: r,
      reason: r.reason,
      expiresAt: r.expiresAt,
      specificity: spec,
      state,
      valid: r.valid,
      validationErrors: r.validationErrors,
      rank: i + 1,
      disposition: 'shadowed',
    };
    if (winner && r.ruleId === winner.ruleId) {
      base.disposition = 'won';
    } else if (state === 'active') {
      base.disposition = 'shadowed';
      if (winner) base.coveredBy = { ruleId: winner.ruleId, revision: winner.revision, why: coverageWhy(specificity(winner), spec) };
    } else {
      // expired / invalid / disabled：不能生效，因此也不会“覆盖”别人
      base.disposition = state;
    }
    return base;
  });

  let outcome: Outcome;
  if (winner) {
    outcome = 'suppressed';
  } else {
    // 没有可生效规则时，暴露最高优先级候选为何不可用
    const top = matched[0];
    const st = top ? ruleState(top, nowMs) : undefined;
    outcome = st === 'expired' ? 'expired' : st === 'invalid' ? 'invalid' : st === 'disabled' ? 'disabled' : 'unsuppressed';
  }

  return {
    snapshotId: snapshot.id,
    issueId: issue.id,
    ruleCode: issue.ruleCode,
    nodeId,
    fingerprint,
    path,
    outcome,
    winner: winner
      ? { ruleId: winner.ruleId, revision: winner.revision, reason: winner.reason, expiresAt: winner.expiresAt, specificity: specificity(winner) }
      : undefined,
    candidates,
  };
}

export function evaluateSnapshot(snapshot: Snapshot, rules: RuleSet, nowMs: number): SnapshotDecision {
  const decisions = snapshot.issues.map((issue) => evaluateIssue(snapshot, issue, rules, nowMs));
  const stats = emptyStats();
  for (const d of decisions) stats[d.outcome]++;
  return { snapshotId: snapshot.id, decisions, stats };
}

export function evaluateMany(
  snapshots: Snapshot[],
  rules: RuleSet,
  nowMs: number,
  snapshotFilter?: ReadonlySet<string>,
): { decisions: IssueDecision[]; stats: Record<Outcome, number> } {
  const decisions: IssueDecision[] = [];
  const stats = emptyStats();
  for (const snapshot of snapshots) {
    if (snapshotFilter && !snapshotFilter.has(snapshot.id)) continue;
    const result = evaluateSnapshot(snapshot, rules, nowMs);
    decisions.push(...result.decisions);
    for (const d of result.decisions) stats[d.outcome]++;
  }
  return { decisions, stats };
}
