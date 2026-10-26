import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { FixtureIntegrity } from '../src/eval/fixture-integrity.js';

export const manifestSchema = z.strictObject({
  $comment: z.string().min(1),
  fixtures: z
    .array(
      FixtureIntegrity.extend({
        // Names become filenames, so reject separators and traversal components.
        name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        description: z.string().min(1),
        retrievedAt: z.iso.date(),
        jurisdiction: z.enum(['US Congress', 'Ohio', 'New York', 'New Jersey']),
        notes: z.string().min(1),
      })
        .strict()
        .refine(
          (fixture) =>
            !fixture.normalizedTextSha256 ||
            fixture.format === 'html' ||
            fixture.format === 'pdf',
          'Normalized text fingerprints require HTML or PDF',
        ),
    )
    .min(1)
    .refine(
      (fixtures) =>
        new Set(fixtures.map(({ name }) => name)).size === fixtures.length,
      'Fixture names must be unique',
    ),
});

export type FixtureManifest = z.infer<typeof manifestSchema>;
export type Fixture = FixtureManifest['fixtures'][number];

export const manifestPath = fileURLToPath(
  new URL('../fixtures/manifest.json', import.meta.url),
);
export const downloadsDirectory = fileURLToPath(
  new URL('../fixtures/downloads/', import.meta.url),
);

export function readManifest(path = manifestPath): FixtureManifest {
  return manifestSchema.parse(
    JSON.parse(readFileSync(path, 'utf8')) as unknown,
  );
}

export function fixtureFilename(fixture: Fixture): string {
  const extension = fixture.format === 'text' ? 'txt' : fixture.format;
  return `${fixture.name}.${extension}`;
}

export function verifyFixture(
  data: Uint8Array,
  fixture: Pick<Fixture, 'sha256' | 'bytes'>,
): {
  matches: boolean;
  sha256: string;
  bytes: number;
} {
  const sha256 = createHash('sha256').update(data).digest('hex');
  return {
    matches: sha256 === fixture.sha256 && data.byteLength === fixture.bytes,
    sha256,
    bytes: data.byteLength,
  };
}
