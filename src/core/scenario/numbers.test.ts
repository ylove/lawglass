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
    expect(textNumbers('abc123')).toEqual([]);
    // A raw section id is not exempt: it fails closed rather than hiding amounts.
    expect(numberTokens('sec-1').length).toBeGreaterThan(0);
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

describe('fail-closed caption numbers', () => {
  it.each([
    'The fee is a hundred dollars.',
    'The fee is a thousand dollars.',
    'The fee is a million dollars.',
    'The fee is a billion dollars.',
    'The fee is a grand.',
    'The fee is hundreds of dollars.',
    'Thousands of residents pay.',
    'A hundred percent of income.',
    'The tax is tenfold.',
    'A two-fold increase.',
    'One-half of income.',
    'A one half share.',
    '2x the tax.',
    '2× the tax.',
    'Three score years.',
    'A gross of forms.',
    'Dozens of forms.',
    'The fee is ١١٠٠ dollars.',
    'The fee is ११००.',
    'The fee is ১১০০.',
    'The fee is $٥٠٠.',
    'The rate is ٥٪.',
    'The fee is Ⅻ dollars.',
    'The fee is ⅷ dollars.',
    'Twice the tax is owed.',
    'The tax is thrice as high.',
    'The tax was halved.',
    'The tax was doubled.',
    'The tax was tripled.',
    'The tax was quadrupled.',
    'A hundredth of income.',
    'A thousandth of income.',
    'A fifth of income.',
    'An eighth of income.',
    'A quarter of income.',
    'One quarter of income.',
    'Quarter of income.',
    'The quarter share applies.',
    'A quarter portion is due.',
    'The quarter rate is set.',
    'Five lakh dollars.',
    'A crore of dollars.',
    'The fee is 1.000.000 dollars.',
    'The fee is 0x10.',
  ])('reports an undeclared number in %s', (caption) => {
    expect(numberTokens(caption).length).toBeGreaterThan(0);
  });
  it('keeps ordinary prose number-free', () => {
    expect(numberTokens('Due in the first quarter.')).toEqual([]);
    expect(numberTokens('Paid each quarter.')).toEqual([]);
    expect(numberTokens('The manifold forms are crossed out.')).toEqual([]);
    expect(numberTokens('Alex files a form.')).toEqual([]);
  });
  it.each([
    'Each quarter share is paid.',
    'Paid every quarter.',
    'Paid quarterly.',
    'A per-quarter rate applies.',
    'Due in the second quarter.',
    'A third party files.',
    'A second job pays.',
    'The first form is filed.',
    'The third of May.',
    'The third vehicle is listed.',
  ])('keeps %s number-free', (caption) => {
    expect(numberTokens(caption)).toEqual([]);
  });
  it.each([
    "A third of May's taxes.",
    'A third of May taxes.',
    'A third of April income.',
    'A fifth of May.',
    "The first of January's income.",
    'The third of May taxes.',
    'one third property tax',
    'one-third property tax',
    'one fifth time share',
    'one tenth round',
    'The quarter-rate applies.',
    'A third of income.',
    'The second of three.',
    'A third share.',
  ])('still counts ordinals not followed by an allowed noun: %s', (caption) => {
    expect(numberTokens(caption).length).toBeGreaterThan(0);
  });
  it('treats "the/on <ordinal> of <Month>" as a date, leaving only the year', () => {
    for (const text of [
      'On the first of January, 2027 it starts.',
      'It starts on the first of January 2027.',
    ])
      expect(textNumbers(text)).toEqual([{ value: 2027, unit: '' }]);
  });
  it('does not double count a scale already inside a numeral phrase', () => {
    expect(textNumbers('one thousand dollars')).toEqual([
      { value: 1000, unit: 'usd' },
    ]);
  });
  it.each([
    'A first-time homebuyer qualifies.',
    'The third-party administrator files.',
    'Second-hand goods are exempt.',
    'A first-year teacher.',
    'A second-year student.',
    'Due in the third-quarter filing.',
    'A first-degree felony.',
    'A second-degree relative.',
    'A first-class vehicle.',
    'First-Time Homebuyer credit.',
  ])('treats allow-listed hyphenated ordinal compounds as labels: %s', (t) => {
    expect(numberTokens(t)).toEqual([]);
  });
  it.each([
    'The first $10,000 is exempt.',
    'The first 3 months are free.',
    'A third of income.',
    'One-third of income.',
    'A quarter of income.',
    'The second of three.',
    'The first-of-month rule.',
    'one-third-party share',
    'The first-month rent.',
    'The third-share rate.',
  ])('still counts real quantities: %s', (t) => {
    expect(numberTokens(t).length).toBeGreaterThan(0);
  });
  it.each([
    'The rate-4 percent applies.',
    'A flat-500 dollar fee.',
    'the tax-twenty percent',
    'a non-4 percent',
    'Pay re-5 dollars',
    'A tax-half applies.',
  ])('audits a number joined to a word by a hyphen: %s', (t) => {
    expect(numberTokens(t).length).toBeGreaterThan(0);
  });
  it.each([
    ['a 4-percent rate', 4],
    ['a 500-dollar fee', 500],
    ['5-10 days', 5],
  ])('still catches %s', (t, v) => {
    expect(textNumbers(t).map((n) => n.value)).toContain(v);
  });
  it.each([
    'sec-500 dollar fee',
    'Sec-500 dollars',
    'SEC-4 percent',
    'sec-4%',
    'sec-5 percent fee',
    'sec-50 days',
    'sec-1 dollars',
  ])('does not hide an amount behind a section-id look-alike: %s', (t) => {
    expect(textNumbers(t).some((n) => n.unit !== '')).toBe(true);
  });
  it('audits the tail of a numeric range', () => {
    expect(textNumbers('The window is 5-10 days.')).toContainEqual({
      value: 10,
      unit: 'day',
    });
    expect(textNumbers('The rate is 4-60 percent.')).toContainEqual({
      value: 60,
      unit: 'percent',
    });
    expect(textNumbers('a -4 percent change')).toEqual([
      { value: -4, unit: 'percent' },
    ]);
  });
  it.each(['rate_4 percent', 'rate.4 percent', 'rate_-4 percent'])(
    'does not let _ or . shield a number: %s',
    (t) => {
      expect(textNumbers(t).some((n) => n.unit === 'percent')).toBe(true);
    },
  );
  it('keeps a decimal as one token', () => {
    expect(textNumbers('1.5 percent')).toEqual([
      { value: 1.5, unit: 'percent' },
    ]);
  });
});
