import type {
  BatchJob,
  Decision,
  Evaluation,
  FindingDecision,
  Rule,
  RuleDraft,
  RuleHitData,
  RuleStatus,
  Snapshot,
} from '../shared/domain';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...(init.headers ?? {}) } : init?.headers,
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, body };
}

export const api = {
  snapshots: () => jsonFetch<Snapshot[]>('/api/snapshots').then((r) => r.body),
  rules: () => jsonFetch<{ policyVersion: number; rules: Rule[] }>('/api/rules').then((r) => r.body),

  createRule: (input: RuleDraft & { enabled: boolean }) =>
    jsonFetch<{ policyVersion: number; rule: Rule } | { error: string; details?: string[] }>('/api/rules', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateRule: (id: string, input: RuleDraft & { enabled: boolean; expectedRevision: number }) =>
    jsonFetch<any>(`/api/rules/${id}`, { method: 'PUT', body: JSON.stringify(input) }),

  setEnabled: (id: string, enabled: boolean, expectedRevision: number) =>
    jsonFetch<any>(`/api/rules/${id}/enabled`, {
      method: 'POST',
      body: JSON.stringify({ enabled, expectedRevision }),
    }),

  evaluate: (snapshotId: string, persist: boolean, at?: string) =>
    jsonFetch<{ policyVersion: number; evaluation: Evaluation }>(
      `/api/snapshots/${snapshotId}/evaluate`,
      { method: 'POST', body: JSON.stringify({ persist, ...(at ? { at } : {}) }) },
    ),

  evaluations: () => jsonFetch<{ evaluations: Evaluation[] }>('/api/evaluations').then((r) => r.body),
  evaluation: (id: string) =>
    jsonFetch<{ evaluation: Evaluation; annotations: RuleHitData[] }>(`/api/evaluations/${id}`).then((r) => r.body),

  startBatch: (snapshotIds: string[]) =>
    jsonFetch<BatchJob>('/api/batch-jobs', { method: 'POST', body: JSON.stringify({ snapshotIds }) }),
  cancelBatch: (id: string) => jsonFetch<BatchJob>(`/api/batch-jobs/${id}/cancel`, { method: 'POST' }),
  getJob: (id: string) => jsonFetch<BatchJob>(`/api/batch-jobs/${id}`),
};

/**
 * Open a job event stream with automatic reconnect.
 *
 * Reconnects pass the last seen seq as Last-Event-ID; the server replays only
 * events with a greater seq, so onEvent can never observe the same event twice
 * (that is what prevents double counting after a dropped connection).
 */
export function openJobStream(
  jobId: string,
  onEvent: (event: any) => void,
  onState: (state: 'open' | 'closed') => void,
): () => void {
  let lastSeq = 0;
  let closedByCaller = false;
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const seen = new Set<number>(); // belt-and-braces client-side dedup
  const connect = () => {
    es = new EventSource(`/api/batch-jobs/${jobId}/events?afterSeq=${lastSeq}`);
    es.onopen = () => onState('open');
    for (const type of ['started', 'snapshot_done', 'cancelling', 'cancelled', 'completed']) {
      es.addEventListener(type, (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        if (typeof data.seq === 'number') lastSeq = Math.max(lastSeq, data.seq);
        if (seen.has(data.seq)) return;
        seen.add(data.seq);
        onEvent(data);
        if (data.type === 'completed' || data.type === 'cancelled') {
          es?.close();
          onState('closed');
        }
      });
    }
    es.onerror = () => {
      if (closedByCaller) return;
      es?.close();
      onState('closed');
      // Reconnect with the cursor; server replays the gap exactly once.
      retry = setTimeout(connect, 400);
    };
  };
  connect();
  return () => {
    closedByCaller = true;
    if (retry) clearTimeout(retry);
    es?.close();
  };
}

export const decisionLabel: Record<Decision, string> = {
  suppressed: 'Suppressed',
  expired: 'Rule expired',
  invalid: 'Rule invalid',
  disabled: 'Rule disabled',
  uncovered: 'Not suppressed',
};

export function head(rule: Rule) {
  return rule.history[rule.history.length - 1];
}

export function describeStatus(hit: { status: RuleStatus }): string {
  switch (hit.status) {
    case 'active':
      return 'active';
    case 'disabled':
      return 'disabled';
    case 'expired':
      return 'expired';
    case 'invalid':
      return 'invalid';
  }
}

/** Group findings of an evaluation back under their nodes for tree display. */
export function findingsByNode(evaluation: Evaluation): Map<string, FindingDecision[]> {
  const map = new Map<string, FindingDecision[]>();
  for (const f of evaluation.findings) {
    const list = map.get(f.nodeId) ?? [];
    list.push(f);
    map.set(f.nodeId, list);
  }
  return map;
}
