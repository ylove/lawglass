/**
 * HTTP API + SSE event contracts between src/server (Hono) and src/web (React).
 * The server validates requests with these schemas; the web client validates events.
 *
 * Routes:
 *   GET    /api/health                              -> Health
 *   GET    /api/config                              -> ClientConfig
 *   POST   /api/ingest            IngestRequest     -> SSE stream of IngestEvent
 *   GET    /api/docs                                -> DocSummary[]
 *   GET    /api/docs/:docId                         -> DocDetail
 *   DELETE /api/docs/:docId                         -> 204
 *   GET    /api/docs/:docId/sections/:sectionId     -> SectionExcerpt   (sectionId URL-encoded)
 *   GET    /api/docs/:docId/summary                 -> SummaryResponse (future)
 *   POST   /api/docs/:docId/ask   AskRequest        -> SSE stream of AskEvent
 *   POST   /api/docs/:docId/scenario ScenarioRequest -> ScenarioResponse
 *   GET    /api/docs/:docId/breakdown               -> BreakdownResponse  (v1.1)
 *   GET    /api/docs/:docId/sections/:sectionId/example -> ScenarioResponse (v1.1)
 *   POST   /api/docs/:docId/locate  LocateRequest    -> LocateResponse     (v1.1)
 *   POST   /api/docs/:docId/locate/versions LocateRequest -> LocateVersionsResponse (v1.1)
 */
import { z } from 'zod';
import { AnswerResult, ChipId, Citation } from './answer.js';
import { ChunkType } from './chunk.js';
import { BillHistory } from './history.js';
import { Scenario } from './scenario.js';
import {
  BillMetadata,
  DocFormat,
  ScanStatus,
  ExternalRef,
  HttpsUrl,
  SectionId,
  SourceLocation,
  Span,
} from './doc.js';

export const Health = z.object({ ok: z.literal(true), version: z.string() });
export type Health = z.infer<typeof Health>;

/** What the UI needs to know about the server's mode. */
export const ClientConfig = z.object({
  productName: z.string(),
  publicMode: z.boolean(),
  freeformEnabled: z.boolean(),
  backend: z.enum(['pinecone', 'local']),
  provider: z.string(),
  model: z.string(),
  chips: z.array(z.object({ id: ChipId, label: z.string() })),
  /**
   * False in public mode, where scenarios are not offered. Defaults to false so a config
   * response from an older server (no field) still parses and hides the feature.
   */
  scenariosEnabled: z.boolean().default(false),
  /** Public-mode bot-check site key (Turnstile); absent when not configured. */
  turnstileSiteKey: z.string().optional(),
  /**
   * Whose document list `GET /api/docs` returns: `local` (everything on this machine) or
   * `reader` (hosted modes: only what this reader added; removing takes it off their list).
   * Absent from older servers, which behave as `local`.
   */
  library: z.enum(['local', 'reader']).optional(),
  /** Example bills the homepage offers, chosen by whoever runs the server. */
  examples: z
    .array(z.object({ label: z.string().min(1).max(80), url: z.url() }))
    .max(6)
    .optional(),
  /** "Section by section" and per-section examples. Defaults to off for older servers. */
  breakdownEnabled: z.boolean().default(false),
  /** "Find where it says that". Defaults to off for older servers. */
  locateEnabled: z.boolean().default(false),
});
export type ClientConfig = z.infer<typeof ClientConfig>;

export const IngestRequest = z.object({
  url: z.url(),
  label: z.string().trim().min(1).max(80).optional(),
  /** Public-mode bot check token (Turnstile stub). */
  turnstileToken: z.string().optional(),
});
export type IngestRequest = z.infer<typeof IngestRequest>;

export const IngestStage = z.enum([
  'fetching',
  'parsing',
  'enriching',
  'chunking',
  'embedding',
  'done',
]);
export type IngestStage = z.infer<typeof IngestStage>;

export const IngestStats = z.object({
  format: DocFormat,
  sectionCount: z.number().int(),
  chunkCountsByType: z.record(ChunkType, z.number().int()),
  insertedSpanCount: z.number().int(),
  deletedSpanCount: z.number().int(),
  externalRefCount: z.number().int(),
  embedTokens: z.number().int(),
  /** True when the doc was already indexed and nothing was spent. */
  reused: z.boolean(),
});
export type IngestStats = z.infer<typeof IngestStats>;

export const DocSummary = z.object({
  docId: z.string(),
  label: z.string(),
  sourceUrl: z.string(),
  format: DocFormat,
  title: z.string().nullable(),
  billNumber: z.string().nullable(),
  ingestedAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  backend: z.enum(['pinecone', 'local']),
});
export type DocSummary = z.infer<typeof DocSummary>;

