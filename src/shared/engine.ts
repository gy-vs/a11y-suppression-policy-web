import type {
  AttributeMap,
  AttributePredicate,
  Decision,
  Evaluation,
  EvaluationStats,
  FindingDecision,
  Rule,
  RuleHitData,
  RuleRevisionData,
  RuleScope,
  RuleStatus,
  RuleValidationError,
  Snapshot,
} from './domain';

/** Glob with '*' (any run) and '?' (one char), case-sensitive. Anchored. */
export function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

export function globMatch(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}

function attributesMatch(predicates: AttributePredicate[], attrs: AttributeMap): boolean {
  return predicates.every((p) => {
    const actual = attrs[p.name];
    return actual !== undefined && globMatch(p.valuePattern, actual);
  });
}

/**
 * Specificity = sum of constrained scope dimensions:
 * fingerprint 4, code 2, path 1, and 1 per attribute predicate.
 * Fingerprint beats code beats path by design so the most identifying
 * constraint always wins; ties are broken later by creation order.
 */
export function specificity(scope: RuleScope): number {
  let n = 0;
  if (scope.fingerprint) n += 4;
  if (scope.code) n += 2;
  if (scope.pathPattern) n += 1;
  n += scope.attributes.length;
  return n;
}

/** Whether the rule's scope covers this node/finding on this path. */
export function scopeMatches(scope: RuleScope, path: string, fingerprint: string, code: string, attrs: AttributeMap): boolean {
  if (scope.pathPattern !== null && !globMatch(scope.pathPattern, path)) return false;
  if (scope.fingerprint !== null && scope.fingerprint !== fingerprint) return false;
  if (scope.code !== null && scope.code !== code) return false;
  if (!attributesMatch(scope.attributes, attrs)) return false;
  return true;
}

export function ruleStatusAt(rule: RuleRevisionData, nowMs: number): RuleStatus {
  if (rule.invalid.length > 0) return 'invalid';
  if (!rule.enabled) return 'disabled';
  if (rule.expiresAt !== null && Date.parse(rule.expiresAt) <= nowMs) return 'expired';
  return 'active';
}

export const emptyStats = (): EvaluationStats => ({ suppressed: 0, expired: 0, invalid: 0, disabled: 0, uncovered: 0, total: 0 });

function addStats(a: EvaluationStats, b: EvaluationStats): EvaluationStats {
  return {
    suppressed: a.suppressed + b.suppressed,
    expired: a.expired + b.expired,
    invalid: a.invalid + b.invalid,
    disabled: a.disabled + b.disabled,
    uncovered: a.uncovered + b.uncovered,
    total: a.total + b.total,
  };
}

/**
 * Validate a draft. Invalid rules are stored (so their history stays intact)
 * but marked with structured errors; evaluation reports them as 'invalid'
 * rather than silently ignoring them, and they still shadow lower-priority
 * rules so overlaps are visible to reviewers.
 */
export function validateDraft(input: {
  pathPattern: string | null;
  fingerprint: string | null;
  code: string | null;
  attributes: AttributePredicate[];
  expiresAt: string | null;
  reason: string;
}): RuleValidationError[] {
  const errors: RuleValidationError[] = [];
  const { pathPattern, fingerprint, code, attributes, expiresAt, reason } = input;
  if (pathPattern !== null) {
    if (pathPattern === '') errors.push({ field: 'pathPattern', code: 'empty', message: 'Path pattern cannot be empty.' });
    else if (!pathPattern.startsWith('/')) errors.push({ field: 'pathPattern', code: 'absolute_path', message: 'Path pattern must start with /.' });
    else {
      try {
        globToRegExp(pathPattern);
      } catch {
        errors.push({ field: 'pathPattern', code: 'bad_glob', message: 'Path pattern is not a valid glob.' });
      }
    }
  }
  if (fingerprint !== null && fingerprint.trim() === '')
    errors.push({ field: 'fingerprint', code: 'empty', message: 'Fingerprint cannot be empty.' });
  if (code !== null && code.trim() === '') errors.push({ field: 'code', code: 'empty', message: 'Rule code cannot be empty.' });
  const seen = new Set<string>();
  for (const predicate of attributes) {
    if (!predicate.name.trim()) {
      errors.push({ field: 'attributes', code: 'missing_name', message: 'Attribute predicate needs a name.' });
      continue;
    }
    if (seen.has(predicate.name))
      errors.push({ field: 'attributes', code: 'duplicate_name', message: `Duplicate attribute predicate "${predicate.name}".` });
    seen.add(predicate.name);
    if (predicate.valuePattern === '')
      errors.push({ field: 'attributes', code: 'empty_value', message: `Value pattern for "${predicate.name}" cannot be empty.` });
  }
  if (expiresAt !== null) {
    if (Number.isNaN(Date.parse(expiresAt)))
      errors.push({ field: 'expiresAt', code: 'bad_timestamp', message: 'Expiry is not a valid timestamp.' });
  }
  if (!reason.trim()) errors.push({ field: 'reason', code: 'empty', message: 'A suppression reason is required.' });
  return errors;
}

/**
 * Write-time only: a new/edited rule may not expire in the past. This is NOT
 * structural — a rule whose expiry passes naturally later must become
 * 'expired', not 'invalid'.
 */
