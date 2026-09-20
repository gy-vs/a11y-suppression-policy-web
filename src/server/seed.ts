import type { Snapshot } from '../shared/model';
import type { RuleStore } from './store';

/**
 * 静态样例快照：三个页面，刻意覆盖
 * 作用域重叠（精确路径 vs 通配）、属性变化（role 由 button 变为 link）、
 * 规则代码/指纹特异度差异。
 */
export const SAMPLE_SNAPSHOTS: Snapshot[] = [
  {
    id: 'snap-home-q4',
    label: '首页 / 2026 Q4 快照',
    path: '/home',
    capturedAt: '2026-09-10T08:00:00.000Z',
    nodes: [
      {
        id: 'n-banner',
        fingerprint: 'fp:brand-logo',
        selector: 'header > a.logo > img',
        name: '品牌标志',
        attributes: { src: '/logo.svg', width: '32', height: '32' },
      },
      {
        id: 'n-search',
        fingerprint: 'fp:search-input',
        selector: 'form.search input[name=q]',
        name: '搜索',
        attributes: { type: 'search', placeholder: '搜索文档' },
      },
      {
        id: 'n-submit',
        fingerprint: 'fp:submit-cta',
        selector: 'form.cta button.submit',
        name: '提交申请',
        attributes: { type: 'submit', role: 'button', 'data-qa': 'submit-cta' },
      },
      {
        id: 'n-nav',
        fingerprint: 'fp:main-nav',
        selector: 'nav[aria-label=主导航]',
        name: '主导航',
        attributes: { 'aria-label': '主导航' },
      },
    ],
    issues: [
      { id: 'i-logo-alt', nodeId: 'n-banner', ruleCode: 'image-alt', message: '图片缺少 alt 属性' },
      { id: 'i-search-label', nodeId: 'n-search', ruleCode: 'label', message: '输入框缺少可访问名称' },
      { id: 'i-submit-aria', nodeId: 'n-submit', ruleCode: 'aria-required-attr', message: '按钮缺少 ARIA 属性' },
      { id: 'i-submit-contrast', nodeId: 'n-submit', ruleCode: 'color-contrast', message: '文字与背景对比度不足' },
      { id: 'i-nav-unique', nodeId: 'n-nav', ruleCode: 'landmark-unique', message: '地标应唯一' },
    ],
  },
  {
    id: 'snap-report-q3',
    label: '报告页 / 2026 Q3 快照（旧）',
    path: '/reports/q3',
    capturedAt: '2026-07-01T08:00:00.000Z',
    nodes: [
      {
        id: 'r-title',
        fingerprint: 'fp:report-title',
        selector: 'main h1.report-title',
        name: 'Q3 报告',
        attributes: { role: 'heading', 'aria-level': '1' },
      },
      {
        id: 'r-export',
        fingerprint: 'fp:export-button',
        selector: 'div.report-tools .export',
        name: '导出',
        attributes: { role: 'button', tabindex: '0' },
      },
    ],
    issues: [
      { id: 'i-r-heading', nodeId: 'r-title', ruleCode: 'aria-required-attr', message: '标题结构待复核' },
      { id: 'i-r-export', nodeId: 'r-export', ruleCode: 'aria-required-attr', message: '自定义按钮缺少 aria 状态' },
    ],
  },
  {
    id: 'snap-report-q3-fixed',
    label: '报告页 / 修复后快照（role 变化）',
    path: '/reports/q3',
    capturedAt: '2026-09-15T08:00:00.000Z',
    nodes: [
      {
        id: 'r-title',
        fingerprint: 'fp:report-title',
        selector: 'main h1.report-title',
        name: 'Q3 报告',
        attributes: { role: 'heading', 'aria-level': '1' },
      },
      {
        id: 'r-export',
        fingerprint: 'fp:export-button',
        selector: 'div.report-tools .export',
        name: '导出',
        // 属性变化：从 button 改为 link，原“role=button”的属性抑制应失效
        attributes: { role: 'link', href: '/export/q3' },
      },
    ],
    issues: [
      { id: 'i-r-heading', nodeId: 'r-title', ruleCode: 'aria-required-attr', message: '标题结构待复核' },
      { id: 'i-r-export', nodeId: 'r-export', ruleCode: 'aria-required-attr', message: '自定义按钮缺少 aria 状态' },
    ],
  },
];

export interface SeedResult {
  rules: {
    thirdParty: string;
    codeGlob: string;
    exportRole: string;
    expiredGlob: string;
    invalid: string;
    disabledLogo: string;
  };
}

export function seedRules(store: RuleStore): SeedResult {
  const base = '2026-01-01T00:00:00.000Z';
  const mk = (offsetMinutes: number) =>
    new Date(Date.parse(base) + offsetMinutes * 60_000).toISOString();

  // 1) 精确路径 + 规则代码 + 指纹：最具体
  const thirdParty = store.seed(
    {
      pathPattern: '/home',
      ruleCode: 'aria-required-attr',
      fingerprint: 'fp:submit-cta',
      reason: '第三方 CTA 组件，供应商在 v12 修复，当前误报',
      enabled: true,
    },
    'rule-third-party',
    mk(0),
    1,
  ).ruleId;

  // 2) 仅规则代码（通配全部路径/指纹/属性）：低特异度，会被上面覆盖
  const codeGlob = store.seed(
    {
      ruleCode: 'color-contrast',
      reason: '设计系统令牌已统一，对比度批量豁免',
      enabled: true,
    },
    'rule-code-glob',
    mk(10),
    2,
  ).ruleId;

  // 3) 属性约束 role=button：旧快照命中，修复后快照（role=link）失效
  const exportRole = store.seed(
    {
      pathPattern: '/reports/*',
      attributes: [{ key: 'role', op: 'equals', value: 'button' }],
      reason: '旧版导出组件采用 button role，已知问题，重写后移除',
      enabled: true,
    },
    'rule-export-role',
    mk(20),
    3,
  ).ruleId;

  // 4) 已过期规则：演示“规则过期”与“已抑制”的区分
  const expiredGlob = store.seed(
    {
      ruleCode: 'landmark-unique',
      reason: '临时豁免，仅到 2026-08-31',
      expiresAt: '2026-08-31T23:59:59.000Z',
      enabled: true,
    },
    'rule-expired-glob',
    mk(30),
    4,
  ).ruleId;

  // 5) 非法规则：到期时间不是合法 ISO，结构无效（永不抑制，但要被解释）
  const invalid = store.seed(
    {
      ruleCode: 'label',
      reason: '搜索框标签走视觉占位，产品确认',
      expiresAt: 'not-a-date',
      enabled: true,
    },
    'rule-invalid',
    mk(40),
    5,
  ).ruleId;

  // 6) 已禁用规则：演示禁用不抑制
  const disabledLogo = store.seed(
    {
      ruleCode: 'image-alt',
      reason: '曾经豁免 logo alt，已禁用要求重新标注',
      enabled: false,
    },
    'rule-disabled-logo',
    mk(50),
    6,
  ).ruleId;

  return { rules: { thirdParty, codeGlob, exportRole, expiredGlob, invalid, disabledLogo } };
}
