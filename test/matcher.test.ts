import { describe, expect, it } from 'vitest';
import {
  compareRules,
  compareSpecificity,
  compilePathGlob,
  coverageWhy,
  specificity,
  validateRule,
  isExpired,
  attributeMatches,
  scopeMatches,
} from '../src/shared/matcher';
import type { RuleInput } from '../src/shared/model';

describe('路径通配', () => {
  it('精确匹配、单段 * 不跨 /、** 跨 /', () => {
    expect(compilePathGlob('/home').re?.test('/home')).toBe(true);
    expect(compilePathGlob('/reports/*').re?.test('/reports/q3')).toBe(true);
    expect(compilePathGlob('/reports/*').re?.test('/reports/q3/x')).toBe(false);
    expect(compilePathGlob('/reports/**').re?.test('/reports/q3/x')).toBe(true);
  });
  it('拒绝非法路径', () => {
    expect(compilePathGlob('home').error).toBe('path_must_start_with_slash');
    expect(compilePathGlob('').error).toBe('path_empty');
  });
});

describe('特异度', () => {
  it('属性 > 指纹 > 规则代码 > 路径，精确路径高于通配', () => {
    expect(compareSpecificity(specificity({ attributes: [{ key: 'role', op: 'exists' }] }), specificity({})) > 0).toBe(true);
    expect(compareSpecificity(specificity({ fingerprint: 'f' }), specificity({ ruleCode: 'c' })) > 0).toBe(true);
    expect(compareSpecificity(specificity({ ruleCode: 'c' }), specificity({ pathPattern: '/x' })) > 0).toBe(true);
    expect(compareSpecificity(specificity({ pathPattern: '/x' }), specificity({ pathPattern: '/*' })) > 0).toBe(true);
  });

  it('覆盖原因指出第一个拉开差距的列，或退回创建顺序', () => {
    const winner = specificity({ fingerprint: 'f' });
    const loser = specificity({ ruleCode: 'c' });
    expect(coverageWhy(winner, loser)).toContain('组件指纹');
    expect(coverageWhy(specificity({ ruleCode: 'c' }), specificity({ ruleCode: 'd' }))).toContain('创建顺序');
  });
});

describe('属性约束', () => {
  const attrs = { role: 'button', 'aria-label': '', tabindex: '0' };
  it('exists/absent/equals/notEquals/contains 与空字符串值', () => {
    expect(attributeMatches({ key: 'role', op: 'equals', value: 'button' }, attrs)).toBe(true);
    expect(attributeMatches({ key: 'role', op: 'notEquals', value: 'link' }, attrs)).toBe(true);
    expect(attributeMatches({ key: 'href', op: 'absent' }, attrs)).toBe(true);
    expect(attributeMatches({ key: 'aria-label', op: 'exists' }, attrs)).toBe(true);
    expect(attributeMatches({ key: 'aria-label', op: 'equals', value: '' }, attrs)).toBe(true);
    expect(attributeMatches({ key: 'role', op: 'contains', value: 'but' }, attrs)).toBe(true);
  });
});

describe('规则校验与时钟边界', () => {
  it('缺原因、非法到期时间、缺属性值都判无效', () => {
    expect(validateRule({ reason: '' })).toContain('reason_required');
    expect(validateRule({ reason: 'x', expiresAt: 'nope' })).toContain('expiresAt_not_iso');
    expect(validateRule({ reason: 'x', attributes: [{ key: 'role', op: 'equals' }] })).toContain(
      'attributes[0].value_required_for_equals',
    );
  });

  it('到期瞬间 now == expiresAt 即过期（边界包含）', () => {
    const t = '2026-08-31T23:59:59.000Z';
    expect(isExpired({ expiresAt: t }, Date.parse(t))).toBe(true);
    expect(isExpired({ expiresAt: t }, Date.parse(t) - 1)).toBe(false);
    expect(isExpired({ expiresAt: null }, Date.parse(t))).toBe(false);
  });
});

describe('作用域 AND 组合', () => {
  const target = {
    path: '/reports/q3',
    fingerprint: 'fp:export',
    ruleCode: 'aria-required-attr',
    node: { id: 'n', fingerprint: 'fp:export', selector: '', attributes: { role: 'button' } },
  };
  it('所有维度都满足才命中', () => {
    expect(scopeMatches({ pathPattern: '/reports/*', attributes: [{ key: 'role', op: 'equals', value: 'button' }] }, target)).toBe(true);
    expect(scopeMatches({ attributes: [{ key: 'role', op: 'equals', value: 'link' }] }, target)).toBe(false);
  });

  it('排序：特异度降序，同特异度 createdSeq 升序', () => {
    const mk = (over: Partial<RuleInput>, seq: number): import('../src/shared/model').RuleRevision => ({
      reason: 'r',
      revision: 1,
      ruleId: `r${seq}`,
      createdSeq: seq,
      valid: true,
      enabled: true,
      expiresAt: null,
      createdAt: '',
      updatedAt: '',
      validationErrors: [],
      attributes: [],
      pathPattern: null,
      fingerprint: null,
      ruleCode: null,
      ...over,
    });
    const specific = mk({ fingerprint: 'f' }, 2);
    const early = mk({ ruleCode: 'c' }, 1);
    const late = mk({ ruleCode: 'c' }, 3);
    const sorted = [late, specific, early].sort(compareRules);
    expect(sorted.map((r) => r.createdSeq)).toEqual([2, 1, 3]);
  });
});
