/**
 * "Section by section": one plain-language brief per substantive part of a bill.
 *
 * Briefs are written in batches by one structured model call per batch.
 *
 *   - WHOLE-BILL MODE. The model reads the whole bill. Every batch sends exactly the system
 *     prompt and first (cacheable) user part that whole-bill answers send, so the bill is
 *     written to the provider's prompt cache once and read from it afterwards. Only the second
 *     part (this batch's task and unit list) differs. Batches run one after another, because
 *     parallel batches would all miss the cache before the first one had written it.
 *   - EXCERPT MODE (a bill too large to read whole). Each part gets its own text, the
 *     definitions it uses and the sections it refers to (`buildUnitContext`); a batch is the
 *     excerpts of a few parts together.
 *
 * Whatever the model writes is checked like an answer: every `[S:...]` marker is validated
 * against the sections that were in the prompt (`validateCitations`), invalid markers are
 * removed, and a brief left with no valid citation is dropped. The model never chooses a
 * reading grade; we compute it.
 */
import { z } from 'zod';
import { coveredSectionIds, validateCitations } from '../answer/citations.js';
import { wholeBillEffort, type DocumentContext } from '../answer/context.js';
import {
  buildPrompt,
  promptVersion,
  WHOLE_SYSTEM_PROMPT,
} from '../answer/prompt.js';
import {
  PLAIN_LANGUAGE_INSTRUCTION,
  readingGradeCeiling,
  REGENERATION_TIMEOUT_MS,
  REGENERATION_VERSION,
  refuseRegeneration,
} from '../answer/regenerate.js';
import { fleschKincaidGrade, stripCitations } from '../answer/readability.js';
import { jsonSchema, validateObject } from '../llm/shared.js';
import {
  AppError,
  type AnswerWarning,
  type LlmProvider,
  type NormalizedDoc,
  type RetrievalBackend,
  type SearchHit,
  type Section,
  type SectionBrief,
  walkSections,
} from '../model/index.js';
import { buildUnitContext, unitExcerpts } from './context.js';
import { UNIT_RULES_VERSION } from './units.js';

/** Parts per model call when the whole bill is in the prompt: each brief is short. */
export const WHOLE_BATCH_SIZE = 10;
/** Parts per call in excerpt mode: each part brings its own text, definitions and references. */
export const EXCERPT_BATCH_SIZE = 4;
/** Output budget per call; a brief is at most three sentences. */
const BATCH_MAX_TOKENS = 6000;
/** A brief longer than this is not "one to three sentences"; drop it rather than show a wall. */
export const MAX_BRIEF_CHARS = 1200;

export const BREAKDOWN_INSTRUCTION =
  'For each part of the bill listed in the question, write a brief of what that part does: one to three short sentences in plain words, at about a 7th-grade reading level. Use only that part\'s own text, plus the definitions and the cross-referenced sections it relies on. End every sentence that states a fact with the section marker [S:<section>], copied exactly from a section attribute, and prefer the part\'s own section. If the part strikes or replaces old wording, say what the bill removes or replaces; never describe struck text as something the bill requires. Return one entry for each listed part, with its id copied exactly as listed. Set example to "available" only when the part\'s text lets you write a concrete, honest example about one person or one business it affects (it says who must do, may get, or cannot do something); otherwise set example to "none". Do not say whether a part is good or bad, and give no advice.';

/** The structured reply for one batch. Ids are matched against the batch; strays are ignored. */
export const BriefBatch = z.object({
  briefs: z
    .array(
      z.object({
        id: z.string().min(1).max(300),
        text: z
          .string()
          .min(1)
          .max(MAX_BRIEF_CHARS * 2),
        example: z.enum(['available', 'none']),
      }),
    )
    .max(WHOLE_BATCH_SIZE * 2),
});
export type BriefBatch = z.infer<typeof BriefBatch>;

/** Changing the prompts, reading rules or batching invalidates cached breakdowns. */
export function breakdownPromptVersion(
  ceiling = readingGradeCeiling(),
): string {
  return promptVersion(
    BREAKDOWN_INSTRUCTION,
    WHOLE_SYSTEM_PROMPT,
    JSON.stringify({
      whole: WHOLE_BATCH_SIZE,
      excerpt: EXCERPT_BATCH_SIZE,
      max: MAX_BRIEF_CHARS,
      units: UNIT_RULES_VERSION,
      ceiling,
      regeneration: REGENERATION_VERSION,
    }),
  );
}

