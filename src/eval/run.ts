/**
 * The eval run: ingest each fixture through the shared pipeline, then score every retrieval
 * variant against the golden questions.
 *
 * Retrieval is called directly (not through `ask`) with `injectDefinitions: false`, so each
 * mode is scored on what it ranked itself. Answer metrics, when requested, go through `ask`
 * so they measure the real product path, injection included.
 */
import { createHash } from 'node:crypto';
import { ask, ingest, type PdfParser } from '../core/pipeline/index.js';
import { batchLimits } from '../core/pipeline/limits.js';
import { retrieve } from '../core/retrieve/index.js';
import type { Registry } from '../core/registry.js';
import {
  AppError,
  walkSections,
  type AnswerMetrics,
  type BackendKind,
  type BackendUsage,
  type FusionMethod,
  type GoldenQuestion,
  type GoldenSet,
  type LlmProvider,
  type NormalizedDoc,
  type RetrievalBackend,
  type RetrievalMetrics,
  type RetrievalMode,
  type SpanStatus,
} from '../core/model/index.js';
import { ZERO_USAGE, addUsage } from '../core/model/index.js';
import { memoryFetcher, type EvalFixture } from './fixtures.js';
import {
  EVAL_TOP_K,
  retrievalDetails,
  type DetailedEvalRow,
  type DetailedEvalRun,
  type RetrievalDetailHit,
} from './details.js';
import {
  citationValidity,
  declineRate,
  deletedLeakageRate,
  mean,
  p50,
  recallAtK,
  reciprocalRank,
  removalAcknowledgedRate,
  summarizeGrades,
  type AnswerOutcome,
  type RankedHit,
} from './metrics.js';

/** Hits retrieved per question; recall@5 reads the first five of the same ranking. */
export { EVAL_TOP_K } from './details.js';

/** One retrieval configuration under test. */
export interface Variant {
  mode: RetrievalMode;
  /** Set only for the hybrid family, where fusion applies. */
  fusion?: FusionMethod;
}

/** Dense, sparse, hybrid (RRF), hybrid_rerank, plus weighted fusion as the hybrid variant. */
export function variantsFor(
  modes: readonly RetrievalMode[],
  fusionVariant: boolean,
): Variant[] {
  return modes.flatMap((mode): Variant[] => {
    if (mode === 'hybrid')
      return [
        { mode, fusion: 'rrf' },
        ...(fusionVariant ? [{ mode, fusion: 'weighted' as const }] : []),
      ];
    if (mode === 'hybrid_rerank') return [{ mode, fusion: 'rrf' }];
    return [{ mode }];
  });
}

export interface EvalBackendInput {
  kind: BackendKind;
  backend: RetrievalBackend;
  /** Scratch registry for this backend. Never the user's real one. */
  registry: Registry;
}

