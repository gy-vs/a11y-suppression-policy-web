import express from 'express';
import type { Request, Response } from 'express';
import { fileURLToPath } from 'node:url';
import type { RuleCreateInput, RuleDraft, RuleUpdateInput } from '../shared/domain';
import { validateFutureExpiry } from '../shared/engine';
import { Store, type StoreClock } from './store';

type BadRequest = { error: 'bad_request'; details: string[] };

function normalizeDraft(body: any): { draft: RuleDraft; details: string[] } {
  const details: string[] = [];
  const nullableString = (v: unknown, field: string): string | null => {
    if (v === null || v === undefined || v === '') return v === '' ? '' : null;
    if (typeof v !== 'string') {
      details.push(`${field} must be a string or null`);
      return null;
    }
    return v;
  };
  const pathPattern = body?.pathPattern === undefined ? null : nullableString(body.pathPattern, 'pathPattern');
  const fingerprint = nullableString(body?.fingerprint, 'fingerprint');
  const code = nullableString(body?.code, 'code');
  const expiresAt = nullableString(body?.expiresAt, 'expiresAt');
  const reason = typeof body?.reason === 'string' ? body.reason : '';
  if (typeof body?.reason !== 'string') details.push('reason must be a string');

  let attributes: RuleDraft['attributes'] = [];
  if (body?.attributes !== undefined) {
    if (!Array.isArray(body.attributes)) details.push('attributes must be an array');
    else
      attributes = body.attributes.map((entry: any) => ({
        name: String(entry?.name ?? ''),
        valuePattern: String(entry?.valuePattern ?? ''),
      }));
  }
  return { draft: { pathPattern, fingerprint, code, attributes, reason, expiresAt }, details };
}

