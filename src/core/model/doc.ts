/**
 * The normalized document model: every parser (XML, HTML, PDF, text) produces a
 * `NormalizedDoc`, and everything downstream (chunking, enrichment, citations, the UI's
 * excerpt drawer) reads only this shape. Frozen contract: see docs/decisions/0005.
 */
import { z } from 'zod';

/**
 * A section id as used in citations `[S:<id>]`: a non-empty path with no whitespace and no
 * square brackets (e.g. "sec-4/b/2", "sec-5747.01/a"). Every contract field holding a section
 * id uses this schema, so an id that parses can always be cited and matched back.
 */
export const SectionId = z
  .string()
  .regex(
    /^[^\s[\]]+$/,
    'section ids must be non-empty with no whitespace or brackets',
  );
export type SectionId = z.infer<typeof SectionId>;

export const DocFormat = z.enum(['xml', 'html', 'pdf', 'text']);
export type DocFormat = z.infer<typeof DocFormat>;

/** Amendment markup on a run of text. `deleted` = struck text, `inserted` = underlined/new text. */
export const SpanStatus = z.enum(['unchanged', 'inserted', 'deleted']);
export type SpanStatus = z.infer<typeof SpanStatus>;

/**
 * A run of text with one amendment status. `page`/`line` give where the run starts in the
 * printed source (PDFs with line numbers); they are absent for XML/HTML/text.
 */
export const Span = z.object({
  text: z.string(),
  status: SpanStatus,
  page: z.number().int().positive().optional(),
  line: z.number().int().positive().optional(),
});
export type Span = z.infer<typeof Span>;

/** Where something sits in the printed source. All fields optional: XML/HTML have no pages or lines. */
export const SourceLocation = z.object({
  pageStart: z.number().int().positive().optional(),
  pageEnd: z.number().int().positive().optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
});
export type SourceLocation = z.infer<typeof SourceLocation>;

/**
 * A node in the section tree. `id` is a stable path built from section numbers
 * (e.g. "sec-4/b/2"), unique within the document, safe to use in citations `[S:<id>]`.
 */
export interface Section extends SourceLocation {
  id: string;
  /** Number as printed, e.g. "4(b)(2)", "5747.01", "101". */
  num?: string | undefined;
  heading?: string | undefined;
  /** Depth in the tree; top-level sections are 1. */
  level: number;
  /** This section's own text (not its children's). */
  spans: Span[];
  children: Section[];
}
export const Section: z.ZodType<Section> = z.lazy(() =>
  SourceLocation.extend({
    id: SectionId,
    num: z.string().optional(),
    heading: z.string().optional(),
    level: z.number().int().positive(),
    spans: z.array(Span),
    children: z.array(Section),
  }),
);

/** Where a sponsor link points. `search` links are never verified (they are only a search URL). */
export const SponsorLinkKind = z.enum([
  'official',
  'wikipedia',
  'ballotpedia',
  'legislature',
  'search',
]);
export type SponsorLinkKind = z.infer<typeof SponsorLinkKind>;

/** An absolute `https:` URL. The one place the rule lives; used by sponsor links and bill history. */
export const HttpsUrl = z.string().refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an https URL');
export type HttpsUrl = z.infer<typeof HttpsUrl>;

/** A link about a sponsor. HTTPS only; `verified` means an official record confirmed it. */
export const SponsorLink = z
  .object({
    kind: SponsorLinkKind,
    url: HttpsUrl,
    label: z.string().min(1),
    verified: z.boolean(),
  })
  .refine((l) => l.kind !== 'search' || !l.verified, {
    message: 'a search link can never be verified',
    path: ['verified'],
  });
export type SponsorLink = z.infer<typeof SponsorLink>;

/**
 * A sponsor or cosponsor as the official record describes them. Profiles come only from
 * official records (e.g. Congress.gov, a state legislature API), never from the LLM.
 */
export const SponsorProfile = z.object({
  name: z.string().min(1),
  role: z.enum(['sponsor', 'cosponsor']),
  party: z.string().optional(),
  state: z.string().optional(),
  district: z.string().optional(),
  chamber: z.enum(['house', 'senate', 'assembly', 'other']).optional(),
  /** Congress.gov member id. */
  bioguideId: z.string().optional(),
  /** State legislature member id. */
  memberId: z.string().optional(),
  links: z.array(SponsorLink),
});
export type SponsorProfile = z.infer<typeof SponsorProfile>;

/** What kind of document this is: a bill, or a local measure such as a charter amendment. */
export const DocKind = z.enum([
  'bill',
  'resolution',
  'charter_amendment',
  'ballot_issue',
  'ordinance',
  'other',
]);
export type DocKind = z.infer<typeof DocKind>;

/** The law a document amends, e.g. {name: "Revised Code", sections: ["5747.01"]}. */
export const AmendsTarget = z.object({
  name: z.string().min(1),
  jurisdiction: z.string().optional(),
  sections: z.array(z.string()),
  /**
   * Ids of the document's own sections that reprint amended text (struck or inserted), so a
   * UI can link a listed number to the reprinted section and never to a section of the
   * measure itself that happens to share the number. Absent on older cached documents.
   */
  sectionIds: z.array(SectionId).optional(),
});
export type AmendsTarget = z.infer<typeof AmendsTarget>;

/**
 * Metadata about the bill. Every field is nullable: a value is set only when it is stated in
 * the document (structured XML fields, or extracted by the model with "null unless stated").
 */
