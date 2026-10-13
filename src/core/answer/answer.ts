/**
 * Answer assembly: build the prompt, stream the model's reply, then validate it.
 */
import {
  DECLINE_TEXT,
  type AnswerResult,
  type BillMetadata,
  type LlmProvider,
  type LlmUsage,
  type SearchHit,
} from '../model/index.js';
import { validateCitations } from './citations.js';
import { buildPrompt } from './prompt.js';
import { fleschKincaidGrade, stripCitations } from './readability.js';

export interface AnswerContext {
  /** Retrieved hits, best first. */
  hits: readonly SearchHit[];
  /** Definition chunks injected for defined terms used in the hits. */
  definitions?: readonly SearchHit[] | undefined;
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

export async function answer(input: AnswerInput): Promise<AnswerResult> {
  const { provider, context, onToken } = input;
  const base = { provider: provider.id, model: provider.model };

  const prompt = buildPrompt({
    question: input.question,
    hits: context.hits,
    definitions: context.definitions,
    metadata: context.metadata,
    chipInstruction: input.chipInstruction,
  });

  // Nothing to ground an answer in: decline without spending a model call.
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
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  for await (const event of provider.streamText({
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    maxTokens: input.maxTokens ?? 1024,
    temperature: 0,
    signal: input.signal,
  })) {
    if (event.type === 'text') {
      raw += event.text;
      onToken?.(event.text);
    } else {
      usage = event.usage;
    }
  }

  const sectionIds = new Set(prompt.hits.map((h) => h.chunk.sectionId));
  const validated = validateCitations(
    raw,
    sectionIds,
    prompt.hits.map((h) => h.chunk),
  );
  return {
    text: validated.text,
    citations: validated.citations,
    invalidCitations: validated.invalidCitations,
    warnings: validated.warnings,
    declined: validated.declined,
    readingGrade: fleschKincaidGrade(stripCitations(validated.text)),
    ...base,
    usage,
  };
}
