import { describe, expect, it } from 'vitest';
import { evaluateArithmetic } from './arith.js';

describe('safe arithmetic', () => {
  it.each([
    ['2 + 3 * 4', 14],
    ['(2 + 3) × 4', 20],
    ['10 − 6 ÷ 2', 7],
    ['-.5 + +2.5', 2],
    ['-(-2)', 2],
    ['income * rate', 2000],
    ['toString + 1', 3],
  ])('evaluates %s with precedence', (expression, expected) => {
    expect(
      evaluateArithmetic(expression, { income: 50000, rate: 0.04, toString: 2 })
        ?.value,
    ).toBe(expected);
  });

  it('records input provenance separately from the result', () => {
    expect(evaluateArithmetic('income * 4 / 100', { income: 50000 })).toEqual({
      value: 2000,
      names: ['income'],
      literals: [4, 100],
    });
  });

  it.each([
    '',
    ' ',
    '1 / 0',
    '0 / 0',
    '2 ** 3',
    '1e3',
    '2(3)',
    '(2',
    '2)',
    '1+',
    'unknown',
    'toString',
    'constructor',
    'NaN',
    'Infinity',
    'globalThis',
    'process.exit()',
    'x.y',
    'alert(1)',
    '1; 2',
    '1,2',
    '1 // 2',
    '1 % 2',
    '1 = 2',
    '2 < 3',
    '[1]',
    '/*hi*/1',
    'Function("return 1")()',
  ])('rejects %s', (expression) => {
    expect(evaluateArithmetic(expression)).toBeUndefined();
  });

  it('bounds depth, token count, input length and nonfinite inputs/results', () => {
    expect(
      evaluateArithmetic('('.repeat(34) + '1' + ')'.repeat(34)),
    ).toBeUndefined();
    expect(evaluateArithmetic('1+'.repeat(65) + '1')).toBeUndefined();
    expect(evaluateArithmetic(' '.repeat(512) + '1')).toBeUndefined();
    expect(evaluateArithmetic('x', { x: Infinity })).toBeUndefined();
    expect(evaluateArithmetic('9'.repeat(310))).toBeUndefined();
  });

  it('runs a deterministic fuzz-ish matrix of arithmetic and hostile suffixes', () => {
    for (let a = -5; a <= 5; a++)
      for (let b = 1; b <= 8; b++) {
        const expression = `(${String(a)} + ${String(b)}) * ${String(b)} / ${String(b)}`;
        expect(evaluateArithmetic(expression)?.value).toBe(a + b);
        for (const suffix of [';x', '.constructor', '[0]', '=>1', '/*x*/'])
          expect(evaluateArithmetic(expression + suffix)).toBeUndefined();
      }
  });
});
