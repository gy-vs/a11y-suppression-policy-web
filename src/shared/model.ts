// 共享领域模型：抑制规则、样例快照、评估结论。
// 前后端同构，服务端据此权威评估，客户端仅用于渲染服务端结果。

/** 节点属性约束支持的运算符 */
export type AttrOp = 'equals' | 'notEquals' | 'exists' | 'absent' | 'contains';

/** 一条节点属性约束 */
export interface AttributeConstraint {
  key: string;
  op: AttrOp;
  /** equals/notEquals/contains 需要；空字符串 '' 是合法值（例如 aria-label=""），只有缺省才非法 */
  value?: string;
}

/** 规则作用域：所有字段均为可选，缺省表示该维度通配 */
export interface RuleScope {
  /** 页面路径：精确串或含 * / ** 的通配 */
  pathPattern?: string | null;
  /** 组件指纹 */
  fingerprint?: string | null;
  /** 无障碍规则代码，如 color-contrast */
  ruleCode?: string | null;
  /** 节点属性约束（AND 关系） */
  attributes?: AttributeConstraint[];
}

/** 创建/修改规则时的输入 */
export interface RuleInput extends RuleScope {
  reason: string;
  /** 到期时间（ISO），null/缺省表示永不到期 */
  expiresAt?: string | null;
  enabled?: boolean;
}

/**
 * 不可变的规则 revision 文档。
 * 每次修改都追加一份新文档；createdSeq/createdAt 终身不变，
 * 因此编辑规则不会改变“创建顺序”这一优先级维度。
 */
export interface RuleRevision extends RuleInput {
  ruleId: string;
  revision: number;
  enabled: boolean;
  /** 存储层总是归一化为 null（永不到期） */
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 单调创建序号，用于同特异度时的稳定排序 */
  createdSeq: number;
  /** 结构是否合法；非法规则永不抑制，但仍会在评估中被解释 */
  valid: boolean;
  validationErrors: string[];
}

/** 样例快照中的节点（来自静态样例，不连接线上系统） */
export interface A11yNode {
  id: string;
  /** 组件指纹：同一组件跨快照保持稳定 */
  fingerprint: string;
  selector: string;
  name?: string;
  attributes: Record<string, string>;
}

/** 一条无障碍问题（命中某条 a11y 规则代码、落在某节点上） */
export interface Issue {
  id: string;
  nodeId: string;
  ruleCode: string;
  message?: string;
}

export interface Snapshot {
  id: string;
  label: string;
  path: string;
  capturedAt: string;
  nodes: A11yNode[];
  issues: Issue[];
}

/** 单条规则在某一时刻的状态。invalid 优先于 disabled/expired */
export type RuleState = 'active' | 'expired' | 'invalid' | 'disabled';

/** 问题的最终结论 */
export type Outcome = 'suppressed' | 'expired' | 'invalid' | 'disabled' | 'unsuppressed';

/**
 * 特异度元组，按字典序比较：属性约束数 > 组件指纹 > 规则代码 > 页面路径。
 * 路径维度：精确=2，通配=1，缺省=0。
 */
export interface Specificity {
  attrs: number;
  fingerprint: number;
  ruleCode: number;
  path: number;
}

export const SPEC_COLUMNS: (keyof Specificity)[] = ['attrs', 'fingerprint', 'ruleCode', 'path'];

export const SPEC_COLUMN_LABELS: Record<keyof Specificity, string> = {
  attrs: '节点属性约束',
  fingerprint: '组件指纹',
  ruleCode: '规则代码',
  path: '页面路径（精确 > 通配 > 缺省）',
};

/** 评估排序后的候选规则 */
export interface RankedRule {
  ruleId: string;
  revision: number;
  createdSeq: number;
  scope: RuleScope;
  reason: string;
  expiresAt: string | null;
  specificity: Specificity;
  /** 评估时刻该规则自身的状态 */
  state: RuleState;
  valid: boolean;
  validationErrors: string[];
  rank: number;
  /** won=最终生效；shadowed=本可生效但被更高优先级规则覆盖；其余为自身状态 */
  disposition: 'won' | 'shadowed' | 'expired' | 'invalid' | 'disabled';
  coveredBy?: { ruleId: string; revision: number; why: string };
}

/** 单个问题的评估结论 */
export interface IssueDecision {
  snapshotId: string;
  issueId: string;
  ruleCode: string;
  nodeId: string;
  fingerprint: string;
  path: string;
  outcome: Outcome;
  winner?: {
    ruleId: string;
    revision: number;
    reason: string;
    expiresAt: string | null;
    specificity: Specificity;
  };
  /** 按优先级排序的全部作用域命中规则（含过期/禁用/非法，便于解释） */
  candidates: RankedRule[];
}

export interface SnapshotDecision {
  snapshotId: string;
  decisions: IssueDecision[];
  stats: Record<Outcome, number>;
}

/** 固化的规则 revision 集合 + 评估时钟，批量/回放共用 */
export type RevisionPins = Record<string, number>;

/** 历史报告：自包含，脱离规则当前状态仍能解释当时为何被抑制 */
export interface EvaluationReport {
  id: string;
  snapshotIds: string[];
  /** 整批评估共用的时钟瞬间，避免批内跨到期边界翻转 */
  evaluatedAt: string;
  /** 启动时固化的规则 revision */
  ruleRevisionPins: RevisionPins;
  decisions: IssueDecision[];
  stats: Record<Outcome, number>;
  completedAt: string;
  canceled?: boolean;
}

export function emptyStats(): Record<Outcome, number> {
  return { suppressed: 0, expired: 0, invalid: 0, disabled: 0, unsuppressed: 0 };
}
