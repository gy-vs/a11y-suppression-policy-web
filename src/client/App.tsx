import { useEffect, useMemo, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { api } from './api';
import type { IssueDecision, RuleInput, RuleRevision, Snapshot } from '../shared/model';
import RuleList from './components/RuleList';
import RuleForm from './components/RuleForm';
import SnapshotPreview from './components/SnapshotPreview';
import BatchPanel from './components/BatchPanel';

const BENCH_NOW = '2026-09-20T12:00:00.000Z'; // 审阅工作台基准时钟（仅样例）

interface EvalState { evaluatedAt: string; decisions: IssueDecision[]; stats: Record<string, number> }

export default function App() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotId, setSnapshotId] = useState<string>('');
  const [rules, setRules] = useState<RuleRevision[]>([]);
  const [history, setHistory] = useState<Record<string, RuleRevision[]>>({});
  const [editing, setEditing] = useState<RuleRevision | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [highlightRule, setHighlightRule] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [evalState, setEvalState] = useState<EvalState | null>(null);
  const [atOverride, setAtOverride] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loadRules = async () => {
    const data = await api.listRules();
    setRules(data.rules);
    setHistory(data.history);
  };

  useEffect(() => {
    void api.listSnapshots().then((d) => {
      setSnapshots(d.snapshots);
      if (d.snapshots[0]) setSnapshotId(d.snapshots[0].id);
    });
    void loadRules();
  }, []);

  const evaluate = async (snapId: string, at: string | null) => {
    const res = await api.evaluate(snapId, at ?? undefined);
    setEvalState({ evaluatedAt: res.evaluatedAt, decisions: res.result.decisions, stats: res.result.stats });
  };

  useEffect(() => {
    if (snapshotId) void evaluate(snapshotId, atOverride);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotId, atOverride, rules]);

  const snapshot = useMemo(() => snapshots.find((s) => s.id === snapshotId) ?? null, [snapshots, snapshotId]);

  const submitRule = async (input: RuleInput, expectedRevision?: number) => {
    if (expectedRevision === undefined || !editing) await api.createRule(input);
    else await api.updateRule(editing.ruleId, input, expectedRevision);
    await loadRules();
    setEditing(null);
    setShowForm(false);
    setToast(expectedRevision === undefined ? '规则已创建' : '已生成新 revision');
    setTimeout(() => setToast(null), 2500);
  };

  const toggleEnabled = async (rule: RuleRevision) => {
    setBusyId(rule.ruleId);
    try {
      await api.setEnabled(rule.ruleId, !rule.enabled, rule.revision);
      await loadRules();
    } catch {
      setToast('并发冲突：规则已被修改，请刷新');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>无障碍问题抑制规则</strong>
        <small>本地审阅工作台 · 仅样例快照，不连接线上系统 · 基准时钟 {new Date(BENCH_NOW).toLocaleString()}</small>
      </header>

      <nav className="snap-tabs">
        {snapshots.map((s) => (
          <button key={s.id} className={s.id === snapshotId ? 'active' : ''} onClick={() => setSnapshotId(s.id)}>
            {s.label}
          </button>
        ))}
        <button className="new-rule" onClick={() => { setEditing(null); setShowForm((v) => !v); }}>+ 新建规则</button>
      </nav>

      <section className="workspace three">
        <aside className="pane rules-pane">
          <h2>抑制规则（{rules.length}）</h2>
          <p className="hint">点击规则可在右侧高亮它命中的节点。匹配：特异度（属性&gt;指纹&gt;代码&gt;路径）降序，相同则按创建顺序。</p>
          <RuleList
            rules={rules}
            history={history}
            nowIso={BENCH_NOW}
            selectedId={highlightRule}
            onSelect={(id) => setHighlightRule((cur) => (cur === id ? null : id))}
            onEdit={(r) => { setEditing(r); setShowForm(true); }}
            onToggleEnabled={toggleEnabled}
            busyId={busyId}
          />
        </aside>

        <section className="pane preview-pane">
          {showForm ? (
            <RuleForm
              editing={editing}
              onSubmit={submitRule}
              onCancel={() => { setShowForm(false); setEditing(null); }}
              onRevisionConflict={() => undefined}
            />
          ) : snapshot && evalState ? (
            <SnapshotPreview snapshot={snapshot} decisions={evalState.decisions} evaluatedAt={evalState.evaluatedAt} highlightRuleId={highlightRule} />
          ) : (
            <p>加载中…</p>
          )}
        </section>

        <aside className="pane batch-pane">
          <BatchPanel snapshotIds={snapshots.map((s) => s.id)} nowIso={BENCH_NOW} onClockOverride={setAtOverride} />
        </aside>
      </section>

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
