/**
 * Read the U.S. Code sections a bill borrows definitions from, and attach them to the document
 * as `ReferenceText` (issue #275). Runs once per document at ingest, after enrichment.
 *
 * Everything here is best effort. A reference is extra grounding, never a requirement: a failed
 * fetch, an odd page or a timeout leaves that reference out, and the reader sees nothing but
 * its absence. Only the official GovInfo link service is ever asked (exact host, https, the
 * `uscode` link path); the fetcher passed in does the SSRF guarding, redirect checks, byte
 * limits and download caching.
 */
import {
  isAppError,
  REFERENCE_ID_PREFIX,
  type ExternalRef,
  type NormalizedDoc,
  type ReferenceText,
} from '../model/index.js';
import {
  findDefinitionTargets,
  MAX_TARGETS,
  type DefinitionTarget,
} from './definition-refs.js';
import {
  editionYear,
  findSubsection,
  findTermBlock,
  parseUsCodePage,
  partText,
  sectionPlainText,
  shorten,
} from './govinfo-text.js';
import { neutralizeCitations } from '../answer/markers.js';
import { parseUsCodeCitation, usCodeUrl } from './official-url.js';

/** The part of the pipeline's fetcher this module needs. */
export type ReferenceFetcher = (
  url: string,
  opts: {
    signal?: AbortSignal | undefined;
    validateUrl?: ((url: URL) => void) | undefined;
    skipWrapperCheck?: boolean | undefined;
    maxBytes?: number | undefined;
  },
) => Promise<{
  bytes: Uint8Array;
  finalUrl: string;
  /** Present when the fetcher defers its download-cache write until the caller has used the bytes. */
  commitCache?: (() => Promise<void>) | undefined;
}>;

export interface ReferenceContext {
  fetcher: ReferenceFetcher;
  now: () => Date;
  signal?: AbortSignal | undefined;
  /** Log-only sink for failures: the citation and an error code, never a message or address. */
  onSkip?: ((citation: string, code: string) => void) | undefined;
}

const GOVINFO_HOST = 'www.govinfo.gov';
const FETCH_TIMEOUT_MS = 10_000;
/** A U.S. Code section page is well under 1 MB (42 U.S.C. 1395x is about 560 KB). */
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const STAGE_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;
/** All terms read from one section together. */
const MAX_TEXT_CHARS = 9000;

export function referenceIdFor(title: number, section: string): string {
  return `${REFERENCE_ID_PREFIX}usc/${String(title)}/${section}`;
}

/**
 * Only the GovInfo link service may be asked for a reference, and only what it redirects to:
 * a U.S. Code page. Exact comparisons, not suffix checks, so a lookalike host cannot pass.
 */
export function assertUsCodeUrl(url: URL): void {
  const ok =
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.hostname === GOVINFO_HOST &&
    (url.pathname.startsWith('/link/uscode/') ||
      url.pathname.startsWith('/content/pkg/USCODE-'));
  if (!ok) throw new Error('Not a GovInfo U.S. Code address.');
}

