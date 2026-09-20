import type {
  EvaluationReport,
  IssueDecision,
  RuleInput,
  RuleRevision,
  Snapshot,
} from '../shared/model';

const BASE = '/api/suppression';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw Object.assign(new Error('request_failed'), { status: res.status, body: await res.json().catch(() => null) });
  return (await res.json()) as T;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => json<T>(r));
}
function put<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<T>(r));
}

export const api = {
  listRules: () => fetch(`${BASE}/rules`).then((r) => json<{ rules: RuleRevision[]; history: Record<string, RuleRevision[]> }>(r)),
  createRule: (input: RuleInput) => post<{ rule: RuleRevision }>(`${BASE}/rules`, input),
  updateRule: (id: string, input: RuleInput, expectedRevision: number) =>
    put<{ rule: RuleRevision }>(`${BASE}/rules/${id}`, { ...input, expectedRevision }),
  setEnabled: (id: string, enabled: boolean, expectedRevision: number) =>
    post<{ rule: RuleRevision }>(`${BASE}/rules/${id}/enabled`, { enabled, expectedRevision }),

  listSnapshots: () => fetch(`${BASE}/snapshots`).then((r) => json<{ snapshots: Snapshot[] }>(r)),
  evaluate: (snapshotId: string, at?: string) =>
    post<{ evaluatedAt: string; result: { snapshotId: string; decisions: IssueDecision[]; stats: Record<string, number> } }>(
      `${BASE}/snapshots/${snapshotId}/evaluate`,
      at ? { at } : {},
    ),

  startBatch: (snapshotIds?: string[]) => post<{ batchId: string }>(`${BASE}/batches`, { snapshotIds }),
  cancelBatch: (id: string) => post<{ status: string }>(`${BASE}/batches/${id}/cancel`),
  batchStatus: (id: string) => fetch(`${BASE}/batches/${id}`).then((r) => json<{ status: string; reportId?: string }>(r)),

  listReports: () => fetch(`${BASE}/reports`).then((r) => json<{ reports: EvaluationReport[] }>(r)),
  getReport: (id: string) => fetch(`${BASE}/reports/${id}`).then((r) => json<{ report: EvaluationReport }>(r)),
  replay: (id: string) => post<{ report: EvaluationReport; matchesStored: boolean }>(`${BASE}/reports/${id}/replay`),
};

/** 打开一条 SSE，浏览器在断线重连时自动带 Last-Event-ID，服务端只重放后续事件 */
export function openBatchEvents(batchId: string, handlers: {
  onEvent: (ev: BatchStreamEvent) => void;
  onError?: () => void;
}): EventSource {
  const es = new EventSource(`${BASE}/batches/${batchId}/events`);
  (['started', 'item', 'completed', 'canceled'] as const).forEach((type) => {
    es.addEventListener(type, (e) => {
      const data = JSON.parse((e as MessageEvent).data) as BatchStreamEvent;
      handlers.onEvent(data);
    });
  });
  if (handlers.onError) es.onerror = handlers.onError;
  return es;
}

export type BatchStreamEvent =
  | { batchId: string; seq: number; type: 'started'; snapshotIds: string[]; evaluatedAt: string; ruleRevisionPins: Record<string, number> }
  | { batchId: string; seq: number; type: 'item'; snapshotId: string; index: number; total: number; snapshotStats: Record<string, number>; cumulative: Record<string, number>; decisions: IssueDecision[] }
  | { batchId: string; seq: number; type: 'completed'; cumulative: Record<string, number>; reportId: string }
  | { batchId: string; seq: number; type: 'canceled'; processedItems: number };