/** A candidate document link found on a wrapper page (user picks one; never auto-followed). */
export const CandidateLink = z.object({
  url: z.url(),
  text: z.string(),
  format: z.enum(['pdf', 'xml', 'html', 'text', 'unknown']),
});
export type CandidateLink = z.infer<typeof CandidateLink>;

export const ErrorPayload = z.object({ code: z.string(), message: z.string() });
export type ErrorPayload = z.infer<typeof ErrorPayload>;

export const IngestEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    stage: IngestStage,
    detail: z.string().optional(),
    done: z.number().optional(),
    total: z.number().optional(),
  }),
  z.object({ type: z.literal('candidates'), links: z.array(CandidateLink) }),
  z.object({ type: z.literal('done'), doc: DocSummary, stats: IngestStats }),
  z.object({ type: z.literal('error'), error: ErrorPayload }),
]);
export type IngestEvent = z.infer<typeof IngestEvent>;

export const OutlineItem = z.object({
  id: SectionId,
  num: z.string().optional(),
  heading: z.string().optional(),
  level: z.number().int(),
});
export type OutlineItem = z.infer<typeof OutlineItem>;

export const DocDetail = z.object({
  doc: DocSummary,
  metadata: BillMetadata,
  outline: z.array(OutlineItem),
  externalRefs: z.array(ExternalRef),
  warnings: z.array(z.string()),
  /** False for XML/HTML: citations are section-only (no printed line numbers). */
  hasLineNumbers: z.boolean(),
  /** Official history (summary, versions, actions, amendments), when available. */
  history: BillHistory.optional(),
  /**
   * Public pages on the official site where the full record lives, derived at request time
   * from the document's own source (so history cached before this field existed gets them).
   * Always https on the official host; absent when the source is not understood.
   */
  historyLinks: z
    .object({
      /** Every recorded action, e.g. Congress.gov "All Actions". */
      actions: HttpsUrl.optional(),
      /** Every amendment, e.g. Congress.gov "Amendments". */
      amendments: HttpsUrl.optional(),
    })
    .optional(),
  /** One-line "what is this bill" shown before any question is asked. */
  preview: z
    .object({
      kind: z.enum(['purpose', 'title']),
      text: z.string(),
      sectionId: SectionId.optional(),
    })
    .optional(),
  /** Per-page read quality for scanned PDFs. */
  scan: ScanStatus.optional(),
  /** Suggested subjects for the scenario picker. */
  scenarioPersonas: z.array(z.string()).optional(),
});
export type DocDetail = z.infer<typeof DocDetail>;

export const SectionExcerpt = z.object({
  sectionId: SectionId,
  breadcrumb: z.string(),
  num: z.string().optional(),
  heading: z.string().optional(),
  spans: z.array(Span),
  location: SourceLocation,
  /** Set when the section is another law's text read for this document (`ReferenceText`). */
  reference: z.object({ citation: z.string(), url: z.url() }).optional(),
});
export type SectionExcerpt = z.infer<typeof SectionExcerpt>;

export const AskRequest = z
  .object({
    chipId: ChipId.optional(),
    /** Freeform question; rejected in public mode. */
    question: z.string().trim().min(1).max(500).optional(),
    turnstileToken: z.string().optional(),
  })
  .refine((r) => (r.chipId === undefined) !== (r.question === undefined), {
    message: 'Provide exactly one of chipId or question',
  });
export type AskRequest = z.infer<typeof AskRequest>;

/** `POST /api/docs/:docId/scenario`: an illustrated example for one subject. */
export const ScenarioRequest = z.object({
  subject: z.string().trim().min(1).max(80),
});
export type ScenarioRequest = z.infer<typeof ScenarioRequest>;

export const ScenarioResponse = z.object({
  /** `pending` (v1.1): a per-section example is being made; ask again. */
  status: z.enum(['ok', 'none', 'disabled', 'pending']),
  scenario: Scenario.optional(),
  /** With `none`: one plain sentence on why this part has no example. Written by our code. */
  note: z.string().optional(),
});
export type ScenarioResponse = z.infer<typeof ScenarioResponse>;

/**
 * One part of the bill in plain words ("Section by section"). `text` carries `[S:]` markers
 * validated like an answer's; `example` says whether a per-section example can be asked for.
 */
export const SectionBrief = z.object({
  sectionId: SectionId,
  num: z.string().optional(),
  heading: z.string().optional(),
  text: z.string(),
  citations: z.array(Citation),
  readingGrade: z.number().nullable(),
  example: z.enum(['available', 'none']),
});
export type SectionBrief = z.infer<typeof SectionBrief>;

