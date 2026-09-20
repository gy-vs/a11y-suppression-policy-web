import { useState } from 'react';
import { PlusCircle, Trash2 } from 'lucide-react';
import type { AttributeConstraint, AttrOp, RuleInput, RuleRevision } from '../../shared/model';

interface Props {
  editing: RuleRevision | null;
  onSubmit: (input: RuleInput, expectedRevision?: number) => Promise<void>;
  onCancel: () => void;
  onRevisionConflict: () => void;
}

const emptyDraft: RuleInput = {
  reason: '',
  pathPattern: '',
  fingerprint: '',
  ruleCode: '',
  attributes: [],
  expiresAt: '',
  enabled: true,
};

export default function RuleForm({ editing, onSubmit, onCancel }: Props) {
  const [draft, setDraft] = useState<RuleInput>(() =>
    editing
      ? {
          reason: editing.reason,
          pathPattern: editing.pathPattern ?? '',
          fingerprint: editing.fingerprint ?? '',
          ruleCode: editing.ruleCode ?? '',
          attributes: (editing.attributes ?? []).map((a) => ({ ...a })),
          expiresAt: editing.expiresAt ?? '',
          enabled: editing.enabled,
        }
      : emptyDraft,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof RuleInput>(key: K, value: RuleInput[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const updateAttr = (i: number, patch: Partial<AttributeConstraint>) =>
    set('attributes', (draft.attributes ?? []).map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  const addAttr = () =>
    set('attributes', [...(draft.attributes ?? []), { key: '', op: 'equals', value: '' }]);
  const removeAttr = (i: number) =>
    set('attributes', (draft.attributes ?? []).filter((_, idx) => idx !== i));

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    const input: RuleInput = {
      reason: draft.reason,
      pathPattern: draft.pathPattern || null,
      fingerprint: draft.fingerprint || null,
      ruleCode: draft.ruleCode || null,
      attributes: draft.attributes,
      expiresAt: draft.expiresAt || null,
      enabled: draft.enabled,
    };
    try {
      await onSubmit(input, editing?.revision);
      if (!editing) setDraft(emptyDraft);
    } catch (e) {
      const err = e as { status?: number };
      setError(err.status === 409 ? '规则已被他人修改，请刷新后基于最新 revision 重试（并发冲突 409）' : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rule-form">
      <h3>{editing ? `编辑规则 · rev ${editing.revision}` : '新建抑制规则'}</h3>
      {editing && <p className="hint">修改会生成新 revision；创建顺序不变，历史快照仍按当时版本解释。</p>}

      <label>
        页面路径（精确或通配，如 /reports/*）
        <input value={draft.pathPattern ?? ''} onChange={(e) => set('pathPattern', e.target.value)} placeholder="留空=全部路径" />
      </label>
      <label>
        组件指纹
        <input value={draft.fingerprint ?? ''} onChange={(e) => set('fingerprint', e.target.value)} placeholder="留空=全部组件" />
      </label>
      <label>
        规则代码
        <input value={draft.ruleCode ?? ''} onChange={(e) => set('ruleCode', e.target.value)} placeholder="如 color-contrast" />
      </label>

      <div className="attr-editor">
        <div className="attr-head">
          <span>节点属性约束（全部满足）</span>
          <button type="button" className="ghost" onClick={addAttr}><PlusCircle size={14} />添加</button>
        </div>
        {(draft.attributes ?? []).map((attr, i) => (
          <div className="attr-row" key={i}>
            <input aria-label="属性名" value={attr.key} placeholder="属性名，如 role" onChange={(e) => updateAttr(i, { key: e.target.value })} />
            <select aria-label="运算符" value={attr.op} onChange={(e) => updateAttr(i, { op: e.target.value as AttrOp })}>
              <option value="equals">=</option>
              <option value="notEquals">≠</option>
              <option value="contains">包含</option>
              <option value="exists">存在</option>
              <option value="absent">不存在</option>
            </select>
            {(attr.op === 'equals' || attr.op === 'notEquals' || attr.op === 'contains') && (
              <input aria-label="属性值" value={attr.value ?? ''} placeholder="值" onChange={(e) => updateAttr(i, { value: e.target.value })} />
            )}
            <button type="button" className="icon danger" onClick={() => removeAttr(i)} aria-label="删除约束"><Trash2 size={14} /></button>
          </div>
        ))}
      </div>

      <label>
        到期时间（UTC，留空=永久）
        <input type="datetime-local" step="1" value={toLocalInput(draft.expiresAt)} onChange={(e) => set('expiresAt', fromLocalInput(e.target.value))} />
      </label>
      <label>
        原因（必填）
        <textarea rows={2} value={draft.reason} onChange={(e) => set('reason', e.target.value)} placeholder="为什么抑制？用于审计与解释" />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={draft.enabled ?? true} onChange={(e) => set('enabled', e.target.checked)} />
        启用（取消勾选即禁用，同样产生新 revision）
      </label>

      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button className="primary" onClick={submit} disabled={submitting}>{submitting ? '保存中…' : '保存'}</button>
        {editing && <button onClick={onCancel}>取消编辑</button>}
      </div>
    </div>
  );
}

function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fromLocalInput(local: string): string | null {
  if (!local) return null;
  const iso = new Date(local).toISOString();
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}
