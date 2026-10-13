/**
 * Metadata enrichment (issue #20): structured fields first, model fallback second.
 *
 * The parser may already have filled fields from the document's own markup. This module only
 * fills fields that are still null, asks the model to return null unless a value is explicitly
 * stated, and then double-checks every risky value against the source text so a hallucinated
 * bill number, sponsor or session never reaches the user. Failures never abort ingest.
 */
import { z } from 'zod';
import {
  AppError,
  type BillMetadata,
  type LlmProvider,
  type NormalizedDoc,
} from '../model/index.js';

/** Roughly the first three pages; non-PDF formats get the same character budget. */
export const MAX_METADATA_CHARS = 6000;

/** Strict output schema: mirrors BillMetadata minus `source`; every field nullable. */
export const ExtractedMetadata = z
  .object({
    title: z.string().nullable(),
    billNumber: z.string().nullable(),
    jurisdiction: z.string().nullable(),
    session: z.string().nullable(),
    version: z.string().nullable(),
    sponsors: z.array(z.string()).nullable(),
  })
  .strict();
export type ExtractedMetadata = z.infer<typeof ExtractedMetadata>;

const SYSTEM_PROMPT = [
  'You extract bill metadata from the opening text of a piece of legislation.',
  'Return null for any field unless its value is explicitly stated in the text.',
  'Never guess sponsors, dates, session or jurisdiction, and never infer from context or general knowledge.',
  'Copy values as they are printed. For sponsors, return an array of names, or null if none are stated.',
].join('\n');

/** Lowercase and drop everything but letters and digits: "H.R. 1234" matches "HR1234". */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'md', 'esq']);

/** Last name token of a sponsor string, ignoring suffixes like "Jr." and trailing party tags. */
function surname(sponsor: string): string {
  const tokens = sponsor
    .replace(/\([^)]*\)/g, ' ')
    .split(/[\s,]+/)
    .map(squash)
    .filter((t) => t.length > 0 && !NAME_SUFFIXES.has(t));
  return tokens.at(-1) ?? '';
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export interface MetadataResult {
  metadata: BillMetadata;
  /** Non-fatal problems: provider failure, discarded hallucinations. */
  warnings: string[];
}

export interface ExtractMetadataOptions {
  provider: LlmProvider;
  /** Raw text of the first ~3 pages (or first ~6,000 characters for non-PDF formats). */
  text: string;
  signal?: AbortSignal | undefined;
}

/**
 * Fill still-null metadata fields. Never throws on extraction problems; returns warnings.
 * Only a caller-initiated abort propagates.
 */
export async function extractMetadata(
  doc: Pick<NormalizedDoc, 'metadata'>,
  opts: ExtractMetadataOptions,
): Promise<MetadataResult> {
  const existing = doc.metadata;
  const warnings: string[] = [];
  const hasNullField =
    existing.title === null ||
    existing.billNumber === null ||
    existing.jurisdiction === null ||
    existing.session === null ||
    existing.version === null ||
    existing.sponsors === null;
  const text = opts.text.slice(0, MAX_METADATA_CHARS);

  // Nothing to fill, or nothing to read: skip the model call entirely.
  if (!hasNullField || text.trim().length === 0) {
    return { metadata: existing, warnings };
  }

  let extracted: ExtractedMetadata;
  try {
    const { object } = await opts.provider.generateObject({
      system: SYSTEM_PROMPT,
      prompt: `Bill text:\n\n${text}`,
      schema: ExtractedMetadata,
      schemaName: 'bill_metadata',
      maxTokens: 600,
      signal: opts.signal,
    });
    // Re-validate: a provider adapter should already have, but this module owns the contract.
    extracted = ExtractedMetadata.parse(object);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const code = err instanceof AppError ? err.code : 'unexpected error';
    warnings.push(
      `Metadata extraction failed (${code}); unstated fields left empty.`,
    );
    return { metadata: existing, warnings };
  }

  const haystack = squash(text);
  const appears = (value: string): boolean => {
    const needle = squash(value);
    return needle.length > 0 && haystack.includes(needle);
  };

  const merged: BillMetadata = { ...existing };
  let usedModel = false;

  // Free-text fields (title, jurisdiction, version) are taken as returned when non-empty;
  // the fields below are the ones most damaging when invented, so they must appear in the text.
  for (const key of ['title', 'jurisdiction', 'version'] as const) {
    const value = extracted[key];
    if (merged[key] === null && nonEmpty(value)) {
      merged[key] = value.trim();
      usedModel = true;
    }
  }

  for (const key of ['billNumber', 'session'] as const) {
    const value = extracted[key];
    if (merged[key] !== null || !nonEmpty(value)) continue;
    if (appears(value)) {
      merged[key] = value.trim();
      usedModel = true;
    } else {
      warnings.push(
        `Discarded extracted ${key} "${value}": not found in the document text.`,
      );
    }
  }

  if (merged.sponsors === null && extracted.sponsors !== null) {
    const kept: string[] = [];
    for (const sponsor of extracted.sponsors) {
      if (!nonEmpty(sponsor)) continue;
      const last = surname(sponsor);
      if (last && haystack.includes(last)) kept.push(sponsor.trim());
      else
        warnings.push(
          `Discarded extracted sponsor "${sponsor}": surname not found in the document text.`,
        );
    }
    if (kept.length > 0) {
      merged.sponsors = kept;
      usedModel = true;
    }
  }

  if (usedModel) merged.source = 'extracted';
  return { metadata: merged, warnings };
}
