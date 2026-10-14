import { describe, expect, it } from 'vitest';
import {
  billContains,
  normalizeUnit,
  numberTokens,
  textNumbers,
} from './numbers.js';

describe('figure normalization', () => {
  it.each(['$', 'USD', 'dollar', 'dollars'])('normalizes %s', (unit) => {
    expect(normalizeUnit(unit)).toBe('usd');
  });
  it.each(['%', 'percent', 'percentage', 'per cent'])(
    'normalizes %s',
    (unit) => {
      expect(normalizeUnit(unit)).toBe('percent');
    },
  );
  it('matches complete amounts, rates, durations and cheap spelled-out numbers', () => {
    for (const [value, unit, text] of [
      [2000000, 'USD', '$2,000,000'],
      [4, 'percent', '4%'],
      [10, 'years', 'ten years'],
      [21, 'days', 'twenty-one days'],
      [90, 'days', 'ninety days'],
    ] as const)
      expect(billContains(value, unit, text)).toBe(true);
    expect(textNumbers('one two days')).toEqual([{ value: 2, unit: 'day' }]);
  });
  it('accepts sentence punctuation and decimals', () => {
    expect(textNumbers('The amount is $50,000. A 0.5 percent rate.')).toEqual([
      { value: 50000, unit: 'usd' },
      { value: 0.5, unit: 'percent' },
    ]);
  });
  it('does not match substrings or change units', () => {
    expect(billContains(5, 'USD', '$500')).toBe(false);
    expect(billContains(4, 'percent', '4 days')).toBe(false);
    expect(billContains(500, 'USD', '$50,00')).toBe(false);
    expect(textNumbers('sec-1 abc123 income_2')).toEqual([]);
  });
  it('normalizes spelled-out scales without treating one hundred as one', () => {
    expect(billContains(100, 'percent', 'one hundred percent')).toBe(true);
    expect(
      billContains(125, 'USD', 'one hundred and twenty-five dollars'),
    ).toBe(true);
    expect(billContains(50000, 'USD', 'fifty thousand dollars')).toBe(true);
    expect(
      billContains(2500000, 'USD', 'two million five hundred thousand dollars'),
    ).toBe(true);
    expect(billContains(2000000000, 'USD', 'two billion dollars')).toBe(true);
    expect(billContains(1, 'percent', 'one hundred percent')).toBe(false);
    expect(textNumbers('a 2-bedroom home')).toEqual([
      { value: 2, unit: 'bedroom' },
    ]);
  });
});

it.each([
  ['5k', 5000, ''],
  ['$5K', 5000, 'usd'],
  ['$2M', 2000000, 'usd'],
  ['$3B', 3000000000, 'usd'],
  ['half', 0.5, ''],
  ['3rd', 3, ''],
  ['third', 3, ''],
  ['a dozen', 12, ''],
  ['１１００', 1100, ''],
  ['1e3', 1000, ''],
  ['doubles the tax', 2, ''],
  ['1.1 million dollars', 1100000, 'usd'],
  ['one day', 1, 'day'],
] as const)('normalizes the complete numeric token %s', (text, value, unit) => {
  expect(textNumbers(text)).toEqual([{ value, unit }]);
});
it('records complete token boundaries without allowing identifiers to hide neighboring amounts', () => {
  const caption = 'Example 4: the tax is $4444.';
  expect(numberTokens(caption)).toEqual([
    { value: 4, unit: '', start: 8, end: 9 },
    { value: 4444, unit: 'usd', start: 22, end: 27 },
  ]);
  expect(numberTokens('Section 2: $777')).toEqual([
    { value: 777, unit: 'usd', start: 11, end: 15 },
  ]);
});
