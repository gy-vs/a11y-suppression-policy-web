import type {
  BatchJob,
  Evaluation,
  EvaluationStats,
  JobEvent,
  Rule,
  RuleCreateInput,
  RuleDraft,
  RuleHitData,
  RuleRevisionData,
  RuleUpdateInput,
  Snapshot,
} from '../shared/domain';
import { aggregateStats, annotateHistory, evaluateSnapshot, validateDraft, validateFutureExpiry } from '../shared/engine';

export interface StoreClock {
  now(): number;
  /** Per-snapshot delay for the demo batch job so cancellation is observable. */
  delayMs(): number;
}

export const defaultClock: StoreClock = { now: () => Date.now(), delayMs: () => 120 };

let counter = 0;
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

const T0 = '2026-09-01T09:00:00.000Z';

function seedSnapshots(): Snapshot[] {
  return [
    {
      id: 'snap-checkout',
      name: 'Checkout (sample)',
      path: '/checkout',
      capturedAt: '2026-09-18T14:02:00.000Z',
      latestEvaluationId: null,
      nodes: [
        {
          id: 'n-1',
          name: 'button "Place order"',
          fingerprint: 'btn-primary-a1',
          attributes: { role: 'button', 'data-testid': 'place-order', 'aria-label': 'Place order' },
          findings: [
            { code: 'color-contrast', message: 'Element contrast 3.4:1 below 4.5:1', selector: '#place-order' },
            { code: 'label', message: 'Accessible name relies on visual text only', selector: '#place-order' },
          ],
        },
        {
          id: 'n-2',
          name: 'img "brand mark"',
          fingerprint: 'img-brand-9x',
          attributes: { alt: '', src: '/brand.svg', role: 'img' },
          findings: [{ code: 'image-alt', message: 'Image has empty alt without role=presentation', selector: 'img.brand' }],
        },
      ],
    },
    {
      id: 'snap-help',
      name: 'Help FAQ (sample)',
      path: '/help/faq',
      capturedAt: '2026-09-19T10:30:00.000Z',
      latestEvaluationId: null,
      nodes: [
        {
          id: 'n-3',
          name: 'button "Submit request"',
          fingerprint: 'btn-primary-a1',
          attributes: { role: 'button', 'data-testid': 'submit-request' },
          // Only the expired /help/* path waiver covers this code: expired.
          findings: [{ code: 'color-contrast', message: 'Element contrast 3.4:1 below 4.5:1', selector: '#submit-request' }],
        },
      ],
    },
    {
      id: 'snap-account',
      name: 'Account settings (sample)',
      path: '/account',
      capturedAt: '2026-09-19T11:05:00.000Z',
      latestEvaluationId: null,
      nodes: [
        {
          // Same fingerprint as the checkout CTA, but data-testid drifted and
          // no path-wide rule covers /account: attribute predicates must fail
          // to match and these findings stay uncovered.
          id: 'n-4a',
          name: 'button "Save profile"',
          fingerprint: 'btn-primary-a1',
          attributes: { role: 'button', 'data-testid': 'save-profile' },
          findings: [
            { code: 'color-contrast', message: 'Element contrast 3.4:1 below 4.5:1', selector: '#save-profile' },
            { code: 'label', message: 'Accessible name relies on visual text only', selector: '#save-profile' },
          ],
        },
      ],
    },
    {
      id: 'snap-home',
      name: 'Home (sample)',
      path: '/',
      capturedAt: '2026-09-19T18:15:00.000Z',
      latestEvaluationId: null,
      nodes: [
        {
          id: 'n-4',
          name: 'nav link "Skip"',
          fingerprint: 'link-skip-7c',
          attributes: { href: '#main' },
          findings: [{ code: 'skip-link', message: 'Skip link not first focusable element', selector: 'a.skip' }],
        },
      ],
    },
  ];
}

