import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  downloadsDirectory,
  readManifest,
} from '../../scripts/fixture-manifest.js';
import { describeWithFixture, fixturePath } from './fixtures.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: vi.fn(),
}));
vi.mock('../../scripts/fixture-manifest.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../scripts/fixture-manifest.js')
  >()),
  readManifest: vi.fn(),
}));

const data = Buffer.from('synthetic legislation');
const fixture = {
  name: 'sample-bill',
  description: 'Synthetic bill',
  format: 'text' as const,
  url: 'https://example.com/sample',
  sha256: createHash('sha256').update(data).digest('hex'),
  bytes: data.length,
  retrievedAt: '2026-10-13',
  jurisdiction: 'Ohio' as const,
  notes: 'Generated test data',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readManifest).mockReturnValue({
    $comment: 'Synthetic test manifest',
    fixtures: [fixture],
  });
  vi.mocked(readFileSync).mockReturnValue(data);
});

test('returns the path for a verified fixture', () => {
  expect(fixturePath('sample-bill')).toBe(
    join(downloadsDirectory, 'sample-bill.txt'),
  );
});
test('returns undefined for unknown, missing, corrupted or incorrectly sized files', () => {
  expect(fixturePath('unknown')).toBeUndefined();
  vi.mocked(readFileSync).mockImplementationOnce(() => {
    throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
  });
  expect(fixturePath('sample-bill')).toBeUndefined();
  vi.mocked(readFileSync).mockReturnValueOnce(Buffer.from('corrupt'));
  expect(fixturePath('sample-bill')).toBeUndefined();
  vi.mocked(readManifest).mockReturnValueOnce({
    $comment: 'Test',
    fixtures: [{ ...fixture, bytes: data.length + 1 }],
  });
  expect(fixturePath('sample-bill')).toBeUndefined();
});
test('surfaces filesystem failures other than absence', () => {
  vi.mocked(readFileSync).mockImplementationOnce(() => {
    throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
  });
  expect(() => fixturePath('sample-bill')).toThrow('Permission denied');
});
test('registers a normal suite when the fixture is verified', () => {
  const fn = vi.fn();
  const suite = { run: vi.fn(), skip: vi.fn() };
  describeWithFixture('sample-bill', fn, suite);
  expect(suite.run).toHaveBeenCalledWith('sample-bill', fn);
  expect(suite.skip).not.toHaveBeenCalled();
});
test('registers a skipped suite with fetch instructions when absent', () => {
  const fn = vi.fn();
  const suite = { run: vi.fn(), skip: vi.fn() };
  vi.mocked(readFileSync).mockReturnValueOnce(Buffer.from('corrupt'));
  describeWithFixture('sample-bill', fn, suite);
  expect(suite.skip).toHaveBeenCalledWith(
    expect.stringContaining('npm run fixtures:fetch -- --only sample-bill'),
    fn,
  );
  expect(suite.run).not.toHaveBeenCalled();
});

test('asynchronous fixture suites run on a text match despite differing raw bytes, and skip changed text', async () => {
  const { fixturePathAsync, describeWithFixtureAsync } =
    await import('./fixtures.js');
  const { normalizedFixtureSha256 } =
    await import('../../src/eval/fixture-integrity.js');
  const html =
    '<article><h1>Section 1. Notices.</h1><p>Each steward shall send a notice.</p></article>';
  const entry = {
    ...fixture,
    format: 'html' as const,
    normalizedTextSha256: await normalizedFixtureSha256(Buffer.from(html), {
      format: 'html',
      url: fixture.url,
    }),
  };
  vi.mocked(readManifest).mockReturnValue({
    $comment: 'Test',
    fixtures: [entry],
  });
  vi.mocked(readFileSync).mockReturnValue(
    Buffer.from(`<script src="random-12345.js"></script>${html}`),
  );
  const suite = { run: vi.fn(), skip: vi.fn() };
  const fn = vi.fn();
  expect(await fixturePathAsync(fixture.name)).toBe(
    join(downloadsDirectory, 'sample-bill.html'),
  );
  await describeWithFixtureAsync(fixture.name, fn, suite);
  expect(suite.run).toHaveBeenCalledWith(fixture.name, fn);
  vi.mocked(readFileSync).mockReturnValue(
    Buffer.from(html.replace('steward', 'farmer')),
  );
  await describeWithFixtureAsync(fixture.name, fn, suite);
  expect(suite.skip).toHaveBeenCalledWith(
    expect.stringContaining('fixture absent or invalid'),
    fn,
  );
});
