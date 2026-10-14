import { randomUUID } from 'node:crypto';
import { Pinecone } from '@pinecone-database/pinecone';
import { afterAll } from 'vitest';
import { describeBackendContract } from '../../../../tests/contracts/backend.contract.js';
import { BRAND } from '../../brand.js';
import { AppError } from '../../model/index.js';
import { PineconeBackend } from './pinecone.js';

const apiKey = process.env.PINECONE_API_KEY;
const indexPrefix = `${BRAND.indexPrefix}test-${randomUUID().slice(0, 12)}-`;
let client: Pinecone | undefined;

// Root teardown also runs if contract setup fails while creating one of the two indexes.
afterAll(async () => {
  {
    if (client) {
      const results = await Promise.allSettled(
        ['dense', 'sparse'].map(async (kind) => {
          try {
            await client!.indexes.delete(`${indexPrefix}${kind}`);
          } catch (error) {
            if (!(
              error instanceof Error && error.name === 'PineconeNotFoundError'
            ))
              throw new AppError(
                'BACKEND_UNAVAILABLE',
                'Could not clean up Pinecone test indexes.',
              );
          }
        }),
      );
      if (results.some((result) => result.status === 'rejected'))
        throw new AppError(
          'BACKEND_UNAVAILABLE',
          'Could not clean up Pinecone test indexes.',
        );
    }
  }
});

describeBackendContract(
  'pinecone (live)',
  () => {
    client = new Pinecone({ apiKey: apiKey!, maxRetries: 0 });
    const backend = new PineconeBackend({
      client,
      config: {
        indexPrefix,
        timeoutMs: 180_000,
      },
    });
    return Promise.resolve({ backend, settle: () => backend.settle() });
  },
  { skip: !apiKey, timeoutMs: 180_000 },
);
