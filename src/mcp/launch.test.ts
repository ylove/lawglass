import { expect, test, vi } from 'vitest';
import { makePipelineEnv } from '../../tests/support/pipeline-env.js';
import { createMcpLauncher } from './launch.js';

test('claims stdout before opening the runtime, serves, then shuts down', async () => {
  const env = await makePipelineEnv();
  const order: string[] = [];
  const protocol = {} as never;
  const launcher = createMcpLauncher({
    claim: () => {
      order.push('claim');
      return { protocol, restore: vi.fn() };
    },
    serve: (server, given) => {
      order.push('serve');
      expect(given).toBe(protocol);
      expect(server).toBeDefined();
      return Promise.resolve();
    },
  });
  await launcher(() => {
    order.push('open');
    return Promise.resolve(env.runtime);
  });
  expect(order).toEqual(['claim', 'open', 'serve']);
  await env.cleanup();
});

test('a failing runtime stops before anything is served', async () => {
  const serve = vi.fn();
  const launcher = createMcpLauncher({
    claim: () => ({ protocol: {} as never, restore: vi.fn() }),
    serve,
  });
  await expect(
    launcher(() => Promise.reject(new Error('no config'))),
  ).rejects.toThrow('no config');
  expect(serve).not.toHaveBeenCalled();
});
