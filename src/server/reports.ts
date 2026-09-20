import type { EvaluationReport } from '../shared/model';
import { evaluateMany } from './evaluator';
import type { RuleStore, SnapshotStore } from './store';

/** 仅保存“已完成”批量的最终报告；取消不写入 */
export class ReportStore {
  private map = new Map<string, EvaluationReport>();

  save(report: EvaluationReport): EvaluationReport {
    this.map.set(report.id, report);
    return report;
  }

  get(id: string): EvaluationReport | undefined {
    return this.map.get(id);
  }

  list(): EvaluationReport[] {
    return [...this.map.values()].sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
  }
}

/**
 * 用报告固化的规则 revision 与评估时钟重新推导。
 * 即使规则此后被编辑/禁用/过期，结果也必须与当时逐字段一致。
 */
export function replayReport(report: EvaluationReport, rules: RuleStore, snapshots: SnapshotStore): EvaluationReport {
  const nowMs = Date.parse(report.evaluatedAt);
  const docs = rules.resolvePinned(report.ruleRevisionPins);
  const ruleSet = new Map(docs.map((d) => [d.ruleId, d]));
  const wanted = new Set(report.snapshotIds);
  const orderedSnapshots = report.snapshotIds
    .map((id) => snapshots.get(id))
    .filter((s): s is NonNullable<typeof s> => !!s);

  // 按报告中的快照顺序、问题顺序重新评估，得到逐决策结果
  const decisions: EvaluationReport['decisions'] = [];
  for (const snapshot of orderedSnapshots) {
    const { decisions: ds } = evaluateMany([snapshot], ruleSet, nowMs, wanted);
    decisions.push(...ds);
  }

  return {
    ...report,
    decisions,
    stats: aggregate(decisions),
  };
}

function aggregate(decisions: EvaluationReport['decisions']): EvaluationReport['stats'] {
  const stats = {
    suppressed: 0,
    expired: 0,
    invalid: 0,
    disabled: 0,
    unsuppressed: 0,
  } as EvaluationReport['stats'];
  for (const d of decisions) stats[d.outcome]++;
  return stats;
}
