import type { RuleInput, RuleRevision, Snapshot } from '../shared/model';
import { validateRule } from '../shared/matcher';

export class RevisionConflictError extends Error {
  constructor(public current: number) {
    super('revision_conflict');
    this.name = 'RevisionConflictError';
  }
}

/**
 * 追加式规则存储。当前态 + 完整 revision 历史都保留：
 * 修改不会覆盖旧文档，历史快照/批量据此用固化 revision 回放。
 */
export class RuleStore {
  private latest = new Map<string, RuleRevision>();
  private history = new Map<string, RuleRevision[]>();
  private seq = 0;

  constructor(private clock: () => number = Date.now) {}

  private nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  list(): RuleRevision[] {
    return [...this.latest.values()];
  }

  get(ruleId: string): RuleRevision | undefined {
    return this.latest.get(ruleId);
  }

  /** 取某条规则的指定 revision（缺省取最新）；不存在返回 undefined */
  getRevision(ruleId: string, revision?: number): RuleRevision | undefined {
    const docs = this.history.get(ruleId);
    if (!docs) return undefined;
    if (revision === undefined) return docs[docs.length - 1];
    return docs.find((d) => d.revision === revision);
  }

  historyOf(ruleId: string): RuleRevision[] {
    return [...(this.history.get(ruleId) ?? [])];
  }

  create(input: RuleInput): RuleRevision {
    const seq = this.nextSeq();
    const ruleId = `rule_${seq.toString(36).padStart(4, '0')}`;
    const now = new Date(this.clock()).toISOString();
    const doc = this.buildDoc(ruleId, 1, seq, now, now, input);
    this.latest.set(ruleId, doc);
    this.history.set(ruleId, [doc]);
    return doc;
  }

  /**
   * 乐观并发更新：expectedRevision 必须等于当前 revision。
   * createdSeq/createdAt 从首版继承——编辑不改变创建顺序优先级。
   */
  update(ruleId: string, input: RuleInput, expectedRevision: number): RuleRevision {
    const current = this.latest.get(ruleId);
    if (!current) throw new Error('not_found');
    if (current.revision !== expectedRevision) throw new RevisionConflictError(current.revision);
    const now = new Date(this.clock()).toISOString();
    const doc = this.buildDoc(ruleId, current.revision + 1, current.createdSeq, current.createdAt, now, input);
    this.latest.set(ruleId, doc);
    this.history.get(ruleId)!.push(doc);
    return doc;
  }

  /** 禁用/启用同样生成新 revision */
  setEnabled(ruleId: string, enabled: boolean, expectedRevision: number): RuleRevision {
    const current = this.latest.get(ruleId);
    if (!current) throw new Error('not_found');
    return this.update(
      ruleId,
      {
        reason: current.reason,
        pathPattern: current.pathPattern,
        fingerprint: current.fingerprint,
        ruleCode: current.ruleCode,
        attributes: current.attributes,
        expiresAt: current.expiresAt,
        enabled,
      },
      expectedRevision,
    );
  }

  private buildDoc(
    ruleId: string,
    revision: number,
    createdSeq: number,
    createdAt: string,
    updatedAt: string,
    input: RuleInput,
  ): RuleRevision {
    const validationErrors = validateRule(input);
    return {
      ruleId,
      revision,
      createdSeq,
      createdAt,
      updatedAt,
      reason: input.reason,
      pathPattern: input.pathPattern ?? null,
      fingerprint: input.fingerprint ?? null,
      ruleCode: input.ruleCode ?? null,
      attributes: input.attributes ?? [],
      expiresAt: input.expiresAt ?? null,
      enabled: input.enabled ?? true,
      valid: validationErrors.length === 0,
      validationErrors,
    };
  }

  /** 按固化的 revision 还原当时的规则集合（pin 中缺失的规则不存在） */
  resolvePinned(pins: Record<string, number>): RuleRevision[] {
    const docs: RuleRevision[] = [];
    for (const [ruleId, rev] of Object.entries(pins)) {
      const doc = this.getRevision(ruleId, rev);
      if (doc) docs.push(doc);
    }
    return docs;
  }

  /** 当前各规则的 revision 固化表（批量启动时刻） */
  currentPins(): Record<string, number> {
    const pins: Record<string, number> = {};
    for (const doc of this.list()) pins[doc.ruleId] = doc.revision;
    return pins;
  }

  /** 测试/种子：以确定的 id/时间直接落一份首版 */
  seed(input: RuleInput, ruleId: string, createdAt: string, createdSeq: number): RuleRevision {
    const doc = this.buildDoc(ruleId, 1, createdSeq, createdAt, createdAt, input);
    this.latest.set(ruleId, doc);
    this.history.set(ruleId, [doc]);
    this.seq = Math.max(this.seq, createdSeq);
    return doc;
  }
}

/** 静态样例快照（审阅用，不连线上系统） */
export class SnapshotStore {
  private map = new Map<string, Snapshot>();
  constructor(snapshots: Snapshot[] = []) {
    for (const s of snapshots) this.map.set(s.id, s);
  }
  list(): Snapshot[] {
    return [...this.map.values()];
  }
  get(id: string): Snapshot | undefined {
    return this.map.get(id);
  }
}
