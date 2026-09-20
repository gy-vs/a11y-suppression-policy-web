import { describe, expect, it } from 'vitest';
import { RuleStore, SnapshotStore, RevisionConflictError } from '../src/server/store';
import { SAMPLE_SNAPSHOTS, seedRules } from '../src/server/seed';
import { evaluateSnapshot } from '../src/server/evaluator';
import { replayReport } from '../src/server/reports';
import type { EvaluationReport, RuleRevision } from '../src/shared/model';

const SEED_NOW = Date.parse('2026-09-20T12:00:00.000Z');
const AT_BOUNDARY = Date.parse('2026-08-31T23:59:59.000Z');

function setup(now = SEED_NOW) {
  const rules = new RuleStore(() => now);
  const ids = seedRules(rules).rules;
  const snapshots = new SnapshotStore(SAMPLE_SNAPSHOTS);
  const current = () => new Map(rules.list().map((r) => [r.ruleId, r]));
  return { rules, snapshots, ids, current, now };
}

const byIssue = (snapId: string, now = SEED_NOW) => {
  const { rules, snapshots, current } = setup(now);
  const result = evaluateSnapshot(snapshots.get(snapId)!, current(), now);
  return Object.fromEntries(result.decisions.map((d) => [d.issueId, d]));
};

describe('作用域重叠：特异度与创建顺序', () => {
  const d = byIssue('snap-home-q4');

  it('最具体的“精确路径+规则代码+指纹”胜出', () => {
    const submit = d['i-submit-aria'];
    expect(submit.outcome).toBe('suppressed');
    expect(submit.winner?.ruleId).toBe('rule-third-party');
  });

  it('低特异度规则在另一条问题上仍生效', () => {
    // color-contrast 只被 codeGlob 命中
    expect(d['i-submit-contrast'].outcome).toBe('suppressed');
    expect(d['i-submit-contrast'].winner?.ruleId).toBe('rule-code-glob');
  });

  it('被更高优先级覆盖的活动规则标记 shadowed 并给出原因', () => {
    // thirdParty 比 codeGlob 多了路径/指纹维度，但 codeGlob 不匹配 aria-required-attr？
    // codeGlob 仅规则代码=color-contrast，因此不会出现在 aria 问题候选中。
    const submit = d['i-submit-aria'];
    expect(submit.candidates.find((c) => c.ruleId === 'rule-third-party')?.disposition).toBe('won');
  });

  it('两个重叠活动规则：具体的胜出，另一个 shadowed', () => {
    const { rules, snapshots, current } = setup();
    // 再加一条仅规则代码的 aria 规则（晚创建、低特异度）
    rules.create({ ruleCode: 'aria-required-attr', reason: '兜底豁免' });
    const result = evaluateSnapshot(snapshots.get('snap-home-q4')!, current(), SEED_NOW);
    const submit = result.decisions.find((x) => x.issueId === 'i-submit-aria')!;
    const winner = submit.candidates.find((c) => c.disposition === 'won')!;
    const shadow = submit.candidates.find((c) => c.disposition === 'shadowed')!;
    expect(winner.ruleId).toBe('rule-third-party');
    expect(shadow.coveredBy?.ruleId).toBe('rule-third-party');
    expect(shadow.coveredBy?.why).toContain('特异度');
  });
});

describe('明确区分已抑制 / 规则过期 / 规则无效 / 规则禁用', () => {
  const d = byIssue('snap-home-q4');

  it('过期规则：唯一命中且已过期 -> expired，不是 suppressed', () => {
    expect(d['i-nav-unique'].outcome).toBe('expired');
    expect(d['i-nav-unique'].winner).toBeUndefined();
    expect(d['i-nav-unique'].candidates[0].state).toBe('expired');
  });

  it('无效规则（expiresAt 非 ISO）-> invalid', () => {
    expect(d['i-search-label'].outcome).toBe('invalid');
    expect(d['i-search-label'].candidates[0].valid).toBe(false);
    expect(d['i-search-label'].candidates[0].validationErrors).toContain('expiresAt_not_iso');
  });

  it('禁用规则 -> disabled', () => {
    expect(d['i-logo-alt'].outcome).toBe('disabled');
    expect(d['i-logo-alt'].candidates[0].state).toBe('disabled');
  });

  it('无任何规则 -> unsuppressed', () => {
    const { rules, snapshots, current } = setup();
    const fresh = snapshots.get('snap-home-q4')!;
    // 用空规则集
    const result = evaluateSnapshot(fresh, new Map<string, RuleRevision>(), SEED_NOW);
    expect(result.stats.unsuppressed).toBe(fresh.issues.length);
  });

  it('过期/无效/禁用的高优先级规则不会挡住后面的有效规则', () => {
    const { rules, snapshots, current } = setup();
    // landmark-unique 现有最高优先级是已过期的 rule-expired-glob（仅规则代码）。
    // 再补一条同样仅规则代码、但更晚创建的“有效”规则：过期规则不应阻止它生效。
    const valid = rules.create({ ruleCode: 'landmark-unique', reason: '后续有效豁免' });
    const result = evaluateSnapshot(snapshots.get('snap-home-q4')!, current(), SEED_NOW);
    const nav = result.decisions.find((d) => d.issueId === 'i-nav-unique')!;
    expect(nav.outcome).toBe('suppressed');
    expect(nav.winner?.ruleId).toBe(valid.ruleId);
    // 过期规则仍在候选里被解释，但不覆盖别人
    expect(nav.candidates.find((c) => c.ruleId === 'rule-expired-glob')?.disposition).toBe('expired');
  });
});

