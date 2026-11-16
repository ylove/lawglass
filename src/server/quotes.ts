/**
 * Quotes (ADR 0018, section 4). A quote fetches and parses a bill and sizes the work; it makes no
 * model call and stores nothing in the registry. The in-memory store lets a later ingest refer to
 * the quote the reader saw.
 */
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  estimateBill,
  estimateQuestion,
  type BillEstimate,
  type BillFacts,
  type EstimatePlan,
  type FeatureEstimate,
  type ModelAssignment,
  type PriceTable,
} from '../core/cost/index.js';
import type { SafeFetchResult } from '../core/fetch/index.js';
import type { HistoryAttachment } from '../core/pipeline/ingest.js';
import type { NormalizedDoc } from '../core/model/index.js';
import type { PregenerateExamples } from '../core/breakdown/coverage.js';

export const QuoteRequest = z.object({ url: z.url() });

/** Pages, sections, tokens, mode and units; the facts a host turns into a price. */
export interface QuoteFacts {
  /** The document id: the SHA-256 of the fetched bytes, so a host can bind a quote to exact bytes. */
  contentHash: string;
  pages: number | null;
  sections: number;
  tokens: number;
  mode: BillFacts['mode'];
  units: number;
}

export interface QuoteEntry {
  url: string;
  /** The document id: the SHA-256 of the fetched bytes. */
  contentHash: string;
  facts: QuoteFacts;
  estimates: Record<string, BillEstimate>;
  createdAt: number;
  /** Binds a quote to the reader who asked for it. */
  readerId: string | undefined;
}

export interface QuoteOptions {
  /** Model plans to estimate, by tier name. Default: one `default` tier from the configured models. */
  tiers?: Record<string, ModelAssignment>;
  /** Prices for models missing from the built-in table, and the dollar budget's rates. */
  prices?: PriceTable;
  /** Settings every plan shares (cache policy, example count, thinking tokens). */
  plan?: Omit<EstimatePlan, keyof ModelAssignment>;
  /** Public servers refuse quotes unless the host turns this on. */
  allowInPublicMode?: boolean;
  /** Quotes per client address per hour in hosted modes. Default 20. */
  perHour?: number;
  /** Quotes and, separately, ingests per signed-in reader per hour in auth and private modes. Default 60. */
  perReaderPerHour?: number;
}

export const QUOTE_TTL_MS = 30 * 60 * 1000;
export const QUOTE_STORE_CAP = 500;

export class QuoteStore {
  private readonly entries = new Map<string, QuoteEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = QUOTE_TTL_MS,
    private readonly cap = QUOTE_STORE_CAP,
  ) {}

  add(entry: Omit<QuoteEntry, 'createdAt'>): {
    quoteId: string;
    entry: QuoteEntry;
  } {
    this.sweep();
    while (this.entries.size >= this.cap) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    const quoteId = randomBytes(18).toString('base64url');
    const stored = { ...entry, createdAt: this.now() };
    this.entries.set(quoteId, stored);
    return { quoteId, entry: stored };
  }

  /** A live quote made for this reader and address, or undefined. */
  get(
    quoteId: string | undefined,
    readerId: string | undefined,
    url: string,
  ): QuoteEntry | undefined {
    if (quoteId === undefined) return undefined;
    const entry = this.entries.get(quoteId);
    if (!entry) return undefined;
    if (this.now() - entry.createdAt >= this.ttlMs) {
      this.entries.delete(quoteId);
      return undefined;
    }
    return entry.readerId === readerId && entry.url === url ? entry : undefined;
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, entry] of this.entries)
      if (t - entry.createdAt >= this.ttlMs) this.entries.delete(id);
  }
}

/** What a measure downloaded, kept so the ingest it leads to reads exactly the bytes that were priced. */
export interface QuotedDownload {
  doc: NormalizedDoc;
  fetched: SafeFetchResult;
  attachment: HistoryAttachment | undefined;
  /** What the reader was shown for these bytes, for an ingest that has no quote of ours. */
  publicFacts: QuoteFacts;
  estimates: Record<string, BillEstimate>;
}

export const DOWNLOAD_STORE_CAP = 50;
/** One reader (or one guest address) cannot push everyone else's downloads out of the store. */
export const DOWNLOAD_PER_READER_CAP = 3;
/** Budget in bytes of what an entry really holds (see `downloadSize`), not of entries. */
export const DOWNLOAD_STORE_BYTES = 64 * 1024 * 1024;

