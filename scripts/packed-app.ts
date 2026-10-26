/** Runs the published package in isolation; never imports application runtime code. */
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { BRAND, envVar } from '../src/core/brand.js';
import { Health } from '../src/core/model/index.js';
import { makeAmendingBillPdf } from '../tests/synth/index.js';

const execute = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');
export const SAMPLE_LABEL = 'Synthetic amendment bill';

/** Check actual archive entries, rather than trusting package.json's files allowlist. */
export function assertPackageFiles(paths: readonly string[]): void {
  const files = paths.map((path) => path.replace(/^package\//, ''));
  for (const required of ['dist/cli.js', 'dist/web/index.html']) {
    assert(files.includes(required), `Tarball is missing ${required}`);
  }
  // An allowlist, so widening package.json#files can't quietly ship scripts, e2e or src. Source
  // maps stay out too: they would add ~15 MB (bundled dependency sources) to every npx install.
  const allowed = (path: string): boolean =>
    /^(package\.json|README\.md|LICENSE)$/.test(path) ||
    (path.startsWith('dist/') && !path.endsWith('.map'));
  const forbidden = files.filter(
    (path) =>
      !allowed(path) ||
      /(^|\/)(tests|fixtures)(\/|$)|\.test\.|(^|\/)\.env[^/]*|(^|\/)eval\/goldens?(\/|$)/i.test(
        path,
      ),
  );
  assert.deepEqual(
    forbidden,
    [],
    'Tarball contains development or secret files',
  );
}

/** Production maps are allowed, but they must not embed test sources. */
export function assertPackageMap(content: unknown, path: string): void {
  const map = z.object({ sources: z.array(z.string()) }).parse(content);
  assert(
    !map.sources.some((source) => /(^|\/)tests\/|\.test\./.test(source)),
    `Test source in ${path}`,
  );
}

export function isolatedEnvironment(
  source: NodeJS.ProcessEnv,
  home: string,
): NodeJS.ProcessEnv {
  // A developer's real credentials, alternate config path and Node hooks must not leak in.
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !key.startsWith(`${BRAND.envPrefix}_`) &&
        ![
          'PINECONE_API_KEY',
          'ANTHROPIC_API_KEY',
          'OPENAI_API_KEY',
          'GOOGLE_API_KEY',
          'NODE_OPTIONS',
          'NODE_PATH',
        ].includes(key),
    ),
  );
  return {
    ...env,
    HOME: home,
    [envVar('LLM_PROVIDER')]: 'mock',
    npm_config_cache: join(repoRoot, '.cache/npm'),
    npm_config_update_notifier: 'false',
  };
}

export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const result = await execute(command, [...args], {
      cwd,
      env,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `Command failed: ${command} ${args.join(' ')}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
      { cause: error },
    );
  }
}

export interface PackedServer {
  url: string;
  stop(): Promise<void>;
}

/** Always reap the child, including when startup fails or graceful shutdown stalls. */
export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      child.kill('SIGKILL');
    }, 5_000);
    child.once('close', () => {
      clearTimeout(force);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

export interface PackedServeOptions {
  privateMode?: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function startPackedServer(
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  port = 0,
  options: PackedServeOptions = {},
): Promise<PackedServer> {
  // Port 0 is assigned by the OS, avoiding a free-port probe/bind race. A caller that restarts
  // a server (the server-down e2e) passes the old port back so the open page can reach it again.
  const child = spawn(
    process.execPath,
    [
      binary,
      'serve',
      '--backend',
      'local',
      '--port',
      String(port),
      '--no-open',
      ...(options.privateMode ? ['--private', '--trust-proxy', '1'] : []),
    ],
    {
      cwd,
      env: { ...env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let spawnError: Error | undefined;
  child.on('error', (error) => {
    spawnError = error;
  });
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    output += data.toString();
  });
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Packed server exited during startup:\n${output.replace(/([?&]k=)[^&\s]+/g, '$1[redacted]')}`,
        );
      }
      const url =
        /Serving at (http:\/\/\S+)/.exec(output)?.[1] ??
        /Private mode on (http:\/\/\S+)\. Share/.exec(output)?.[1];
      if (url) {
        const invite = new URL(url);
        if (options.privateMode)
          invite.searchParams.set(
            'k',
            options.env?.[envVar('ACCESS_KEY')] ?? '',
          );
        const exchange = await fetch(invite, {
          redirect: 'manual',
          signal: AbortSignal.timeout(2_000),
        });
        assert.equal(exchange.status, 302);
        const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
        assert(cookie, 'Launch link did not establish a session');
        await exchange.arrayBuffer();
        const response = await fetch(new URL('/api/health', url), {
          headers: { cookie },
          signal: AbortSignal.timeout(2_000),
        });
        assert.equal(response.status, 200);
        Health.parse(await response.json());
        return { url, stop: () => stopChild(child) };
      }
      await delay(50);
    }
    throw new Error(
      `Packed server did not become healthy:\n${output.replace(/([?&]k=)[^&\s]+/g, '$1[redacted]')}`,
    );
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

