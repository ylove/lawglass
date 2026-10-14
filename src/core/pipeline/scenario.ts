/**
 * Targeted scenarios on demand (#196): an illustrated example for a subject the reader names.
 *
 * retrieve (subject as the query, plus the summary's cited sections) -> generate -> validate ->
 * cache. Every guarantee of the automatic scenario carries over unchanged: the persona name
 * comes from the fixed list, every rule or effect frame is cited, and `validateScenario` runs
 * as-is. The subject is untrusted and is checked before any model call.
 */
import { join } from 'node:path';
import {
  AppError,
  type LlmProvider,
  type RetrievalBackend,
  type RetrievalMode,
  type ScenarioResponse,
  type SearchHit,
} from '../model/index.js';
import type { Registry } from '../registry.js';
import { retrieve } from '../retrieve/index.js';
import { attachScenario } from '../scenario/attach.js';
import { SCENARIO_SUBJECT_PROMPT_VERSION } from '../scenario/generate.js';
import {
  ScenarioCache,
  type ScenarioCacheKey,
} from '../scenario/scenario-cache.js';
import { checkScenarioSubject } from '../scenario/subject.js';

/** Hits for the subject itself, then up to this many from the summary's cited sections. */
const SUBJECT_HITS = 5;
const SUMMARY_HITS = 3;
/** A scenario shows three frames; the model is asked for 3 to 4 so one can fail validation. */
export const SCENARIO_FRAMES = 3;

export interface RunScenarioDeps {
  backend: RetrievalBackend;
  provider: LlmProvider;
  registry: Registry;
  retrievalMode?: RetrievalMode | undefined;
  /** Chunk ids the cached summary cited, if one exists. Read lazily: only a cache miss needs them. */
  summaryChunkIds?: (() => Promise<readonly string[]>) | undefined;
  /** Defaults to a cache in the registry's answer-cache directory. */
  cache?: ScenarioCache | undefined;
  now?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export async function runScenario(
  docId: string,
  rawSubject: string,
  deps: RunScenarioDeps,
): Promise<ScenarioResponse> {
  // Before any lookup or model call: a refused subject costs nothing.
  const checked = checkScenarioSubject(rawSubject);
  if (!checked.ok)
    throw new AppError('INVALID_INPUT', 'Scenario subject refused.', {
      userMessage: checked.reason,
    });
  const { subject } = checked;
  const { registry, backend } = deps;
  // Also proves the document exists (DOC_NOT_FOUND).
  await registry.getDocument(docId);
  const cache =
    deps.cache ??
    new ScenarioCache({
      dir: join(registry.configDir, 'cache', 'answers'),
      ...(deps.now ? { now: deps.now } : {}),
      isStillRegistered: (id) => registry.isRegistered(id).catch(() => false),
    });
  const key: ScenarioCacheKey = {
    docId,
    subject,
    provider: deps.provider.id,
    model: deps.provider.model,
    promptVersion: SCENARIO_SUBJECT_PROMPT_VERSION,
  };

  const result = await cache.getOrCompute(key, async () => {
    if (!(await backend.hasDocument(docId)))
      throw new AppError('DOC_NOT_FOUND', 'The document has no index.', {
        userMessage:
          "This document's search index is missing. Run ingest again for its URL.",
      });
    await backend.ensureReady(deps.signal);
    const retrieved = await retrieve(backend, {
      docId,
      query: subject,
      mode: deps.retrievalMode ?? 'hybrid_rerank',
      includeDeleted: false,
      signal: deps.signal,
    });
    const subjectHits = retrieved.hits
      .filter((hit) => hit.chunk.amendmentStatus !== 'deleted')
      .slice(0, SUBJECT_HITS);
    const have = new Set(subjectHits.map((hit) => hit.chunk.id));
    const summaryIds = ((await deps.summaryChunkIds?.()) ?? []).filter(
      (id) => !have.has(id),
    );
    const summaryHits: SearchHit[] = (
      summaryIds.length ? await backend.getChunks(docId, summaryIds) : []
    )
      .slice(0, SUMMARY_HITS)
      .map((chunk) => ({ chunk, score: 0 }));
    // The subject's own passages come first: they are what the example is about.
    const hits = [...subjectHits, ...summaryHits];

    const attached = await attachScenario({
      provider: deps.provider,
      hits,
      subject,
      docId,
      signal: deps.signal,
      timeoutMs: deps.timeoutMs,
    });
    await registry.touch(docId, {
      embedTokens: retrieved.usage.embedTokens,
      rerankUnits: retrieved.usage.rerankUnits,
      llmInputTokens: attached.usage.inputTokens,
      llmOutputTokens: attached.usage.outputTokens,
    });
    const frames = attached.scenario?.frames.slice(0, SCENARIO_FRAMES);
    // Showing the first three that validated must still leave at least one cited frame.
    if (
      !attached.scenario ||
      !frames ||
      frames.length < SCENARIO_FRAMES ||
      frames.every((frame) => frame.kind === 'setup')
    )
      return { status: 'none' as const };
    return {
      status: 'ok' as const,
      scenario: { ...attached.scenario, frames },
    };
  });
  return result.status === 'ok'
    ? { status: 'ok', scenario: result.scenario }
    : { status: 'none' };
}
