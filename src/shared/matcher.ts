import type {
  AttributeConstraint,
  Issue,
  RuleInput,
  RuleRevision,
  RuleState,
  RuleScope,
  Specificity,
  Snapshot,
} from './model';
import { SPEC_COLUMNS, type A11yNode } from './model';

/** 把含 * / ** 的路径通配编译为锚定正则，并校验 */
export function compilePathGlob(pattern: string): { re?: RegExp; error?: string } {
  if (pattern === '') return { error: 'path_empty' };
  if (!pattern.startsWith('/')) return { error: 'path_must_start_with_slash' };
  let body = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // **：匹配任意字符（含 '/')
        body += '.*';
        i++;
      } else {
        // *：匹配单段内任意字符（不含 '/')
        body += '[^/]*';
      }
    } else {
      body += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  try {
    return { re: new RegExp('^' + body + '$') };
  } catch {
    return { error: 'path_bad_glob' };
  }
}

function pathMatches(pattern: string | null | undefined, path: string): boolean {
  if (pattern == null || pattern === '') return true;
  return compilePathGlob(pattern).re?.test(path) ?? false;
}

export function patternIsExact(pattern: string | null | undefined): boolean {
  return !!pattern && !pattern.includes('*');
}

export function validateAttribute(c: AttributeConstraint, idx: number): string[] {
  const errs: string[] = [];
  if (!c.key) errs.push(`attributes[${idx}].key_empty`);
  if (c.op === 'equals' || c.op === 'notEquals' || c.op === 'contains') {
    if (c.value === undefined) errs.push(`attributes[${idx}].value_required_for_${c.op}`);
  }
  const ops: AttributeConstraint['op'][] = ['equals', 'notEquals', 'exists', 'absent', 'contains'];
  if (!ops.includes(c.op)) errs.push(`attributes[${idx}].unknown_op`);
  return errs;
}

/** 结构校验：只判断规则本身是否合法，与时间无关 */
export function validateRule(input: RuleInput): string[] {
  const errs: string[] = [];
  if (typeof input.reason !== 'string' || input.reason.trim() === '') errs.push('reason_required');
  if (input.pathPattern) {
    const { error } = compilePathGlob(input.pathPattern);
    if (error) errs.push(error);
  }
  if (input.expiresAt != null) {
    const t = Date.parse(input.expiresAt);
    if (Number.isNaN(t)) errs.push('expiresAt_not_iso');
  }
  for (const c of input.attributes ?? []) {
    errs.push(...validateAttribute(c, errs.length));
  }
  return errs;
}

export function isExpired(rule: Pick<RuleRevision, 'expiresAt'>, nowMs: number): boolean {
  if (rule.expiresAt == null) return false;
  const t = Date.parse(rule.expiresAt);
  if (Number.isNaN(t)) return false; // 非法时间由 validateRule 处理
  // expiresAt 为到期瞬间：now == expiresAt 即视为过期（边界包含）
  return nowMs >= t;
}

/** 规则在某时刻的状态：invalid 优先于 disabled/expired */
export function ruleState(rule: Pick<RuleRevision, 'valid' | 'enabled' | 'expiresAt'>, nowMs: number): RuleState {
  if (!rule.valid) return 'invalid';
  if (!rule.enabled) return 'disabled';
  if (isExpired(rule, nowMs)) return 'expired';
  return 'active';
}

export function specificity(scope: RuleScope): Specificity {
  const attrs = scope.attributes?.length ?? 0;
  const fingerprint = scope.fingerprint ? 1 : 0;
  const ruleCode = scope.ruleCode ? 1 : 0;
  let path = 0;
  if (scope.pathPattern) path = patternIsExact(scope.pathPattern) ? 2 : 1;
  return { attrs, fingerprint, ruleCode, path };
}

/** 特异度字典序比较：a 更具体返回 >0 */
export function compareSpecificity(a: Specificity, b: Specificity): number {
  for (const col of SPEC_COLUMNS) {
    if (a[col] !== b[col]) return a[col] - b[col];
  }
  return 0;
}

/**
 * 服务端排序键：特异度降序、createdSeq 升序（先创建者优先）、ruleId 兜底。
 * 返回 <0 表示 a 排在 b 前面。
 */
export function compareRules(a: RuleRevision, b: RuleRevision): number {
  const spec = compareSpecificity(specificity(a), specificity(b));
  if (spec !== 0) return -spec;
  if (a.createdSeq !== b.createdSeq) return a.createdSeq - b.createdSeq;
  return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
}

export function attributeMatches(c: AttributeConstraint, attrs: Record<string, string>): boolean {
  const present = Object.prototype.hasOwnProperty.call(attrs, c.key);
  switch (c.op) {
    case 'exists':
      return present;
    case 'absent':
      return !present;
    case 'equals':
      return present && attrs[c.key] === c.value;
    case 'notEquals':
      // 属性不存在即“不等于该值”
      return !present || attrs[c.key] !== c.value;
    case 'contains':
      return present && attrs[c.key].includes(c.value ?? '');
    default:
      return false;
  }
}

interface Target {
  path: string;
  fingerprint: string;
  ruleCode: string;
  node: A11yNode;
}

/** 作用域是否命中（仅看维度匹配，不含时间/启用/合法） */
export function scopeMatches(scope: RuleScope, t: Target): boolean {
  if (!pathMatches(scope.pathPattern, t.path)) return false;
  if (scope.fingerprint && scope.fingerprint !== t.fingerprint) return false;
  if (scope.ruleCode && scope.ruleCode !== t.ruleCode) return false;
  for (const c of scope.attributes ?? []) {
    if (!attributeMatches(c, t.node.attributes)) return false;
  }
  return true;
}

export function resolveNode(snapshot: Snapshot, nodeId: string): A11yNode | undefined {
  return snapshot.nodes.find((n) => n.id === nodeId);
}

export function issueTarget(snapshot: Snapshot, issue: Issue): Target | undefined {
  const node = resolveNode(snapshot, issue.nodeId);
  if (!node) return undefined;
  return { path: snapshot.path, fingerprint: node.fingerprint, ruleCode: issue.ruleCode, node };
}

/** 人类可读的覆盖原因：指出第一个拉开差距的特异度列，或退回创建顺序 */
export function coverageWhy(winner: Specificity, loser: Specificity): string {
  for (const col of SPEC_COLUMNS) {
    if (winner[col] !== loser[col]) {
      const name =
        col === 'attrs'
          ? `节点属性约束（${winner[col]} > ${loser[col]}）`
          : col === 'fingerprint'
            ? '组件指纹（命中 vs 通配）'
            : col === 'ruleCode'
              ? '规则代码（命中 vs 通配）'
              : '页面路径（精确 > 通配 > 缺省）';
      return `特异度更高：${name}`;
    }
  }
  return '特异度相同，按创建顺序更早的规则优先';
}
