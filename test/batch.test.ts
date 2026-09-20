import { describe, expect, it } from 'vitest';
import { RuleStore, SnapshotStore } from '../src/server/store';
import { BatchManager, type BatchEvent, type ItemEvent } from '../src/server/batch';
import { SAMPLE_SNAPSHOTS, seedRules } from '../src/server/seed';
import { emptyStats } from '../src/shared/model';

import type { EvaluationReport } from '../src/shared/model';

const NOW = Date.parse('2026-09-20T12:00:00.000Z');

function setup(delayMs = 5) {
  const clock = () => NOW;
  const rules = new RuleStore(clock);
  seedRules(rules);
  const snapshots = new SnapshotStore(SAMPLE_SNAPSHOTS);
  let saved: EvaluationReport | undefined;
  const batches = new BatchManager(rules, snapshots, clock, { delayMs, onComplete: (r) => (saved = r) });
  const savedReport = () => saved;
  return { rules, snapshots, batches, savedReport };
}

const waitFor = async (predicate: () => boolean, timeout = 1000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 2));
  }
};

const items = (events: BatchEvent[]): ItemEvent[] => events.filter((e): e is ItemEvent => e.type === 'item');

describe('批量重新评估', () => {
  it('固定规则 revision：批量启动后并发编辑不影响本批结论', async () => {
    const { rules, batches } = setup(5);
    const { batchId } = batches.start();
    const pinsAtStart = batches.events(batchId)!.find((e) => e.type === 'started')!;
    expect(pinsAtStart.type).toBe('started');

    // 运行中编辑：把所有规则改到不匹配（生成新 revision）
    await new Promise((r) => setTimeout(r, 1));
    for (const rule of rules.list()) {
      rules.update(
        rule.ruleId,
        {
          reason: rule.reason,
          pathPattern: '/nowhere',
          fingerprint: rule.fingerprint ?? undefined,
          ruleCode: rule.ruleCode ?? undefined,
          attributes: rule.attributes,
          expiresAt: rule.expiresAt ?? undefined,
          enabled: rule.enabled,
        },
        rule.revision,
      );
    }

    await waitFor(() => batches.status(batchId) === 'completed');
    const events = batches.events(batchId)!;
    const completed = events.find((e) => e.type === 'completed')!;
    expect(completed.type).toBe('completed');

    // 本批用的是固化 pins（revision=1），仍有抑制；若用“当前”规则则会全部 unsuppressed
    const cumulative = (completed as { cumulative: Record<string, number> }).cumulative;
    expect(cumulative.suppressed).toBeGreaterThan(0);

    // started 事件里记录的 pin 是 revision 1
    const startedPins = pinsAtStart as unknown as { ruleRevisionPins: Record<string, number> };
    expect(new Set(Object.values(startedPins.ruleRevisionPins))).toEqual(new Set([1]));
  });

  it('完成后落库最终报告', async () => {
    const { batches, savedReport } = setup(5);
    const { batchId } = batches.start();
    await waitFor(() => batches.status(batchId) === 'completed');
    expect(savedReport()).toBeDefined();
  });

  it('取消后不写部分最终统计：无 completed、无报告、无 cumulative', async () => {
    const { batches, savedReport } = setup(40); // 每 item 40ms，3 个快照
    const { batchId } = batches.start();
    // 等到第一个 item 处理完，再取消
    await waitFor(() => items(batches.events(batchId)!).length >= 1);
    const canceled = batches.cancel(batchId);
    expect(canceled).toBe(true);
    await waitFor(() => batches.status(batchId) === 'canceled');

    const events = batches.events(batchId)!;
    expect(events.some((e) => e.type === 'completed')).toBe(false);
    expect(events.some((e) => e.type === 'canceled')).toBe(true);
    const canceledEvent = events.find((e) => e.type === 'canceled') as unknown as {
      processedItems: number;
      cumulative?: unknown;
    };
    expect(canceledEvent.cumulative).toBeUndefined(); // 刻意不带部分最终统计
    expect(canceledEvent.processedItems).toBeGreaterThanOrEqual(1);
    expect(batches.report(batchId)).toBeUndefined();
    expect(savedReport()).toBeUndefined();
  });

  it('取消幂等：重复取消只产生一个 canceled 终结事件', async () => {
    const { batches } = setup(40);
    const { batchId } = batches.start();
    await waitFor(() => items(batches.events(batchId)!).length >= 1);
    expect(batches.cancel(batchId)).toBe(true);
    expect(batches.cancel(batchId)).toBe(false); // 已非 running
    await waitFor(() => batches.status(batchId) === 'canceled');
    const canceledCount = batches.events(batchId)!.filter((e) => e.type === 'canceled').length;
    expect(canceledCount).toBe(1);
  });

  it('取消后不再处理后续 item（只处理取消前已开始/完成的）', async () => {
    const { batches } = setup(40);
    const { batchId } = batches.start();
    await waitFor(() => items(batches.events(batchId)!).length >= 1);
    batches.cancel(batchId);
    await new Promise((r) => setTimeout(r, 120));
    const processed = items(batches.events(batchId)!).length;
    expect(processed).toBeLessThan(3);
  });

  it('单一时钟：同批所有 item 使用同一 evaluatedAt', async () => {
    const { batches } = setup(1);
    const { batchId } = batches.start();
    await waitFor(() => batches.status(batchId) === 'completed');
    const started = batches.events(batchId)!.find((e) => e.type === 'started') as unknown as { evaluatedAt: string };
    // started 时钟固定；completed 的报告也使用同一瞬间（由 report 校验）
    const report = batches.report(batchId)!;
    expect(report.evaluatedAt).toBe(started.evaluatedAt);
  });
});

