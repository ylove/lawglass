import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  fixtureFilename,
  manifestSchema,
  readManifest,
  verifyFixture,
} from './fixture-manifest.js';

const manifest = readManifest();
const fixture = manifest.fixtures[0];
if (!fixture) throw new Error('The manifest needs at least one fixture');

test('the committed manifest contains twelve validated public sources', () => {
  expect(manifest.fixtures).toHaveLength(12);
  expect(manifest.fixtures.map(({ name }) => name)).toEqual([
    'us-s202-119-is',
    'us-s202-119-is-html',
    'us-s3235-118-rs',
    'oh-sb113-136-in',
    'oh-sb203-133-in',
    'oh-hb62-135-in',
    'us-hr5009-118-enr',
    'oh-columbus-issue8-2026',
    'ny-s1234-2025-introduced',
    'ny-s8102-2025-introduced',
    'nj-s1446-2024-r2',
    'ny-s1234-2025-assembly',
  ]);
  expect(
    manifest.fixtures.every(({ retrievedAt }) =>
      [
        '2026-10-13',
        '2026-10-14',
        '2026-10-21',
        '2026-10-25',
        '2026-10-26',
      ].includes(retrievedAt),
    ),
  ).toBe(true);
});

test.each([
  { name: '../escape' },
  { name: '/absolute' },
  { name: 'nested/file' },
  { format: 'exe' },
  { url: 'not a URL' },
  { url: 'file:///tmp/document' },
  { sha256: 'bad' },
  { sha256: 'A'.repeat(64) },
  { bytes: -1 },
  { bytes: 1.5 },
  { retrievedAt: '2026-02-30' },
  { jurisdiction: 'unknown' },
  { description: '' },
  { notes: '' },
  { unexpected: true },
])('rejects invalid manifest fields: %j', (fields) => {
  expect(
    manifestSchema.safeParse({
      ...manifest,
      fixtures: [{ ...fixture, ...fields }],
    }).success,
  ).toBe(false);
});

test('rejects missing fields, empty fixture lists and duplicate names', () => {
  expect(manifestSchema.safeParse({ fixtures: [{}] }).success).toBe(false);
  expect(manifestSchema.safeParse({ ...manifest, fixtures: [] }).success).toBe(
    false,
  );
  expect(
    manifestSchema.safeParse({ ...manifest, fixtures: [fixture, fixture] })
      .success,
  ).toBe(false);
});

test.each(['xml', 'pdf', 'html', 'text'] as const)(
  'maps %s to a local extension',
  (format) => {
    expect(fixtureFilename({ ...fixture, format })).toBe(
      `${fixture.name}.${format === 'text' ? 'txt' : format}`,
    );
  },
);

test('verification requires both SHA-256 and byte size to match', () => {
  const data = Buffer.from('synthetic legislation');
  const sha256 = createHash('sha256').update(data).digest('hex');
  expect(verifyFixture(data, { sha256, bytes: data.length })).toEqual({
    matches: true,
    sha256,
    bytes: data.length,
  });
  expect(verifyFixture(data, { sha256, bytes: data.length + 1 }).matches).toBe(
    false,
  );
  expect(
    verifyFixture(data, { sha256: '0'.repeat(64), bytes: data.length }).matches,
  ).toBe(false);
});
