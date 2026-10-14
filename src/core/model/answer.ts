/**
 * Answers and chips. An answer is generated only from retrieved excerpts, cites every claim as
 * `[S:<sectionId>]`, and is validated against the retrieved set before it is shown.
 */
import { z } from 'zod';
import { ChunkFilter } from './chunk.js';
import { Scenario } from './scenario.js';
import { SectionId, SourceLocation } from './doc.js';

/**
 * Matches one citation marker in answer text, e.g. `[S:sec-4/b/2]`. It is global, so prefer
 * `findCitationIds`, which never shares `lastIndex` state between calls.
 */
export const CITATION_PATTERN = /\[S:([^\]\s]+)\]/g;

/** Section ids cited in `text`, in order of appearance (duplicates kept). */
export function findCitationIds(text: string): string[] {
  return Array.from(
    text.matchAll(new RegExp(CITATION_PATTERN.source, 'g')),
    (m) => m[1] ?? '',
  ).filter(Boolean);
}

export const Citation = z.object({
  sectionId: SectionId,
  /** True when the section is in the retrieved set given to the model. */
  valid: z.boolean(),
  /** Retrieved chunks from that section (for the excerpt drawer). */
  chunkIds: z.array(z.string()),
  breadcrumb: z.string().optional(),
  location: SourceLocation.optional(),
});
export type Citation = z.infer<typeof Citation>;

export const AnswerWarning = z.enum([
  /** No valid citations and the answer is not a "not addressed" decline. */
  'NO_VALID_CITATIONS',
  /** One or more citations pointed outside the retrieved set and were removed. */
  'INVALID_CITATIONS_REMOVED',
  /** Retrieval found nothing relevant. */
  'NO_RELEVANT_EXCERPTS',
  /** The model hit its output-token limit; the answer may be cut off. Added in #59. */
  'TRUNCATED',
]);
export type AnswerWarning = z.infer<typeof AnswerWarning>;

export const AnswerResult = z.object({
  /** Final text with invalid citation markers removed. */
  text: z.string(),
  citations: z.array(Citation),
  invalidCitations: z.array(z.string()),
  warnings: z.array(AnswerWarning),
  /** The model said the document doesn't address the question. */
  declined: z.boolean(),
  /** Flesch-Kincaid grade level of `text` (citation markers stripped). */
  readingGrade: z.number().nullable(),
  provider: z.string(),
  model: z.string(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  /** Optional illustrated example; every frame cites sections of the bill. */
  scenario: Scenario.optional(),
});
export type AnswerResult = z.infer<typeof AnswerResult>;

/** The exact sentence the model must use to decline (also detected to set `declined`). */
export const DECLINE_TEXT = "This document doesn't address that question.";

// ---------------------------------------------------------------------------------------------
// Chips (spec §3.3). Definitions live in src/core/chips.ts; this is their shape.
// ---------------------------------------------------------------------------------------------

export const ChipId = z.enum([
  'summary',
  'what-changes',
  'who-affected',
  'penalties',
  'effective-date',
  'money',
  'definitions',
  'sponsors',
  /** Bill history from official sources. Not served until #128 implements it. */
  'history',
  /** "Who decides later": delegated decisions and outside dependencies. Not served until #202. */
  'delegations',
]);
export type ChipId = z.infer<typeof ChipId>;

export const ChipStrategy = z.enum([
  /** Retrieve with the chip's queries/filters, then answer. */
  'retrieve',
  /** Structural outline + first chunk of each top-level section; capped map-reduce for long docs. */
  'outline',
  /** List definition chunks; no free retrieval. */
  'definitions',
  /** Answer from document metadata only; no retrieval and no LLM call. */
  'metadata',
  /** Structured extraction over the whole document (delegations). Not served until #202. */
  'extract',
]);
export type ChipStrategy = z.infer<typeof ChipStrategy>;

export const ChipDefinition = z.object({
  id: ChipId,
  label: z.string(),
  strategy: ChipStrategy,
  /** One or more retrieval queries; results are merged. */
  queries: z.array(z.string()),
  filter: ChunkFilter.optional(),
  retrieval: z
    .object({
      mode: z.enum(['dense', 'sparse', 'hybrid', 'hybrid_rerank']).optional(),
      /** 0..1 weight on sparse results for weighted fusion (e.g. penalties, effective-date). */
      sparseWeight: z.number().min(0).max(1).optional(),
      topK: z.number().int().positive().optional(),
      /** Include struck-text chunks (what-changes). */
      includeDeleted: z.boolean().optional(),
    })
    .optional(),
  /** Extra instruction appended to the user prompt for this chip. */
  answerInstruction: z.string().optional(),
});
export type ChipDefinition = z.infer<typeof ChipDefinition>;
