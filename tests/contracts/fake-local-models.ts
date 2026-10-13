/** Deterministic bag-of-words model: tests exercise the store and retrieval, never the Hub. */
import { createHash } from 'node:crypto';
import type { Embedder, Reranker } from '../../src/core/index/local/index.js';
import { tokenize } from '../../src/core/index/local/bm25.js';

export class FakeEmbedder implements Embedder {
  readonly model = { id: 'fake-bag-of-words', revision: '1' };
  readonly dims = 384;
  readonly calls: { texts: readonly string[]; purpose: string }[] = [];
  ensureReady(): Promise<void> {
    return Promise.resolve();
  }
  embed(texts: readonly string[], purpose: 'query' | 'document') {
    this.calls.push({ texts, purpose });
    const vectors = texts.map((text) => {
      const vector = new Float32Array(this.dims);
      for (const term of tokenize(text)) {
        const row =
          createHash('sha256').update(term).digest().readUInt32LE(0) %
          this.dims;
        vector[row] = (vector[row] ?? 0) + 1;
      }
      const norm = Math.hypot(...vector);
      return vector.map((value) => (norm ? value / norm : 0));
    });
    return Promise.resolve({
      vectors,
      tokens: texts.reduce((count, text) => count + tokenize(text).length, 0),
    });
  }
}

export class FakeReranker implements Reranker {
  readonly model = { id: 'fake-overlap', revision: '1' };
  ensureReady(): Promise<void> {
    return Promise.resolve();
  }
  score(query: string, texts: readonly string[]): Promise<number[]> {
    const terms = new Set(tokenize(query));
    return Promise.resolve(
      texts.map(
        (text) => tokenize(text).filter((term) => terms.has(term)).length,
      ),
    );
  }
}
