// Shared domain types for the accessibility suppression workbench.
// The workbench reviews sample snapshots only; nothing here talks to production.

export type AttributeMap = Record<string, string>;

export interface AttributePredicate {
  name: string;
  valuePattern: string; // literal with optional '*' / '?' globs
}

export interface RuleScope {
  /** Absolute path glob, e.g. '/checkout' or '/help/*'. null means any path. */
  pathPattern: string | null;
  /** Exact component fingerprint, e.g. 'btn-primary-3f9a'. null means any. */
  fingerprint: string | null;
  /** Finding/rule code, e.g. 'color-contrast'. null means any code. */
  code: string | null;
  /** All predicates must match a node's attributes (AND). */
  attributes: AttributePredicate[];
}

export interface RuleDraft extends RuleScope {
  reason: string;
  /** ISO instant; a rule is expired when now >= expiresAt. null = never expires. */
  expiresAt: string | null;
}

export type RuleStatus = 'active' | 'disabled' | 'expired' | 'invalid';

/** Outcome for one (node, finding) pair. */
export type Decision = 'suppressed' | 'expired' | 'invalid' | 'disabled' | 'uncovered';

export interface RuleValidationError {
  field: 'pathPattern' | 'fingerprint' | 'code' | 'attributes' | 'expiresAt' | 'reason';
  code: string;
  message: string;
}

export interface RuleRevisionData extends RuleDraft {
  revision: number;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  invalid: RuleValidationError[];
}

export interface Rule {
  id: string;
  updatedAt: string;
  /** Append-only; the last entry is the live revision. */
  history: RuleRevisionData[];
}

export function ruleHead(rule: Rule): RuleRevisionData {
  return rule.history[rule.history.length - 1];
}

/** What the client sends when creating a rule. */
export type RuleCreateInput = RuleDraft & { enabled?: boolean; createdBy?: string };

/** What the client sends when editing; expectedRevision drives optimistic locking. */
export type RuleUpdateInput = RuleDraft & {
  enabled: boolean;
  expectedRevision: number;
  createdBy?: string;
};

export interface Finding {
  code: string;
  message: string;
  selector: string;
}

export interface SnapshotNode {
  id: string;
  fingerprint: string;
  name: string;
  attributes: AttributeMap;
  findings: Finding[];
}

export interface Snapshot {
  id: string;
  name: string;
  path: string;
  capturedAt: string;
  latestEvaluationId: string | null;
  nodes: SnapshotNode[];
}

export interface OverrideInfo {
  /** Why this hit did not win: specificity gap or creation-order tiebreak. */
  kind: 'higher_specificity' | 'older_rule_tiebreak';
  winnerRuleId: string;
  winnerRevision: number;
  /** The winner's status, useful when an inactive rule shadows an active one. */
  winnerStatus: RuleStatus;
}

/** A rule revision as seen during one evaluation (frozen for history replay). */
export interface RuleHitData {
  ruleId: string;
  revision: number;
  rank: number; // 1 = winning hit
  specificity: number;
  status: RuleStatus;
  scope: RuleScope;
  reason: string;
  expiresAt: string | null;
  enabled: boolean;
  invalid: RuleValidationError[];
  createdAt: string;
  winning: boolean;
  override: OverrideInfo | null;
  /** History replay only: rule revision changed / rule removed since this evaluation. */
  changedSince?: boolean;
  removedSince?: boolean;
}

export interface FindingDecision {
  nodeId: string;
  nodeName: string;
  fingerprint: string;
  selector: string;
  code: string;
  message: string;
  decision: Decision;
  winner: { ruleId: string; revision: number } | null;
  hits: RuleHitData[];
}

export interface EvaluationStats {
  suppressed: number;
  expired: number;
  invalid: number;
  disabled: number;
  uncovered: number;
  total: number;
}

export interface Evaluation {
  id: string;
  snapshotId: string;
  snapshotName: string;
  path: string;
  policyVersion: number;
  evaluatedAt: string;
  /** The clock the evaluation used (boundary: now == expiresAt means expired). */
  now: string;
  persisted: boolean;
  findings: FindingDecision[];
  stats: EvaluationStats;
}

export type JobStatus = 'running' | 'cancelling' | 'completed' | 'cancelled';

export type JobEvent =
  | { seq: number; type: 'started'; jobId: string; policyVersion: number; snapshotIds: string[]; at: string }
  | { seq: number; type: 'snapshot_done'; jobId: string; snapshotId: string; evaluationId: string; stats: EvaluationStats }
  | { seq: number; type: 'cancelling'; jobId: string; at: string }
  | { seq: number; type: 'cancelled'; jobId: string; processed: number; at: string }
  | { seq: number; type: 'completed'; jobId: string; stats: EvaluationStats; at: string };

export interface BatchJob {
  id: string;
  status: JobStatus;
  policyVersion: number;
  snapshotIds: string[];
  createdAt: string;
  finishedAt: string | null;
  processed: number;
  /** Final stats exist only for a completed job. Cancelled jobs never get them. */
  stats: EvaluationStats | null;
  events: JobEvent[];
}
