import { describe, expect, it, vi } from 'vitest';
import { DOC_A } from '../../../tests/contracts/sample-chunks.js';
import { ZERO_USAGE, type RetrievalBackend } from './index.js';

// Pins the additive `signal` parameter of RetrievalBackend.upsertChunks (#221). The adapter
// behaviour is pinned in src/core/index/upsert-signal.test.ts: this directory is type-checked
// by the web project too, which cannot compile the local backend.
describe('the port', () => {
  it('accepts a signal as the fourth argument', () => {
    const upsert = vi.fn<RetrievalBackend['upsertChunks']>(() =>
      Promise.resolve({ usage: ZERO_USAGE }),
    );
    void upsert(DOC_A, [], undefined, new AbortController().signal);
    expect(upsert).toHaveBeenCalledOnce();
  });
});
