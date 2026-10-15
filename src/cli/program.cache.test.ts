import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  clearCache,
  defaultCacheDir,
  writeCache,
} from '../core/fetch/index.js';
import { createProgram } from './program.js';
import type { CliRuntime } from './runtime.js';

let configDir: string;
let output: string;
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cli-cache-'));
  output = '';
});
afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

const run = (...args: string[]): Promise<unknown> => {
  const cacheDir = defaultCacheDir(configDir);
  // Only the cache command's own dependency is needed; the rest of the runtime stays unbuilt.
  const runtime = {
    clearFetchCache: () => clearCache(cacheDir),
  } as unknown as CliRuntime;
  return createProgram({
    runtime: () => Promise.resolve(runtime),
    write: (text) => {
      output += text;
    },
  }).parseAsync(args, { from: 'user' });
};

const meta = (url: string) => ({
  url,
  finalUrl: url,
  contentType: 'text/plain',
  fetchedAt: '2026-10-13T00:00:00.000Z',
});

test('cache clear deletes cached downloads, reports what it freed and keeps answers', async () => {
  const cacheDir = defaultCacheDir(configDir);
  const bytes = (text: string) => new TextEncoder().encode(text);
  await writeCache(bytes('one'), meta('https://example.gov/1'), cacheDir);
  await writeCache(bytes('two'), meta('https://example.gov/2'), cacheDir);
  await mkdir(join(cacheDir, 'answers'));
  await writeFile(join(cacheDir, 'answers', 'a.json'), '{}');
  await run('cache', 'clear');
  expect(output).toMatch(
    /^Cleared 2 cached downloads \(\d+(\.\d)? [KM]?B\)\.\n$/,
  );
  expect(await readdir(cacheDir)).toEqual(['answers']);
  expect(await readFile(join(cacheDir, 'answers', 'a.json'), 'utf8')).toBe(
    '{}',
  );
});

test('cache clear on an empty or missing cache says so without failing', async () => {
  await run('cache', 'clear');
  expect(output).toBe('Cleared 0 cached downloads (0 B).\n');
});

test('cache clear uses the singular for one download', async () => {
  await writeCache(
    new TextEncoder().encode('one'),
    meta('https://example.gov/1'),
    defaultCacheDir(configDir),
  );
  await run('cache', 'clear');
  expect(output).toContain('Cleared 1 cached download (');
});
