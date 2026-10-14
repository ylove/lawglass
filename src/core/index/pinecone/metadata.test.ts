import { describe, expect, it } from 'vitest';
import { CHUNKS_A, DOC_A } from '../../../../tests/contracts/sample-chunks.js';
import { fromRecord, toRecord, translateFilter } from './metadata.js';

describe('Pinecone metadata', () => {
  it('round-trips all fields, empty strings/arrays, and absent optional fields', () => {
    for (const chunk of [
      ...CHUNKS_A,
      { ...CHUNKS_A[0]!, heading: '', sectionNum: '', pageEnd: 2 },
    ]) {
      const record = toRecord(chunk);
      const { embedText: _omit, ...stored } = chunk;
      expect(record._id).toBe(chunk.id);
      expect(record.embed_text).toBe(chunk.embedText);
      expect(fromRecord(chunk.id, record, DOC_A)).toEqual(stored);
      expect(
        Object.values(record as Record<string, unknown>).every(
          (v) => v !== null && v !== undefined,
        ),
      ).toBe(true);
    }
    expect(toRecord(CHUNKS_A[2]!)).not.toHaveProperty('page_start');
    expect(
      fromRecord(CHUNKS_A[2]!.id, toRecord(CHUNKS_A[2]!), DOC_A),
    ).not.toHaveProperty('pageStart');
    expect(
      toRecord({ ...CHUNKS_A[0]!, heading: undefined }),
    ).not.toHaveProperty('heading');
  });
  it('translates OR within fields and AND across fields, including definitions', () => {
    expect(translateFilter(undefined)).toBeUndefined();
    expect(translateFilter({})).toBeUndefined();
    expect(
      translateFilter({
        chunkType: ['definition', 'operative'],
        amendmentStatus: ['inserted'],
        sectionIds: ['sec-2'],
        definesTerm: ['town'],
      }),
    ).toEqual({
      $and: [
        { chunk_type: { $in: ['definition', 'operative'] } },
        { amendment_status: { $in: ['inserted'] } },
        { section_id: { $in: ['sec-2'] } },
        { defines_term: { $in: ['town'] } },
      ],
    });
    expect(() => translateFilter({ sectionIds: [] })).toThrow();
    expect(() =>
      translateFilter({
        definesTerm: Array.from({ length: 10_001 }, () => 'term'),
      }),
    ).toThrow();
  });
  it('rejects oversized records using UTF-8 byte counts and ID limits', () => {
    expect(() =>
      toRecord({ ...CHUNKS_A[0]!, text: 'é'.repeat(21_000) }),
    ).toThrow('record limits');
    expect(() => toRecord({ ...CHUNKS_A[0]!, id: 'x'.repeat(513) })).toThrow(
      'record limits',
    );
    expect(() =>
      toRecord({ ...CHUNKS_A[0]!, embedText: 'x'.repeat(41_000) }),
    ).toThrow('record limits');
  });
  it.each([
    null,
    'text',
    {},
    { doc_id: DOC_A, text: null },
    toRecord({ ...CHUNKS_A[0]!, docId: 'wrong' }),
  ])('rejects malformed and cross-document metadata', (fields) => {
    expect(() => fromRecord('chunk', fields, DOC_A)).toThrow();
  });
});
