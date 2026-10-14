/**
 * A tiny synthetic corpus for contract tests. Two documents so namespace isolation can be checked.
 * Text is invented for tests (not taken from any real bill).
 */
import { makeChunkId, type Chunk } from '../../src/core/model/index.js';

export const DOC_A = 'a'.repeat(64);
export const DOC_B = 'b'.repeat(64);

function chunk(
  docId: string,
  sectionId: string,
  n: number,
  over: Partial<Chunk> & { text: string },
): Chunk {
  const breadcrumb = over.breadcrumb ?? `Sec. ${sectionId}`;
  return {
    id: makeChunkId(docId, sectionId, n),
    docId,
    sectionId,
    breadcrumb,
    chunkType: 'operative',
    amendmentStatus: 'unchanged',
    embedText: `${breadcrumb}: ${over.text}`,
    definedTermsUsed: [],
    refs: [],
    tokenCount: over.text.split(/\s+/).length,
    ...over,
  };
}

export const CHUNKS_A: Chunk[] = [
  chunk(DOC_A, 'sec-1', 0, {
    text: 'This act may be cited as the Clean Water Grants Act.',
    heading: 'Short title',
    sectionNum: '1',
    pageStart: 1,
    lineStart: 1,
    lineEnd: 3,
  }),
  chunk(DOC_A, 'sec-2', 0, {
    text: 'The term "eligible town" means a municipality with fewer than 10,000 residents.',
    chunkType: 'definition',
    definesTerm: 'eligible town',
    heading: 'Definitions',
    sectionNum: '2',
  }),
  chunk(DOC_A, 'sec-3', 0, {
    text: 'The department shall award grants to each eligible town for water treatment upgrades.',
    definedTermsUsed: ['eligible town'],
    refs: ['sec-2'],
    coveredSectionIds: ['sec-3', 'sec-3/a', 'sec-3/b'],
  }),
  chunk(DOC_A, 'sec-4', 0, {
    text: 'A person who violates this section shall be fined not more than $5,000 per day.',
    chunkType: 'penalty',
  }),
  chunk(DOC_A, 'sec-5', 0, {
    text: 'There is appropriated $2,000,000 from the general fund for fiscal year 2027.',
    chunkType: 'appropriation',
    amendmentStatus: 'inserted',
  }),
  chunk(DOC_A, 'sec-5', 1, {
    text: 'Section 5747.01 of the Revised Code is repealed.',
    amendmentStatus: 'deleted',
  }),
  chunk(DOC_A, 'sec-6', 0, {
    text: 'This act takes effect ninety days after its passage.',
    chunkType: 'effective_date',
  }),
];

export const CHUNKS_B: Chunk[] = [
  chunk(DOC_B, 'sec-1', 0, {
    text: 'Zoning boards may approve data center construction permits.',
  }),
  chunk(DOC_B, 'sec-2', 0, {
    text: 'Noise from cooling equipment shall not exceed 55 decibels at night.',
  }),
];
