/**
 * The shared ask pipeline: retrieve -> answer -> record usage. Used by the CLI, the server
 * (#29) and eval (#32).
 */
import {
  documentContext,
  deleteIndexedDocument,
  MEMO_OWNER,
} from '../answer/context.js';
import { answer } from '../answer/index.js';
import { getChip, runChip } from '../chips.js';
import { withInlineChanges } from './inline-changes.js';
import { readHistory } from '../history/history-store.js';
import { asksAboutChanges, retrieve } from '../retrieve/index.js';
import {
  AppError,
  ZERO_USAGE,
  type AnswerResult,
  type ChipId,
  type BackendUsage,
  type BillHistory,
  type LlmProvider,
  type NormalizedDoc,
  type SearchHit,
  type RetrievalBackend,
  type RetrievalMode,
  type RetrievedRef,
  type Scenario,
} from '../model/index.js';
import type { Registry } from '../registry.js';
import {
  addScenarioUsage,
  attachScenario,
  type AttachedScenario,
} from '../scenario/attach.js';
import { withoutSyntheticChunks } from '../chip-types.js';
import { classifyBill, wantsScenario } from '../scenario/detect.js';
import { sharedLimits, type Limits } from './limits.js';
import { cleanQuestion } from './question.js';

/**
 * Chip dispatch seam, shaped like `runChip` from core/chips.ts. The default is
 * `defaultChipRunner`; tests (and eval) may inject their own.
 */
export type ChipRunner = (
  chipId: ChipId,
  docId: string,
  ctx: {
    backend: RetrievalBackend;
    provider: LlmProvider;
    /** The full cached document: `definitions` lists document-wide definitions first. */
    doc: Pick<NormalizedDoc, 'metadata' | 'sections' | 'definitions'> & {
      /** Only loaded for the history chip. */
      history?: BillHistory | undefined;
    };
  },
  opts: {
    wholeBillMaxTokens?: number | undefined;
    signal?: AbortSignal | undefined;
    onToken?: ((text: string) => void) | undefined;
  },
) => Promise<{
  answer: AnswerResult;
  hits: readonly (SearchHit & { injected?: boolean })[];
  backendUsage: BackendUsage;
  /** The retrieval mode the chip actually used; 'none' for chips that don't retrieve. */
  mode?: RetrievalMode | 'none' | 'whole';
}>;

/** Runs the real chip strategies from core/chips.ts. */
export const defaultChipRunner: ChipRunner = (chipId, docId, ctx, opts) =>
  runChip(getChip(chipId), docId, ctx, opts);

export interface AskDeps {
  /** 0 keeps the retrieval evaluation on excerpts. */
  wholeBillMaxTokens?: number | undefined;
  backend: RetrievalBackend;
  provider: LlmProvider;
  registry: Registry;
  /** Default `hybrid_rerank`. */
  retrievalMode?: RetrievalMode | undefined;
  /** Defaults to `defaultChipRunner`. */
  chips?: ChipRunner | undefined;
  now?: (() => number) | undefined;
  /**
   * Scenario attachment (#127). Defaults to OFF so a new caller fails closed; the server passes
   * `!publicMode`, because public mode makes no extra model call for a visitor. `timeoutMs` bounds the generation.
   */
  scenario?: { enabled?: boolean; timeoutMs?: number } | undefined;
  /** Concurrency and per-minute budgets. Defaults to the process-wide limits from the environment. */
  limits?: Limits | undefined;
}

export type AskInput = { chipId: ChipId } | { question: string };

export interface AskOptions {
  onToken?: ((text: string) => void) | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Return the answer without waiting for its scenario; `AskResult.scenario` then resolves to
   * it (or `undefined`). The server uses this to emit `done` first. Default false: the CLI and
   * eval get `answer.scenario` set before `ask` returns.
   */
  deferScenario?: boolean | undefined;
}

