import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeBackendContract } from '../../../../tests/contracts/backend.contract.js';
import { CHUNKS_A, DOC_A } from '../../../../tests/contracts/sample-chunks.js';
import { envVar } from '../../brand.js';
import { LocalBackend } from './index.js';
import { createLocalModels } from './models.js';

describe.skipIf(process.env.LOCAL_MODELS !== '1')(
  'offline quantized local models',
  () => {
    const configDir = process.env[envVar('CONFIG_DIR')];
    const models = createLocalModels({
      ...(configDir ? { configDir } : {}),
      allowRemoteModels: false,
    });
    afterAll(() => models.dispose());

    describeBackendContract(
      'local (real models, offline)',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'local-real-contract-'));
        return {
          backend: new LocalBackend({
            root,
            embedder: models.embedder,
            reranker: models.reranker,
          }),
          cleanup: () => rm(root, { recursive: true, force: true }),
        };
      },
      { timeoutMs: 120_000 },
    );

    it('finds an appropriation from a paraphrase with no matching appropriation keywords', async () => {
      const root = await mkdtemp(join(tmpdir(), 'local-paraphrase-'));
      const backend = new LocalBackend({
        root,
        embedder: models.embedder,
        reranker: models.reranker,
      });
      try {
        await backend.upsertChunks(DOC_A, CHUNKS_A);
        const { hits, usage } = await backend.search({
          docId: DOC_A,
          index: 'dense',
          query: 'money set aside for the program',
          topK: 1,
        });
        expect(hits[0]?.chunk.id).toBe(CHUNKS_A[4]!.id);
        expect(usage.embedTokens).toBeGreaterThan(0);
        const candidates = await backend.search({
          docId: DOC_A,
          index: 'dense',
          query: 'fines for violations',
          topK: CHUNKS_A.length,
        });
        const reranked = await backend.rerank({
          query: 'fines for violations',
          hits: candidates.hits,
          topN: 1,
        });
        expect(reranked.hits[0]?.chunk.id).toBe(CHUNKS_A[3]!.id);
        expect(reranked.usage.rerankUnits).toBe(CHUNKS_A.length);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
