/** Fixture fingerprints share the parsers' text extraction, ignoring transport-only changes. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sectionText, walkSections } from '../core/model/index.js';
import { parseHtml } from '../core/parse/html.js';
import { parsePdf } from '../core/parse/pdf.js';

export const FixtureIntegrity = z.object({
  format: z.enum(['xml', 'pdf', 'html', 'text']),
  url: z.url({ protocol: /^https?$/ }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  normalizedTextSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type FixtureIntegrity = z.infer<typeof FixtureIntegrity>;

export async function normalizedFixtureSha256(
  data: Uint8Array,
  fixture: Pick<FixtureIntegrity, 'format' | 'url'>,
): Promise<string> {
  const context = {
    sourceUrl: fixture.url,
    fetchedAt: '1970-01-01T00:00:00.000Z',
  };
  if (fixture.format !== 'html' && fixture.format !== 'pdf')
    throw new Error('Normalized text fingerprints require HTML or PDF.');
  const doc =
    fixture.format === 'html'
      ? parseHtml(data, context)
      : await parsePdf(data, context);
  const text = [...walkSections(doc.sections)]
    .map(
      (section) =>
        `${section.num ?? ''} ${section.heading ?? ''} ${sectionText(section, { includeDeleted: true })}`,
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text)
    throw new Error('Cannot fingerprint a fixture with no extracted text.');
  return createHash('sha256').update(text).digest('hex');
}

export async function verifyFixtureIntegrity(
  data: Uint8Array,
  fixture: FixtureIntegrity,
): Promise<{ matches: boolean; sha256: string; bytes: number }> {
  const sha256 = fixture.normalizedTextSha256
    ? await normalizedFixtureSha256(data, fixture)
    : createHash('sha256').update(data).digest('hex');
  return {
    // Content-pinned sources may change transport bytes and size on every request.
    matches: fixture.normalizedTextSha256
      ? sha256 === fixture.normalizedTextSha256
      : sha256 === fixture.sha256 && data.byteLength === fixture.bytes,
    sha256,
    bytes: data.byteLength,
  };
}
