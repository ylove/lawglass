import { expect, test } from 'vitest';
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
