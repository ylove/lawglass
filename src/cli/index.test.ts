import { expect, test, vi } from 'vitest';

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('./program.js', () => ({ createProgram: () => ({ parse }) }));

test('entrypoint parses process arguments', async () => {
  await import('./index.js');
  expect(parse).toHaveBeenCalledOnce();
});
