import { useEffect, useRef, useState } from 'react';
import { Ban, History, RefreshCw } from 'lucide-react';
import { api, openBatchEvents, type BatchStreamEvent } from '../api';
import type { EvaluationReport, Outcome } from '../../shared/model';
import { emptyStats } from '../../shared/model';

interface Props {
  snapshotIds: string[];
  nowIso: string;
  onClockOverride: (at: string | null) => void;
}

const OUTCOMES: Outcome[] = ['suppressed', 'expired', 'invalid', 'disabled', 'unsuppressed'];
const LABELS: Record<Outcome, string> = {
  suppressed: '已抑制', expired: '规则过期', invalid: '规则无效', disabled: '规则禁用', unsuppressed: '未抑制',
};

export default function BatchPanel({ snapshotIds, nowIso, onClockOverride }: Props) {
  const [running, setRunning] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  // 唯一真相：直接来自服务端 item/completed 事件的 cumulative（覆盖，绝不累加）
  const [cumulative, setCumulative] = useState<Record<Outcome, number>>(emptyStats());
  const [terminal, setTerminal] = useState<null | { kind: 'completed'; reportId: string } | { kind: 'canceled'; processedItems: number }>(null);
  const [reports, setReports] = useState<EvaluationReport[]>([]);
  const [replayResult, setReplayResult] = useState<{ id: string; matches: boolean } | null>(null);
  const [atOverride, setAtOverride] = useState('');
  const esRef = useRef<EventSource | null>(null);

  const refreshReports = async () => setReports((await api.listReports()).reports);
  useEffect(() => { void refreshReports(); }, []);

  useEffect(() => () => esRef.current?.close(), []);

  const start = async () => {
    onClockOverride(atOverride || null); // 即时评估时钟；批量仍用服务端时钟（本工作台固定为审阅基准时间）
    setTerminal(null);
    setCumulative(emptyStats());
    setProgress({ done: 0, total: snapshotIds.length });
    const { batchId: id } = await api.startBatch(snapshotIds);
    setBatchId(id);
    setRunning(true);

    // 重连时浏览器自动带 Last-Event-ID；服务端只重放之后的事件。
    // 因此这里对 cumulative 永远“覆盖”：即使同一 item 事件被重放两次，计数也不翻倍。
    const seenSeq = new Set<number>();
    esRef.current = openBatchEvents(id, {
      onEvent: (ev: BatchStreamEvent) => {
        if (seenSeq.has(ev.seq)) return; // 双保险：序号去重
        seenSeq.add(ev.seq);
        if (ev.type === 'started') setProgress({ done: 0, total: ev.snapshotIds.length });
        if (ev.type === 'item') {
          setCumulative(ev.cumulative as Record<Outcome, number>); // 覆盖，不是 +=
          setProgress({ done: ev.index + 1, total: ev.total });
        }
        if (ev.type === 'completed') {
          setCumulative(ev.cumulative as Record<Outcome, number>);
          setTerminal({ kind: 'completed', reportId: ev.reportId });
          setRunning(false);
          esRef.current?.close();
          void refreshReports();
        }
        if (ev.type === 'canceled') {
          // 取消：清空任何最终统计，明确不展示“部分最终统计”
          setCumulative(emptyStats());
          setTerminal({ kind: 'canceled', processedItems: ev.processedItems });
          setRunning(false);
          esRef.current?.close();
        }
      },
    });
  };

  const cancel = async () => {
    if (!batchId) return;
    await api.cancelBatch(batchId).catch(() => undefined);
  };

  const replay = async (id: string) => {
    const r = await api.replay(id);
    setReplayResult({ id, matches: r.matchesStored });
  };

  return (
    <div className="batch-panel">
      <h3>批量重新评估</h3>
      <p className="hint">启动时固定全部规则 revision 与单个评估时钟；运行中的并发编辑不影响本批。</p>

      <label className="at-line">
        即时评估时钟（UTC，留空=审阅基准 {new Date(nowIso).toLocaleString()}）
        <input type="datetime-local" step="1" value={atOverride} onChange={(e) => setAtOverride(e.target.value)} />
      </label>

      <div className="batch-actions">
        <button className="primary" onClick={start} disabled={running}><RefreshCw size={14} />开始批量（{snapshotIds.length} 个样例）</button>
        <button onClick={cancel} disabled={!running}><Ban size={14} />取消（不写部分统计）</button>
      </div>

      {batchId && (
        <div className="batch-state">
          <div className="progress"><div className="bar" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
          <small>{progress.done}/{progress.total} · {batchId}</small>
          <div className="counts">
            {OUTCOMES.map((o) => <span key={o} className={`chip oc-${o}`}>{LABELS[o]} {cumulative[o]}</span>)}
          </div>
          {terminal?.kind === 'completed' && <p className="ok">完成，已保存报告 {terminal.reportId}（最终统计见上）。</p>}
          {terminal?.kind === 'canceled' && <p className="warn">已取消：处理到 {terminal.processedItems} 个样例即停止；最终统计未写入，计数已清零。</p>}
        </div>
      )}

      <div className="reports">
        <h4><History size={14} /> 历史报告（固定 revision，可回放）</h4>
        {reports.length === 0 && <p className="hint">尚无已完成批量。</p>}
        {reports.map((r) => (
          <div key={r.id} className="report-row">
            <div>
              <code>{r.id}</code>
              <small> {new Date(r.evaluatedAt).toLocaleString()} · {r.snapshotIds.length} 快照 · 抑制 {r.stats.suppressed}</small>
            </div>
            <button className="ghost" onClick={() => void replay(r.id)}>回放</button>
            {replayResult?.id === r.id && (
              <span className={replayResult.matches ? 'ok' : 'warn'}>
                {replayResult.matches ? '逐字段一致 ✓' : '与已存结论不一致 ✗'}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