/** Response for `GET /api/docs/:docId/breakdown`. */
export const BreakdownResponse = z.object({
  status: z.enum(['cached', 'pending', 'disabled']),
  briefs: z.array(SectionBrief).optional(),
  /** Substantive parts left out of a long bill's breakdown. */
  omitted: z.number().int().nonnegative().optional(),
});
export type BreakdownResponse = z.infer<typeof BreakdownResponse>;

export const RetrievedRef = z.object({
  chunkId: z.string(),
  sectionId: SectionId,
  breadcrumb: z.string(),
  score: z.number(),
  injectedDefinition: z.boolean(),
});
export type RetrievedRef = z.infer<typeof RetrievedRef>;

export const AskEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('retrieval'),
    mode: z.string(),
    refs: z.array(RetrievedRef),
    latencyMs: z.number(),
  }),
  z.object({ type: z.literal('token'), text: z.string() }),
  z.object({ type: z.literal('scenario'), scenario: Scenario }),
  z.object({ type: z.literal('done'), answer: AnswerResult }),
  z.object({ type: z.literal('error'), error: ErrorPayload }),
]);
export type AskEvent = z.infer<typeof AskEvent>;

/** Response for `GET /api/docs/:docId/summary`: a cached summary, one being made, or off. */
export const SummaryResponse = z.object({
  status: z.enum(['cached', 'pending', 'disabled']),
  answer: AnswerResult.optional(),
});
export type SummaryResponse = z.infer<typeof SummaryResponse>;

// ---------------------------------------------------------------------------------------------
// "Find where it says that" (v1.1, #295): a reader pastes someone else's sentence about the bill
// (a press release, a headline, a post) and gets the passage that addresses it. The quoted words
// are always copied from the section's own spans, never written by the model, and the label is
// computed from span status, never chosen by the model. There is no true/false verdict.
// ---------------------------------------------------------------------------------------------

export const LocateRequest = z.object({
  text: z.string().trim().min(3).max(500),
  /** Public-mode bot check token (Turnstile). */
  turnstileToken: z.string().optional(),
});
export type LocateRequest = z.infer<typeof LocateRequest>;

/**
 * What the matching words are, read from their spans: `added` (inserted by this bill), `removed`
 * (struck by this bill), `changed` (both), `existing` (current law the bill reprints unchanged;
 * only for bills that mark their changes), `in-bill` (the bill's own text, no change marks).
 */
export const LocateLabel = z.enum([
  'added',
  'removed',
  'changed',
  'existing',
  'in-bill',
]);
export type LocateLabel = z.infer<typeof LocateLabel>;

export const LocateMatch = z.object({
  sectionId: SectionId,
  breadcrumb: z.string(),
  /** The exact words with their status, copied from the section's spans. */
  quote: z.array(Span).min(1),
  label: LocateLabel,
  /** One plain sentence on what the passage says, with `[S:]` markers validated like an answer. */
  explanation: z.string(),
  citations: z.array(Citation),
  /** A condition, exception or "subject to" the passage carries, in plain words. */
  conditions: z.string().optional(),
  /** The law the passage changes, as the bill names it, e.g. "42 U.S.C. 1395". */
  amends: z.string().optional(),
  location: SourceLocation,
});
export type LocateMatch = z.infer<typeof LocateMatch>;

export const LocateResponse = z.object({
  /** `not-found`: no passage addresses the sentence. Never shown as "false". */
  status: z.enum(['found', 'not-found', 'disabled']),
  /** Best first, at most 3. */
  matches: z.array(LocateMatch).max(3),
  /** With `not-found`: what the bill does say on the topic, cited, when it says anything. */
  note: z.string().optional(),
  noteCitations: z.array(Citation).optional(),
  readingGrade: z.number().nullable().optional(),
  provider: z.string(),
  model: z.string(),
});
export type LocateResponse = z.infer<typeof LocateResponse>;

/** "Check earlier versions": plain text matching across the official versions, no model call. */
export const LocateVersionsResponse = z.object({
  status: z.enum(['ok', 'unavailable', 'disabled']),
  versions: z.array(
    z.object({
      label: z.string(),
      date: z.string().optional(),
      url: z.url(),
      /** How much of the sentence's wording this version contains, 0..1. */
      overlap: z.number().min(0).max(1),
      /** The best-matching passage in that version, as printed (plain text). */
      excerpt: z.string().optional(),
    }),
  ),
});
export type LocateVersionsResponse = z.infer<typeof LocateVersionsResponse>;