export interface AskResult {
  answer: AnswerResult;
  /** Present only with `deferScenario` and when a scenario was attempted. Never rejects. */
  scenario?: Promise<Scenario | undefined>;
  refs: RetrievedRef[];
  /** 'none' when the answer needed no retrieval (e.g. the sponsors chip). */
  mode: RetrievalMode | 'none' | 'whole';
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
 * Wraps the backend so reads check that the document's namespace exists, and only search or
 * rerank loads models. Whole-bill reads need stored text, not embeddings. Chips that never
 * retrieve (sponsors) therefore load nothing,
 * and a registry entry whose index vanished is a clear error rather than an empty result that
 * the model would "decline" to answer.
 */
function guarded(
  backend: RetrievalBackend,
  docId: string,
  signal: AbortSignal | undefined,
): { backend: RetrievalBackend; used: () => boolean } {
  let checked: Promise<void> | undefined;
  let ready: Promise<void> | undefined;
  const ensureDocument = (): Promise<void> => {
    checked ??= (async () => {
      signal?.throwIfAborted();
      if (!(await backend.hasDocument(docId)))
        throw new AppError('DOC_NOT_FOUND', 'The document has no index.', {
          userMessage:
            "This document's search index is missing. Run ingest again for its URL.",
        });
    })();
    return checked;
  };
  const ensure = (): Promise<void> => {
    ready ??= ensureDocument().then(() => backend.ensureReady(signal));
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
      await ensureDocument();
      return backend.getChunks(id, ids);
    },
    rerank: async (req) => {
      await ensure();
      return backend.rerank(req);
    },
    deleteDocument: (id) => deleteIndexedDocument(backend, id),
    // The per-ask wrapper must share the real backend's whole-bill scan memo.
    [MEMO_OWNER]: backend,
  } as RetrievalBackend;
  return { backend: wrapped, used: () => checked !== undefined };
}

/**
 * Start generating a scenario for a finished answer; resolves to `undefined` when none is
 * wanted. Runs after the answer text, so streaming is never delayed, and never rejects (see
 * `attachScenario`).
 */
function startScenario(
  result: AnswerResult,
  hits: readonly SearchHit[],
  wanted: boolean,
  deps: AskDeps,
  question: string | undefined,
  signal: AbortSignal | undefined,
): Promise<AttachedScenario> | undefined {
  // Off unless a caller turns it on: the server passes `!publicMode` explicitly.
  if (!wanted || deps.scenario?.enabled !== true) return undefined;
  // A declined or uncited answer has nothing for a story to stand on.
  if (result.declined || !result.citations.some((c) => c.valid))
    return undefined;
  return attachScenario({
    provider: deps.provider,
    hits,
    whole: result.context === 'whole',
    citedSectionIds: result.citations
      .filter((c) => c.valid)
      .map((c) => c.sectionId),
    question,
    signal,
    timeoutMs: deps.scenario.timeoutMs,
  });
}

/** Records deferred scenario tokens; `touch` adds deltas, so it can run after the answer's own. */
function recorder(
  registry: Registry,
  docId: string,
): (usage: AttachedScenario['usage']) => Promise<void> {
  return async (usage) => {
    await registry.touch(docId, {
      llmInputTokens: usage.inputTokens,
      llmOutputTokens: usage.outputTokens,
    });
  };
}

/**
 * Finish a scenario run. Inline (default): wait for it and fold scenario and usage into the
 * answer. Deferred: return the answer now and a promise for the scenario, recording its usage
 * when it settles.
 */
async function settleScenario(
  result: AnswerResult,
  pending: Promise<AttachedScenario> | undefined,
  deferred: boolean,
  record: (usage: AttachedScenario['usage']) => Promise<void>,
): Promise<{
  answer: AnswerResult;
  scenario?: Promise<Scenario | undefined>;
}> {
  if (!pending) return { answer: result };
  if (deferred) {
    const scenario = pending.then(async (attached) => {
      await record(attached.usage).catch(() => undefined);
      return attached.scenario;
    });
    return { answer: result, scenario };
  }
  const attached = await pending;
  const usage = addScenarioUsage(result.usage, attached.usage);
  return {
    answer: attached.scenario
      ? { ...result, usage, scenario: attached.scenario }
      : { ...result, usage },
  };
}

export async function ask(
  docId: string,
  input: AskInput,
  deps: AskDeps,
  opts: AskOptions = {},
): Promise<AskResult> {
  // Validate before taking a permit: a bad question must not occupy a slot.
  const checked: AskInput =
    'chipId' in input ? input : { question: cleanQuestion(input.question) };
  const limits = deps.limits ?? sharedLimits();
  const release = await limits.acquire('ask', opts.signal);
  let result: AskResult;
  // Filled by `askWithinLimits` as soon as a scenario starts, so even a later failure keeps
  // the permit until that scenario's model call has finished.
  const started: { scenario?: Promise<unknown> } = {};
  try {
    // Model calls are charged to the per-minute ceiling by the metered provider.
    result = await askWithinLimits(
      docId,
      checked,
      { ...deps, provider: limits.meter(deps.provider) },
      opts,
      started,
    );
  } catch (error) {
    if (started.scenario) void started.scenario.finally(release);
    else release();
    throw error;
  }
  if (!result.scenario) {
    release();
    return result;
  }
  // A deferred scenario is still model work: keep the permit until it settles (it never rejects).
  return { ...result, scenario: result.scenario.finally(release) };
}

