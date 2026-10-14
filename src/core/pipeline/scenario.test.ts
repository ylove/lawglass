import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../model/index.js';
import { runScenario, type RunScenarioDeps } from './scenario.js';

describe('runScenario limits hook', () => {
  it('refuses a bad subject before the limiter is consulted', async () => {
    const limits = vi.fn();
    await expect(
      runScenario('a'.repeat(64), 'unfair', {
        limits,
      } as unknown as RunScenarioDeps),
    ).rejects.toBeInstanceOf(AppError);
    expect(limits).not.toHaveBeenCalled();
  });

  it('a limiter that refuses stops the cache-miss computation and surfaces its error', async () => {
    const deps = {
      provider: { id: 'p', model: 'm' },
      registry: {
        getDocument: () => Promise.resolve({}),
        configDir: '/nonexistent-scenario-test',
        isRegistered: () => Promise.resolve(true),
      },
      limits: () => Promise.reject(new AppError('RATE_LIMITED')),
      backend: {
        hasDocument: () => {
          throw new Error('must not run');
        },
      },
    } as unknown as RunScenarioDeps;
    await expect(
      runScenario('a'.repeat(64), 'a renter', deps),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});