function revision(
  draft: RuleDraft,
  revisionNo: number,
  createdAt: string,
  createdBy: string,
  enabled: boolean,
): RuleRevisionData {
  return {
    ...draft,
    attributes: draft.attributes.map((a) => ({ ...a })),
    revision: revisionNo,
    enabled,
    createdAt,
    createdBy,
    invalid: validateDraft(draft),
  };
}

function seedRules(): Rule[] {
  const make = (
    rid: string,
    createdOffsetDays: number,
    draft: RuleDraft,
    enabled = true,
  ): Rule => {
    const createdAt = new Date(Date.parse(T0) + createdOffsetDays * 86_400_000).toISOString();
    const rev = revision(draft, 1, createdAt, 'sample@workbench', enabled);
    return { id: rid, updatedAt: createdAt, history: [rev] };
  };
  return [
    // Oldest + broadest: path-only suppression on /checkout.
    make('r-broad', 0, {
      pathPattern: '/checkout',
      fingerprint: null,
      code: null,
      attributes: [],
      reason: 'Checkout screen audited in Q3; track follow-ups in ticket A11Y-120.',
      expiresAt: null,
    }),
    // More specific rule, created later: fingerprint + code + attribute beats
    // path-only. The attribute predicate is also the reason the *same*
    // fingerprint on the help snapshot (different data-testid) is not covered.
    make('r-cta-contrast', 1, {
      pathPattern: null,
      fingerprint: 'btn-primary-a1',
      code: 'color-contrast',
      attributes: [{ name: 'data-testid', valuePattern: 'place-order' }],
      reason: 'Brand CTA contrast 3.4:1 accepted by design review #77.',
      expiresAt: '2026-12-31T23:59:59.000Z',
    }),
    // Code + attribute predicate overlaps the broad rule; specificity 3 > 1.
    make('r-testid-label', 2, {
      pathPattern: null,
      fingerprint: null,
      code: 'label',
      attributes: [{ name: 'data-testid', valuePattern: 'place-order' }],
      reason: 'place-order nodes expose aria-label in the current component version.',
      expiresAt: null,
    }),
    // Expired rule: status must surface distinctly from suppressed/invalid.
    make('r-help-expired', 3, {
      pathPattern: '/help/*',
      fingerprint: null,
      code: null,
      attributes: [],
      reason: 'Help center temporary waiver during relaunch.',
      expiresAt: '2026-09-10T00:00:00.000Z',
    }),
    // Disabled rule: same scope as the expired one would have, distinct status.
    make(
      'r-home-disabled',
      4,
      {
        pathPattern: '/',
        fingerprint: null,
        code: null,
        attributes: [],
        reason: 'Home waiver paused pending re-audit.',
        expiresAt: null,
      },
      false,
    ),
    // Invalid rule (duplicate attribute predicates): kept so its history is
    // visible. Specificity 3 beats the broad path rule on /checkout img-alt,
    // demonstrating that an invalid winner surfaces as 'invalid' instead of
    // silently falling through to a lower-priority active rule.
    make('r-invalid', 5, {
      pathPattern: null,
      fingerprint: null,
      code: 'image-alt',
      attributes: [
        { name: 'role', valuePattern: 'img' },
        { name: 'role', valuePattern: '*' },
      ],
      reason: 'Drafted while merging two attribute templates.',
      expiresAt: null,
    }),
  ];
}

export class Store {
  readonly clock: StoreClock;
  rules: Rule[];
  snapshots: Snapshot[];
  evaluations = new Map<string, Evaluation>();
  jobs = new Map<string, BatchJob>();
  /** Bumped on every rule create/edit/disable; batch jobs pin the value. */
  policyVersion = 1;

  constructor(clock: StoreClock = defaultClock) {
    this.clock = clock;
    this.snapshots = seedSnapshots();
    this.rules = seedRules();
  }

  nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  getSnapshot(id: string): Snapshot | undefined {
    return this.snapshots.find((s) => s.id === id);
  }

  getRule(id: string): Rule | undefined {
    return this.rules.find((r) => r.id === id);
  }