async function askWithinLimits(
  docId: string,
  input: AskInput,
  deps: AskDeps,
  opts: AskOptions,
  started: { scenario?: Promise<unknown> },
): Promise<AskResult> {
  const { backend, registry } = deps;
  const { signal } = opts;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  // Also proves the doc exists (DOC_NOT_FOUND) and gives the prompt its metadata.
  const doc = await registry.getDocument(docId);

  if ('chipId' in input) {
    const runChipFor = deps.chips ?? defaultChipRunner;
    const guard = guarded(backend, docId, signal);
    // The record lives in a sidecar file; only the history chip reads it.
    const history =
      input.chipId === 'history'
        ? // A corrupt sidecar is the same as no history: say "not available", don't fail.
          await readHistory(registry.configDir, docId).catch(() => undefined)
        : undefined;
    const ran = await runChipFor(
      input.chipId,
      docId,
      {
        backend: guard.backend,
        provider: deps.provider,
        doc: { ...doc, history },
      },
      {
        signal,
        onToken: opts.onToken,
        wholeBillMaxTokens: deps.wholeBillMaxTokens,
      },
    );
    // `who-affected` always tries; `summary` only for a single-subject bill, since an omnibus
    // summary stays descriptive (spec amendment 13).
    const wanted =
      input.chipId === 'who-affected' ||
      (input.chipId === 'summary' &&
        classifyBill(doc.sections) === 'single-subject');
    const pending = startScenario(
      ran.answer,
      ran.hits,
      wanted,
      deps,
      undefined,
      signal,
    );
    if (pending) started.scenario = pending;
    const settled = await settleScenario(
      ran.answer,
      pending,
      opts.deferScenario === true,
      recorder(registry, docId),
    );
    await registry.touch(docId, {
      embedTokens: ran.backendUsage.embedTokens,
      rerankUnits: ran.backendUsage.rerankUnits,
      llmInputTokens: settled.answer.usage.inputTokens,
      llmOutputTokens: settled.answer.usage.outputTokens,
    });
    return {
      answer: settled.answer,
      ...(settled.scenario && { scenario: settled.scenario }),
      refs: ran.mode === 'whole' ? [] : refsOf(ran.hits),
      // Chips report the mode they used; an injected runner that doesn't falls back here.
      mode:
        ran.mode ??
        (guard.used() ? (deps.retrievalMode ?? 'hybrid_rerank') : 'none'),
      latencyMs: now() - startedAt,
    };
  }

  // Already cleaned and length-checked by `ask`.
  const question = input.question;
  const guard = guarded(backend, docId, signal);

  const mode = deps.retrievalMode ?? 'hybrid_rerank';
  const includeDeleted = asksAboutChanges(question);
  const whole = await documentContext(guard.backend, docId, doc.sections, {
    budget: deps.wholeBillMaxTokens,
    includeDeleted,
    signal,
  });
  const retrieved: {
    hits: (SearchHit & { injected?: boolean })[];
    usage: BackendUsage;
    mode: RetrievalMode | 'whole';
  } =
    whole.mode === 'whole'
      ? {
          hits: whole.hits,
          usage: ZERO_USAGE,
          mode: 'whole',
        }
      : await retrieve(guard.backend, {
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
  // A question about changes sees each retrieved section with its struck and inserted words in
  // place (a one-word deletion cannot be retrieved on its own). Others keep plain chunks.
  const live = usable.filter((hit) => !hit.injected);
  const result = await answer({
    provider: deps.provider,
    question,
    context: {
      mode: whole.mode,
      hits: includeDeleted
        ? withInlineChanges(live, doc, docId, whole.mode === 'whole')
        : live,
      definitions: usable.filter((hit) => hit.injected),
      metadata: doc.metadata,
    },
    signal,
    onToken: opts.onToken,
  });
  // Inline excerpts have no stored chunk behind them, so citations name sections only.
  if (includeDeleted)
    result.citations = result.citations.map((c) =>
      withoutSyntheticChunks(c, docId),
    );

  const pending = startScenario(
    result,
    usable.filter((hit) => !hit.injected),
    wantsScenario(question),
    deps,
    question,
    signal,
  );
  if (pending) started.scenario = pending;
  const settled = await settleScenario(
    result,
    pending,
    opts.deferScenario === true,
    recorder(registry, docId),
  );
  await registry.touch(docId, {
    embedTokens: retrieved.usage.embedTokens,
    rerankUnits: retrieved.usage.rerankUnits,
    llmInputTokens: settled.answer.usage.inputTokens,
    llmOutputTokens: settled.answer.usage.outputTokens,
  });

  return {
    answer: settled.answer,
    ...(settled.scenario && { scenario: settled.scenario }),
    refs: whole.mode === 'whole' ? [] : refsOf(usable),
    mode: retrieved.mode,
    latencyMs: now() - startedAt,
  };
}