export function validateFutureExpiry(expiresAt: string | null, nowMs: number): RuleValidationError | null {
  if (expiresAt === null) return null;
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return { field: 'expiresAt', code: 'bad_timestamp', message: 'Expiry is not a valid timestamp.' };
  if (ms <= nowMs) return { field: 'expiresAt', code: 'past', message: 'Expiry must be in the future.' };
  return null;
}

interface MatchedRule {
  rule: Rule;
  revision: RuleRevisionData;
  specificity: number;
  createdAtMs: number;
  status: RuleStatus;
  invalid: RuleValidationError[];
}

function overrideKind(hit: MatchedRule, winner: MatchedRule): 'higher_specificity' | 'older_rule_tiebreak' {
  if (winner.specificity > hit.specificity) return 'higher_specificity';
  return 'older_rule_tiebreak';
}

/**
 * Decide every finding of one snapshot against a frozen set of rules.
 *
 * Server matches by specificity (desc) then creation order (older first).
 * The highest-priority matching revision decides the outcome outright:
 * an expired/invalid/disabled winner yields 'expired'/'invalid'/'disabled'
 * even if a lower, still-active rule would have suppressed the finding.
 * Every matching revision is returned in `hits` so the UI can explain both
 * suppression and why a rule was overridden.
 */
export function evaluateSnapshot(
  snapshot: Snapshot,
  rules: Rule[],
  opts: { policyVersion: number; evaluatedAt: string; id: string; nowMs?: number },
): Evaluation {
  const nowMs = opts.nowMs ?? Date.parse(opts.evaluatedAt);
  const findings: FindingDecision[] = [];

  for (const node of snapshot.nodes) {
    for (const finding of node.findings) {
      const matched: MatchedRule[] = [];
      for (const rule of rules) {
        const revision = rule.history[rule.history.length - 1];
        if (!scopeMatches(revision, snapshot.path, node.fingerprint, finding.code, node.attributes)) continue;
        matched.push({
          rule,
          revision,
          specificity: specificity(revision),
          createdAtMs: Date.parse(revision.createdAt),
          status: ruleStatusAt(revision, nowMs),
          invalid: revision.invalid,
        });
      }
      // specificity desc; ties -> oldest createdAt first; final tiebreak: rule id for determinism.
      matched.sort((a, b) => b.specificity - a.specificity || a.createdAtMs - b.createdAtMs || (a.rule.id < b.rule.id ? -1 : 1));

      const winner = matched[0] ?? null;
      const decision: Decision = winner
        ? winner.status === 'active'
          ? 'suppressed'
          : winner.status
        : 'uncovered';

      const hits: RuleHitData[] = matched.map((hit, index) => ({
        ruleId: hit.rule.id,
        revision: hit.revision.revision,
        rank: index + 1,
        specificity: hit.specificity,
        status: hit.status,
        scope: {
          pathPattern: hit.revision.pathPattern,
          fingerprint: hit.revision.fingerprint,
          code: hit.revision.code,
          attributes: hit.revision.attributes.map((a) => ({ ...a })),
        },
        reason: hit.revision.reason,
        expiresAt: hit.revision.expiresAt,
        enabled: hit.revision.enabled,
        invalid: hit.invalid.map((e) => ({ ...e })),
        createdAt: hit.revision.createdAt,
        winning: hit === winner,
        override:
          winner && hit !== winner
            ? {
                kind: overrideKind(hit, winner),
                winnerRuleId: winner.rule.id,
                winnerRevision: winner.revision.revision,
                winnerStatus: winner.status,
              }
            : null,
      }));

      findings.push({
        nodeId: node.id,
        nodeName: node.name,
        fingerprint: node.fingerprint,
        selector: finding.selector,
        code: finding.code,
        message: finding.message,
        decision,
        winner: winner ? { ruleId: winner.rule.id, revision: winner.revision.revision } : null,
        hits,
      });
    }
  }

  const stats = findings.reduce<EvaluationStats>((acc, f) => {
    acc[f.decision] += 1;
    acc.total += 1;
    return acc;
  }, emptyStats());

  return {
    id: opts.id,
    snapshotId: snapshot.id,
    snapshotName: snapshot.name,
    path: snapshot.path,
    policyVersion: opts.policyVersion,
    evaluatedAt: opts.evaluatedAt,
    now: new Date(nowMs).toISOString(),
    persisted: false,
    findings,
    stats,
  };
}

export function aggregateStats(evaluations: Evaluation[]): EvaluationStats {
  return evaluations.reduce<EvaluationStats>((acc, e) => addStats(acc, e.stats), emptyStats());
}

/**
 * Historical replay: re-explain why a past snapshot was suppressed at the time.
 * Evaluations store the winning rule id + revision and the full frozen hit list;
 * the current ruleset is only used to annotate what has changed since then
 * (rule edited since, rule removed since). No re-matching is performed.
 */
export function annotateHistory(evaluation: Evaluation, currentRules: Rule[]): RuleHitData[] {
  const byId = new Map(currentRules.map((r) => [r.id, r]));
  return evaluation.findings.flatMap((f) =>
    f.hits.map((hit) => {
      const current = byId.get(hit.ruleId);
      const head = current?.history[current.history.length - 1];
      const changedSince = head ? head.revision !== hit.revision : false;
      const removedSince = !current;
      return { ...hit, changedSince, removedSince } as RuleHitData;
    }),
  );
}