/** Heap held per parsed span or reference beyond its text: the object, its fields and its array slot. */
const SPAN_OVERHEAD_BYTES = 100;
const SECTION_OVERHEAD_BYTES = 200;

/**
 * What an entry holds in memory: the raw bytes plus the parsed document. Text is 2 bytes per
 * character (JS strings are UTF-16), and every span, section and external reference carries
 * object overhead (measured on real parses, text alone undercounted by 2.5x). The Cheerio DOM of
 * an HTML download is dropped before storing (it measured about 32x the raw bytes), so it is
 * not counted.
 */
export function downloadSize(download: QuotedDownload): number {
  const sectionBytes = (
    sections: readonly NormalizedDoc['sections'][number][],
  ): number =>
    sections.reduce(
      (n, section) =>
        n +
        SECTION_OVERHEAD_BYTES +
        2 * (section.heading?.length ?? 0) +
        section.spans.reduce(
          (m, span) => m + SPAN_OVERHEAD_BYTES + 2 * span.text.length,
          0,
        ) +
        sectionBytes(section.children),
      0,
    );
  const definitionBytes = download.doc.definitions.reduce(
    (n, d) => n + SPAN_OVERHEAD_BYTES + 2 * (d.term.length + d.text.length),
    0,
  );
  const refBytes = download.doc.externalRefs.reduce(
    (n, ref) =>
      n +
      SPAN_OVERHEAD_BYTES +
      2 * (ref.text.length + ref.citation.length) +
      ref.sectionIds.length * 40,
    0,
  );
  return (
    download.fetched.bytes.byteLength +
    sectionBytes(download.doc.sections) +
    definitionBytes +
    refBytes
  );
}

interface DownloadEntry {
  download: QuotedDownload;
  reader: string;
  size: number;
  createdAt: number;
}

/**
 * The latest download each reader was priced on for each URL, bounded by age, count, bytes, and
 * a share per reader (oldest out first). It is keyed by reader and URL, not by our quote id,
 * because a host binds its own quote to the docId it saw at admission and never sends ours
 * back; the ingest must read those same bytes or that docId can never match (New York bytes
 * differ on every download). An entry is not removed on use: the host may refuse the ingest
 * (402) and the confirm, or a retry after a dropped connection, must see the same bytes. An
 * admission that uses an entry renews its age, so the time between a 402 and the confirm is not
 * counted against it. Losing one is safe: the ingest measures again, and the host's own quote
 * is checked against that new measure.
 */
export class QuotedDownloads {
  private readonly entries = new Map<string, DownloadEntry>();
  private bytes = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = QUOTE_TTL_MS,
    private readonly cap = DOWNLOAD_STORE_CAP,
    private readonly maxBytes = DOWNLOAD_STORE_BYTES,
    private readonly perReader = DOWNLOAD_PER_READER_CAP,
    /** One reader's share of the byte budget; the rest is other readers'. */
    private readonly perReaderBytes = Math.floor(maxBytes / 4),
  ) {}

  /** A reader id cannot contain the URL, but encode both so no pair can collide with another. */
  private static key(reader: string | undefined, url: string): string {
    return JSON.stringify([reader ?? null, url]);
  }

  /** Returns what is stored: the download without its parse-time DOM. */
  put(
    reader: string | undefined,
    url: string,
    download: QuotedDownload,
  ): QuotedDownload {
    const key = QuotedDownloads.key(reader, url);
    // Only what the ingest reads is kept; the DOM is of no use once `doc` is parsed.
    const kept: QuotedDownload = {
      ...download,
      fetched: { ...download.fetched, preparedHtml: undefined },
    };
    // A newer measure replaces the older one for the same reader and URL.
    this.remove(key);
    this.sweep();
    const size = downloadSize(kept);
    // Bigger than a reader's share is bigger than anyone may hold: not kept, so it cannot push
    // other readers' downloads out. The ingest still reads it from the returned copy.
    if (size > Math.min(this.maxBytes, this.perReaderBytes)) return kept;
    const owner = reader ?? '';
    // A reader over their share, in entries or bytes, loses their own oldest first, never
    // someone else's.
    while (
      this.countFor(owner) >= this.perReader ||
      this.bytesFor(owner) + size > this.perReaderBytes
    )
      if (!this.evictOldest((e) => e.reader === owner)) break;
    while (this.entries.size >= this.cap || this.bytes + size > this.maxBytes)
      if (!this.evictOldest(() => true)) break;
    this.entries.set(key, {
      download: kept,
      reader: owner,
      size,
      createdAt: this.now(),
    });
    this.bytes += size;
    return kept;
  }

  /** The reader's latest live download of this URL, or undefined. */
  get(reader: string | undefined, url: string): QuotedDownload | undefined {
    this.sweep();
    return this.entries.get(QuotedDownloads.key(reader, url))?.download;
  }

  /** Restarts the entry's age (and puts it last in line to be evicted). */
  touch(reader: string | undefined, url: string): void {
    const key = QuotedDownloads.key(reader, url);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, { ...entry, createdAt: this.now() });
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.bytes -= entry.size;
    this.entries.delete(id);
  }

  private bytesFor(reader: string): number {
    let n = 0;
    for (const entry of this.entries.values())
      if (entry.reader === reader) n += entry.size;
    return n;
  }

  private countFor(reader: string): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.reader === reader) n++;
    return n;
  }

  private evictOldest(matches: (entry: DownloadEntry) => boolean): boolean {
    for (const [id, entry] of this.entries)
      if (matches(entry)) {
        this.remove(id);
        return true;
      }
    return false;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, entry] of this.entries)
      if (t - entry.createdAt >= this.ttlMs) this.remove(id);
  }
}