  /** Deep snapshot of the ruleset at a policy version. Jobs freeze this. */
  freezeRules(): { policyVersion: number; rules: Rule[] } {
    return { policyVersion: this.policyVersion, rules: structuredClone(this.rules) };
  }

  createRule(input: RuleCreateInput): { rule: Rule } {
    const nowMs = this.clock.now();
    const draft: RuleDraft = {
      pathPattern: input.pathPattern ?? null,
      fingerprint: input.fingerprint ?? null,
      code: input.code ?? null,
      attributes: input.attributes ?? [],
      reason: input.reason ?? '',
      expiresAt: input.expiresAt ?? null,
    };
    const enabled = input.enabled ?? true;
    const at = this.nowIso();
    const rev = revision(draft, 1, at, input.createdBy ?? 'reviewer@workbench', enabled);
    // Invalid drafts are still stored (so reviewers can fix them in place),
    // but nothing else is rejected at write time beyond transport shape.
    const rule: Rule = { id: id('r'), updatedAt: at, history: [rev] };
    this.rules.push(rule);
    this.policyVersion += 1;
    return { rule };
  }

  updateRule(
    existing: Rule,
    input: RuleUpdateInput,
  ): { rule: Rule } | { status: 409; current: Rule } {
    const head = existing.history[existing.history.length - 1];
    if (input.expectedRevision !== head.revision) return { status: 409, current: existing };
    const nowMs = this.clock.now();
    const draft: RuleDraft = {
      pathPattern: input.pathPattern ?? null,
      fingerprint: input.fingerprint ?? null,
      code: input.code ?? null,
      attributes: input.attributes ?? [],
      reason: input.reason ?? '',
      expiresAt: input.expiresAt ?? null,
    };
    const at = this.nowIso();
    // Every edit becomes a new revision; nothing mutates prior revisions so
    // historical evaluations keep pointing at the exact text that suppressed.
    const rev = revision(draft, head.revision + 1, at, input.createdBy ?? 'reviewer@workbench', input.enabled);
    existing.history.push(rev);
    existing.updatedAt = at;
    this.policyVersion += 1;
    return { rule: existing };
  }

  setEnabled(
    existing: Rule,
    enabled: boolean,
    expectedRevision: number,
    by = 'reviewer@workbench',
  ): { rule: Rule } | { status: 409; current: Rule } {
    const head = existing.history[existing.history.length - 1];
    if (expectedRevision !== head.revision) return { status: 409, current: existing };
    const at = this.nowIso();
    // Enable/disable is itself a modification -> new revision (history must
    // show when a suppression stopped applying).
    const next: RuleRevisionData = { ...head, attributes: head.attributes.map((a) => ({ ...a })), revision: head.revision + 1, enabled, createdAt: at, createdBy: by };
    existing.history.push(next);
    existing.updatedAt = at;
    this.policyVersion += 1;
    return { rule: existing };
  }

  evaluate(snapshot: Snapshot, frozen: { policyVersion: number; rules: Rule[] }, nowMs: number, persisted: boolean): Evaluation {
    const evaluation = evaluateSnapshot(snapshot, frozen.rules, {
      policyVersion: frozen.policyVersion,
      evaluatedAt: new Date(nowMs).toISOString(),
      id: id('ev'),
      nowMs,
    });
    evaluation.persisted = persisted;
    return evaluation;
  }

  persistEvaluation(evaluation: Evaluation): void {
    this.evaluations.set(evaluation.id, evaluation);
    const snapshot = this.getSnapshot(evaluation.snapshotId);
    if (snapshot) snapshot.latestEvaluationId = evaluation.id;
  }

  annotatedEvaluation(evaluation: Evaluation): { evaluation: Evaluation; annotations: RuleHitData[] } {
    return { evaluation, annotations: annotateHistory(evaluation, this.rules) };
  }

  listEvaluations(): Evaluation[] {
    return [...this.evaluations.values()].sort((a, b) => (a.evaluatedAt < b.evaluatedAt ? 1 : -1));
  }

