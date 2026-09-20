import { Router, type Request, type Response } from 'express';
import type { RuleInput } from '../shared/model';
import { RevisionConflictError, type RuleStore, type SnapshotStore } from './store';
import { evaluateSnapshot } from './evaluator';
import { BatchManager } from './batch';
import { ReportStore, replayReport } from './reports';

export interface SuppressionDeps {
  rules: RuleStore;
  snapshots: SnapshotStore;
  batches: BatchManager;
  reports: ReportStore;
  clock: () => number;
}

export function createSuppressionRouter(deps: SuppressionDeps): Router {
  const { rules, snapshots, batches, reports, clock } = deps;
  const router = Router();

  // ---- 规则 ----
  router.get('/rules', (_req, res) => {
    res.json({
      rules: rules.list(),
      history: Object.fromEntries(rules.list().map((r) => [r.ruleId, rules.historyOf(r.ruleId)])),
    });
  });

  router.get('/rules/:id', (req, res) => {
    const rule = rules.get(req.params.id);
    if (!rule) return res.status(404).json({ error: 'not_found' });
    res.json({ rule, history: rules.historyOf(req.params.id) });
  });

  // 非法规则也会被持久化（valid=false）：评估时要能区分“规则本身无效”
  router.post('/rules', (req, res) => {
    const body = (req.body ?? {}) as RuleInput;
    const doc = rules.create(body);
    res.status(201).json({ rule: doc });
  });

  router.put('/rules/:id', (req, res) => {
    const expected = Number((req.body as { expectedRevision?: number })?.expectedRevision);
    if (!Number.isInteger(expected)) return res.status(400).json({ error: 'expectedRevision_required' });
    try {
      const doc = rules.update(req.params.id, req.body as RuleInput, expected);
      res.json({ rule: doc });
    } catch (err) {
      if (err instanceof RevisionConflictError) return res.status(409).json({ error: 'revision_conflict', current: rules.get(req.params.id) });
      return res.status(404).json({ error: 'not_found' });
    }
  });

  router.post('/rules/:id/enabled', (req, res) => {
    const expected = Number(req.body?.expectedRevision);
    const enabled = Boolean(req.body?.enabled);
    if (!Number.isInteger(expected)) return res.status(400).json({ error: 'expectedRevision_required' });
    try {
      const doc = rules.setEnabled(req.params.id, enabled, expected);
      res.json({ rule: doc });
    } catch (err) {
      if (err instanceof RevisionConflictError) return res.status(409).json({ error: 'revision_conflict', current: rules.get(req.params.id) });
      return res.status(404).json({ error: 'not_found' });
    }
  });

  // ---- 样例快照 ----
  router.get('/snapshots', (_req, res) => {
    // 节点/问题完整下发，前端做样例预览
    res.json({ snapshots: snapshots.list() });
  });

  router.get('/snapshots/:id', (req, res) => {
    const snapshot = snapshots.get(req.params.id);
    if (!snapshot) return res.status(404).json({ error: 'not_found' });
    res.json({ snapshot });
  });

  // ---- 即时评估（当前规则）。?at=<iso> 用于时钟边界测试 ----
  router.post('/snapshots/:id/evaluate', (req, res) => {
    const snapshot = snapshots.get(req.params.id);
    if (!snapshot) return res.status(404).json({ error: 'not_found' });
    const atRaw = (req.body?.at as string | undefined) ?? (req.query.at as string | undefined);
    const nowMs = atRaw !== undefined ? Date.parse(atRaw) : clock();
    if (atRaw !== undefined && Number.isNaN(nowMs)) return res.status(400).json({ error: 'at_not_iso' });
    const ruleSet = new Map(rules.list().map((r) => [r.ruleId, r]));
    const result = evaluateSnapshot(snapshot, ruleSet, nowMs);
    res.json({ evaluatedAt: new Date(nowMs).toISOString(), result });
  });

  // ---- 批量重新评估 ----
  router.post('/batches', (req, res) => {
    const { batchId } = batches.start({ snapshotIds: req.body?.snapshotIds });
    res.status(202).json({ batchId });
  });

  router.post('/batches/:id/cancel', (req, res) => {
    const ok = batches.cancel(req.params.id);
    if (!ok) return res.status(409).json({ error: 'not_running', status: batches.status(req.params.id) ?? 'not_found' });
    res.json({ status: 'canceled' });
  });

  router.get('/batches/:id', (req, res) => {
    const status = batches.status(req.params.id);
    if (!status) return res.status(404).json({ error: 'not_found' });
    const report = batches.report(req.params.id);
    res.json({ status, reportId: report?.id });
  });

  // SSE 事件流。支持 Last-Event-ID 头（EventSource 自动）或 ?lastEventId（测试用）
  router.get('/batches/:id/events', (req: Request, res: Response) => {
    const batchId = String(req.params.id);
    if (!batches.status(batchId)) return res.status(404).json({ error: 'not_found' });

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const headerId = req.header('last-event-id');
    const lastEventId = Number(headerId ?? req.query.lastEventId ?? 0) || 0;

    const send = (events: NonNullable<ReturnType<BatchManager['events']>>) => {
      for (const ev of events) {
        res.write(`id: ${ev.seq}\n`);
        res.write(`event: ${ev.type}\n`);
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    };

    const initial = batches.replay(batchId, lastEventId);
    if (initial) send(initial.events);

    // 运行中：轮询缓冲，新事件（含终结事件）到达即推送后结束流
    if (initial && initial.status === 'running') {
      let cursor = Math.max(lastEventId, initial.events.length ? initial.events[initial.events.length - 1].seq : lastEventId);
      const timer = setInterval(() => {
        const tail = batches.replay(batchId, cursor);
        if (!tail) {
          clearInterval(timer);
          return res.end();
        }
        if (tail.events.length) {
          send(tail.events);
          cursor = tail.events[tail.events.length - 1].seq;
        }
        if (tail.status !== 'running') {
          clearInterval(timer);
          res.end();
        }
      }, 15);
      req.on('close', () => clearInterval(timer));
    } else {
      res.end();
    }
  });

  // ---- 历史报告与回放 ----
  router.get('/reports', (_req, res) => res.json({ reports: reports.list() }));

  router.get('/reports/:id', (req, res) => {
    const report = reports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'not_found' });
    res.json({ report });
  });

  router.post('/reports/:id/replay', (req, res) => {
    const report = reports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'not_found' });
    const redone = replayReport(report, rules, snapshots);
    res.json({
      report: redone,
      matchesStored: JSON.stringify(redone.decisions) === JSON.stringify(report.decisions),
      note: '按固化 revision 与 evaluatedAt 重新推导，应与已存结论逐字段一致',
    });
  });

  return router;
}
