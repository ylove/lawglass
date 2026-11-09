import { describe, expect, test } from 'vitest';
import { envVar } from '../brand.js';
import { AppError } from '../model/index.js';
import {
  breakdownMaxUnitsFromEnv,
  isBudgetExhausted,
  isFullCoverage,
  pregenerateExamplesFromEnv,
  unitCapOf,
} from './coverage.js';
import { MAX_BREAKDOWN_UNITS } from './units.js';

describe('unitCapOf', () => {
  test('defaults to 30, takes a count, and turns "all" into no cap', () => {
    expect(unitCapOf(undefined)).toBe(MAX_BREAKDOWN_UNITS);
    expect(unitCapOf(7)).toBe(7);
    expect(unitCapOf('all')).toBe(Infinity);
    expect(unitCapOf(Infinity)).toBe(Infinity);
  });
  test('refuses a count that is not a nonnegative integer', () => {
    expect(() => unitCapOf(-1)).toThrow(RangeError);
    expect(() => unitCapOf(1.5)).toThrow(RangeError);
  });
  test('only a cap past the default is full coverage', () => {
    expect(isFullCoverage(30)).toBe(false);
    expect(isFullCoverage(31)).toBe(true);
    expect(isFullCoverage(Infinity)).toBe(true);
  });
});

describe('environment', () => {
  const max = envVar('BREAKDOWN_MAX_UNITS');
  const pre = envVar('PREGENERATE_EXAMPLES');
  test('breakdown max units: a count or "all", else the default', () => {
    expect(breakdownMaxUnitsFromEnv({})).toBe(30);
    expect(breakdownMaxUnitsFromEnv({ [max]: ' 120 ' })).toBe(120);
    expect(breakdownMaxUnitsFromEnv({ [max]: 'ALL' })).toBe('all');
    expect(breakdownMaxUnitsFromEnv({ [max]: 'lots' })).toBe(30);
    expect(breakdownMaxUnitsFromEnv({ [max]: '-4' })).toBe(30);
    expect(breakdownMaxUnitsFromEnv({ [max]: '' })).toBe(30);
  });
  test('pregenerate examples: the old 0 switch, all, else small', () => {
    expect(pregenerateExamplesFromEnv({})).toBe('small');
    expect(pregenerateExamplesFromEnv({ [pre]: '1' })).toBe('small');
    expect(pregenerateExamplesFromEnv({ [pre]: '0' })).toBe('off');
    expect(pregenerateExamplesFromEnv({ [pre]: 'off' })).toBe('off');
    expect(pregenerateExamplesFromEnv({ [pre]: 'all' })).toBe('all');
  });
});

describe('isBudgetExhausted', () => {
  test('recognises the budget hook by code, and nothing else', () => {
    const budget = new AppError('RATE_LIMITED');
    Object.defineProperty(budget, 'code', { value: 'BUDGET_EXHAUSTED' });
    expect(isBudgetExhausted(budget)).toBe(true);
    expect(isBudgetExhausted(new AppError('RATE_LIMITED'))).toBe(false);
    expect(isBudgetExhausted(new Error('BUDGET_EXHAUSTED'))).toBe(false);
    expect(isBudgetExhausted(undefined)).toBe(false);
  });
});
