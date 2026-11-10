/**
 * Quotes (ADR 0018, section 4). A quote fetches and parses a bill and sizes the work; it makes no
 * model call and stores nothing in the registry. The in-memory store lets a later ingest refer to
 * the quote the reader saw.
 */
import { randomBytes } from 'node:crypto';
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
import type { NormalizedDoc } from '../core/model/index.js';

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
): Record<string, BillEstimate> {
  return Object.fromEntries(
    Object.entries(tiers).map(([name, models]) => [
      name,
      estimateBill(facts, { ...options?.plan, ...models }, options?.prices),
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
