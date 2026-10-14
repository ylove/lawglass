import { expect, test } from 'vitest';
import { SlidingWindowLimiter } from './rate-limit.js';

test('allows up to the limit per key, then refuses', () => {
  const limiter = new SlidingWindowLimiter(2, 1000, () => 0);
  expect(limiter.take('a')).toBe(true);
  expect(limiter.take('a')).toBe(true);
  expect(limiter.take('a')).toBe(false);
  expect(limiter.take('b')).toBe(true);
});

test('the window slides: old hits expire one by one', () => {
  let t = 0;
  const limiter = new SlidingWindowLimiter(2, 1000, () => t);
  limiter.take('a');
  t = 600;
  limiter.take('a');
  t = 999;
  expect(limiter.take('a')).toBe(false);
  t = 1000; // first hit has just expired, the second has not
  expect(limiter.take('a')).toBe(true);
  expect(limiter.take('a')).toBe(false);
});

test('idle keys are forgotten', () => {
  let t = 0;
  const limiter = new SlidingWindowLimiter(1, 10, () => t);
  limiter.take('a');
  t = 100;
  expect(limiter.take('b')).toBe(true);
  expect(limiter.take('a')).toBe(true);
});
