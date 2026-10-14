import { expect, test } from 'vitest';
import type { IngestResult } from '../core/pipeline/index.js';
import { formatIngest, formatList } from './format.js';

function result(refs: number, label = 'bill'): IngestResult {
  return {
    doc: { docId: 'a'.repeat(64), label } as IngestResult['doc'],
    stats: {
      format: 'xml',
      sectionCount: 1,
      chunkCountsByType: {
        operative: 1,
      } as IngestResult['stats']['chunkCountsByType'],
      insertedSpanCount: 0,
      deletedSpanCount: 0,
      externalRefCount: refs,
      embedTokens: 5,
      reused: false,
    },
    usage: { embedTokens: 5, llmInputTokens: 0, llmOutputTokens: 0 },
    normalized: {
      metadata: {
        title: '\u001b[31mTitle',
        billNumber: null,
        jurisdiction: null,
        session: null,
        version: null,
        sponsors: null,
        source: 'none',
      },
      externalRefs: Array.from({ length: refs }, (_, i) => ({
        text: `t${String(i)}`,
        citation: `R.C. ${String(i)}`,
        kind: 'state_code' as const,
        sectionIds: [],
      })),
      warnings: ['careful\u0007'],
      sections: [],
    } as unknown as IngestResult['normalized'],
  };
}

test('caps the external reference list and says how many more exist', () => {
  const text = formatIngest(result(25));
  expect(text).toContain('Unresolved external references: 25');
  expect(text.match(/^ {2}- R\.C\./gm)).toHaveLength(10);
  expect(text).toContain('... and 15 more');
  expect(formatIngest(result(3))).not.toContain('more');
});

test('document-derived strings are sanitized', () => {
  const text = formatIngest(result(0, 'la\u001b]0;x\u0007bel'));
  expect(text).toContain('Title: Title');
  expect(text).toContain('Ingested: label');
  expect(text).not.toMatch(/\u001b|\u0007/);
  expect(
    formatList([
      {
        label: 'a\u001b[1mb',
        docId: 'f'.repeat(64),
        format: 'xml',
        title: null,
        billNumber: null,
        lastUsedAt: 't',
      } as never,
    ]),
  ).not.toMatch(/\u001b/);
});
