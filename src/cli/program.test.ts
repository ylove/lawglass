import { afterEach, expect, test, vi } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { BRAND } from '../core/brand.js';
import { createProgram } from './program.js';

const previousExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
});

test('--help lists every command and the default URL argument', () => {
  let output = '';
  const program = createProgram()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        output += text;
      },
    });
  expect(() => program.parse(['--help'], { from: 'user' })).toThrow(
    expect.objectContaining({ code: 'commander.helpDisplayed', exitCode: 0 }),
  );
  expect(output).toContain(`Usage: ${BRAND.name}`);
  expect(output).toContain('<url>');
  for (const command of [
    'init',
    'ingest',
    'ask',
    'list',
    'remove',
    'serve',
    'eval',
  ]) {
    expect(output).toMatch(new RegExp(`\\n  ${command}\\b`));
  }
});

test('--version prints the package version', () => {
  let output = '';
  const program = createProgram()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        output += text;
      },
    });
  expect(() => program.parse(['--version'], { from: 'user' })).toThrow(
    expect.objectContaining({ code: 'commander.version', exitCode: 0 }),
  );
  expect(output).toBe(`${packageJson.version}\n`);
});

test('init awaits configuration without printing returned credentials', async () => {
  const init = vi
    .fn()
    .mockResolvedValue({ anthropicApiKey: 'synthetic-key-do-not-display' });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await createProgram({ init }).parseAsync(['init'], { from: 'user' });
  expect(init).toHaveBeenCalledOnce();
  expect(output).toHaveBeenCalledExactlyOnceWith(
    'Configuration saved with private file permissions.',
  );
});

test('init passes --force through', async () => {
  const init = vi.fn().mockResolvedValue({});
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await createProgram({ init }).parseAsync(['init', '--force'], {
    from: 'user',
  });
  expect(init).toHaveBeenCalledWith({ force: true });
});

test.each([
  { command: 'init', option: '--force' },
  { command: 'ingest', option: '--name' },
  { command: 'ask', option: '--chip' },
  { command: 'serve', option: '--port' },
  { command: 'serve', option: '--public' },
  { command: 'eval', option: '--fixture' },
  { command: 'eval', option: '--mode' },
  { command: 'eval', option: '--backend' },
  { command: 'eval', option: '--answers' },
])('$command documents $option', ({ command, option }) => {
  const registered = createProgram().commands.find(
    (entry) => entry.name() === command,
  );
  expect(registered?.helpInformation()).toContain(option);
});
