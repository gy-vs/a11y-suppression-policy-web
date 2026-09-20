import { Pencil, Power } from 'lucide-react';
import type { RuleRevision } from '../../shared/model';
import { specificity } from '../../shared/matcher';

interface Props {
  rules: RuleRevision[];
  history: Record<string, RuleRevision[]>;
  nowIso: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (rule: RuleRevision) => void;
  onToggleEnabled: (rule: RuleRevision) => void;
  busyId?: string | null;
}

function stateOf(r: RuleRevision, nowMs: number): { label: string; cls: string } {
  if (!r.valid) return { label: '无效', cls: 'st-invalid' };
  if (!r.enabled) return { label: '禁用', cls: 'st-disabled' };
  if (r.expiresAt && nowMs >= Date.parse(r.expiresAt)) return { label: '已过期', cls: 'st-expired' };
  return { label: '生效中', cls: 'st-active' };
}

export default function RuleList({ rules, history, nowIso, selectedId, onSelect, onEdit, onToggleEnabled, busyId }: Props) {
  const nowMs = Date.parse(nowIso);
  return (
    <div className="rule-list">
      {rules.map((r) => {
        const st = stateOf(r, nowMs);
        const spec = specificity(r);
        return (
          <article
            key={r.ruleId}
            className={`rule-card ${selectedId === r.ruleId ? 'selected' : ''} ${r.valid ? '' : 'invalid'}`}
            onClick={() => onSelect(r.ruleId)}
          >
            <header>
              <code className="rule-id">{r.ruleId}</code>
              <span className={`badge ${st.cls}`}>{st.label}</span>
              <span className="rev">rev {r.revision}</span>
            </header>
            <p className="reason" title={r.reason}>{r.reason || <em>（缺原因：非法）</em>}</p>
            <div className="scope-tags">
              {r.pathPattern && <span>路径 {r.pathPattern}</span>}
              {r.fingerprint && <span>指纹 {r.fingerprint}</span>}
              {r.ruleCode && <span>代码 {r.ruleCode}</span>}
              {r.attributes?.map((a, i) => <span key={i}>@{a.key} {a.op} {a.value ?? ''}</span>)}
              {!r.pathPattern && !r.fingerprint && !r.ruleCode && !r.attributes?.length && <span className="wide">全作用域</span>}
            </div>
            <div className="spec" title="特异度：属性 &gt; 指纹 &gt; 代码 &gt; 路径">
              特异度 [{spec.attrs},{spec.fingerprint},{spec.ruleCode},{spec.path}]
              {r.expiresAt && <span className={r.expiresAt && nowMs >= Date.parse(r.expiresAt) ? 'expired-text' : ''}> · 到期 {new Date(r.expiresAt).toLocaleString()}</span>}
            </div>
            {!r.valid && <ul className="validation">{r.validationErrors.map((e) => <li key={e}>{e}</li>)}</ul>}
            <footer onClick={(e) => e.stopPropagation()}>
              <button className="ghost" onClick={() => onEdit(r)}><Pencil size={13} />编辑（新 rev）</button>
              <button className="ghost" onClick={() => onToggleEnabled(r)} disabled={busyId === r.ruleId}>
                <Power size={13} />{r.enabled ? '禁用' : '启用'}
              </button>
            </footer>
            {history[r.ruleId]?.length > 1 && (
              <details className="history">
                <summary>历史 {history[r.ruleId].length} 版</summary>
                <ol>
                  {history[r.ruleId].map((h) => (
                    <li key={h.revision}>rev {h.revision} · {new Date(h.updatedAt).toLocaleString()} · {h.valid ? '有效' : '无效'} · {h.enabled ? '启用' : '禁用'}</li>
                  ))}
                </ol>
              </details>
            )}
          </article>
        );
      })}
    </div>
  );
}
