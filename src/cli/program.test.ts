import { afterEach, expect, test, vi } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { BRAND, envVar } from '../core/brand.js';
import { createProgram } from './program.js';

const previousExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('--help lists every command and the default URL or path argument', () => {
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
  expect(output).toContain('<url-or-path>');
  for (const command of [
    'init',
    'ingest',
    'ask',
    'list',
    'remove',
    'cache',
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

test('init passes non-interactive settings and backend through', async () => {
  const init = vi.fn().mockResolvedValue({});
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await createProgram({ init }).parseAsync(
    ['init', '--non-interactive', '--backend', 'local'],
    { from: 'user' },
  );
  expect(init).toHaveBeenCalledWith({
    force: false,
    nonInteractive: true,
    backend: 'local',
  });
});

test('serve passes private mode and trusted hops without exposing the key', async () => {
  vi.stubEnv(envVar('ACCESS_KEY'), 'x'.repeat(32));
  const runtime = vi.fn().mockResolvedValue({});
  const serve = vi.fn().mockResolvedValue(undefined);
  await createProgram({ runtime, serve }).parseAsync(
    [
      'serve',
      '--private',
      '--trust-proxy',
      '1',
      '--host',
      '0.0.0.0',
      '--port',
      '8080',
      '--no-open',
    ],
    { from: 'user' },
  );
  expect(runtime).toHaveBeenCalledWith({
    backend: undefined,
    needsLlm: true,
    hostedMode: true,
  });
  expect(serve).toHaveBeenCalledWith(
    {},
    {
      publicMode: false,
      privateMode: true,
      trustProxyHops: 1,
      host: '0.0.0.0',
      port: 8080,
      noOpen: true,
    },
  );
});
test.each([
  ['--private', '--public'],
  ['--trust-proxy', '-1'],
  ['--trust-proxy', '1.5'],
  ['--trust-proxy', 'oops'],
  ['--trust-proxy', ''],
  ['--trust-proxy', '9007199254740992'],
])('serve rejects invalid mode or proxy arguments: %s', async (...flags) => {
  const runtime = vi.fn();
  await expect(
    createProgram({ runtime }).parseAsync(['serve', ...flags], {
      from: 'user',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(runtime).not.toHaveBeenCalled();
});
test('serve refuses a missing private access key before opening the runtime', async () => {
  vi.stubEnv(envVar('ACCESS_KEY'), '');
  const runtime = vi.fn();
  await expect(
    createProgram({ runtime }).parseAsync(['serve', '--private'], {
      from: 'user',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(runtime).not.toHaveBeenCalled();
});
