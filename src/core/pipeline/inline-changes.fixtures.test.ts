/** Local-only: the HB 62 strike question's context holds the struck word (skipped without the PDF). */
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import {
  describeWithFixture,
  fixturePath,
} from '../../../tests/support/fixtures.js';
import { parsePdf } from '../parse/index.js';
import type { NormalizedDoc } from '../model/index.js';
import { buildPrompt } from '../answer/prompt.js';
import { withInlineChanges } from './inline-changes.js';

describeWithFixture('oh-hb62-135-in', () => {
  let doc: NormalizedDoc;
  beforeAll(async () => {
    doc = await parsePdf(readFileSync(fixturePath('oh-hb62-135-in')!), {
      sourceUrl: 'https://search-prod.lis.state.oh.us/fixture.pdf',
      fetchedAt: '2026-10-13T00:00:00.000Z',
    });
  });

  it('hb62-03: section 2901.05(A) shows [struck]presented[/struck] in place', () => {
    const hit = {
      score: 1,
      chunk: {
        id: 'x:sec-2901.05/a:0',
        docId: 'x',
        sectionId: 'sec-2901.05/a',
        breadcrumb: 'x',
        chunkType: 'operative' as const,
        amendmentStatus: 'inserted' as const,
        text: 'live',
        definedTermsUsed: [],
        refs: [],
        tokenCount: 1,
      },
    };
    const { user } = buildPrompt({
      question:
        'What word does the bill strike from division (A) of section 2901.05?',
      hits: withInlineChanges([hit], doc, 'x'),
    });
    expect(user).toContain('[struck]presented[/struck]');
  });
});