export interface PackedApp {
  home: string;
  cli(...args: string[]): Promise<string>;
  serve(port?: number, options?: PackedServeOptions): Promise<PackedServer>;
  dispose(): Promise<void>;
}

export async function createPackedApp(): Promise<PackedApp> {
  const root = await mkdtemp(join(tmpdir(), 'packed-app-'));
  const home = join(root, 'home');
  const installDir = join(root, 'install');
  const env = {
    ...isolatedEnvironment(process.env, home),
    // The mock costs nothing, but background work (pictures, examples) still waits for headroom
    // under the default 30 calls a minute. One server serves every e2e spec, so lift the ceiling
    // rather than let a spec's result depend on how many calls the earlier ones made.
    [envVar('MAX_CALLS_PER_MINUTE')]: '600',
  };
  const servers: PackedServer[] = [];
  const dispose = async () => {
    try {
      await Promise.all(servers.map((server) => server.stop()));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(installDir);
    console.log('Building and packing the application…');
    await runCommand('npm', ['run', 'build'], repoRoot, env);
    const packed = await runCommand(
      'npm',
      ['pack', '--json', '--pack-destination', root],
      repoRoot,
      env,
    );
    const [manifest] = z
      .array(z.object({ filename: z.string() }))
      .length(1)
      .parse(JSON.parse(packed));
    assert(manifest);
    const tarball = join(root, manifest.filename);
    const entries = (await runCommand('tar', ['-tzf', tarball], repoRoot, env))
      .trim()
      .split('\n');
    assertPackageFiles(entries);
    // Maps may embed tests even when their own filename looks harmless.
    for (const path of entries.filter((entry) => entry.endsWith('.map'))) {
      const content = await runCommand(
        'tar',
        ['-xOf', tarball, path],
        repoRoot,
        env,
      );
      assertPackageMap(JSON.parse(content), path);
    }
    await writeFile(
      join(installDir, 'package.json'),
      '{"private":true,"type":"module"}\n',
    );
    console.log('Installing the tarball in a clean directory…');
    await runCommand(
      'npm',
      ['install', '--no-audit', '--no-fund', tarball],
      installDir,
      env,
    );
    const configDir = join(home, BRAND.configDirName);
    // CI fills this cache with models:fetch; local runs reuse already downloaded models.
    const modelSource = join(
      process.env[envVar('CONFIG_DIR')] ?? join(homedir(), BRAND.configDirName),
      'models',
    );
    await mkdir(configDir, { mode: 0o700 });
    await cp(modelSource, join(configDir, 'models'), { recursive: true });
    const binary = join(installDir, 'node_modules', '.bin', BRAND.name);
    const cli = (...args: string[]) =>
      runCommand(
        process.execPath,
        [binary, ...args, '--backend', 'local'],
        installDir,
        env,
      );
    assert.match(await cli('init', '--non-interactive'), /Configuration saved/);
    const saved: unknown = JSON.parse(
      await readFile(join(configDir, 'config.json'), 'utf8'),
    );
    assert.deepEqual(saved, { llmProvider: 'mock', backend: 'local' });
    const sample = await makeAmendingBillPdf();
    const pdfPath = join(root, 'synthetic.pdf');
    await writeFile(pdfPath, sample.bytes);
    const ingested = await cli('ingest', pdfPath, '--name', SAMPLE_LABEL);
    assert.match(ingested, /Format: pdf/);
    assert.match(
      ingested,
      /Amendment spans: [1-9]\d* deleted, [1-9]\d* inserted/,
    );
    assert.match(ingested, /Embedding tokens: [1-9]\d*/);
    return {
      home,
      cli,
      async serve(port, options) {
        const server = await startPackedServer(
          binary,
          installDir,
          env,
          port,
          options,
        );
        servers.push(server);
        return server;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