/**
 * Whether a fresh measure is still what the quote priced. Not a byte comparison: some sources
 * (New York) change their bytes on every request, so the content hash can never match. The
 * facts must agree and so must the whole estimate, since it also depends on parts the facts
 * do not show (map units, single subject, omitted units).
 */
export function sameQuotedBill(
  quoted: Pick<QuoteEntry, 'facts' | 'estimates'>,
  measured: Pick<QuotedDownload, 'publicFacts' | 'estimates'>,
): boolean {
  const a = quoted.facts;
  const b = measured.publicFacts;
  return (
    a.pages === b.pages &&
    a.sections === b.sections &&
    a.tokens === b.tokens &&
    a.mode === b.mode &&
    a.units === b.units &&
    isDeepStrictEqual(quoted.estimates, measured.estimates)
  );
}

const DEFAULT_MODELS: ModelAssignment = {
  answerModel: 'claude-sonnet-5-5',
  extractModel: 'claude-haiku-5-5',
};

export function quoteFacts(doc: NormalizedDoc, facts: BillFacts): QuoteFacts {
  return {
    contentHash: doc.docId,
    pages: doc.pageCount ?? null,
    sections: facts.sectionCount,
    tokens: facts.estimatedTokens,
    mode: facts.mode,
    units: facts.breakdownUnits,
  };
}

/** The configured tiers, or one `default` tier from the models the server is set up with. */
export function quoteTiers(
  options: QuoteOptions | undefined,
  configured: () => Partial<ModelAssignment>,
): Record<string, ModelAssignment> {
  if (options?.tiers && Object.keys(options.tiers).length > 0)
    return options.tiers;
  return { default: { ...DEFAULT_MODELS, ...configured() } };
}

export function estimatesFor(
  facts: BillFacts,
  tiers: Record<string, ModelAssignment>,
  options: QuoteOptions | undefined,
  /** What the server will actually generate; the host's own `quote.plan` still wins. */
  coverage: { pregenerateExamples?: PregenerateExamples } = {},
): Record<string, BillEstimate> {
  return Object.fromEntries(
    Object.entries(tiers).map(([name, models]) => [
      name,
      estimateBill(
        facts,
        {
          ...(coverage.pregenerateExamples
            ? { pregenerateExamples: coverage.pregenerateExamples }
            : {}),
          ...options?.plan,
          ...models,
        },
        options?.prices,
      ),
    ]),
  );
}

export function questionEstimate(
  facts: BillFacts,
  models: ModelAssignment,
  options: QuoteOptions | undefined,
): FeatureEstimate {
  return estimateQuestion(facts, options?.prices, {
    ...options?.plan,
    ...models,
  });
}