export interface RunEvalInput {
  fixtures: readonly EvalFixture[];
  golden: readonly GoldenSet[];
  backends: readonly EvalBackendInput[];
  /** Metadata extraction during ingest. Retrieval does not depend on it; offline eval passes the mock. */
  extractProvider: LlmProvider;
  modes: readonly RetrievalMode[];
  /** Add the weighted-fusion hybrid row. Default true. */
  fusionVariant?: boolean | undefined;
  /** Generate answers and score them. Needs a real (or scripted) provider. */
  answerProvider?: LlmProvider | undefined;
  commit: string;
  now?: (() => Date) | undefined;
  parsePdf?: PdfParser | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

export interface SkippedFixture {
  fixture: string;
  /** `all` when the fixture could not be loaded at all, so no backend ever saw it. */
  backend: BackendKind | 'all';
  reason: string;
}

/** Numbers that are not part of the frozen `EvalRow` but belong in the report next to it. */
export interface RowExtras {
  removalAcknowledgedRate?: number | undefined;
}

export interface RunEvalResult {
  run: DetailedEvalRun;
  /** Parallel to `run.rows`. */
  extras: RowExtras[];
  skipped: SkippedFixture[];
  /** Golden fixtures with no document supplied. */
  unmatchedGolden: string[];
}

/** Coalesce runs within a section; printing/markup whitespace does not end a run. */
function spanRunTexts(
  doc: Pick<NormalizedDoc, 'sections'>,
  include: (status: SpanStatus) => boolean,
): string[] {
  const texts: string[] = [];
  for (const section of walkSections(doc.sections)) {
    let run: string[] = [];
    const flush = (): void => {
      if (run.length > 0) texts.push(run.join(' '));
      run = [];
    };
    for (const span of section.spans) {
      if (!span.text.trim()) continue;
      if (include(span.status)) run.push(span.text.trim());
      else flush();
    }
    // Never join separate provisions, including a parent and its child.
    flush();
  }
  return texts;
}

/** Contiguous deleted text, including runs split across printed lines. */
export function struckSpanTexts(
  doc: Pick<NormalizedDoc, 'sections'>,
): string[] {
  return spanRunTexts(doc, (status) => status === 'deleted');
}

/** Live wording used to reject partial matches shared with unchanged or replacement text. */
export function liveSpanTexts(doc: Pick<NormalizedDoc, 'sections'>): string[] {
  return spanRunTexts(doc, (status) => status !== 'deleted');
}

interface QuestionRetrieval<Hit extends RankedHit = RankedHit> {
  hits: Hit[];
  usage: BackendUsage;
  latencyMs: number;
}

/** Score one variant's retrievals. Unanswerable questions have no expected sections, so they are skipped. */
export function scoreRetrieval(
  questions: readonly GoldenQuestion[],
  retrievals: ReadonlyMap<string, QuestionRetrieval>,
): RetrievalMetrics {
  const scored = questions.flatMap((q) => {
    const r = retrievals.get(q.id);
    return q.kind === 'unanswerable' || !r ? [] : [{ q, r }];
  });
  const usage = scored.reduce(
    (total, { r }) => addUsage(total, r.usage),
    ZERO_USAGE,
  );
  return {
    recallAt5: mean(
      scored.map(({ q, r }) => recallAtK(r.hits, q.expectedSectionIds, 5)),
    ),
    recallAt10: mean(
      scored.map(({ q, r }) => recallAtK(r.hits, q.expectedSectionIds, 10)),
    ),
    mrr: mean(
      scored.map(({ q, r }) => reciprocalRank(r.hits, q.expectedSectionIds)),
    ),
    p50LatencyMs: p50(scored.map(({ r }) => r.latencyMs)),
    embedTokens: usage.embedTokens,
    rerankUnits: usage.rerankUnits,
  };
}

async function collectRetrievals(
  backend: RetrievalBackend,
  docId: string,
  questions: readonly GoldenQuestion[],
  variant: Variant,
): Promise<Map<string, QuestionRetrieval<RetrievalDetailHit>>> {
  const results = new Map<string, QuestionRetrieval<RetrievalDetailHit>>();
  for (const q of questions) {
    if (q.kind === 'unanswerable') continue;
    const retrieved = await retrieve(backend, {
      docId,
      query: q.question,
      mode: variant.mode,
      fusion: variant.fusion,
      topK: EVAL_TOP_K,
      injectDefinitions: false,
      now: () => performance.now(),
    });
    results.set(q.id, {
      // Belt and braces: with injection off nothing is injected, but never score an injected hit.
      hits: retrieved.hits
        .filter((h) => !h.injected)
        .map(({ chunk, score }) => ({
          sectionId: chunk.sectionId,
          breadcrumb: chunk.breadcrumb,
          score,
          ...(chunk.coveredSectionIds
            ? { coveredSectionIds: chunk.coveredSectionIds }
            : {}),
        })),
      usage: retrieved.usage,
      latencyMs: retrieved.latencyMs,
    });
  }
  return results;
}

/** Eval is a deliberate batch job, so it runs without the interactive per-minute ceiling. */
const EVAL_LIMITS = batchLimits();

async function collectAnswers(input: {
  backend: EvalBackendInput;
  docId: string;
  questions: readonly GoldenQuestion[];
  mode: RetrievalMode;
  provider: LlmProvider;
}): Promise<AnswerOutcome[]> {
  const outcomes: AnswerOutcome[] = [];
  for (const q of input.questions) {
    const { answer } = await ask(
      input.docId,
      { question: q.question },
      {
        backend: input.backend.backend,
        provider: input.provider,
        registry: input.backend.registry,
        retrievalMode: input.mode,
        limits: EVAL_LIMITS,
      },
    );
    outcomes.push({
      kind: q.kind,
      text: answer.text,
      declined: answer.declined,
      validCitations: answer.citations.filter((c) => c.valid).length,
      invalidCitations: answer.invalidCitations.length,
      readingGrade: answer.readingGrade,
    });
  }
  return outcomes;
}

export function scoreAnswers(
  outcomes: readonly AnswerOutcome[],
  struckSpans: readonly string[],
  liveTexts: readonly string[] = [],
): { metrics: AnswerMetrics; removalAcknowledgedRate: number | undefined } {
  const grades = summarizeGrades(outcomes.map((o) => o.readingGrade));
  return {
    metrics: {
      citationValidity: citationValidity(outcomes),
      declineRate: declineRate(outcomes),
      deletedLeakageRate: deletedLeakageRate(outcomes, struckSpans, liveTexts),
      meanReadingGrade: grades.mean,
      answersAboveGrade9: grades.above9,
    },
    removalAcknowledgedRate: removalAcknowledgedRate(outcomes),
  };
}

export async function runEval(input: RunEvalInput): Promise<RunEvalResult> {
  const now = input.now ?? (() => new Date());
  const fusionVariant = input.fusionVariant ?? true;
  const variants = variantsFor(input.modes, fusionVariant);
  const fixtures = new Map(input.fixtures.map((f) => [f.name, f]));
  const fetcher = memoryFetcher(input.fixtures);
  const rows: DetailedEvalRow[] = [];
  const extras: RowExtras[] = [];
  const skipped: SkippedFixture[] = [];
  const unmatchedGolden = input.golden
    .filter((g) => !fixtures.has(g.fixture))
    .map((g) => g.fixture);

  for (const target of input.backends) {
    for (const golden of input.golden) {
      const fixture = fixtures.get(golden.fixture);
      if (!fixture) continue;
      const docId = createHash('sha256').update(fixture.bytes).digest('hex');
      // Leave documents the user already had indexed alone; remove only what eval added.
      await target.backend.ensureReady();
      const existed = await target.backend.hasDocument(docId);
      try {
        input.onProgress?.(`${target.kind}: ingesting ${fixture.name}`);
        const ingested = await ingest(
          fixture.url,
          {
            backend: target.backend,
            provider: input.extractProvider,
            registry: target.registry,
            fetcher,
            now,
            maxDocs: input.fixtures.length + 1,
            parsePdf: input.parsePdf,
            limits: EVAL_LIMITS,
          },
          { label: fixture.name },
        );
        const struck = struckSpanTexts(ingested.normalized);
        const live = liveSpanTexts(ingested.normalized);
        for (const variant of variants) {
          input.onProgress?.(
            `${target.kind}: ${fixture.name} ${variant.mode}${variant.fusion ? `/${variant.fusion}` : ''}`,
          );
          const retrievals = await collectRetrievals(
            target.backend,
            docId,
            golden.questions,
            variant,
          );
          const row: DetailedEvalRow = {
            fixture: fixture.name,
            backend: target.kind,
            mode: variant.mode,
            ...(variant.fusion ? { fusion: variant.fusion } : {}),
            retrieval: scoreRetrieval(golden.questions, retrievals),
            questions: retrievalDetails(golden.questions, retrievals),
          };
          let extra: RowExtras = {};
          // The weighted-fusion variant is a retrieval comparison; `ask` has no fusion switch.
          if (input.answerProvider && variant.fusion !== 'weighted') {
            const outcomes = await collectAnswers({
              backend: target,
              docId,
              questions: golden.questions,
              mode: variant.mode,
              provider: input.answerProvider,
            });
            const scored = scoreAnswers(outcomes, struck, live);
            row.answers = scored.metrics;
            row.provider = input.answerProvider.id;
            row.model = input.answerProvider.model;
            extra = { removalAcknowledgedRate: scored.removalAcknowledgedRate };
          }
          rows.push(row);
          extras.push(extra);
        }
      } catch (error) {
        // An unparsable or unsupported fixture must not sink the others; anything else is a bug.
        if (!(error instanceof AppError)) throw error;
        skipped.push({
          fixture: fixture.name,
          backend: target.kind,
          reason: error.userMessage,
        });
      } finally {
        if (!existed) await target.backend.deleteDocument(docId);
      }
    }
  }

  const frozen = new Set(input.golden.map((g) => g.frozenAtCommit));
  const [onlyFrozen] = frozen;
  return {
    run: {
      runAt: now().toISOString(),
      commit: input.commit,
      goldenFrozenAtCommit: frozen.size === 1 ? (onlyFrozen ?? null) : null,
      rows,
    },
    extras,
    skipped,
    unmatchedGolden,
  };
}
