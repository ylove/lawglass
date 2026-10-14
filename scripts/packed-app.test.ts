import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envVar } from '../src/core/brand.js';
import {
  assertPackageFiles,
  assertPackageMap,
  isolatedEnvironment,
  runCommand,
  startPackedServer,
  stopChild,
} from './packed-app.js';

const required = ['package/dist/cli.js', 'package/dist/web/index.html'];

describe('packed archive guard', () => {
  it('accepts runtime files and production source maps', () => {
    expect(() => {
      assertPackageFiles([
        ...required,
        'package/dist/server.js.map',
        'package/README.md',
      ]);
    }).not.toThrow();
  });
  it.each([
    'tests/sample.ts',
    'fixtures/downloads/bill.pdf',
    'dist/core.test.js',
    'dist/core.test.js.map',
    '.env',
    '.env.example',
    'dist/.env.local',
    'eval/goldens/sample.json',
    'src/eval/golden/sample.json',
    'dist/tests/source.js.map',
  ])('rejects %s', (path) => {
    expect(() => {
      assertPackageFiles([...required, `package/${path}`]);
    }).toThrow(/development or secret/);
  });
  it.each(required)('requires %s', (path) => {
    expect(() => {
      assertPackageFiles(required.filter((entry) => entry !== path));
    }).toThrow(/missing/);
  });
});

it('isolates HOME, provider, credentials and config overrides without mutating the environment', () => {
  const source = {
    HOME: '/real',
    PATH: '/bin',
    [envVar('LLM_PROVIDER')]: 'anthropic',
    [envVar('CONFIG_DIR')]: '/real/config',
    [envVar('OPENAI_BASE_URL')]: 'https://example.com',
    ANTHROPIC_API_KEY: 'private',
    PINECONE_API_KEY: 'private',
    OPENAI_API_KEY: 'private',
    GOOGLE_API_KEY: 'private',
    NODE_OPTIONS: '--import=/real/hook.js',
    NODE_PATH: '/real/modules',
  };
  const env = isolatedEnvironment(source, '/isolated');
  expect(env.HOME).toBe('/isolated');
  expect(env[envVar('LLM_PROVIDER')]).toBe('mock');
  expect(env.PATH).toBe('/bin');
  for (const key of [
    envVar('CONFIG_DIR'),
    envVar('OPENAI_BASE_URL'),
    'ANTHROPIC_API_KEY',
    'PINECONE_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'NODE_OPTIONS',
    'NODE_PATH',
  ])
    expect(env[key]).toBeUndefined();
  expect(source.HOME).toBe('/real');
  expect(env.npm_config_cache).toContain('.cache/npm');
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function temporaryScript(code: string) {
  const dir = await mkdtemp(join(tmpdir(), 'packed-harness-test-'));
  dirs.push(dir);
  await mkdir(join(dir, 'home'));
  const script = join(dir, 'script.mjs');
  await writeFile(script, code);
  return {
    dir,
    script,
    env: isolatedEnvironment(process.env, join(dir, 'home')),
  };
}

it('reports command output when an installed command fails', async () => {
  const { dir, script, env } = await temporaryScript(
    "console.error('broken command'); process.exit(2);",
  );
  await expect(
    runCommand(process.execPath, [script], dir, env),
  ).rejects.toThrow(/broken command/);
});

it('starts a loopback server on an OS-assigned port and validates its health', async () => {
  const { dir, script, env } = await temporaryScript(`
    import { createServer } from 'node:http';
    const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, version: 'test' })); });
    server.listen(0, '127.0.0.1', () => console.log('Serving at http://127.0.0.1:' + server.address().port));
    process.on('SIGTERM', () => { server.close(); });
  `);
  const server = await startPackedServer(script, dir, env);
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  await server.stop();
  await server.stop();
});

it('rejects an early exit with startup diagnostics', async () => {
  const { dir, script, env } = await temporaryScript(
    "console.error('startup failed'); process.exit(1);",
  );
  await expect(startPackedServer(script, dir, env)).rejects.toThrow(
    /startup failed/,
  );
});

it('cleans up a server whose health endpoint returns HTML', async () => {
  const { dir, script, env } = await temporaryScript(`
    import { createServer } from 'node:http';
    const server = createServer((req, res) => res.end('<html>fallback</html>'));
    server.listen(0, '127.0.0.1', () => console.log('Serving at http://127.0.0.1:' + server.address().port));
  `);
  await expect(startPackedServer(script, dir, env)).rejects.toThrow();
});

it('reaps a running process', async () => {
  const { dir, script, env } = await temporaryScript(
    'setInterval(() => {}, 1000);',
  );
  const child = spawn(process.execPath, [script], {
    cwd: dir,
    env,
    stdio: 'ignore',
  });
  await stopChild(child);
  expect(child.signalCode).toBe('SIGTERM');
  await stopChild(child);
});

it('rejects test sources embedded in otherwise innocuous production maps', () => {
  expect(() => {
    assertPackageMap({ sources: ['../src/core/model/index.ts'] }, 'cli.js.map');
  }).not.toThrow();
  for (const source of ['../tests/synth/pdf.ts', '../src/core/foo.test.ts']) {
    expect(() => {
      assertPackageMap({ sources: [source] }, 'cli.js.map');
    }).toThrow('Test source');
  }
  expect(() => {
    assertPackageMap({ sources: 'invalid' }, 'cli.js.map');
  }).toThrow();
});