export const BREAKDOWN_PROMPT_VERSION = breakdownPromptVersion();

export interface BriefRegenerationEvent {
  event: 'brief_regeneration';
  rewritten: number;
  refused: number;
}
export type BreakdownLog = (event: BriefRegenerationEvent) => void;

export interface BreakdownInput {
  provider: LlmProvider;
  log?: BreakdownLog | undefined;
  docId: string;
  backend: RetrievalBackend;
  doc: Pick<
    NormalizedDoc,
    'metadata' | 'sections' | 'references' | 'externalRefs'
  >;
  context: DocumentContext;
  units: readonly Section[];
  signal?: AbortSignal | undefined;
  /** Called after each batch with every brief finished so far (for a partial view). */
  onProgress?: ((briefs: readonly SectionBrief[]) => void) | undefined;
}

export interface BreakdownOutput {
  briefs: SectionBrief[];
  /** Parts that got no brief: a batch that stayed malformed, or a brief that failed validation. */
  dropped: number;
  usage: { inputTokens: number; outputTokens: number };
  backendUsage: { embedTokens: number; rerankUnits: number };
}

function label(section: Section): string {
  const name = [
    section.num ? `Section ${section.num}` : '',
    section.heading ?? '',
  ]
    .filter(Boolean)
    .join(', ');
  return name || section.id;
}

/** The question for one batch. Headings are the bill's words; `buildPrompt` escapes them. */
function batchQuestion(units: readonly Section[]): string {
  return `Write the brief for each of these parts of the bill:\n${units
    .map((u) => `- id ${u.id}: ${label(u)}`)
    .join('\n')}`;
}

interface CheckedBrief {
  brief: SectionBrief;
  warnings: AnswerWarning[];
}

/** Validate one model brief against the sections that were in the prompt. */
function toBrief(
  unit: Section,
  raw: BriefBatch['briefs'][number],
  hits: readonly SearchHit[],
): CheckedBrief | undefined {
  const allowed = hits.flatMap((h) => coveredSectionIds(h.chunk));
  const checked = validateCitations(
    raw.text,
    allowed,
    hits.map((h) => h.chunk),
  );
  const citations = checked.citations.filter((c) => c.valid);
  const text = checked.text.trim();
  // Whole mode lets the model cite any section of the bill, so a brief must cite its own part
  // (or something inside it); otherwise two parts' briefs could be swapped unnoticed.
  const own = new Set([...walkSections([unit])].map((s) => s.id));
  // A brief with no valid citation is a claim with no source; a very long one is not a brief.
  if (
    !citations.some((c) => own.has(c.sectionId)) ||
    checked.declined ||
    text.length === 0 ||
    text.length > MAX_BRIEF_CHARS
  )
    return undefined;
  return {
    warnings: checked.warnings,
    brief: {
      sectionId: unit.id,
      ...(unit.num ? { num: unit.num } : {}),
      ...(unit.heading ? { heading: unit.heading } : {}),
      text,
      citations,
      readingGrade: fleschKincaidGrade(stripCitations(text)),
      example: raw.example,
    },
  };
}

