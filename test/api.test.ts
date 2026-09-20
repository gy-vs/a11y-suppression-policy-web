import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import { createApp } from '../src/server/index';
import type { StoreClock } from '../src/server/store';

// Fixed wall clock: 2026-09-20, well after the seeded 2026-09-10 expiry.
const NOW = Date.parse('2026-09-20T12:00:00.000Z');
function clock(now = NOW): StoreClock {
  return { now: () => now, delayMs: () => 5 };
}

type App = ReturnType<typeof createApp>;

async function evalSnap(app: App, id: string, at?: string, persist = false) {
  const body: any = { persist };
  if (at) body.at = at;
  const res = await request(app).post(`/api/snapshots/${id}/evaluate`).send(body).expect(200);
  return res.body.evaluation;
}

function decisionMap(evaluation: any): Record<string, { decision: string; winner: any; hits: any[] }> {
  return Object.fromEntries(
    evaluation.findings.map((f: any) => [`${f.nodeId}:${f.code}`, { decision: f.decision, winner: f.winner, hits: f.hits }]),
  );
}

describe('rule matching semantics', () => {
  it('orders by specificity then creation time and explains overrides', async () => {
    const app = createApp(clock());
    const evaluation = await evalSnap(app, 'snap-checkout');
    const dm = decisionMap(evaluation);

    // fingerprint+code+attribute (specificity 7) beats path-only (1), even
    // though the path rule was created first.
    const contrast = dm['n-1:color-contrast'];
    expect(contrast.decision).toBe('suppressed');
    expect(contrast.winner.ruleId).toBe('r-cta-contrast');
    const broadHit = contrast.hits.find((h) => h.ruleId === 'r-broad')!;
    expect(broadHit.winning).toBe(false);
    expect(broadHit.override.kind).toBe('higher_specificity');
    expect(broadHit.override.winnerRuleId).toBe('r-cta-contrast');

    // code+attribute (3) beats path-only (1)
    expect(dm['n-1:label'].winner.ruleId).toBe('r-testid-label');
  });

  it('equal-specificity overlap is resolved oldest-first (tiebreak surfaced on hits)', async () => {
    const app = createApp(clock());
    // r-help-expired (path-only /help/*) is older; add a newer rule with the
    // exact same scope. The expired older rule must still outrank the newer
    // active rule — inactive winners shadow, tiebreak never reorders to active.
    await request(app)
      .post('/api/rules')
      .send({ pathPattern: '/help/*', reason: 'newer equal scope', createdBy: 'b@x' })
      .expect(201);
    const help = decisionMap(await evalSnap(app, 'snap-help'));
    const contrast = help['n-3:color-contrast'];
    expect(contrast.decision).toBe('expired');
    expect(contrast.winner.ruleId).toBe('r-help-expired');
    const newerHit = contrast.hits.find((h) => !h.winning)!;
    expect(newerHit.override.kind).toBe('older_rule_tiebreak');
    expect(newerHit.status).toBe('active');
  });
  it('distinguishes expired, invalid, disabled, suppressed and uncovered', async () => {
    const app = createApp(clock());
    const checkout = decisionMap(await evalSnap(app, 'snap-checkout'));
    expect(checkout['n-1:color-contrast'].decision).toBe('suppressed');
    expect(checkout['n-2:image-alt'].decision).toBe('invalid');
    expect(checkout['n-2:image-alt'].winner.ruleId).toBe('r-invalid');

    const help = decisionMap(await evalSnap(app, 'snap-help'));
    expect(help['n-3:color-contrast'].decision).toBe('expired');

    const account = decisionMap(await evalSnap(app, 'snap-account'));
    expect(account['n-4a:color-contrast'].decision).toBe('uncovered'); // fingerprint match but attribute drifted
    expect(account['n-4a:label'].decision).toBe('uncovered');

    const home = decisionMap(await evalSnap(app, 'snap-home'));
    expect(home['n-4:skip-link'].decision).toBe('disabled');
  });

  it('an inactive higher-priority rule shadows a lower active rule', async () => {
    const app = createApp(clock());
    // image-alt: invalid rule (spec 4) shadows broad path rule (spec 1) that
    // would otherwise suppress -> outcome must be invalid, not suppressed.
    const dm = decisionMap(await evalSnap(app, 'snap-checkout'));
    const img = dm['n-2:image-alt'];
    expect(img.decision).toBe('invalid');
    const broad = img.hits.find((h) => h.ruleId === 'r-broad')!;
    expect(broad.override.winnerStatus).toBe('invalid');
  });
});

