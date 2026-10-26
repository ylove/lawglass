/**
 * Other law's text that goes into a prompt beside the bill (issue #275): the U.S. Code
 * sections a bill borrows definitions from, read at ingest. It is untrusted like the bill, so
 * it is escaped and marker-neutralized exactly like an excerpt (see `prompt.ts`).
 */
import type { ReferenceText, SearchHit } from '../model/index.js';
import { promptText } from './markers.js';

/** Rough tokens the references take in a prompt (characters / 4, as for the bill). */
export function referenceTokens(
  references: readonly ReferenceText[] | undefined,
): number {
  return Math.ceil(
    (references ?? []).reduce((n, r) => n + r.text.length, 0) / 4,
  );
}

/** In excerpt mode only references the retrieved text actually uses are shown, this many at most. */
const MAX_EXCERPT_REFERENCES = 4;
/** Terms named in a heading; the rest are in the text anyway. */
const MAX_HEADING_TERMS = 6;

/**
 * "15 U.S.C. 6809 (U.S. Code, read for 'financial institution')". Used as the prompt heading
 * and as the citation breadcrumb, so the reader sees the same words the model did.
 */
export function referenceHeading(reference: ReferenceText): string {
  // The edition year rides on the page heading ("§6809. Definitions (2024 edition)").
  const edition = /\((\d{4}) edition\)\s*$/.exec(reference.heading ?? '')?.[1];
  const terms = (reference.terms ?? [])
    .slice(0, MAX_HEADING_TERMS)
    .map((t) => `'${t}'`)
    .join(', ');
  // No terms means the definition was not found: say what the text is, not what it was read for.
  const read = terms ? `read for ${terms}` : 'opening of the section only';
  return `${reference.citation} (U.S. Code${edition ? `, ${edition} edition` : ''}, ${read})`;
}

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentions(text: string, phrase: string): boolean {
  // Whole words, so "bank" in a hit does not pull in a reference read for "bank holding company".
  return new RegExp(
    `(?<![A-Za-z0-9])${escapeRegExp(phrase)}(?![A-Za-z0-9])`,
    'i',
  ).test(text);
}

/**
 * The references to show with this context. Reading the whole bill, all of them: the bill is
 * all there, so is everything it borrows. In excerpt mode, those whose terms (or citation)
 * appear in the text being shown, like definition injection.
 */
export function selectReferences(
  references: readonly ReferenceText[] | undefined,
  hits: readonly SearchHit[],
  mode: 'whole' | 'excerpts' | undefined,
): ReferenceText[] {
  if (!references || references.length === 0) return [];
  if (mode === 'whole') return [...references];
  const texts = hits.map((h) => promptText(h.chunk));
  return references
    .filter((ref) =>
      [...(ref.terms ?? []), ref.citation].some((phrase) =>
        texts.some((text) => mentions(text, phrase)),
      ),
    )
    .slice(0, MAX_EXCERPT_REFERENCES);
}
