import {
  sectionText,
  walkSections,
  AppError,
  type BillHistory,
  type LocateVersionsResponse,
} from '../model/index.js';
import { parseHtml, parsePdf, parseText, parseXml } from '../parse/index.js';
import { readParseLimits } from '../parse/limits.js';
import type { Fetcher, PdfParser } from '../pipeline/ingest.js';
import { sharedLimits, type Limits } from '../pipeline/limits.js';
import { cleanSentence } from './index.js';

export const MAX_VERSIONS = 5;
export const MAX_VERSION_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const HOSTS = new Set(['www.govinfo.gov', 'search-prod.lis.state.oh.us']);
const STOP = new Set(
  'a an the of to in on at for by and or is are was were be been that this it as with from bill would will shall must'.split(
    ' ',
  ),
);

function words(text: string): { word: string; start: number; end: number }[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    word: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** Fraction of distinct content words present in the best local window; no truth inference. */
export function versionOverlap(
  query: string,
  text: string,
): { overlap: number; excerpt?: string } {
  const wanted = new Set(
    words(query)
      .map((w) => w.word)
      .filter((w) => !STOP.has(w)),
  );
  if (!wanted.size) return { overlap: 0 };
  const tokens = words(text);
  const width = Math.min(100, Math.max(20, words(query).length * 2));
  const counts = new Map<string, number>();
  let best = 0,
    bestStart = 0,
    bestEnd = 0;
  for (let end = 0; end < tokens.length; end++) {
    const word = tokens[end]?.word ?? '';
    if (wanted.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    const start = Math.max(0, end - width + 1);
    if (end >= width) {
      const old = tokens[end - width]?.word ?? '';
      const count = counts.get(old);
      if (count === 1) counts.delete(old);
      else if (count) counts.set(old, count - 1);
    }
    if (counts.size > best) {
      best = counts.size;
      bestStart = start;
      bestEnd = end;
    }
  }
  if (!best) return { overlap: 0 };
  const start = tokens[bestStart]?.start ?? 0;
  return {
    overlap: best / wanted.size,
    excerpt: text
      .slice(
        start,
        Math.min((tokens[bestEnd]?.end ?? start) + 160, start + 700),
      )
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

export function assertVersionUrl(url: URL): void {
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !HOSTS.has(url.hostname)
  )
    throw new AppError('SSRF_BLOCKED');
}

export interface VersionsDeps {
  fetcher: Fetcher;
  validateUrl?: ((url: URL) => void) | undefined;
  parsePdf?: PdfParser | undefined;
  limits?: Limits | undefined;
  signal?: AbortSignal | undefined;
}

export async function locateVersions(
  raw: string,
  history: BillHistory | undefined,
  deps: VersionsDeps,
): Promise<LocateVersionsResponse> {
  const query = cleanSentence(raw);
  const seen = new Set<string>();
  const versions = (history?.versions ?? [])
    .filter((v) => {
      if (!v.url || seen.has(v.url)) return false;
      try {
        assertVersionUrl(new URL(v.url));
        deps.validateUrl?.(new URL(v.url));
      } catch {
        return false;
      }
      seen.add(v.url);
      return true;
    })
    .slice(0, MAX_VERSIONS);
  if (!versions.length) return { status: 'unavailable', versions: [] };
  const signal = AbortSignal.any([
    ...(deps.signal ? [deps.signal] : []),
    AbortSignal.timeout(45_000),
  ]);
  const release = await (deps.limits ?? sharedLimits()).acquire('ask', signal);
  try {
    const results: LocateVersionsResponse['versions'] = [];
    let remaining = MAX_TOTAL_BYTES;
    const policy = (url: URL): void => {
      assertVersionUrl(url);
      deps.validateUrl?.(url);
    };
    for (const version of versions) {
      // The time cap ends the run but keeps the versions already read.
      if (signal.aborted) {
        if (deps.signal?.aborted || !results.length) signal.throwIfAborted();
        break;
      }
      const versionUrl = version.url;
      if (!versionUrl) continue;
      if (remaining <= 0) break;
      const parseLimits = {
        ...readParseLimits(),
        maxNonPdfBytes: Math.min(MAX_VERSION_BYTES, remaining),
        maxHtmlBytes: Math.min(MAX_VERSION_BYTES, remaining),
        maxPages: 100,
        timeoutMs: 10_000,
      };
      // The fetch port carries maxBytes through to safeFetch, which applies the byte cap
      // during streaming (including PDFs). Check injected fetchers again before parsing.
      // A failed stream may already have consumed its full allowance. Reserve it until
      // a successful fetch gives the actual byte count.
      let bytes = Math.min(MAX_VERSION_BYTES, remaining);
      try {
        const fetched = await deps.fetcher(versionUrl, {
          signal,
          validateUrl: policy,
          parseLimits,
          maxBytes: Math.min(MAX_VERSION_BYTES, remaining),
        });
        policy(new URL(fetched.finalUrl));
        bytes = fetched.bytes.byteLength;
        if (bytes > Math.min(MAX_VERSION_BYTES, remaining))
          throw new AppError('TOO_LARGE');
        const context = {
          sourceUrl: fetched.finalUrl,
          fetchedAt: new Date().toISOString(),
          signal,
          timeoutMs: parseLimits.timeoutMs,
          maxPages: parseLimits.maxPages,
          maxHtmlBytes: parseLimits.maxHtmlBytes,
          contentType: fetched.contentType,
        };
        const doc =
          fetched.format === 'pdf'
            ? await (deps.parsePdf ?? parsePdf)(fetched.bytes, context)
            : fetched.format === 'xml'
              ? parseXml(fetched.bytes, context)
              : fetched.format === 'html'
                ? parseHtml(fetched.bytes, context)
                : fetched.format === 'text'
                  ? parseText(fetched.bytes, context)
                  : undefined;
        if (!doc) continue;
        await fetched.commitCache?.();
        const plain = [...walkSections(doc.sections)]
          // Struck words are not that version's law; neither count nor show them.
          .map((s) => sectionText(s, { includeDeleted: false }))
          .join('\n');
        results.push({
          label: version.label,
          ...(version.date ? { date: version.date } : {}),
          url: versionUrl,
          ...versionOverlap(query, plain),
        });
      } catch {
        /* A missing version does not hide the versions we could read. */
        if (deps.signal?.aborted) signal.throwIfAborted();
      } finally {
        remaining -= bytes;
      }
    }
    return { status: results.length ? 'ok' : 'unavailable', versions: results };
  } finally {
    release();
  }
}