describe('clock boundary', () => {
  it('treats now == expiresAt as expired, an instant before as suppressed', async () => {
    const app = createApp(clock());
    const expiry = '2026-12-31T23:59:59.000Z';
    const at = (ms: number) => new Date(Date.parse(expiry) + ms).toISOString();
    const before = decisionMap(await evalSnap(app, 'snap-checkout', at(-1)));
    const boundary = decisionMap(await evalSnap(app, 'snap-checkout', at(0)));
    expect(before['n-1:color-contrast'].decision).toBe('suppressed');
    expect(boundary['n-1:color-contrast'].decision).toBe('expired');
  });
});

describe('attribute changes', () => {
  it('stops matching attribute predicates when node attributes drift', async () => {
    const app = createApp(clock());
    // n-1 (checkout) and n-4a (account) share the same fingerprint + code;
    // only the data-testid attribute differs, which must flip both
    // attribute-scoped rules from suppressed to uncovered.
    const checkout = decisionMap(await evalSnap(app, 'snap-checkout'));
    const account = decisionMap(await evalSnap(app, 'snap-account'));
    expect(checkout['n-1:label'].decision).toBe('suppressed');
    expect(checkout['n-1:color-contrast'].decision).toBe('suppressed');
    expect(account['n-4a:label'].decision).toBe('uncovered');
    expect(account['n-4a:color-contrast'].decision).toBe('uncovered');
    expect(account['n-4a:color-contrast'].hits).toEqual([]);
  });
});

describe('rule editing, revisions and concurrency', () => {
  it('creates revisions on edit/disable and rejects stale writes', async () => {
    const app = createApp(clock());
    const get = await request(app).get('/api/rules/r-broad').expect(200);
    const rev1 = get.body.rule.history[0].revision;
    const updated = await request(app)
      .put('/api/rules/r-broad')
      .send({
        pathPattern: '/checkout',
        reason: 'updated reason',
        enabled: true,
        expectedRevision: rev1,
      })
      .expect(200);
    expect(updated.body.rule.history).toHaveLength(2);
    expect(updated.body.rule.history[1].reason).toBe('updated reason');
    expect(updated.body.rule.history[0].reason).toContain('A11Y-120'); // frozen

    const stale = await request(app)
      .put('/api/rules/r-broad')
      .send({ pathPattern: '/checkout', reason: 'lost edit', enabled: true, expectedRevision: rev1 })
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.current.history[1].reason).toBe('updated reason');

    const disabled = await request(app)
      .post('/api/rules/r-broad/enabled')
      .send({ enabled: false, expectedRevision: 2 })
      .expect(200);
    expect(disabled.body.rule.history[2].enabled).toBe(false);
    expect(disabled.body.rule.history[2].revision).toBe(3);
  });

  it('concurrent edits: one wins, the other must rebase to the new revision', async () => {
    const app = createApp(clock());
    const rev1 = 1;
    const a = request(app)
      .put('/api/rules/r-broad')
      .send({ pathPattern: '/checkout', reason: 'editor A', enabled: true, expectedRevision: rev1 });
    const b = request(app)
      .put('/api/rules/r-broad')
      .send({ pathPattern: '/checkout', reason: 'editor B', enabled: true, expectedRevision: rev1 });
    const [ra, rb] = await Promise.all([a, b]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    // The 409 payload carries the current revision so the loser can rebase.
    const conflict = [ra, rb].find((r) => r.status === 409)!;
    expect(conflict.body.current.history[1].revision).toBe(2);
    const rebased = await request(app)
      .put('/api/rules/r-broad')
      .send({
        pathPattern: '/checkout',
        reason: 'editor B rebased',
        enabled: true,
        expectedRevision: 2,
      })
      .expect(200);
    expect(rebased.body.rule.history[2].reason).toBe('editor B rebased');
  });

  it('rejects a past expiry at write time (expiry-in-past is not a stored rule state)', async () => {
    const app = createApp(clock());
    await request(app)
      .post('/api/rules')
      .send({ pathPattern: '/x', reason: 'late waiver', expiresAt: '2020-01-01T00:00:00.000Z' })
      .expect(400);
    await request(app)
      .put('/api/rules/r-broad')
      .send({ pathPattern: '/checkout', reason: 'x', enabled: true, expectedRevision: 1, expiresAt: '2020-01-01T00:00:00.000Z' })
      .expect(400);
    // Rule untouched despite the rejected edit.
    const still = await request(app).get('/api/rules/r-broad').expect(200);
    expect(still.body.rule.history).toHaveLength(1);
  });

  it('validates drafts and surfaces structured errors; invalid rule still stored', async () => {
    const app = createApp(clock());
    const res = await request(app)
      .post('/api/rules')
      .send({ pathPattern: 'checkout', reason: '', attributes: [] })
      .expect(201); // stored...
    expect(res.body.rule.history[0].invalid.map((e: any) => e.field).sort()).toEqual(['pathPattern', 'reason']);
    const list = await request(app).get('/api/rules').expect(200);
    expect(list.body.rules.some((r: any) => r.id === res.body.rule.id)).toBe(true);
  });
});

