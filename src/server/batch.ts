import {
  emptyStats,
  type EvaluationReport,
  type IssueDecision,
  type Outcome,
  type RevisionPins,
  type RuleRevision,
  type Snapshot,
} from '../shared/model';
import { evaluateSnapshot, type RuleSet } from './evaluator';
import type { RuleStore, SnapshotStore } from './store';

export type BatchStatus = 'running' | 'completed' | 'canceled';

export interface BatchEventData {
  batchId: string;
  seq: number;
  type: 'started' | 'item' | 'completed' | 'canceled';
}

export interface StartedEvent extends BatchEventData {
  type: 'started';
  snapshotIds: string[];
  evaluatedAt: string;
  ruleRevisionPins: RevisionPins;
}

export interface ItemEvent extends BatchEventData {
  type: 'item';
  snapshotId: string;
  index: number; // 0-based
  total: number;
  /** 该快照的统计 */
  snapshotStats: Record<Outcome, number>;
  /** 权威累计统计：客户端应直接覆盖本地计数，禁止把重放事件叠加第二次 */
  cumulative: Record<Outcome, number>;
  decisions: IssueDecision[];
}

export interface CompletedEvent extends BatchEventData {
  type: 'completed';
  cumulative: Record<Outcome, number>;
  /** 仅完成时才存在：完整、可回放的报告 */
  reportId: string;
}

export interface CanceledEvent extends BatchEventData {
  type: 'canceled';
  processedItems: number;
  // 刻意不提供 cumulative/final 统计：取消不落部分最终统计
}

export type BatchEvent = StartedEvent | ItemEvent | CompletedEvent | CanceledEvent;

// Omit 在联合类型上默认不分配，需显式分配，否则 emit 的 data 会被收窄成公共字段
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

interface Job {
  id: string;
  status: BatchStatus;
  events: BatchEvent[];
  resolveReport?: () => EvaluationReport | undefined;
}

export interface StartOptions {
  snapshotIds?: string[]; // 缺省=全部样例
}

/**
 * 批量重评估。
 * - 启动即固化规则 revision 与评估时钟，运行期间的并发编辑不影响本批；
 * - 事件带单调序号并全量缓冲，重连只重放 lastEventId 之后的事件；
 * - 每个 item 只处理一次（服务端顺序循环），累计统计以服务端事件为唯一真相；
 * - 取消后状态为 canceled 且不产出/持久化任何最终统计。
 */
export class BatchManager {
  private jobs = new Map<string, Job>();
  private counter = 0;
  readonly delayMs: number;
  private readonly onComplete?: (report: EvaluationReport) => void;

  constructor(
    private rules: RuleStore,
    private snapshots: SnapshotStore,
    private clock: () => number = Date.now,
    opts: { delayMs?: number; onComplete?: (report: EvaluationReport) => void } = {},
  ) {
    this.delayMs = opts.delayMs ?? 25;
    this.onComplete = opts.onComplete;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  start(opts: StartOptions = {}): { batchId: string } {
    this.counter += 1;
    const batchId = `batch_${this.counter.toString(36).padStart(4, '0')}`;

    const requested = opts.snapshotIds ?? this.snapshots.list().map((s) => s.id);
    const snapshotIds = requested
      .map((id) => this.snapshots.get(id))
      .filter((s): s is Snapshot => !!s)
      .map((s) => s.id);

    // 固化：时钟 + revision pin，并立即把对应文档解析成不可变 RuleSet
    const nowMs = this.clock();
    const pins = this.rules.currentPins();
    const frozenDocs: RuleRevision[] = this.rules.resolvePinned(pins);
    const ruleSet: RuleSet = new Map(frozenDocs.map((d) => [d.ruleId, d]));
    const evaluatedAt = new Date(nowMs).toISOString();

    const job: Job = { id: batchId, status: 'running', events: [] };
    this.jobs.set(batchId, job);

    this.emit(job, {
      type: 'started',
      snapshotIds,
      evaluatedAt,
      ruleRevisionPins: pins,
    });

    // 异步运行但不 await：状态机由 status 把关
    void this.run(job, snapshotIds, ruleSet, nowMs, evaluatedAt, pins);

    return { batchId };
  }

  private async run(
    job: Job,
    snapshotIds: string[],
    ruleSet: RuleSet,
    nowMs: number,
    evaluatedAt: string,
    pins: RevisionPins,
  ): Promise<void> {
    const cumulative = emptyStats();
    const decisions: IssueDecision[] = [];
    let processed = 0;

    for (let index = 0; index < snapshotIds.length; index++) {
      // 在处理每个 item 前等待并复检取消标志，保证取消后绝不处理新 item
      await this.delay(this.delayMs);
      if (job.status === 'canceled') return;

      const snapshot = this.snapshots.get(snapshotIds[index]);
      if (!snapshot) continue;
      const result = evaluateSnapshot(snapshot, ruleSet, nowMs);
      decisions.push(...result.decisions);
      for (const d of result.decisions) cumulative[d.outcome]++;
      processed += 1;

      this.emit(job, {
        type: 'item',
        snapshotId: snapshot.id,
        index,
        total: snapshotIds.length,
        snapshotStats: { ...result.stats },
        cumulative: { ...cumulative },
        decisions: result.decisions,
      });
    }

    // 全部 item 完成后再复检：等待期间若被取消，不写最终统计
    if (job.status === 'canceled') return;

    const reportId = `report_${job.id.slice(6)}`;
    const completedAt = new Date(this.clock()).toISOString();
    const report: EvaluationReport = {
      id: reportId,
      snapshotIds,
      evaluatedAt,
      ruleRevisionPins: pins,
      decisions,
      stats: { ...cumulative },
      completedAt,
    };
    job.resolveReport = () => report;
    job.status = 'completed';
    this.emit(job, { type: 'completed', cumulative: { ...cumulative }, reportId });
    // 只在真正完成时落库最终报告；取消路径不触发
    this.onComplete?.(report);
  }

  cancel(batchId: string): boolean {
    const job = this.jobs.get(batchId);
    // 只有未终结的批量可取消；幂等：重复取消已取消的不产生第二个终结事件
    if (!job || job.status !== 'running') return false;
    job.status = 'canceled';
    const processedItems = job.events.filter((e) => e.type === 'item').length;
    this.emit(job, { type: 'canceled', processedItems });
    return true;
  }

  status(batchId: string): BatchStatus | undefined {
    return this.jobs.get(batchId)?.status;
  }

  /** 仅供完成批量调用：取消的批量拿不到报告（不写部分最终统计） */
  report(batchId: string): EvaluationReport | undefined {
    return this.jobs.get(batchId)?.resolveReport?.();
  }

  private emit(job: Job, data: DistributiveOmit<BatchEvent, 'batchId' | 'seq'>): void {
    const seq = job.events.length + 1;
    job.events.push({ batchId: job.id, seq, ...data } as BatchEvent);
  }

  /** 重连：只返回 lastEventId 之后的事件。事件本身唯一，重放不会重复计数 */
  replay(batchId: string, lastEventId = 0): { status: BatchStatus; events: BatchEvent[] } | undefined {
    const job = this.jobs.get(batchId);
    if (!job) return undefined;
    return { status: job.status, events: job.events.filter((e) => e.seq > lastEventId) };
  }

  events(batchId: string): BatchEvent[] | undefined {
    return this.jobs.get(batchId)?.events;
  }
}