function parseAt(body: any, query: any): number | undefined {
  const raw = (body?.at ?? query?.at) as string | undefined;
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

export function createApp(clock?: StoreClock) {
  const app = express();
  const store = new Store(clock);
  app.use(express.json({ limit: '1mb' }));
  app.set('store', store);

  app.get('/api/bootstrap', (_req, res) =>
    res.json({ family: 'accessibility-review', policyVersion: store.policyVersion, mode: 'sample-snapshots' }),
  );

  app.get('/api/snapshots', (_req, res) => res.json(store.snapshots));
  app.get('/api/snapshots/:id', (req, res) => {
    const snapshot = store.getSnapshot(req.params.id);
    if (!snapshot) return res.status(404).json({ error: 'not_found' });
    res.json(snapshot);
  });

  // ---- Rules ------------------------------------------------------------

  app.get('/api/rules', (_req, res) => res.json({ policyVersion: store.policyVersion, rules: store.rules }));

  app.post('/api/rules', (req, res) => {
    const { draft, details } = normalizeDraft(req.body);
    if (details.length) return res.status(400).json({ error: 'bad_request', details } satisfies BadRequest);
    const expiryError = validateFutureExpiry(draft.expiresAt, store.clock.now());
    if (expiryError) return res.status(400).json({ error: 'bad_request', details: [expiryError.message] } satisfies BadRequest);
    const input: RuleCreateInput = { ...draft, enabled: req.body?.enabled !== false, createdBy: req.body?.createdBy };
    const result = store.createRule(input);
    res.status(201).json({ policyVersion: store.policyVersion, rule: result.rule });
  });

  app.get('/api/rules/:id', (req, res) => {
    const rule = store.getRule(req.params.id);
    if (!rule) return res.status(404).json({ error: 'not_found' });
    res.json({ policyVersion: store.policyVersion, rule });
  });

  app.put('/api/rules/:id', (req: Request<{ id: string }>, res: Response) => {
    const existing = store.getRule(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const expectedRevision = Number(req.body?.expectedRevision);
    if (!Number.isInteger(expectedRevision))
      return res.status(400).json({ error: 'bad_request', details: ['expectedRevision must be an integer'] } satisfies BadRequest);
    const { draft, details } = normalizeDraft(req.body);
    if (details.length) return res.status(400).json({ error: 'bad_request', details } satisfies BadRequest);
    const expiryError = validateFutureExpiry(draft.expiresAt, store.clock.now());
    if (expiryError) return res.status(400).json({ error: 'bad_request', details: [expiryError.message] } satisfies BadRequest);
    const input: RuleUpdateInput = {
      ...draft,
      enabled: req.body?.enabled !== false,
      expectedRevision,
      createdBy: req.body?.createdBy,
    };
    const result = store.updateRule(existing, input);
    if ('status' in result)
      return res.status(409).json({ error: 'revision_conflict', policyVersion: store.policyVersion, current: result.current });
    res.json({ policyVersion: store.policyVersion, rule: result.rule });
  });

  app.post('/api/rules/:id/enabled', (req, res) => {
    const existing = store.getRule(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const expectedRevision = Number(req.body?.expectedRevision);
    if (!Number.isInteger(expectedRevision))
      return res.status(400).json({ error: 'bad_request', details: ['expectedRevision must be an integer'] } satisfies BadRequest);
    if (typeof req.body?.enabled !== 'boolean')
      return res.status(400).json({ error: 'bad_request', details: ['enabled must be a boolean'] } satisfies BadRequest);
    const result = store.setEnabled(existing, req.body.enabled, expectedRevision, req.body?.createdBy);
    if ('status' in result)
      return res.status(409).json({ error: 'revision_conflict', policyVersion: store.policyVersion, current: result.current });
    res.json({ policyVersion: store.policyVersion, rule: result.rule });
  });

  // ---- Evaluation -------------------------------------------------------

  app.post('/api/snapshots/:id/evaluate', (req, res) => {
    const snapshot = store.getSnapshot(req.params.id);
    if (!snapshot) return res.status(404).json({ error: 'not_found' });
    const at = parseAt(req.body, req.query);
    if (req.body?.at !== undefined && at === undefined)
      return res.status(400).json({ error: 'bad_request', details: ['at must be an ISO timestamp'] } satisfies BadRequest);
    const persist = req.body?.persist === true;
    const frozen = store.freezeRules();
    const evaluation = store.evaluate(snapshot, frozen, at ?? store.clock.now(), persist);
    if (persist) store.persistEvaluation(evaluation);
    res.json({ policyVersion: frozen.policyVersion, evaluation });
  });

  app.get('/api/evaluations', (_req, res) => res.json({ evaluations: store.listEvaluations() }));

  app.get('/api/evaluations/:id', (req, res) => {
    const evaluation = store.evaluations.get(req.params.id);
    if (!evaluation) return res.status(404).json({ error: 'not_found' });
    // Replay explanation: the stored evaluation is the frozen record; current
    // rules are attached only as change annotations, never used to re-match.
    res.json(store.annotatedEvaluation(evaluation));
  });

  // ---- Batch jobs -------------------------------------------------------

  app.post('/api/batch-jobs', (req, res) => {
    const ids = req.body?.snapshotIds;
    if (!Array.isArray(ids) || !ids.every((v: unknown) => typeof v === 'string'))
      return res.status(400).json({ error: 'bad_request', details: ['snapshotIds must be a string array'] } satisfies BadRequest);
    const result = store.createBatchJob(ids, parseAt(req.body, {}));
    if ('error' in result) return res.status(404).json(result);
    res.status(202).json(result);
  });

  app.get('/api/batch-jobs/:id', (req, res) => {
    const job = store.jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'not_found' });
    res.json(job);
  });

  app.post('/api/batch-jobs/:id/cancel', (req, res) => {
    const job = store.jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'not_found' });
    res.json(store.requestCancel(job));
  });

  // SSE: events carry monotonic per-job seq numbers. On reconnect the client
  // sends Last-Event-ID (or ?afterSeq); the server replays only newer events,
  // so a dropped connection can never double-count a snapshot_done.
  app.get('/api/batch-jobs/:id/events', (req, res) => {
    const job = store.jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'not_found' });

    let afterSeq = 0;
    const headerId = req.header('last-event-id');
    if (headerId !== undefined && /^\d+$/.test(headerId)) afterSeq = Number(headerId);
    const querySeq = Number(req.query.afterSeq);
    if (Number.isInteger(querySeq) && querySeq > afterSeq) afterSeq = querySeq;

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const send = (event: (typeof job.events)[number]) => {
      res.write(`id: ${event.seq}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Replay missed history first (deduplicated by seq against this cursor).
    for (const event of job.events) if (event.seq > afterSeq) send(event);

    const unsubscribe = store.onJobEvent(job.id, send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
