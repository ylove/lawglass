/**
 * Section by section (#276) and a per-section example (#277), as pipeline steps.
 *
 * Both run under the shared budgets, one model call at a time: each call takes a slot in the
 * `ask` pool only while it runs and counts toward the per-minute ceiling (`Limits.paced`), so a
 * reader's question never waits out a whole run. Background work (the breakdown, examples drawn
 * ahead) also yields to readers. A cache hit takes neither.
 */
import { join } from 'node:path';
import { documentContext, type DocumentContext } from '../answer/context.js';
import { WHOLE_PROMPT_VERSION } from '../answer/prompt.js';
import {
  BreakdownCache,
  type BreakdownCacheKey,
  type StoredBreakdown,
} from '../breakdown/cache.js';
import { buildUnitContext, unitExcerpts } from '../breakdown/context.js';
import {
  breakdownPromptVersion,
  type BreakdownLog,
  generateBreakdown,
} from '../breakdown/generate.js';
import { EXAMPLE_FAILED_NOTE } from '../breakdown/notes.js';
import { chooseBreakdownUnits } from '../breakdown/units.js';
import {
  AppError,
  type LlmProvider,
  type RetrievalBackend,
  type ScenarioResponse,
  type SectionBrief,
} from '../model/index.js';
import type { Registry } from '../registry.js';
import { attachScenario } from '../scenario/attach.js';
import { SCENARIO_SECTION_PROMPT_VERSION } from '../scenario/generate.js';
import {
  ScenarioCache,
  type ScenarioCacheKey,
} from '../scenario/scenario-cache.js';
import { sharedLimits, type Limits } from './limits.js';
import { scenarioOutcome } from './scenario.js';

export interface BreakdownDeps {
  log?: BreakdownLog | undefined;
  backend: RetrievalBackend;
  provider: LlmProvider;
  registry: Registry;
  /** Canonical non-secret endpoint identity (`runtime.answerEndpoint`), part of the cache key. */
  endpoint: string;
  /** Pass the context already computed for the cache lookup so the bill is read once. */
  context?: DocumentContext | undefined;
  cache?: BreakdownCache | undefined;
  /** Concurrency and per-minute budgets, shared with asks. Defaults to the process-wide limits. */
  limits?: Limits | undefined;
  signal?: AbortSignal | undefined;
  /** Briefs finished so far, after each batch. */
  onProgress?: ((briefs: readonly SectionBrief[]) => void) | undefined;
}

export function breakdownCacheKey(
  docId: string,
  provider: Pick<LlmProvider, 'id' | 'model'>,
  endpoint: string,
  context: DocumentContext['mode'],
): BreakdownCacheKey {
  return {
    docId,
    provider: provider.id,
    model: provider.model,
    endpoint,
    promptVersion: breakdownPromptVersion(),
    context,
  };
}

export function defaultBreakdownCache(registry: Registry): BreakdownCache {
  return new BreakdownCache({
    dir: join(registry.configDir, 'cache', 'answers'),
    isStillRegistered: (id) => registry.isRegistered(id).catch(() => false),
  });
}

