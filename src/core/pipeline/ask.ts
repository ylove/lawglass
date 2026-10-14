/**
 * The shared ask pipeline: retrieve -> answer -> record usage. Used by the CLI, the server
 * (#29) and eval (#32).
 */
import { answer } from '../answer/index.js';
import { asksAboutChanges, retrieve } from '../retrieve/index.js';
import {
  AppError,
  type AnswerResult,
  type ChipId,
  type BackendUsage,
  type LlmProvider,
  type NormalizedDoc,
  type SearchHit,
  type RetrievalBackend,
  type RetrievalMode,
  type RetrievedRef,
} from '../model/index.js';
import type { Registry } from '../registry.js';

/**
 * Chip dispatch seam, shaped like `runChip` from core/chips.ts (#31) so wiring it later is
 * `chips: (id, docId, ctx, o) => runChip(getChip(id), docId, ctx, o)`.
 * TODO(#70): once chips merge, the default becomes `(id, docId, ctx, o) => runChip(getChip(id), docId, ctx, o)`. Until then a
 * chip request without a runner is a clear user error, and freeform questions are unaffected.
 */
export type ChipRunner = (
  chipId: ChipId,
  docId: string,
  ctx: {
    backend: RetrievalBackend;
    provider: LlmProvider;
    doc: Pick<NormalizedDoc, 'metadata' | 'sections'>;
  },
  opts: {
    signal?: AbortSignal | undefined;
    onToken?: ((text: string) => void) | undefined;
  },
) => Promise<{
  answer: AnswerResult;
  hits: readonly (SearchHit & { injected?: boolean })[];
  backendUsage: BackendUsage;
  /** The retrieval mode the chip actually used; 'none' for chips that don't retrieve. */
  mode?: RetrievalMode | 'none';
}>;

export interface AskDeps {
  backend: RetrievalBackend;
  provider: LlmProvider;
  registry: Registry;
  /** Default `hybrid_rerank`. */
  retrievalMode?: RetrievalMode | undefined;
  chips?: ChipRunner | undefined;
  now?: (() => number) | undefined;
}

export type AskInput = { chipId: ChipId } | { question: string };

export interface AskOptions {
  onToken?: ((text: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface AskResult {
  answer: AnswerResult;
  refs: RetrievedRef[];
  /** 'none' when the answer needed no retrieval (e.g. the sponsors chip). */
  mode: RetrievalMode | 'none';
  latencyMs: number;
}

function refsOf(
  hits: readonly (SearchHit & { injected?: boolean })[],
): RetrievedRef[] {
  return hits.map((hit) => ({
    chunkId: hit.chunk.id,
    sectionId: hit.chunk.sectionId,
    breadcrumb: hit.chunk.breadcrumb,
    score: hit.score,
    injectedDefinition: hit.injected === true,
  }));
}

/**
 * Wraps the backend so the first retrieval call (and only then) loads models and checks that
 * the document's namespace exists. Chips that never retrieve (sponsors) therefore load nothing,
 * and a registry entry whose index vanished is a clear error rather than an empty result that
 * the model would "decline" to answer.
 */
function guarded(
  backend: RetrievalBackend,
  docId: string,
  signal: AbortSignal | undefined,
): { backend: RetrievalBackend; used: () => boolean } {
  let ready: Promise<void> | undefined;
  const ensure = (): Promise<void> => {
    ready ??= (async () => {
      if (!(await backend.hasDocument(docId)))
        throw new AppError('DOC_NOT_FOUND', 'The document has no index.', {
          userMessage:
            "This document's search index is missing. Run ingest again for its URL.",
        });
      await backend.ensureReady(signal);
    })();
    return ready;
  };
  const wrapped: RetrievalBackend = {
    kind: backend.kind,
    ensureReady: (s) => backend.ensureReady(s),
    hasDocument: (id) => backend.hasDocument(id),
    upsertChunks: (id, chunks, onProgress) =>
      backend.upsertChunks(id, chunks, onProgress),
    search: async (req) => {
      await ensure();
      return backend.search(req);
    },
    getChunks: async (id, ids) => {
      await ensure();
      return backend.getChunks(id, ids);
    },
    rerank: async (req) => {
      await ensure();
      return backend.rerank(req);
    },
    deleteDocument: (id) => backend.deleteDocument(id),
  };
  return { backend: wrapped, used: () => ready !== undefined };
}

export async function ask(
  docId: string,
  input: AskInput,
  deps: AskDeps,
  opts: AskOptions = {},
): Promise<AskResult> {
  const { backend, registry } = deps;
  const { signal } = opts;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  // Also proves the doc exists (DOC_NOT_FOUND) and gives the prompt its metadata.
  const doc = await registry.getDocument(docId);

  if ('chipId' in input) {
    if (!deps.chips)
      throw new AppError(
        'INVALID_INPUT',
        `Chip ${input.chipId} is unavailable.`,
        {
          userMessage:
            'Question chips are not available yet. Ask a question instead.',
        },
      );
    const guard = guarded(backend, docId, signal);
    const ran = await deps.chips(
      input.chipId,
      docId,
      { backend: guard.backend, provider: deps.provider, doc },
      { signal, onToken: opts.onToken },
    );
    await registry.touch(docId, {
      embedTokens: ran.backendUsage.embedTokens,
      rerankUnits: ran.backendUsage.rerankUnits,
      llmInputTokens: ran.answer.usage.inputTokens,
      llmOutputTokens: ran.answer.usage.outputTokens,
    });
    return {
      answer: ran.answer,
      refs: refsOf(ran.hits),
      // TODO(#70): derive the exact mode from getChip(id) when the runner doesn't say.
      mode:
        ran.mode ??
        (guard.used() ? (deps.retrievalMode ?? 'hybrid_rerank') : 'none'),
      latencyMs: now() - startedAt,
    };
  }

  const question = input.question.trim();
  if (!question)
    throw new AppError('INVALID_INPUT', 'Empty question.', {
      userMessage: 'Enter a question to ask.',
    });
  const guard = guarded(backend, docId, signal);

  const mode = deps.retrievalMode ?? 'hybrid_rerank';
  const includeDeleted = asksAboutChanges(question);
  const retrieved = await retrieve(guard.backend, {
    docId,
    query: question,
    mode,
    includeDeleted,
    signal,
  });

  // Defense in depth: struck text is not current law, so unless the question asks about
  // changes, nothing deleted reaches the prompt whatever the backend returned.
  const usable = retrieved.hits.filter(
    (hit) => includeDeleted || hit.chunk.amendmentStatus !== 'deleted',
  );
  const result = await answer({
    provider: deps.provider,
    question,
    context: {
      hits: usable.filter((hit) => !hit.injected),
      definitions: usable.filter((hit) => hit.injected),
      metadata: doc.metadata,
    },
    signal,
    onToken: opts.onToken,
  });

  await registry.touch(docId, {
    embedTokens: retrieved.usage.embedTokens,
    rerankUnits: retrieved.usage.rerankUnits,
    llmInputTokens: result.usage.inputTokens,
    llmOutputTokens: result.usage.outputTokens,
  });

  return {
    answer: result,
    refs: refsOf(usable),
    mode: retrieved.mode,
    latencyMs: now() - startedAt,
  };
}
