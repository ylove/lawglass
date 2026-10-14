import { describe, expect, it } from 'vitest';
import type { ScenarioFigure } from '../model/index.js';
import { exampleScenario } from '../../../tests/synth/scenario.js';
import { computedIsGrounded } from './grounding.js';

const assumptions = exampleScenario().profile.assumptions;
function grounded(
  expr: string,
  value: number,
  unit = 'USD',
  text = '4 percent',
  figures: ScenarioFigure[] = [],
): boolean {
  return computedIsGrounded(
    { source: 'computed', expr, value, unit },
    figures,
    assumptions,
    text,
  );
}

describe('unit-aware arithmetic grounding', () => {
  it.each([
    'income * 4/100',
    'income * (4/100)',
    '(income * 4)/100',
    '50000 * 0.04',
    '0.04 * income',
    'income × 4 ÷ 100',
  ])('converts a cited percent at its actual operator boundary: %s', (expr) => {
    expect(grounded(expr, 2000)).toBe(true);
  });
  it.each([
    ['income * 4', 200000],
    ['income * 100 * 0.04', 200000],
    ['income / 4 / 100', 125],
    ['income * (4 + 4) / 100', 4000],
    ['income * 0.04 + 100', 2100],
    ['income * 0.04 / 100', 20],
    ['income + income', 100000],
    ['bill_0', 4],
  ] as const)(
    'rejects raw percents, detached conversions and assumption-only calculations: %s',
    (expr, value) => {
      expect(grounded(expr, value)).toBe(false);
    },
  );
  it.each(['days', 'years', 'employees'])(
    'does not treat %s as a money rate',
    (unit) => {
      expect(grounded('income * 4', 200000, 'USD', `4 ${unit}`)).toBe(false);
      expect(grounded('income + 4', 50004, 'USD', `4 ${unit}`)).toBe(false);
      expect(grounded('income / 4', 12500, 'USD', `4 ${unit}`)).toBe(false);
    },
  );
  it('supports named bill percents only at their conversion', () => {
    const figures: ScenarioFigure[] = [
      { source: 'bill', value: 4, unit: 'percent' },
    ];
    expect(
      grounded('income * bill_0 / 100', 2000, 'USD', '4 percent', figures),
    ).toBe(true);
    expect(
      grounded('income * bill_0', 200000, 'USD', '4 percent', figures),
    ).toBe(false);
  });
  it('supports compatible additions, subtractions and ratios without inventing conversions', () => {
    expect(grounded('income + 100', 50100, 'USD', '$100')).toBe(true);
    expect(grounded('income - 100', 49900, 'USD', '$100')).toBe(true);
    expect(grounded('income / 100', 500, 'ratio', '$100')).toBe(true);
    expect(grounded('income / 0.04', 1250000)).toBe(true);
    expect(grounded('-income * 0.04', -2000)).toBe(true);
    expect(grounded('income * 0.04', 2000, 'days')).toBe(false);
  });
  it('rejects unknown or missing expressions and wrong results', () => {
    expect(
      computedIsGrounded(
        { source: 'bill', value: 4, unit: 'percent' },
        [],
        assumptions,
        '4 percent',
      ),
    ).toBe(false);
    expect(grounded('unknown * 0.04', 2000)).toBe(false);
    expect(grounded('income * 0.04', 2001)).toBe(false);
    expect(grounded('4', 4, 'percent')).toBe(false);
  });
});

it('does not mistake a sign for a calculation', () => {
  expect(grounded('-4', -4, 'USD', '$4')).toBe(false);
  expect(
    grounded('+bill_0', 4, 'USD', '$4', [
      { source: 'bill', value: 4, unit: 'USD' },
    ]),
  ).toBe(false);
});
