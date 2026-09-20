import type { IssueDecision, Snapshot } from '../../shared/model';

interface Props {
  snapshot: Snapshot;
  decisions: IssueDecision[];
  evaluatedAt: string;
  highlightRuleId?: string | null;
}

const OUTCOME_META: Record<string, { label: string; cls: string }> = {
  suppressed: { label: '已抑制', cls: 'oc-suppressed' },
  expired: { label: '规则已过期', cls: 'oc-expired' },
  invalid: { label: '规则无效', cls: 'oc-invalid' },
  disabled: { label: '规则已禁用', cls: 'oc-disabled' },
  unsuppressed: { label: '未抑制', cls: 'oc-unsuppressed' },
};

export default function SnapshotPreview({ snapshot, decisions, evaluatedAt, highlightRuleId }: Props) {
  const byNode = new Map(decisions.map((d) => [d.nodeId, d]));
  const stats = decisions.reduce<Record<string, number>>((acc, d) => {
    acc[d.outcome] = (acc[d.outcome] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="snapshot-preview">
      <div className="snap-head">
        <div>
          <h3>{snapshot.label}</h3>
          <code>{snapshot.path}</code>
          <small> 采集于 {new Date(snapshot.capturedAt).toLocaleString()} · 评估时钟 {new Date(evaluatedAt).toLocaleString()}</small>
        </div>
        <div className="stat-chips">
          {Object.entries(OUTCOME_META).map(([k, meta]) => (
            <span key={k} className={`chip ${meta.cls}`}>{meta.label} {stats[k] ?? 0}</span>
          ))}
        </div>
      </div>

      <div className="nodes">
        {snapshot.nodes.map((node) => {
          const issue = snapshot.issues.find((i) => i.nodeId === node.id);
          const decision = issue ? byNode.get(node.id) : undefined;
          const oc = decision ? OUTCOME_META[decision.outcome] : undefined;
          const winnerHits = decision?.winner && (!highlightRuleId || highlightRuleId === decision.winner.ruleId);
          const highlightCandidates = new Set(decision?.candidates.filter((c) => !highlightRuleId || c.ruleId === highlightRuleId).map((c) => c.ruleId));
          return (
            <div key={node.id} className={`node ${oc?.cls ?? ''} ${highlightRuleId && (!decision || !highlightCandidates.size) ? 'dimmed' : ''}`}>
              <div className="node-line">
                <span className="selector">{node.selector}</span>
                <span className="fp">指纹 {node.fingerprint}</span>
                {oc && <span className={`chip ${oc.cls}`}>{oc.label}</span>}
              </div>
              <div className="attrs">
                {Object.entries(node.attributes).map(([k, v]) => <code key={k} className="node-attr">{k}={v}</code>)}
              </div>

              {issue && (
                <div className="issue">
                  <strong>{issue.ruleCode}</strong>：{issue.message}
                </div>
              )}

              {decision && decision.candidates.length > 0 && (
                <ul className="candidates">
                  {decision.candidates.map((c) => {
                    const dim = highlightRuleId && c.ruleId !== highlightRuleId;
                    return (
                      <li key={`${c.ruleId}:${c.revision}`} className={`cand cand-${c.disposition} ${dim ? 'dim' : ''}`}>
                        <code>{c.ruleId}</code> <span className="cand-rev">rev {c.revision}</span>
                        <span className="cand-state">{candidateLabel(c.disposition)}</span>
                        {c.disposition === 'won' && <em className="why">生效原因：{c.reason}</em>}
                        {c.disposition === 'shadowed' && c.coveredBy && (
                          <em className="why">被 <code>{c.coveredBy.ruleId}</code> 覆盖 —— {c.coveredBy.why}</em>
                        )}
                        {c.disposition === 'expired' && <em className="why">规则在 {c.expiresAt ? new Date(c.expiresAt).toLocaleString() : ''} 已到期，未抑制</em>}
                        {c.disposition === 'invalid' && <em className="why">规则本身无效：{c.validationErrors.join(', ')}</em>}
                        {c.disposition === 'disabled' && <em className="why">规则已禁用，未抑制</em>}
                      </li>
                    );
                  })}
                </ul>
              )}
              {decision && decision.candidates.length === 0 && <p className="no-cand">无作用域命中的规则</p>}
              {winnerHits === false && highlightRuleId && decision?.outcome === 'suppressed' && null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function candidateLabel(d: string): string {
  switch (d) {
    case 'won': return '✓ 生效';
    case 'shadowed': return '被覆盖';
    case 'expired': return '已过期';
    case 'invalid': return '无效';
    case 'disabled': return '已禁用';
    default: return d;
  }
}
