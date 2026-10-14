import { describe, expect, it } from 'vitest';
import { assertEventually } from './backend.contract.js';

describe('assertEventually', () => {
  it('is strict (single attempt) when the backend is not eventually consistent', async () => {
    let calls = 0;
    await expect(
      assertEventually(false, () => {
        calls++;
        return Promise.reject(new Error('stale'));
      }),
    ).rejects.toThrow('stale');
    expect(calls).toBe(1);
  });

  it('retries until the assertion holds when eventually consistent', async () => {
    let calls = 0;
    await assertEventually(
      true,
      () =>
        ++calls < 3 ? Promise.reject(new Error('stale')) : Promise.resolve(),
      1_000,
      5,
    );
    expect(calls).toBe(3);
  });

  it('gives up with the last failure after the bounded wait', async () => {
    await expect(
      assertEventually(
        true,
        () => Promise.reject(new Error('still stale')),
        30,
        5,
      ),
    ).rejects.toThrow('still stale');
  });
});
