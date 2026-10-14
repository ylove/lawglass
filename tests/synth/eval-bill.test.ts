import { expect, test } from 'vitest';
import { parseHtml } from '../../src/core/parse/index.js';
import { walkSections } from '../../src/core/model/index.js';
import { makeEvalBillHtml } from './eval-bill.js';

test('the eval bill parses to its ground-truth sections and struck text', () => {
  const sample = makeEvalBillHtml();
  const doc = parseHtml(sample.bytes, {
    sourceUrl: 'https://example.test/orchard.html',
    fetchedAt: '2026-10-13T00:00:00.000Z',
  });
  const parsedIds = [...walkSections(doc.sections)].map((s) => s.id);
  expect(parsedIds).toEqual(sample.groundTruth.sections.map((s) => s.id));
  const deleted = [...walkSections(doc.sections)]
    .flatMap((s) => s.spans)
    .filter((span) => span.status === 'deleted')
    .map((span) => span.text.trim());
  expect(deleted).toEqual(sample.groundTruth.deletedStrings);
});