export async function generateBreakdown(
  input: BreakdownInput,
): Promise<BreakdownOutput> {
  jsonSchema(BriefBatch);
  const ceiling = readingGradeCeiling();
  const whole = input.context.mode === 'whole';
  const size = whole ? WHOLE_BATCH_SIZE : EXCERPT_BATCH_SIZE;
  const briefs: SectionBrief[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let dropped = 0;
  const backendUsage = { embedTokens: 0, rerankUnits: 0 };

  for (let i = 0; i < input.units.length; i += size) {
    input.signal?.throwIfAborted();
    const batch = input.units.slice(i, i + size);
    let contextHits: readonly SearchHit[];
    if (whole) {
      contextHits = input.context.hits;
    } else {
      const contexts = [];
      for (const unit of batch) {
        input.signal?.throwIfAborted();
        const c = await buildUnitContext({
          backend: input.backend,
          docId: input.docId,
          doc: input.doc,
          unit,
          signal: input.signal,
        });
        backendUsage.embedTokens += c.usage.embedTokens;
        backendUsage.rerankUnits += c.usage.rerankUnits;
        contexts.push(c);
      }
      contextHits = contexts.flatMap(unitExcerpts);
    }
    const makePrompt = (units: readonly Section[], instruction: string) =>
      buildPrompt({
        mode: input.context.mode,
        question: batchQuestion(units),
        hits: contextHits,
        metadata: input.doc.metadata,
        chipInstruction: instruction,
      });
    const built = makePrompt(batch, BREAKDOWN_INSTRUCTION);
    const hits = built.hits;
    const call = async (
      prompt: typeof built,
      signal: AbortSignal | undefined = input.signal,
    ): Promise<BriefBatch> => {
      const result = await input.provider.generateObject({
        system: prompt.system,
        prompt: prompt.user,
        schema: BriefBatch,
        schemaName: 'section_briefs',
        maxTokens: BATCH_MAX_TOKENS,
        ...(whole ? { effort: wholeBillEffort() } : {}),
        signal,
      });
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      return validateObject(BriefBatch, result.object);
    };

    // One malformed reply is retried once; a batch that stays malformed loses its parts (they
    // are counted as dropped), not the whole breakdown. Anything else (a budget, an abort, a
    // provider outage) must stop the run.
    let reply: BriefBatch | undefined;
    for (let attempt = 0; attempt < 2 && !reply; attempt++) {
      try {
        reply = await call(built);
      } catch (error) {
        if (!(
          error instanceof AppError && error.code === 'PROVIDER_BAD_OUTPUT'
        ))
          throw error;
      }
    }
    if (!reply) {
      dropped += batch.length;
      continue;
    }

    // Match replies to the batch by id (a stray or repeated id is ignored), then keep the
    // bill's own order whatever order the model answered in.
    const byId = new Map(batch.map((u) => [u.id, u]));
    const finished = new Map<string, CheckedBrief>();
    for (const raw of reply.briefs) {
      const unit = byId.get(raw.id);
      if (!unit || finished.has(raw.id)) continue;
      const brief = toBrief(unit, raw, hits);
      if (brief) finished.set(raw.id, brief);
    }
    const difficult = batch.filter((unit) => {
      const grade = finished.get(unit.id)?.brief.readingGrade;
      return ceiling > 0 && grade != null && grade > ceiling;
    });
    if (difficult.length > 0) {
      let rewritten = 0;
      const timeout = AbortSignal.timeout(REGENERATION_TIMEOUT_MS);
      const signal = input.signal
        ? AbortSignal.any([input.signal, timeout])
        : timeout;
      try {
        const second = await call(
          makePrompt(
            difficult,
            `${BREAKDOWN_INSTRUCTION} ${PLAIN_LANGUAGE_INSTRUCTION}`,
          ),
          signal,
        );
        const seen = new Set<string>();
        for (const raw of second.briefs) {
          const unit = difficult.find((u) => u.id === raw.id);
          if (!unit || seen.has(raw.id)) continue;
          seen.add(raw.id);
          const first = finished.get(raw.id);
          const next = toBrief(unit, raw, hits);
          if (
            !first ||
            !next ||
            refuseRegeneration(
              { ...first.brief, warnings: first.warnings, declined: false },
              { ...next.brief, warnings: next.warnings, declined: false },
              hits,
            )
          )
            continue;
          finished.set(raw.id, {
            ...next,
            brief: { ...next.brief, example: first.brief.example },
          });
          rewritten++;
        }
      } catch (error) {
        if (input.signal?.aborted) throw error;
        // A failed optional rewrite must not discard validated briefs. A call that never
        // returned usage may still have been billed; its cost is unknown to us.
      }
      input.log?.({
        event: 'brief_regeneration',
        rewritten,
        refused: difficult.length - rewritten,
      });
    }
    for (const unit of batch) {
      const brief = finished.get(unit.id);
      if (brief) briefs.push(brief.brief);
      else dropped++;
    }
    input.onProgress?.([...briefs]);
  }
  return { briefs, dropped, usage, backendUsage };
}