describe('historical replay', () => {
  it('persisted evaluations keep explaining the rule revision that suppressed them', async () => {
    const app = createApp(clock());
    const first = await evalSnap(app, 'snap-checkout', undefined, true);
    expect(first.persisted).toBe(true);
    const winnerAtFirst = first.findings.find((f: any) => f.code === 'color-contrast').winner;
    expect(winnerAtFirst).toEqual({ ruleId: 'r-cta-contrast', revision: 1 });

    // Later: narrow the cta rule so it no longer matches checkout contrast.
    await request(app)
      .put('/api/rules/r-cta-contrast')
      .send({
        pathPattern: '/other',
        fingerprint: 'btn-primary-a1',
        code: 'color-contrast',
        reason: 'moved to other surface',
        expiresAt: null,
        enabled: true,
        expectedRevision: 1,
      })
      .expect(200);

    // Re-fetch the OLD evaluation: verdict frozen at rev 1, annotated as changed.
    const replay = await request(app).get(`/api/evaluations/${first.id}`).expect(200);
    const oldContrast = replay.body.evaluation.findings.find(
      (f: any) => f.nodeId === 'n-1' && f.code === 'color-contrast',
    );
    expect(oldContrast.decision).toBe('suppressed');
    expect(oldContrast.winner).toEqual({ ruleId: 'r-cta-contrast', revision: 1 });
    const winnerHit = replay.body.annotations.find(
      (h: any) => h.ruleId === 'r-cta-contrast' && h.revision === 1,
    );
    expect(winnerHit.changedSince).toBe(true);

    // A fresh evaluation now falls through to the broad path rule.
    const fresh = decisionMap(await evalSnap(app, 'snap-checkout'));
    expect(fresh['n-1:color-contrast'].winner.ruleId).toBe('r-broad');
  });
});

describe('batch re-evaluation', () => {
  it('pins the policy revision and lists it on the job and events', async () => {
    const app = createApp(clock());
    const before = await request(app).get('/api/rules').expect(200);
    const job = await request(app)
      .post('/api/batch-jobs')
      .send({ snapshotIds: ['snap-checkout', 'snap-home'] })
      .expect(202);
    expect(job.body.policyVersion).toBe(before.body.policyVersion);
    // Edit during the run: the job must not see it.
    await request(app)
      .put('/api/rules/r-broad')
      .send({ pathPattern: '/checkout', reason: 'changed mid-run', enabled: true, expectedRevision: 1 });
    await vi.waitFor(async () => {
      const got = await request(app).get(`/api/batch-jobs/${job.body.id}`).expect(200);
      expect(got.body.status).toBe('completed');
    });
    const done = await request(app).get(`/api/batch-jobs/${job.body.id}`).expect(200);
    expect(done.body.stats.total).toBe(4); // 3 checkout findings + 1 home
    expect(done.body.stats.suppressed).toBeGreaterThan(0);
    expect(done.body.stats.disabled).toBe(1);
    // Persisted evaluations used the pinned revision.
    const evals = await request(app).get('/api/evaluations').expect(200);
    expect(evals.body.evaluations.every((e: any) => e.policyVersion === before.body.policyVersion)).toBe(true);
  });

  it('cancelled jobs write no evaluations and no partial final stats', async () => {
    // Slow clock: cancel before the first snapshot finishes.
    const app = createApp({ now: () => NOW, delayMs: () => 80 });
    const before = (await request(app).get('/api/evaluations').expect(200)).body.evaluations.length;
    const job = await request(app)
      .post('/api/batch-jobs')
      .send({ snapshotIds: ['snap-checkout', 'snap-help', 'snap-home'] })
      .expect(202);
    await request(app).post(`/api/batch-jobs/${job.body.id}/cancel`).expect(200);

    await vi.waitFor(async () => {
      const got = await request(app).get(`/api/batch-jobs/${job.body.id}`).expect(200);
      expect(got.body.status).toBe('cancelled');
    });
    const done = await request(app).get(`/api/batch-jobs/${job.body.id}`).expect(200);
    expect(done.body.stats).toBeNull(); // no partial final stats
    const after = (await request(app).get('/api/evaluations').expect(200)).body.evaluations.length;
    expect(after).toBe(before); // nothing persisted
    const snap = await request(app).get('/api/snapshots/snap-checkout').expect(200);
    expect(snap.body.latestEvaluationId).toBeNull();
  });

  it('cancel after partial progress drops already-computed evaluations too', async () => {
    // First snapshot finishes quickly; later ones take long enough that the
    // cancel lands while the second is still in flight.
    let step = 0;
    const delays = [10, 300, 300];
    const app = createApp({ now: () => NOW, delayMs: () => delays[Math.min(step++, delays.length - 1)] });
    const job = await request(app)
      .post('/api/batch-jobs')
      .send({ snapshotIds: ['snap-checkout', 'snap-help', 'snap-home'] })
      .expect(202);
    // Wait until exactly one snapshot_done landed, then cancel.
    await vi.waitFor(async () => {
      const got = await request(app).get(`/api/batch-jobs/${job.body.id}`).expect(200);
      expect(got.body.processed).toBe(1);
    });
    await request(app).post(`/api/batch-jobs/${job.body.id}/cancel`).expect(200);
    await vi.waitFor(async () => {
      const got = await request(app).get(`/api/batch-jobs/${job.body.id}`).expect(200);
      expect(got.body.status).toBe('cancelled');
    });
    const done = await request(app).get(`/api/batch-jobs/${job.body.id}`);
    expect(done.body.processed).toBe(1);
    expect(done.body.stats).toBeNull();
    const evals = await request(app).get('/api/evaluations').expect(200);
    expect(evals.body.evaluations).toHaveLength(0);
  });
});

