import { afterEach, expect, test, vi } from 'vitest';

const { parseAsync } = vi.hoisted(() => ({ parseAsync: vi.fn() }));
vi.mock('./program.js', () => ({ createProgram: () => ({ parseAsync }) }));
const previousExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.resetModules();
});

test('entrypoint awaits process arguments', async () => {
  parseAsync.mockResolvedValue(undefined);
  await import('./index.js');
  expect(parseAsync).toHaveBeenCalledOnce();
});

test.each([
  [
    'MISSING_KEY',
    'An API key is missing. Run `init` or set the environment variable.',
  ],
  ['plain', 'The command could not be completed.'],
])(
  'entrypoint reports safe errors and exits unsuccessfully',
  async (kind, message) => {
    // Build the error from the module graph the entrypoint will import, since resetModules
    // gives it a fresh AppError class.
    const { AppError } = await import('../core/model/index.js');
    parseAsync.mockRejectedValue(
      kind === 'plain'
        ? new Error('synthetic-key-do-not-display')
        : new AppError('MISSING_KEY'),
    );
    const output = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    await import('./index.js');
    expect(output).toHaveBeenCalledExactlyOnceWith(message);
    expect(process.exitCode).toBe(1);
  },
);

test('entrypoint strips terminal escapes and bidi controls from user messages', async () => {
  const { AppError } = await import('../core/model/index.js');
  parseAsync.mockRejectedValue(
    new AppError('INVALID_INPUT', 'internal', {
      userMessage:
        'Bad \u001b]8;;https://evil.example/\u0007link\u001b]8;;\u0007 \u202egpj\u200b',
    }),
  );
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await import('./index.js');
  expect(output).toHaveBeenCalledExactlyOnceWith('Bad link gpj');
});