/** Cached briefs, or the one run that makes them. `undefined`: nothing worth keeping came out. */
export async function runBreakdown(
  docId: string,
  deps: BreakdownDeps,
): Promise<StoredBreakdown | undefined> {
  const { registry, backend } = deps;
  // Also proves the document exists (DOC_NOT_FOUND).
  const doc = await registry.getDocument(docId);
  const context =
    deps.context ??
    (await documentContext(backend, docId, doc.sections, {
      signal: deps.signal,
    }));
  const key = breakdownCacheKey(
    docId,
    deps.provider,
    deps.endpoint,
    context.mode,
  );
  const cache = deps.cache ?? defaultBreakdownCache(registry);

  return cache.getOrCompute(key, async () => {
    const limits = deps.limits ?? sharedLimits();
    if (!(await backend.hasDocument(docId)))
      throw new AppError('DOC_NOT_FOUND', 'The document has no index.', {
        userMessage:
          "This document's search index is missing. Run ingest again for its URL.",
      });
    const { units, omitted } = chooseBreakdownUnits(doc.sections);
    if (units.length === 0) return undefined;
    if (context.mode === 'excerpts') await backend.ensureReady(deps.signal);
    const made = await generateBreakdown({
      // Nobody is waiting on this run, so it yields to readers (`Limits.paced`).
      provider: limits.paced(deps.provider, {
        background: true,
        signal: deps.signal,
      }),
      docId,
      backend,
      doc,
      context,
      units,
      signal: deps.signal,
      onProgress: deps.onProgress,
      log: deps.log,
    });
    await registry.touch(docId, {
      embedTokens: made.backendUsage.embedTokens,
      rerankUnits: made.backendUsage.rerankUnits,
      llmInputTokens: made.usage.inputTokens,
      llmOutputTokens: made.usage.outputTokens,
    });
    if (made.briefs.length === 0) return undefined;
    return {
      briefs: made.briefs,
      // Parts left out by choice, plus parts whose brief could not be made or checked.
      omitted: omitted + made.dropped,
      context: context.mode,
      provider: deps.provider.id,
      model: deps.provider.model,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Per-section examples
// ---------------------------------------------------------------------------------------------

/** The reader sees a loader for an example, so it may take longer than an automatic one (12 s). */
export const SECTION_EXAMPLE_TIMEOUT_MS = 30_000;

export interface SectionExampleDeps {
  backend: RetrievalBackend;
  provider: LlmProvider;
  registry: Registry;
  context?: DocumentContext | undefined;
  cache?: ScenarioCache | undefined;
  now?: (() => number) | undefined;
  limits?: Limits | undefined;
  /** Drawn ahead of time, with nobody waiting: yields to readers like a breakdown does. */
  background?: boolean | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/** One cached example per document, part of the bill, provider, model and prompt version. */
export function sectionExampleKey(
  docId: string,
  sectionId: string,
  provider: Pick<LlmProvider, 'id' | 'model'>,
  context: DocumentContext['mode'],
): ScenarioCacheKey {
  return {
    docId,
    subject: '',
    sectionId,
    provider: provider.id,
    model: provider.model,
    promptVersion: `${SCENARIO_SECTION_PROMPT_VERSION}.${context}.${context === 'whole' ? WHOLE_PROMPT_VERSION : ''}`,
  };
}

export function defaultExampleCache(
  registry: Registry,
  now?: () => number,
): ScenarioCache {
  return new ScenarioCache({
    dir: join(registry.configDir, 'cache', 'answers'),
    ...(now ? { now } : {}),
    isStillRegistered: (id) => registry.isRegistered(id).catch(() => false),
  });
}

/**
 * An example for one part of the bill: its own text, the definitions it uses, the sections it
 * refers to (one hop) and any other law read for the bill, then the same generation and
 * validation as every other scenario. A part that is not one of the breakdown's units is refused.
 */
export async function runSectionExample(
  docId: string,
  sectionId: string,
  deps: SectionExampleDeps,
): Promise<ScenarioResponse> {
  const { registry, backend } = deps;
  const doc = await registry.getDocument(docId);
  const unit = chooseBreakdownUnits(doc.sections).units.find(
    (u) => u.id === sectionId,
  );
  if (!unit)
    throw new AppError('INVALID_INPUT', 'No such part of the bill.', {
      userMessage: 'That part of the bill could not be found.',
    });
  const context =
    deps.context ??
    (await documentContext(backend, docId, doc.sections, {
      signal: deps.signal,
    }));
  const cache = deps.cache ?? defaultExampleCache(registry, deps.now);
  const key = sectionExampleKey(docId, sectionId, deps.provider, context.mode);

  const result = await cache.getOrCompute(key, async () => {
    const limits = deps.limits ?? sharedLimits();
    if (!(await backend.hasDocument(docId)))
      throw new AppError('DOC_NOT_FOUND', 'The document has no index.', {
        userMessage:
          "This document's search index is missing. Run ingest again for its URL.",
      });
    if (context.mode === 'excerpts') await backend.ensureReady(deps.signal);
    const unitContext = await buildUnitContext({
      backend,
      docId,
      doc,
      unit,
      pool: context.mode === 'whole' ? context.hits : undefined,
      signal: deps.signal,
    });
    const hits = unitExcerpts(unitContext);
    if (unitContext.hits.length === 0) return { status: 'none' as const };
    const attached = await attachScenario({
      provider: limits.paced(deps.provider, {
        background: deps.background === true,
        signal: deps.signal,
      }),
      hits,
      // The part is already bounded by `buildUnitContext`; keep every excerpt it chose.
      whole: true,
      docId,
      focusSectionId: sectionId,
      captureError: true,
      signal: deps.signal,
      timeoutMs: deps.timeoutMs ?? SECTION_EXAMPLE_TIMEOUT_MS,
    });
    await registry.touch(docId, {
      embedTokens: unitContext.usage.embedTokens,
      rerankUnits: unitContext.usage.rerankUnits,
      llmInputTokens: attached.usage.inputTokens,
      llmOutputTokens: attached.usage.outputTokens,
    });
    // A failure is not an answer: it is not cached, and the service backs off. Only a
    // validation outcome ("no honest example") becomes a cached `none`.
    if (attached.error !== undefined)
      throw attached.error instanceof Error
        ? attached.error
        : new AppError('PROVIDER_ERROR');
    return scenarioOutcome(attached.scenario);
  });
  return result.status === 'ok'
    ? { status: 'ok', scenario: result.scenario }
    : { status: 'none', note: EXAMPLE_FAILED_NOTE };
}
