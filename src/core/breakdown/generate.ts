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
  SYSTEM_PROMPT,
  WHOLE_SYSTEM_PROMPT,
} from '../answer/prompt.js';
import { fleschKincaidGrade, stripCitations } from '../answer/readability.js';
import { jsonSchema, validateObject } from '../llm/shared.js';
import {
  AppError,
  type LlmProvider,
  type NormalizedDoc,
  type RetrievalBackend,
  type SearchHit,
  type Section,
  type SectionBrief,
} from '../model/index.js';
import { buildUnitContext, unitExcerpts } from './context.js';

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

/** Changing the instruction, batching or either system prompt invalidates cached breakdowns. */
export const BREAKDOWN_PROMPT_VERSION = promptVersion(
  BREAKDOWN_INSTRUCTION,
  WHOLE_SYSTEM_PROMPT,
  JSON.stringify({
    whole: WHOLE_BATCH_SIZE,
    excerpt: EXCERPT_BATCH_SIZE,
    max: MAX_BRIEF_CHARS,
  }),
);

export interface BreakdownInput {
  provider: LlmProvider;
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

/** Validate one model brief against the sections that were in the prompt. */
function toBrief(
  unit: Section,
  raw: BriefBatch['briefs'][number],
  hits: readonly SearchHit[],
): SectionBrief | undefined {
  const allowed = hits.flatMap((h) => coveredSectionIds(h.chunk));
  const checked = validateCitations(
    raw.text,
    allowed,
    hits.map((h) => h.chunk),
  );
  const citations = checked.citations.filter((c) => c.valid);
  const text = checked.text.trim();
  // A brief with no valid citation is a claim with no source; a very long one is not a brief.
  if (
    citations.length === 0 ||
    checked.declined ||
    text.length === 0 ||
    text.length > MAX_BRIEF_CHARS
  )
    return undefined;
  return {
    sectionId: unit.id,
    ...(unit.num ? { num: unit.num } : {}),
    ...(unit.heading ? { heading: unit.heading } : {}),
    text,
    citations,
    readingGrade: fleschKincaidGrade(stripCitations(text)),
    example: raw.example,
  };
}

export async function generateBreakdown(
  input: BreakdownInput,
): Promise<BreakdownOutput> {
  jsonSchema(BriefBatch);
  const whole = input.context.mode === 'whole';
  const size = whole ? WHOLE_BATCH_SIZE : EXCERPT_BATCH_SIZE;
  const briefs: SectionBrief[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const backendUsage = { embedTokens: 0, rerankUnits: 0 };

  for (let i = 0; i < input.units.length; i += size) {
    input.signal?.throwIfAborted();
    const batch = input.units.slice(i, i + size);
    let hits: SearchHit[];
    let system: string;
    let prompt: Parameters<LlmProvider['generateObject']>[0]['prompt'];
    if (whole) {
      const built = buildPrompt({
        mode: 'whole',
        question: batchQuestion(batch),
        hits: input.context.hits,
        metadata: input.doc.metadata,
        chipInstruction: BREAKDOWN_INSTRUCTION,
      });
      hits = built.hits;
      system = built.system;
      prompt = built.user;
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
      const built = buildPrompt({
        question: batchQuestion(batch),
        hits: contexts.flatMap(unitExcerpts),
        metadata: input.doc.metadata,
        chipInstruction: BREAKDOWN_INSTRUCTION,
      });
      hits = built.hits;
      system = SYSTEM_PROMPT;
      prompt = built.user;
    }

    let reply: BriefBatch;
    try {
      const result = await input.provider.generateObject({
        system,
        prompt,
        schema: BriefBatch,
        schemaName: 'section_briefs',
        maxTokens: BATCH_MAX_TOKENS,
        ...(whole ? { effort: wholeBillEffort() } : {}),
        signal: input.signal,
      });
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      reply = validateObject(BriefBatch, result.object);
    } catch (error) {
      // One malformed batch loses its parts, not the whole breakdown. Anything else (a budget,
      // an abort, a provider outage) must stop the run.
      if (error instanceof AppError && error.code === 'PROVIDER_BAD_OUTPUT')
        continue;
      throw error;
    }

    // Match replies to the batch by id (a stray or repeated id is ignored), then keep the
    // bill's own order whatever order the model answered in.
    const byId = new Map(batch.map((u) => [u.id, u]));
    const finished = new Map<string, SectionBrief>();
    for (const raw of reply.briefs) {
      const unit = byId.get(raw.id);
      if (!unit || finished.has(raw.id)) continue;
      const brief = toBrief(unit, raw, hits);
      if (brief) finished.set(raw.id, brief);
    }
    for (const unit of batch) {
      const brief = finished.get(unit.id);
      if (brief) briefs.push(brief);
    }
    input.onProgress?.([...briefs]);
  }
  return { briefs, usage, backendUsage };
}