describe('属性变化：同一规则跨快照', () => {
  it('旧快照 role=button 命中抑制；修复后 role=link 不再命中', () => {
    const oldSnap = byIssue('snap-report-q3');
    expect(oldSnap['i-r-export'].outcome).toBe('suppressed');
    expect(oldSnap['i-r-export'].winner?.ruleId).toBe('rule-export-role');

    const fixed = byIssue('snap-report-q3-fixed');
    // role 由 button 变为 link：属性约束不满足，无规则命中
    expect(fixed['i-r-export'].outcome).toBe('unsuppressed');
    expect(fixed['i-r-export'].candidates).toHaveLength(0);
  });
});

describe('时钟边界', () => {
  it('到期前一刻 suppressed；到期瞬间及其后 expired', () => {
    const before = byIssue('snap-home-q4', AT_BOUNDARY - 1);
    const at = byIssue('snap-home-q4', AT_BOUNDARY);
    expect(before['i-nav-unique'].outcome).toBe('suppressed');
    expect(at['i-nav-unique'].outcome).toBe('expired');
  });
});

describe('并发编辑：乐观锁 + 生成新 revision', () => {
  it('旧 revision 更新被拒，新 revision 成功，历史保留', () => {
    const { rules, ids } = setup();
    const v1 = rules.get(ids.thirdParty)!;
    expect(v1.revision).toBe(1);

    const v2 = rules.update(ids.thirdParty, { reason: '改：供应商延后', ruleCode: 'aria-required-attr', pathPattern: '/home', fingerprint: 'fp:submit-cta' }, 1);
    expect(v2.revision).toBe(2);

    // 用陈旧 revision=1 再改 -> 冲突
    expect(() => rules.update(ids.thirdParty, { reason: '陈旧写入', ruleCode: 'aria-required-attr' }, 1)).toThrow(RevisionConflictError);

    // createdSeq/createdAt 不变；历史两版都在
    expect(v2.createdSeq).toBe(v1.createdSeq);
    expect(rules.historyOf(ids.thirdParty).map((r) => r.revision)).toEqual([1, 2]);
  });

  it('禁用也产生新 revision，旧版仍可回放', () => {
    const { rules, ids } = setup();
    const disabled = rules.setEnabled(ids.codeGlob, false, 1);
    expect(disabled.revision).toBe(2);
    expect(disabled.enabled).toBe(false);
    expect(rules.getRevision(ids.codeGlob, 1)?.enabled).toBe(true);
  });
});

describe('历史回放：固化 revision + evaluatedAt', () => {
  it('之后编辑/禁用规则，旧报告仍解释当时的抑制，且重放逐字段一致', () => {
    const { rules, snapshots, ids } = setup();
    const pins = rules.currentPins();
    const home = snapshots.get('snap-home-q4')!;

    // 生成一份历史报告（自包含）
    const docs = rules.resolvePinned(pins);
    const ruleSet = new Map(docs.map((d) => [d.ruleId, d]));
    const first = evaluateSnapshot(home, ruleSet, SEED_NOW);
    const report: EvaluationReport = {
      id: 'report_old',
      snapshotIds: [home.id],
      evaluatedAt: new Date(SEED_NOW).toISOString(),
      ruleRevisionPins: pins,
      decisions: first.decisions,
      stats: first.stats,
      completedAt: new Date(SEED_NOW).toISOString(),
    };

    // 此后：删掉其抑制作用——把第三方规则改成别的作用域（新 revision）
    rules.update(ids.thirdParty, { reason: '收窄到不存在的指纹', fingerprint: 'fp:gone', pathPattern: '/home', ruleCode: 'aria-required-attr' }, 1);
    // 全局时钟推到很久以后（让更多规则过期）
    const later = Date.parse('2030-01-01T00:00:00.000Z');

    const redone = replayReport({ ...report, evaluatedAt: new Date(SEED_NOW).toISOString() }, rules, snapshots);
    void later;
    expect(redone.decisions).toEqual(report.decisions);
    const submit = redone.decisions.find((d) => d.issueId === 'i-submit-aria')!;
    expect(submit.outcome).toBe('suppressed');
    expect(submit.winner?.ruleId).toBe('rule-third-party');
    expect(submit.winner?.revision).toBe(1); // 用的是当时的 revision
  });
});
