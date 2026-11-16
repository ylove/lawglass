import { describe, expect, it } from 'vitest';
import { dropOverlap } from '../answer/context.js';
import { buildPrompt } from '../answer/prompt.js';
import { chunkDocument } from '../chunk/index.js';
import { EMPTY_METADATA, type ReferenceText } from '../model/index.js';
import { makeSectionedText } from '../../../tests/synth/text.js';
import { S1582_SHAPE, shapedBill } from '../../../tests/synth/bill-shape.js';
import { wholePromptCharacters } from './prompt-size.js';

const reference: ReferenceText = {
  sectionId: 'ref:usc/15/6809',
  citation: '15 U.S.C. 6809',
  heading: '§6809. Definitions',
  sourceUrl: 'https://example.gov/usc/15/6809',
  text: 'The term "nonpublic personal information" means <anything> & more.',
  fetchedAt: '2026-01-01T00:00:00.000Z',
};

/** Builds the prompt the answer pipeline builds and returns its bill and reference blocks. */
function realPartBlocks(
  sections: ReturnType<typeof shapedBill>,
  references: ReferenceText[] = [],
): string {
  const doc = {
    docId: '0'.repeat(64),
    sourceUrl: 'https://estimate.invalid/',
    format: 'text' as const,
    fetchedAt: '2000-01-01T00:00:00.000Z',
    metadata: EMPTY_METADATA,
    sections,
    definitions: [],
    externalRefs: [],
    warnings: [],
  };
  const hits = dropOverlap(
    chunkDocument(doc).map((chunk) => ({ chunk, score: 1 })),
  );
  const built = buildPrompt({
    mode: 'whole',
    question: 'q',
    hits,
    references,
  });
  if (typeof built.user === 'string')
    throw new Error('Whole mode sends a cached first block.');
  const first = built.user[0];
  if (!first) throw new Error('Whole mode sends a cached first block.');
  return first.text;
}

describe('wholePromptCharacters', () => {
  it('counts the part blocks the real whole-bill prompt builder emits', () => {
    // The wrappers around the parts are `<bill>\n` ... `\n</bill>\n` and the references pair;
    // everything else, tags and attributes included, is what the forecast must see. If the
    // prompt format grows markup, this fails with the builder rather than silently drifting.
    const sections = shapedBill({
      divisions: 1,
      titles: 2,
      sectionsPerTitle: 3,
      sectionChars: 120,
      headingChars: 30,
    });
    const text = realPartBlocks(sections);
    const body = text.slice('<bill>\n'.length, -'\n</bill>\n'.length);
    expect(wholePromptCharacters(sections)).toBe(body.length + 1);
  });
  it('counts reference blocks after the bill, escaped like the builder escapes them', () => {
    const sections = shapedBill({
      divisions: 1,
      titles: 1,
      sectionsPerTitle: 2,
      sectionChars: 100,
      headingChars: 20,
    });
    const without = realPartBlocks(sections);
    const withRefs = realPartBlocks(sections, [reference]);
    const added = withRefs.length - without.length;
    // `<references>\n` and `\n</references>\n` wrap the one block.
    const wrapper = '<references>\n'.length + '\n</references>\n'.length;
    expect(
      wholePromptCharacters(sections, [reference]) -
        wholePromptCharacters(sections),
    ).toBe(added - wrapper + 1);
  });
  it('weighs each part for its breadcrumb, not just its text', () => {
    const base = { divisions: 2, titles: 3, sectionsPerTitle: 5 } as const;
    const shallow = shapedBill({
      ...base,
      sectionChars: 100,
      headingChars: 10,
    });
    const deep = shapedBill({ ...base, sectionChars: 100, headingChars: 80 });
    // The same text; every part's heading="..." attribute carries three names 70 characters
    // longer. Small sibling sections share a chunk, so there are fewer parts than sections:
    // 2,000 is well under one part's worth of extra heading per ten sections.
    expect(wholePromptCharacters(deep)).toBeGreaterThan(
      wholePromptCharacters(shallow) + 2000,
    );
  });
  it('sizes an empty bill at nothing', () => {
    expect(wholePromptCharacters([])).toBe(0);
  });
  it('reads a synthetic bill the way the parser would (sanity)', () => {
    const { sections } = makeSectionedText().groundTruth;
    expect(wholePromptCharacters(sections)).toBeGreaterThan(0);
  });
  it('is large for a many-section bill (S. 1582 shape)', () => {
    expect(wholePromptCharacters(shapedBill(S1582_SHAPE))).toBeGreaterThan(
      150_000,
    );
  });
});
