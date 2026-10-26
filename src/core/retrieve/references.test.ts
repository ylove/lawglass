import { describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { makeChunkId, type Chunk, type SearchHit } from '../model/index.js';
import {
  findReferencedSections,
  MAX_FOLLOWED_REFERENCES,
  referencedSectionsToFollow,
} from './references.js';

const DOC = 'b'.repeat(64);
function chunk(
  sectionId: string,
  refs: string[] = [],
  status: Chunk['amendmentStatus'] = 'unchanged',
): Chunk {
  return {
    id: makeChunkId(DOC, sectionId, 0),
    docId: DOC,
    sectionId,
    breadcrumb: `Sec. ${sectionId}`,
    text: `Text of ${sectionId}.`,
    embedText: `Text of ${sectionId}.`,
    chunkType: 'operative',
    amendmentStatus: status,
    definedTermsUsed: [],
    refs,
    tokenCount: 5,
  };
}
const hit = (c: Chunk): SearchHit => ({ chunk: c, score: 1 });

describe('referencedSectionsToFollow', () => {
  it('lists referenced sections not already in the hits, best hit first, without repeats', () => {
    const hits = [
      hit(chunk('sec-4', ['sec-3', 'sec-2'])),
      hit(chunk('sec-5', ['sec-3', 'sec-4', 'sec-9'])),
    ];
    expect(referencedSectionsToFollow(hits)).toEqual([
      'sec-3',
      'sec-2',
      'sec-9',
    ]);
  });

  it('treats a section covered by a merged chunk as present, and tolerates chunks without refs', () => {
    const merged = {
      ...chunk('sec-1', ['sec-1/a']),
      coveredSectionIds: ['sec-1/a'],
    };
    const bare = { ...chunk('sec-2'), refs: undefined } as unknown as Chunk;
    expect(referencedSectionsToFollow([hit(merged), hit(bare)])).toEqual([]);
  });
});

describe('findReferencedSections', () => {
  it('fetches the opening chunk of each, in one call, capped, and skips struck text unless asked', async () => {
    const backend = new MemoryBackend();
    await backend.upsertChunks(DOC, [
      chunk('sec-2'),
      chunk('sec-3', [], 'deleted'),
      chunk('sec-6'),
      chunk('sec-7'),
      chunk('sec-8'),
    ]);
    const get = vi.spyOn(backend, 'getChunks');
    const hits = [
      hit(chunk('sec-1', ['sec-2', 'sec-3', 'sec-6', 'sec-7', 'sec-8'])),
    ];
    const live = await findReferencedSections({
      backend,
      docId: DOC,
      hits,
      includeDeleted: false,
    });
    expect(live.map((h) => h.chunk.sectionId)).toEqual([
      'sec-2',
      'sec-6',
      'sec-7',
    ]);
    expect(live).toHaveLength(MAX_FOLLOWED_REFERENCES);
    expect(get).toHaveBeenCalledTimes(1);
    const changes = await findReferencedSections({
      backend,
      docId: DOC,
      hits,
      includeDeleted: true,
    });
    expect(changes.map((h) => h.chunk.sectionId)).toEqual([
      'sec-2',
      'sec-3',
      'sec-6',
    ]);
  });

  it('does nothing when nothing is referenced, and ignores sections that are not stored', async () => {
    const backend = new MemoryBackend();
    const get = vi.spyOn(backend, 'getChunks');
    expect(
      await findReferencedSections({
        backend,
        docId: DOC,
        hits: [hit(chunk('sec-1'))],
        includeDeleted: false,
      }),
    ).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(
      await findReferencedSections({
        backend,
        docId: DOC,
        hits: [hit(chunk('sec-1', ['sec-404']))],
        includeDeleted: false,
      }),
    ).toEqual([]);
  });
});

describe('retrieve() follows one hop of references', () => {
  it('appends the referenced section as context, and eval-style raw retrieval does not', async () => {
    const { retrieve } = await import('./retrieve.js');
    const backend = new MemoryBackend();
    await backend.upsertChunks(DOC, [
      {
        ...chunk('sec-4', ['sec-3']),
        text: 'Grants go to the eligible entities described in section 3.',
        embedText: 'Grants go to the eligible entities described in section 3.',
      },
      {
        ...chunk('sec-3'),
        text: 'An eligible entity is a nonprofit with fewer than 50 staff.',
        embedText:
          'An eligible entity is a nonprofit with fewer than 50 staff.',
      },
    ]);
    const followed = await retrieve(backend, {
      docId: DOC,
      query: 'grants described',
      mode: 'sparse',
      topK: 1,
    });
    expect(followed.hits.map((h) => [h.chunk.sectionId, h.injected])).toEqual([
      ['sec-4', false],
      ['sec-3', true],
    ]);
    expect(followed.injectedDefinitions).toEqual([]);
    const raw = await retrieve(backend, {
      docId: DOC,
      query: 'grants described',
      mode: 'sparse',
      topK: 1,
      injectDefinitions: false,
    });
    expect(raw.hits.map((h) => h.chunk.sectionId)).toEqual(['sec-4']);
  });
});
