import { afterEach, expect, it, vi } from 'vitest';
import { BRAND } from '../brand.js';
import {
  assertChunkLimit,
  assertPageLimit,
  ParseBudget,
  readParseLimits,
} from './limits.js';

afterEach(() => vi.restoreAllMocks());

it('uses distinct local and public limits, keeping the public page cap fixed', () => {
  expect(readParseLimits(false, {})).toEqual({
    publicMode: false,
    maxPages: 5_000,
    timeoutMs: 120_000,
    maxChunks: 20_000,
    maxHtmlBytes: 15 * 1024 * 1024,
    maxNonPdfBytes: 50 * 1024 * 1024,
  });
  expect(readParseLimits(true, {})).toEqual({
    publicMode: true,
    maxPages: 200,
    timeoutMs: 30_000,
    maxChunks: 3_000,
    maxHtmlBytes: 5 * 1024 * 1024,
    maxNonPdfBytes: 10 * 1024 * 1024,
  });
  const env = {
    [`${BRAND.envPrefix}_MAX_PAGES`]: '7',
    [`${BRAND.envPrefix}_PARSE_TIMEOUT_MS`]: '12',
    [`${BRAND.envPrefix}_MAX_CHUNKS`]: '3',
  };
  expect(readParseLimits(false, env)).toMatchObject({
    maxPages: 7,
    timeoutMs: 12,
    maxChunks: 3,
  });
  expect(readParseLimits(true, env).maxPages).toBe(200);
});

it.each(['0', '-1', '1.5', 'Infinity', 'nope', ''])(
  'rejects invalid env limits: %s',
  (value) => {
    expect(() =>
      readParseLimits(false, { [`${BRAND.envPrefix}_MAX_PAGES`]: value }),
    ).toThrow(/MAX_PAGES/);
  },
);

it('accepts exact ceilings and gives clear errors on overflow', () => {
  assertChunkLimit(2, 2);
  assertPageLimit(2, 2);
  expect(() => {
    assertChunkLimit(3, 2);
  }).toThrow(/chunk limit/);
  expect(() => {
    assertPageLimit(3, 2);
  }).toThrow(/page limit/);
});

it.each([0, -1, Infinity, NaN])(
  'rejects an invalid time budget %s',
  (timeoutMs) => {
    expect(() => new ParseBudget({ timeoutMs })).toThrow(/budget/);
  },
);

it('checks deadlines even while synchronous work prevents timers from running', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
  const budget = new ParseBudget({ timeoutMs: 5 });
  clock.mockReturnValue(15);
  expect(() => {
    budget.check();
  }).toThrow(/time budget/);
});

it('cancels pending waits and removes their abort listeners', async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const budget = new ParseBudget({ signal: controller.signal });
  const waiting = budget.wait(
    new Promise<never>(() => {
      /* Deliberately stalled work. */
    }),
  );
  controller.abort('private abort reason');
  await expect(waiting).rejects.toMatchObject({
    code: 'PARSE_FAILED',
    userMessage: 'Document parsing was cancelled.',
  });
  expect(remove).toHaveBeenCalledOnce();
});

it('times out stalled asynchronous work', async () => {
  const budget = new ParseBudget({ timeoutMs: 10 });
  await expect(
    budget.wait(
      new Promise<never>(() => {
        /* Deliberately stalled work. */
      }),
    ),
  ).rejects.toMatchObject({
    code: 'PARSE_FAILED',
    userMessage: expect.stringContaining('too long') as unknown,
  });
});

it('returns completed work and propagates work errors', async () => {
  const budget = new ParseBudget();
  expect(await budget.wait(Promise.resolve(42))).toBe(42);
  await expect(
    budget.wait(Promise.reject(new Error('broken'))),
  ).rejects.toThrow('broken');
});

it('re-arms a timeout callback that fires before the monotonic deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    const budget = new ParseBudget({ timeoutMs: 10 });
    const waiting = budget.wait(
      new Promise<never>(() => {
        /* Deliberately stalled work. */
      }),
    );
    const rejected = expect(waiting).rejects.toThrow(/time budget/);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(1);
    clock.mockReturnValue(10);
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
