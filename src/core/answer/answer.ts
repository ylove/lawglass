/**
 * Answer assembly: build the prompt, stream the model's reply, then validate it.
 */
import {
  AppError,
  DECLINE_TEXT,
  type AnswerResult,
  type BillMetadata,
  type LlmProvider,
  type LlmUsage,
  type ReferenceText,
  type SearchHit,
} from '../model/index.js';
import { coveredSectionIds, validateCitations } from './citations.js';
import { createEchoGuard, echoesSystemPrompt } from './echo.js';
import { wholeBillEffort, type ContextMode } from './context.js';
import { buildPrompt } from './prompt.js';
import { referenceHeading, selectReferences } from './references.js';
import { fleschKincaidGrade, stripCitations } from './readability.js';

export interface AnswerContext {
  mode?: ContextMode | undefined;
  /** Retrieved hits, best first. */
  hits: readonly SearchHit[];
  /** Definition chunks injected for defined terms used in the hits. */
  definitions?: readonly SearchHit[] | undefined;
  /**
   * Every reference text the document has (U.S. Code definitions read at ingest). The ones
   * worth showing are chosen here: all of them reading the whole bill, else those whose terms
   * appear in the hits.
   */
  references?: readonly ReferenceText[] | undefined;
  metadata?: BillMetadata | undefined;
}

export interface AnswerInput {
  provider: LlmProvider;
  question: string;
  context: AnswerContext;
  chipInstruction?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Called with each streamed piece. The final text may differ (invalid markers stripped). */
  onToken?: ((text: string) => void) | undefined;
  maxTokens?: number | undefined;
}

/** Provider stop reasons meaning the reply was cut off: Anthropic, OpenAI ('length'), Google ('MAX_TOKENS'). */
const TRUNCATION_STOP_REASONS = new Set([
  'max_tokens',
  'model_context_window_exceeded',
  'length',
  'MAX_TOKENS',
]);

export async function answer(input: AnswerInput): Promise<AnswerResult> {
  input.signal?.throwIfAborted();
  const { provider, context, onToken } = input;
  const base = { provider: provider.id, model: provider.model };

  const prompt = buildPrompt({
    question: input.question,
    mode: context.mode,
    hits: context.hits,
    definitions: context.definitions,
    references: selectReferences(
      context.references,
      [...context.hits, ...(context.definitions ?? [])],
      context.mode,
    ),
    metadata: context.metadata,
    chipInstruction: input.chipInstruction,
  });

  // Nothing to ground an answer in (in either mode, e.g. a bill with no live text): decline
  // without spending a model call.
  if (prompt.hits.length === 0) {
    onToken?.(DECLINE_TEXT);
    return {
      text: DECLINE_TEXT,
      citations: [],
      invalidCitations: [],
      warnings: ['NO_RELEVANT_EXCERPTS'],
      declined: true,
      readingGrade: fleschKincaidGrade(DECLINE_TEXT),
      ...base,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  let raw = '';
  const guard = createEchoGuard(prompt.system);
  let streamedAny = false;
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: string | null = null;
  let finished = false;
  for await (const event of provider.streamText({
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    maxTokens: input.maxTokens ?? (context.mode === 'whole' ? 16_000 : 8192),
    ...(context.mode === 'whole' ? { effort: wholeBillEffort() } : {}),
    signal: input.signal,
  })) {
    if (event.type === 'text') {
      raw += event.text;
      // Never stream a recited system prompt; the final text is replaced by a decline below.
      const safe = guard.push(event.text);
      if (safe) {
        streamedAny = true;
        onToken?.(safe);
      }
    } else {
      usage = event.usage;
      stopReason = event.stopReason;
      finished = true;
    }
  }
  if (!finished) throw new AppError('PROVIDER_BAD_OUTPUT');
  const truncated =
    stopReason !== null && TRUNCATION_STOP_REASONS.has(stopReason);
  if (truncated) {
    raw = `${raw.trimEnd()}…`;
  }

  const sectionIds = new Set([
    ...prompt.hits.flatMap((h) => coveredSectionIds(h.chunk)),
    ...prompt.references.map((r) => r.sectionId),
  ]);
  const validated = validateCitations(
    raw,
    sectionIds,
    prompt.hits.map((h) => h.chunk),
    prompt.references.map((r) => ({
      sectionId: r.sectionId,
      breadcrumb: referenceHeading(r),
    })),
  );
  // After citation validation, so the check sees the text the user would get. The streaming
  // guard keeps a recited run from reaching `onToken`; the final text is what callers store.
  const echoed = echoesSystemPrompt(validated.text, prompt.system);
  if (!echoed) {
    // The guard may have paused streaming on a lookalike; catch the consumer up.
    const rest = guard.withheld();
    if (rest) onToken?.(rest);
    if (truncated) onToken?.('…');
  }
  if (echoed) {
    // Consumers that print only streamed tokens (the CLI) would otherwise show a cut-off answer.
    onToken?.(streamedAny ? `\n${DECLINE_TEXT}` : DECLINE_TEXT);
    return {
      text: DECLINE_TEXT,
      citations: [],
      // The echo's example markers are still invented ids; report them like any other.
      invalidCitations: validated.invalidCitations,
      warnings:
        validated.invalidCitations.length > 0
          ? ['INVALID_CITATIONS_REMOVED']
          : [],
      declined: true,
      readingGrade: fleschKincaidGrade(DECLINE_TEXT),
      ...base,
      usage,
    };
  }
  return {
    text: validated.text,
    citations: validated.citations,
    invalidCitations: validated.invalidCitations,
    warnings: truncated
      ? [...validated.warnings, 'TRUNCATED']
      : validated.warnings,
    declined: validated.declined,
    readingGrade: fleschKincaidGrade(stripCitations(validated.text)),
    ...base,
    usage,
    context: context.mode ?? 'excerpts',
  };
}
