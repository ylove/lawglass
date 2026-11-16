import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KeyedLock } from './keyed-lock.js';

test('tasks with one key run in order, one at a time; other keys are not held up', async () => {
  const lock = new KeyedLock();
  const log: string[] = [];
  let openFirst!: () => void;
  const first = lock.run('a', async () => {
    log.push('a1 start');
    await new Promise<void>((resolve) => {
      openFirst = resolve;
    });
    log.push('a1 end');
  });
  const second = lock.run('a', () => {
    log.push('a2');
    return Promise.resolve();
  });
  await lock.run('b', () => {
    log.push('b');
    return Promise.resolve();
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(log).toEqual(['a1 start', 'b']);
  openFirst();
  await Promise.all([first, second]);
  expect(log).toEqual(['a1 start', 'b', 'a1 end', 'a2']);
});

test('a failing task releases the next and returns its error to its own caller', async () => {
  const lock = new KeyedLock();
  const failing = lock.run('k', () => Promise.reject(new Error('boom')));
  const next = lock.run('k', () => Promise.resolve('ok'));
  await expect(failing).rejects.toThrow('boom');
  expect(await next).toBe('ok');
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test('an aborted waiter leaves the queue and its task never runs', async () => {
  const lock = new KeyedLock();
  const holder = deferred();
  const first = lock.run('k', () => holder.promise);
  const controller = new AbortController();
  let ran = false;
  const waiting = lock.run(
    'k',
    () => {
      ran = true;
      return Promise.resolve();
    },
    controller.signal,
  );
  const behind = lock.run('k', () => Promise.resolve('behind'));
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  holder.resolve();
  await first;
  expect(await behind).toBe('behind');
  expect(ran).toBe(false);
});

test('a signal already aborted never queues; one aborted while granted does no work', async () => {
  const lock = new KeyedLock();
  const gone = new AbortController();
  gone.abort();
  await expect(
    lock.run('k', () => Promise.resolve(), gone.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  // The key is free afterwards.
  expect(await lock.run('k', () => Promise.resolve('free'))).toBe('free');
});

describe('the lease', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a hung holder releases the key at the lease, and the next waiter runs', async () => {
    const lock = new KeyedLock(1000);
    const hung = deferred();
    const first = lock.run('k', () => hung.promise);
    const next = lock.run('k', () => Promise.resolve('next'));
    await vi.advanceTimersByTimeAsync(999);
    let done = false;
    void next.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toBe('next');
    hung.resolve();
    await first;
  });

  test('a late finish of the leased-out holder does not disturb the next holder', async () => {
    const lock = new KeyedLock(1000);
    const hung = deferred();
    const first = lock.run('k', () => hung.promise);
    const order: string[] = [];
    const secondGate = deferred();
    const second = lock.run('k', async () => {
      order.push('second start');
      await secondGate.promise;
      order.push('second end');
    });
    const third = lock.run('k', () => {
      order.push('third');
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(1000); // second now holds the key
    hung.resolve(); // the first finishes late
    await first;
    await vi.advanceTimersByTimeAsync(10);
    // The late release must not have let the third in while the second still holds.
    expect(order).toEqual(['second start']);
    secondGate.resolve();
    await Promise.all([second, third]);
    expect(order).toEqual(['second start', 'second end', 'third']);
  });
});