describe('SSE event stream', () => {
  function rawOpenStream(port: number, jobId: string, opts: { afterSeq?: number; lastEventId?: string }) {
    const msgs: any[] = [];
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (opts.lastEventId) headers['Last-Event-ID'] = opts.lastEventId;
    const path =
      `/api/batch-jobs/${jobId}/events` + (opts.afterSeq !== undefined ? `?afterSeq=${opts.afterSeq}` : '');
    const req = http.get({ port, path, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine) msgs.push(JSON.parse(dataLine.slice(6)));
        }
      });
    });
    return { msgs, close: () => req.destroy() };
  }

  let server: http.Server;
  let port: number;
  beforeEach(async () => {
    const app = createApp({ now: () => NOW, delayMs: () => 30 });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    port = (server.address() as any).port;
    (globalThis as any).__app = app;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (path: string, body?: any) =>
    new Promise<any>((resolve, reject) => {
      const data = body ? JSON.stringify(body) : '';
      const req = http.request(
        { port, path, method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : {} }));
        },
      );
      req.on('error', reject);
      if (body) req.write(data);
      req.end();
    });

  it('reconnect with Last-Event-ID replays missed events without duplicates', async () => {
    const job = await post('/api/batch-jobs', { snapshotIds: ['snap-checkout', 'snap-help'] });
    // First stream connects after the run completed: replays every event once.
    const first = rawOpenStream(port, job.body.id, {});
    await vi.waitFor(() => expect(first.msgs.some((m) => m.type === 'completed')).toBe(true));
    const seqCount = first.msgs.length;
    const lastSeq = first.msgs[first.msgs.length - 1].seq;
    expect(first.msgs.map((m) => m.seq)).toEqual([...Array(seqCount)].map((_, i) => i + 1));
    first.close();

    // Reconnect at the terminal seq: zero events, no double counting.
    const second = rawOpenStream(port, job.body.id, { lastEventId: String(lastSeq) });
    await new Promise((r) => setTimeout(r, 100));
    expect(second.msgs).toEqual([]);
    second.close();

    // Reconnect at seq 1: replays only events > 1, each exactly once.
    const third = rawOpenStream(port, job.body.id, { lastEventId: '1' });
    await vi.waitFor(() => expect(third.msgs.some((m) => m.type === 'completed')).toBe(true));
    expect(third.msgs.every((m) => m.seq > 1)).toBe(true);
    const seqs = third.msgs.map((m) => m.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    third.close();
  });

  it('snapshot_done stats can be aggregated live; terminal event carries final stats once', async () => {
    const job = await post('/api/batch-jobs', { snapshotIds: ['snap-checkout', 'snap-home'] });
    const stream = rawOpenStream(port, job.body.id, { afterSeq: 0 });
    await vi.waitFor(() => expect(stream.msgs.some((m) => m.type === 'completed')).toBe(true));
    const completions = stream.msgs.filter((m) => m.type === 'completed');
    expect(completions).toHaveLength(1);
    expect(completions[0].stats.total).toBe(4);
    stream.close();
  });
});