async function readTarget(
  target: DefinitionTarget,
  context: ReferenceContext,
  signal: AbortSignal,
): Promise<ReferenceText | undefined> {
  const sourceUrl = usCodeUrl(target.title, target.section);
  const fetched = await context.fetcher(sourceUrl, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    validateUrl: assertUsCodeUrl,
    // A statute page is mostly cross-reference links; it is not a link hub to a bill.
    skipWrapperCheck: true,
    maxBytes: MAX_PAGE_BYTES,
  });
  // A fetcher that serves a local snapshot answers for any address; the page must really be
  // the Code page the link service sent us to.
  assertUsCodeUrl(new URL(fetched.finalUrl));
  if (!new URL(fetched.finalUrl).pathname.startsWith('/content/pkg/USCODE-'))
    throw new Error('Not a U.S. Code page.');
  const page = parseUsCodePage(new TextDecoder().decode(fetched.bytes));
  if (page.lines.length === 0) return undefined;
  // The page parsed: keep it in the download cache so a re-ingest does not ask again.
  await fetched.commitCache?.().catch(() => undefined);

  const year = editionYear(fetched.finalUrl);
  // Citation markers in another law's text must never be copyable as citations to the bill.
  // Neutralized here, once, so every consumer of the stored text gets safe text.
  const safe = (text: string): string => neutralizeCitations(text);
  const printed =
    page.heading === undefined ? undefined : neutralizeCitations(page.heading);
  const heading =
    printed === undefined
      ? undefined
      : year === undefined
        ? printed
        : `${printed} (${year} edition)`;

  const blocks: string[] = [];
  const terms: string[] = [];
  for (const term of target.terms) {
    // A cited subsection ("12 U.S.C. 1843(k)") narrows where the term is looked for, and is
    // itself the best answer when the term is not named inside it.
    const part = term.subsection
      ? findSubsection(page, term.subsection)
      : undefined;
    // Inside the cited part first; then anywhere on the page (the bill's subsection letter may
    // be off, or the page laid out differently); then the cited part as it stands.
    const block =
      (part ? findTermBlock(part, term.lookups) : undefined) ??
      findTermBlock(page, term.lookups) ??
      (part ? partText(part) : undefined);
    if (block === undefined) continue;
    terms.push(term.term);
    if (!blocks.includes(block)) blocks.push(block);
  }
  let text: string;
  if (blocks.length > 0) {
    text = shorten(blocks.join('\n\n'), MAX_TEXT_CHARS);
  } else {
    // A guessed term the section does not define was a false lead. A stated one still points
    // here, so the opening of the section is kept, but without claiming it defines the term:
    // it has no `terms`, and its heading says it is only the opening.
    if (!target.terms.some((t) => t.stated)) return undefined;
    text = sectionPlainText(page);
  }
  if (text.trim() === '') return undefined;
  return {
    sectionId: referenceIdFor(target.title, target.section),
    citation: target.citation,
    ...(heading === undefined ? {} : { heading }),
    sourceUrl,
    text: safe(text),
    ...(terms.length > 0 ? { terms } : {}),
    fetchedAt: context.now().toISOString(),
  };
}

/** A short code for the log: an `AppError` code, else a fixed word. Never the message. */
function errorCode(error: unknown): string {
  if (isAppError(error)) return error.code;
  return error instanceof Error && error.name === 'TimeoutError'
    ? 'TIMEOUT'
    : 'ERROR';
}

/** Runs `work` over `items`, `CONCURRENCY` at a time, keeping input order. */
async function inParallel<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await work(items[i] as T);
      }
    }),
  );
  return results;
}

/** Mark the external refs whose text was read. A range or "et seq." is linked by its first section. */
function linkRefs(
  refs: readonly ExternalRef[],
  read: readonly ReferenceText[],
): ExternalRef[] {
  const ids = new Map(read.map((r) => [r.citation, r.sectionId]));
  return refs.map((ref) => {
    if (ref.kind !== 'us_code') return ref;
    const cite = parseUsCodeCitation(ref.citation);
    const id = cite
      ? ids.get(`${String(cite.title)} U.S.C. ${cite.section}`)
      : undefined;
    return id === undefined ? ref : { ...ref, referenceId: id };
  });
}

/**
 * The document with `references` filled in (and `referenceId` set on the refs that were read).
 * Returns the same object when references were already attempted, or when there is nothing to
 * read. If every fetch failed, `references` stays unset so a later ingest can try again.
 */
export async function withReferenceTexts(
  doc: NormalizedDoc,
  context: ReferenceContext,
): Promise<NormalizedDoc> {
  if (doc.references !== undefined) return doc;
  const targets = findDefinitionTargets(doc.sections, doc.definitions).slice(
    0,
    MAX_TARGETS,
  );
  if (targets.length === 0) return { ...doc, references: [] };

  const stage = AbortSignal.any([
    AbortSignal.timeout(STAGE_TIMEOUT_MS),
    ...(context.signal ? [context.signal] : []),
  ]);
  let failures = 0;
  const results = await inParallel(targets, async (target) => {
    try {
      return await readTarget(target, context, stage);
    } catch (error) {
      // The caller cancelled: stop the ingest rather than carry on without a reader.
      if (context.signal?.aborted) throw error;
      failures++;
      context.onSkip?.(target.citation, errorCode(error));
      return undefined;
    }
  });
  const read = results.filter((r): r is ReferenceText => r !== undefined);
  // Everything failed (offline, GovInfo down): leave unset so the next ingest retries.
  if (read.length === 0 && failures === targets.length) return doc;
  return {
    ...doc,
    references: read,
    externalRefs: linkRefs(doc.externalRefs, read),
  };
}
