import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cli: vi.fn<(...args: string[]) => Promise<string>>(),
  serve: vi.fn(),
  dispose: vi.fn(),
  create: vi.fn(),
}));
vi.mock('./packed-app.js', () => ({
  SAMPLE_LABEL: 'Synthetic amendment bill',
  createPackedApp: mocks.create,
}));
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.create.mockResolvedValue({
    cli: mocks.cli,
    serve: mocks.serve,
    dispose: mocks.dispose,
  });
  mocks.serve.mockResolvedValue({ url: 'http://localhost:1' });
  mocks.cli
    .mockResolvedValueOnce("This document doesn't say who sponsored it.")
    .mockResolvedValueOnce('Section 2 [S:sec-2] p. 2, lines 4–5')
    .mockResolvedValueOnce('Synthetic amendment bill | pdf');
});

it('exercises sponsors, freeform ask, list and serving before disposal', async () => {
  await import('./package-smoke.js');
  expect(mocks.cli.mock.calls.map((call) => call[0])).toEqual([
    'ask',
    'ask',
    'list',
  ]);
  expect(mocks.serve).toHaveBeenCalledOnce();
  expect(mocks.dispose).toHaveBeenCalledOnce();
});

it('disposes the install when an answer assertion fails', async () => {
  mocks.cli.mockReset().mockResolvedValue('unexpected answer');
  await expect(import('./package-smoke.js')).rejects.toThrow();
  expect(mocks.serve).not.toHaveBeenCalled();
  expect(mocks.dispose).toHaveBeenCalledOnce();
});

it('disposes the install when server startup fails', async () => {
  mocks.serve.mockRejectedValue(new Error('cannot start'));
  await expect(import('./package-smoke.js')).rejects.toThrow('cannot start');
  expect(mocks.dispose).toHaveBeenCalledOnce();
});