export const BillMetadata = z.object({
  title: z.string().nullable(),
  billNumber: z.string().nullable(),
  jurisdiction: z.string().nullable(),
  session: z.string().nullable(),
  /** Version/stage as printed, e.g. "As Introduced", "Introduced in Senate", "Enrolled". */
  version: z.string().nullable(),
  sponsors: z.array(z.string()).nullable(),
  /** Official-record profiles for the sponsors. Never produced by the model. */
  sponsorProfiles: z.array(SponsorProfile).optional(),
  /** What kind of document this is, when the parser can tell. */
  docKind: DocKind.optional(),
  /** The existing law this document amends (a code, charter or ordinance), when stated. */
  amends: AmendsTarget.optional(),
  /** How the metadata was obtained, for transparency in the UI and eval. */
  source: z.enum(['structured', 'extracted', 'none']),
});
export type BillMetadata = z.infer<typeof BillMetadata>;

export const EMPTY_METADATA: BillMetadata = {
  title: null,
  billNumber: null,
  jurisdiction: null,
  session: null,
  version: null,
  sponsors: null,
  source: 'none',
};

/** A term defined inside the document. Each definition becomes its own chunk. */
export const Definition = z.object({
  term: z.string().min(1),
  text: z.string().min(1),
  /** Section where the definition appears. */
  sectionId: SectionId,
  /**
   * Where the definition applies, as the document states it: the whole act, or one section
   * ("As used in this section"). `unknown` when the text doesn't say.
   */
  scope: z.enum(['document', 'section', 'unknown']),
  /** For `scope: 'section'`, the section the definition is limited to. */
  scopeSectionId: SectionId.optional(),
});
export type Definition = z.infer<typeof Definition>;

/** A reference to law outside this document (listed as "referenced, not loaded"; never fetched in RC). */
export const ExternalRef = z.object({
  /** The text as it appears, e.g. "section 5747.01 of the Revised Code". */
  text: z.string().min(1),
  /** Normalized citation, e.g. "R.C. 5747.01", "42 U.S.C. 1983". */
  citation: z.string().min(1),
  kind: z.enum(['us_code', 'public_law', 'state_code', 'cfr', 'other']),
  /**
   * Finer grouping for refs the `kind` enum cannot name (charter refs use kind `other`).
   * Kept separate so `kind` never gains values an older binary would reject.
   */
  category: z.enum(['charter', 'local_code', 'general_law']).optional(),
  /** Sections of this document that cite it. */
  sectionIds: z.array(SectionId),
  /** Set when the referenced text was read; the `sectionId` of its `ReferenceText`. */
  referenceId: SectionId.optional(),
});
export type ExternalRef = z.infer<typeof ExternalRef>;

/** Prefix of every `ReferenceText.sectionId`, so it can never collide with a bill section id. */
export const REFERENCE_ID_PREFIX = 'ref:';

/**
 * Text of another law that this document relies on, read from an official source (for
 * example the U.S. Code section a definition points to). It is untrusted data, like the bill,
 * and answers cite it as `[S:<sectionId>]` the same way they cite the bill.
 */
export const ReferenceText = z.object({
  /** Starts with `REFERENCE_ID_PREFIX`, e.g. "ref:usc/15/6809". */
  sectionId: SectionId.refine((id) => id.startsWith(REFERENCE_ID_PREFIX), {
    message: `reference ids start with "${REFERENCE_ID_PREFIX}"`,
  }),
  /** Normalized citation, matching `ExternalRef.citation`, e.g. "15 U.S.C. 6809". */
  citation: z.string().min(1),
  /** The heading as printed at the source, e.g. "§6809. Definitions". */
  heading: z.string().optional(),
  sourceUrl: z.url(),
  /** The text that was read: the whole section, or the part a definition points to. */
  text: z.string().min(1),
  /** Terms of the bill whose meaning this text supplies, when it was read for a definition. */
  terms: z.array(z.string().min(1)).optional(),
  fetchedAt: z.iso.datetime(),
});
export type ReferenceText = z.infer<typeof ReferenceText>;

/** How well each page of a scanned PDF was read. */
export const ScanStatus = z.object({
  pages: z.array(
    z.object({
      page: z.number().int().positive(),
      marks: z.enum(['read', 'uncertain', 'not-read']),
    }),
  ),
});
export type ScanStatus = z.infer<typeof ScanStatus>;

export const NormalizedDoc = z.object({
  /** sha256 of the raw fetched bytes (hex). Also the vector-store namespace. */
  docId: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUrl: z.url(),
  format: DocFormat,
  /** ISO timestamp of the fetch. */
  fetchedAt: z.iso.datetime(),
  metadata: BillMetadata,
  sections: z.array(Section),
  definitions: z.array(Definition),
  externalRefs: z.array(ExternalRef),
  /** Other laws' text read for this document (see `ReferenceText`). Absent before v1.1. */
  references: z.array(ReferenceText).optional(),
  /** Non-fatal problems worth showing (e.g. "line numbers not detected on page 3"). */
  warnings: z.array(z.string()),
  /** Number of pages for PDFs; absent otherwise. */
  pageCount: z.number().int().positive().optional(),
  /** Per-page read quality for scanned PDFs; absent otherwise. */
  scan: ScanStatus.optional(),
});
export type NormalizedDoc = z.infer<typeof NormalizedDoc>;

/** Depth-first walk over a section tree. Shared helper so every module agrees on order. */
export function* walkSections(
  sections: readonly Section[],
): Generator<Section> {
  for (const section of sections) {
    yield section;
    yield* walkSections(section.children);
  }
}

/** Plain text of a section's own spans, optionally excluding struck (deleted) text. */
export function sectionText(
  section: Section,
  opts: { includeDeleted: boolean },
): string {
  return section.spans
    .filter((s) => opts.includeDeleted || s.status !== 'deleted')
    .map((s) => s.text)
    .join('');
}