describe('事件流重连：不重复计数', () => {
  it('replay 仅返回 lastEventId 之后的事件，序号唯一', async () => {
    const { batches } = setup(1);
    const { batchId } = batches.start();
    await waitFor(() => batches.status(batchId) === 'completed');
    const all = batches.events(batchId)!;

    // 模拟客户端在第 2 个事件后断线重连
    const tail = batches.replay(batchId, 2)!;
    expect(tail.events[0].seq).toBe(3);
    expect(tail.events[tail.events.length - 1].seq).toBe(all.length);

    // 全程收到的事件序号 = 首次(1..2) + 重放(3..N)，无重复无缺失
    const seqs = [...all.slice(0, 2).map((e) => e.seq), ...tail.events.map((e) => e.seq)];
    expect(seqs).toEqual(all.map((e) => e.seq));
  });

  it('客户端以服务端 cumulative 为唯一真相：重放叠加也不翻倍', async () => {
    const { batches } = setup(1);
    const { batchId } = batches.start();
    await waitFor(() => batches.status(batchId) === 'completed');

    // 模拟：首次处理了 item#1 得到 cumulative A；断线后重放又收到同一个 item#1 事件。
    // 正确做法是“覆盖”而非“累加”。断言该 item 事件的 cumulative 是全量累计。
    const itemEvents = items(batches.events(batchId)!);
    const first = itemEvents[0];
    const replayFirst = batches.replay(batchId, 0)!.events.filter((e): e is ItemEvent => e.type === 'item')[0];

    const sum = (s: Record<string, number>) => Object.values(s).reduce((a, b) => a + b, 0);
    // 同一序号事件两次到达，统计完全相等；客户端覆盖后计数不变
    expect(replayFirst.seq).toBe(first.seq);
    expect(replayFirst.cumulative).toEqual(first.cumulative);
    // cumulative 是累计问题数（非每个快照独立），随 item 单调不减
    const totals = itemEvents.map((e) => sum(e.cumulative));
    expect(totals[totals.length - 1]).toBeGreaterThanOrEqual(totals[0]);
    const last = itemEvents[itemEvents.length - 1].cumulative;
    expect(sum(last)).toBe(totals[totals.length - 1]);
  });

  it('每个 item 仅出现一次（服务端不重发），completed 统计等于各 item 累计', async () => {
    const { batches } = setup(1);
    const { batchId } = batches.start();
    await waitFor(() => batches.status(batchId) === 'completed');
    const itemEvents = items(batches.events(batchId)!);
    const snapshotIds = itemEvents.map((e) => e.snapshotId);
    expect(new Set(snapshotIds).size).toBe(snapshotIds.length); // 无重复 item

    const completed = batches.events(batchId)!.find((e) => e.type === 'completed') as unknown as {
      cumulative: Record<string, number>;
    };
    const finalCumulative = { ...emptyStats() };
    // 若错误地把 cumulative 再相加会翻倍；正确最终值应等于 completed 的全量累计
    const authoritative = itemEvents[itemEvents.length - 1].cumulative;
    for (const k of Object.keys(finalCumulative) as (keyof typeof finalCumulative)[]) {
      finalCumulative[k] = authoritative[k];
    }
    expect(finalCumulative).toEqual(completed.cumulative);
  });
});