  // ---- Batch jobs -------------------------------------------------------

  private listeners = new Map<string, Set<(event: JobEvent) => void>>();

  onJobEvent(jobId: string, listener: (event: JobEvent) => void): () => void {
    let set = this.listeners.get(jobId);
    if (!set) {
      set = new Set();
      this.listeners.set(jobId, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  private emit(job: BatchJob, event: DistributiveOmit<JobEvent, 'seq' | 'jobId'>): JobEvent {
    const full = { ...event, seq: job.events.length + 1, jobId: job.id } as JobEvent;
    job.events.push(full);
    this.listeners.get(job.id)?.forEach((listener) => listener(full));
    return full;
  }

  createBatchJob(snapshotIds: string[], nowOverrideMs?: number): BatchJob | { error: 'unknown_snapshots'; ids: string[] } {
    const snapshots = snapshotIds.map((sid) => this.getSnapshot(sid));
    const missing = snapshots.filter((s, i): s is undefined => !s).map((_, i) => snapshotIds[i]);
    if (missing.length) return { error: 'unknown_snapshots', ids: missing };

    const frozen = this.freezeRules();
    const job: BatchJob = {
      id: id('job'),
      status: 'running',
      policyVersion: frozen.policyVersion,
      snapshotIds: [...snapshotIds],
      createdAt: this.nowIso(),
      finishedAt: null,
      processed: 0,
      stats: null, // final stats only ever exist for a completed job
      events: [],
    };
    this.jobs.set(job.id, job);
    this.emit(job, { type: 'started', policyVersion: frozen.policyVersion, snapshotIds: [...snapshotIds], at: this.nowIso() });

    // Run detached; the await points are where cancel requests interleave.
    void this.runBatch(job, frozen.rules, snapshots as Snapshot[], nowOverrideMs);
    return job;
  }

  private static isCancelling(job: BatchJob): boolean {
    // Read through a method boundary so TS keeps JobStatus (requestCancel mutates job across awaits).
    return (job.status as BatchJob['status']) === 'cancelling';
  }

  private async runBatch(job: BatchJob, frozenRules: Rule[], snapshots: Snapshot[], nowOverrideMs?: number): Promise<void> {
    const produced: Evaluation[] = [];
    for (const snapshot of snapshots) {
      // Cancellation boundary between snapshots; a snapshot that already
      // finished is reported, but its evaluation is never committed.
      if (Store.isCancelling(job)) break;
      await new Promise((resolve) => setTimeout(resolve, this.clock.delayMs()));
      if (Store.isCancelling(job)) break;
      const evaluation = this.evaluate(snapshot, { policyVersion: job.policyVersion, rules: frozenRules }, nowOverrideMs ?? this.clock.now(), false);
      produced.push(evaluation);
      job.processed += 1;
      this.emit(job, { type: 'snapshot_done', snapshotId: snapshot.id, evaluationId: evaluation.id, stats: evaluation.stats });
    }

    if (Store.isCancelling(job)) {
      // No partial final stats: drop every evaluation this job produced and
      // leave snapshot.latestEvaluationId exactly as it was before the run.
      job.status = 'cancelled';
      job.finishedAt = this.nowIso();
      this.emit(job, { type: 'cancelled', processed: job.processed, at: job.finishedAt });
      this.listeners.delete(job.id);
      return;
    }

    // Atomic commit: only a fully completed run becomes history.
    for (const evaluation of produced) this.persistEvaluation(evaluation);
    job.status = 'completed';
    job.finishedAt = this.nowIso();
    job.stats = aggregateStats(produced);
    this.emit(job, { type: 'completed', stats: job.stats, at: job.finishedAt });
    this.listeners.delete(job.id);
  }

  requestCancel(job: BatchJob): BatchJob {
    if (job.status === 'running') {
      job.status = 'cancelling';
      this.emit(job, { type: 'cancelling', at: this.nowIso() });
    }
    return job;
  }
}
