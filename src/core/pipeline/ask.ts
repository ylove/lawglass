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
 * TODO(#31): pass `runChip` here from the CLI/server once that branch merges. Until then a
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
  mode: RetrievalMode;
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
    await backend.ensureReady(signal);
    const ran = await deps.chips(
      input.chipId,
      docId,
      { backend, provider: deps.provider, doc },
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
      mode: deps.retrievalMode ?? 'hybrid_rerank',
      latencyMs: now() - startedAt,
    };
  }

  const question = input.question.trim();
  if (!question)
    throw new AppError('INVALID_INPUT', 'Empty question.', {
      userMessage: 'Enter a question to ask.',
    });
  await backend.ensureReady(signal);

  const mode = deps.retrievalMode ?? 'hybrid_rerank';
  const includeDeleted = asksAboutChanges(question);
  const retrieved = await retrieve(backend, {
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
