import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { expect, test } from 'vitest';
import { bracketHtml, bracketPdf } from '../../tests/synth/brackets.js';
import {
  normalizedFixtureSha256,
  verifyFixtureIntegrity,
  type FixtureIntegrity,
} from './fixture-integrity.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const fixture: FixtureIntegrity = {
  format: 'html',
  url: 'https://example.gov/bill.html',
  sha256: '0'.repeat(64),
  bytes: 1,
};

test('content pins ignore HTML cache-busters and collapsed whitespace, but reject changed bill words', async () => {
  const html = bracketHtml();
  const bytes = encode(html);
  const pinned = {
    ...fixture,
    normalizedTextSha256: await normalizedFixtureSha256(bytes, fixture),
  };
  const rerendered = encode(
    `<head><script src="/cache.js?v=12345"></script></head><nav>Cache 98765</nav>${html.replace('notice ', 'notice   ')}`,
  );
  expect((await verifyFixtureIntegrity(rerendered, pinned)).matches).toBe(true);
  expect(
    (
      await verifyFixtureIntegrity(
        encode(html.replace('Notices.', 'Permits.')),
        pinned,
      )
    ).matches,
  ).toBe(false);
  expect(
    (
      await verifyFixtureIntegrity(
        encode(html.replace('<b>old</b>', '<b>former</b>')),
        pinned,
      )
    ).matches,
  ).toBe(false);
});

test('PDF metadata changes do not change the text pin, but different bill text does', async () => {
  const bytes = await bracketPdf();
  const pdfFixture = {
    ...fixture,
    format: 'pdf' as const,
    url: 'https://legislation.nysenate.gov/pdf/bills/2025/S4321',
  };
  const pinned = {
    ...pdfFixture,
    normalizedTextSha256: await normalizedFixtureSha256(bytes, pdfFixture),
  };
  const doc = await PDFDocument.load(bytes);
  doc.setModificationDate(new Date('2026-10-26T00:00:00Z'));
  doc.setProducer('Different producer metadata');
  const rerendered = await doc.save();
  expect(createHash('sha256').update(rerendered).digest('hex')).not.toBe(
    createHash('sha256').update(bytes).digest('hex'),
  );
  expect((await verifyFixtureIntegrity(rerendered, pinned)).matches).toBe(true);
  expect(
    (await verifyFixtureIntegrity(await bracketPdf(false), pinned)).matches,
  ).toBe(false);
});

test('entries without a content pin still require exact raw bytes and size', async () => {
  const bytes = encode('synthetic legislation');
  const pinned = {
    ...fixture,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
  expect((await verifyFixtureIntegrity(bytes, pinned)).matches).toBe(true);
  expect(
    (
      await verifyFixtureIntegrity(bytes, {
        ...pinned,
        bytes: bytes.length + 1,
      })
    ).matches,
  ).toBe(false);
  expect(
    (await verifyFixtureIntegrity(encode('changed legislation'), pinned))
      .matches,
  ).toBe(false);
});

test('rejects unsupported text extraction formats', async () => {
  await expect(
    normalizedFixtureSha256(encode('text'), { ...fixture, format: 'text' }),
  ).rejects.toThrow('HTML or PDF');
});
