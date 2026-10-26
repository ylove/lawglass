import { resolveNewYork, assertNewYorkFetch } from '../fetch/new-york.js';
import {
  resolveNewJersey,
  assertNewJerseyFetch,
  chooseNewJerseyText,
  newJerseyLookupUrl,
} from '../fetch/new-jersey.js';
/**
 * The shared ingest pipeline: fetch -> parse -> metadata -> chunk -> enrich -> index.
 * The CLI, the server (#29) and eval (#32) all call this, so none of them re-implements
 * dedupe, eviction or cleanup-on-failure.
 */
import { createHash } from 'node:crypto';
import { deleteIndexedDocument, forgetDocument } from '../answer/context.js';
import {
  assertChunkLimit,
  assertPageLimit,
  readParseLimits,
  type ParseLimits,
  type ParseControl,
} from '../parse/limits.js';
import type { PreparedHtml } from '../parse/html.js';
import { chunkDocument } from '../chunk/index.js';
import {
  enrichDocument,
  extractMetadata,
  MAX_METADATA_CHARS,
} from '../enrich/index.js';
import type { SafeFetchResult } from '../fetch/index.js';
import { parseHtml, parsePdf, parseText, parseXml } from '../parse/index.js';
import {
  AppError,
  ChunkType,
  DocSummary,
  sectionText,
  walkSections,
  type Chunk,
  type IngestStage,
  type IngestStats,
  type LlmProvider,
  type LlmUsage,
  type NormalizedDoc,
  type ObjectRequest,
  type RetrievalBackend,
} from '../model/index.js';
import type { Registry, RegistryEntry } from '../registry.js';
import { assertHistoryUrl } from '../history/allowlist.js';
import {
  assertNoCongressFetch,
  chooseVersion,
  historySource,
  resolveHistory,
  type HistoryRecord,
} from '../history/resolve.js';
import { deleteHistory, writeHistory } from '../history/history-store.js';
import { withSponsorLinks } from '../sponsors/enrich.js';
import { withReferenceTexts } from '../enrich/references.js';

export type Fetcher = (
  url: string,
  opts?: {
    signal?: AbortSignal | undefined;
    validateUrl?: ((url: URL) => void) | undefined;
    refresh?: boolean | undefined;
    maxBytes?: number | undefined;
    parseLimits?: ParseLimits | undefined;
    skipWrapperCheck?: boolean | undefined;
  },
) => Promise<SafeFetchResult>;

export interface ParseContext extends ParseControl {
  maxPages?: number | undefined;
  publicMode?: boolean | undefined;
  maxHtmlBytes?: number | undefined;
  contentType?: string;
  preparedHtml?: PreparedHtml | undefined;
  sourceUrl: string;
  fetchedAt: string;
}
import { sharedLimits, type Limits } from './limits.js';
/** Defaults to `core/parse`'s `parsePdf`; tests inject a stub. */
export type PdfParser = (
  bytes: Uint8Array,
  context: ParseContext,
) => NormalizedDoc | Promise<NormalizedDoc>;

/** Keeps eviction away from documents other people are using or ingesting right now. */
export interface EvictionGuard {
  /** Documents some reader still lists; they go last. */
  listed(): Promise<ReadonlySet<string>>;
  /** Documents with an ingest under way: never evicted, so concurrent ingests cannot undo each other. */
  inFlight(): ReadonlySet<string>;
  /** Never evict a listed document (public servers refuse a new one instead). */
  neverEvictListed?: boolean;
}

export interface IngestDeps {
  parseLimits?: ParseLimits | undefined;
  backend: RetrievalBackend;
  /** Used for metadata extraction (the cheap "extract" model). */
  provider: LlmProvider;
  /** Concurrency and per-minute budgets. Defaults to the process-wide limits from the environment. */
  limits?: Limits | undefined;
  registry: Registry;
  fetcher: Fetcher;
  now: () => Date;
  /** LRU cap on indexed documents. Default 5. */
  maxDocs?: number | undefined;
  /** Who may be evicted when the cap is enforced; see `EvictionGuard`. */
  evictionGuard?: EvictionGuard | undefined;
  /**
   * Called once the document id is known and before any indexing, with whether the registry
   * already has it. A server uses it to protect the document while it is being ingested and
   * to refuse a new document when it has no room (throw an AppError). It resolves to whether
   * the registry has the document now: waiting for the server's lock can let another
   * admission reclaim a document that was known a moment ago.
   */
  admit?: ((docId: string, known: boolean) => Promise<boolean>) | undefined;
  parsePdf?: PdfParser | undefined;
  /** Told when a U.S. Code reference could not be read: the citation and an error code only. */
  onReferenceSkip?: ((citation: string, code: string) => void) | undefined;
}

export interface IngestProgress {
  stage: IngestStage;
  detail?: string | undefined;
  done?: number | undefined;
  total?: number | undefined;
}

export interface IngestOptions {
  label?: string | undefined;
  onProgress?: ((progress: IngestProgress) => void) | undefined;
  /**
   * Operator diagnostics that are not reader warnings, e.g. why metadata extraction failed.
   * Codes only: never messages, document text or provider output.
   */
  onDiagnostic?:
    | ((diagnostic: { event: 'metadata_failed'; code: string }) => void)
    | undefined;
  signal?: AbortSignal | undefined;
}

export interface IngestUsage {
  embedTokens: number;
  llmInputTokens: number;
  llmOutputTokens: number;
}

export interface IngestResult {
  doc: DocSummary;
  stats: IngestStats;
  usage: IngestUsage;
  /** The enriched document as cached in the registry (metadata, definitions, external refs). */
  normalized: NormalizedDoc;
}

const DEFAULT_MAX_DOCS = 5;
const MAX_LABEL = 80;
const HISTORY_PARTIAL = 'Part of the legislative history was unavailable.';
const HISTORY_UNAVAILABLE =
  'History unavailable: the official history could not be read or saved.';

interface HistoryAttachment {
  record?: HistoryRecord;
  version: string;
}

function attachHistory(
  doc: NormalizedDoc,
  attachment?: HistoryAttachment,
): NormalizedDoc {
  if (!attachment) return doc;
  const { record, version } = attachment;
  const label = record?.history.versions.find(
    (item) => item.code === version,
  )?.label;
  return {
    ...doc,
    metadata: {
      ...doc.metadata,
      version: label ? `${label} (${version})` : version,
      ...(record ? { sponsorProfiles: record.sponsorProfiles } : {}),
    },
    warnings: [
      ...doc.warnings.filter(
        (item) => item !== HISTORY_UNAVAILABLE && item !== HISTORY_PARTIAL,
      ),
      ...(!record
        ? [HISTORY_UNAVAILABLE]
        : record.partial
          ? [HISTORY_PARTIAL]
          : []),
    ],
  };
}

async function saveHistory(
  doc: NormalizedDoc,
  deps: IngestDeps,
  attachment?: HistoryAttachment,
): Promise<void> {
  if (!attachment?.record) return;
  try {
    await writeHistory(
      deps.registry.configDir,
      doc.docId,
      attachment.record.history,
      undefined,
      attachment.record.officialTitle,
    );
  } catch {
    doc.warnings.push(HISTORY_UNAVAILABLE);
  }
}

function enrichSponsors(
  doc: NormalizedDoc,
  deps: IngestDeps,
  attachment: HistoryAttachment | undefined,
  signal: AbortSignal | undefined,
): Promise<NormalizedDoc> {
  return withSponsorLinks(
    doc,
    {
      fetcher: deps.fetcher,
      configDir: deps.registry.configDir,
      now: deps.now,
      signal,
    },
    { fromRecord: attachment?.record !== undefined },
  );
}

/** Read the U.S. Code definitions the bill points to (issue #275). Never fails an ingest. */
async function enrichReferences(
  doc: NormalizedDoc,
  deps: IngestDeps,
  signal: AbortSignal | undefined,
): Promise<NormalizedDoc> {
  try {
    return await withReferenceTexts(doc, {
      fetcher: deps.fetcher,
      now: deps.now,
      signal,
      onSkip: deps.onReferenceSkip,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return doc;
  }
}

function countSpans(doc: NormalizedDoc): { inserted: number; deleted: number } {
  let inserted = 0;
  let deleted = 0;
  for (const section of walkSections(doc.sections)) {
    for (const span of section.spans) {
      if (span.status === 'inserted') inserted++;
      else if (span.status === 'deleted') deleted++;
    }
  }
  return { inserted, deleted };
}

function buildStats(
  doc: NormalizedDoc,
  chunks: readonly Chunk[],
  embedTokens: number,
  reused: boolean,
): IngestStats {
  const chunkCountsByType = Object.fromEntries(
    ChunkType.options.map((type) => [type, 0]),
  ) as IngestStats['chunkCountsByType'];
  for (const chunk of chunks) chunkCountsByType[chunk.chunkType]++;
  const { inserted, deleted } = countSpans(doc);
  let sectionCount = 0;
  for (const _ of walkSections(doc.sections)) sectionCount++;
  return {
    format: doc.format,
    sectionCount,
    chunkCountsByType,
    insertedSpanCount: inserted,
    deletedSpanCount: deleted,
    externalRefCount: doc.externalRefs.length,
    embedTokens,
    reused,
  };
}

function summarize(entry: RegistryEntry): DocSummary {
  return DocSummary.parse(entry);
}

/** Wraps a provider to total the tokens that metadata extraction spends. */
function metered(provider: LlmProvider): {
  provider: LlmProvider;
  usage: LlmUsage;
} {
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  const wrapped: LlmProvider = {
    id: provider.id,
    model: provider.model,
    streamText: (req) => provider.streamText(req),
    async generateObject<T>(req: ObjectRequest<T>) {
      const result = await provider.generateObject(req);
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      return result;
    },
  };
  return { provider: wrapped, usage };
}

async function parseFetched(
  fetched: SafeFetchResult,
  deps: IngestDeps,
  signal: AbortSignal | undefined,
): Promise<NormalizedDoc> {
  const limits = deps.parseLimits ?? readParseLimits();
  if (
    fetched.format !== 'pdf' &&
    fetched.bytes.byteLength > limits.maxNonPdfBytes
  )
    throw new AppError('TOO_LARGE');
  const context: ParseContext = {
    sourceUrl: fetched.finalUrl,
    fetchedAt: deps.now().toISOString(),
    signal,
    timeoutMs: limits.timeoutMs,
    maxPages: limits.maxPages,
    publicMode: limits.publicMode,
    maxHtmlBytes: limits.maxHtmlBytes,
    contentType: fetched.contentType,
    preparedHtml: fetched.preparedHtml,
  };
  try {
    switch (fetched.format) {
      case 'xml':
        return parseXml(fetched.bytes, context);
      case 'html':
        return parseHtml(fetched.bytes, context);
      case 'text':
        return parseText(fetched.bytes, context);
      case 'pdf': {
        const doc = await (deps.parsePdf ?? parsePdf)(fetched.bytes, context);
        // Also protect injected parsers and cached documents; the real parser checks before extraction.
        assertPageLimit(doc.pageCount ?? 0, limits.maxPages, limits.publicMode);
        return doc;
      }
      default:
        throw new AppError('UNSUPPORTED_FORMAT');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('PARSE_FAILED', undefined, { cause: error });
  }
}

/** Text the extraction model reads: the start of the document, headings included once. */
function metadataText(doc: NormalizedDoc): string {
  let text = '';
  for (const section of walkSections(doc.sections)) {
    const body = sectionText(section, { includeDeleted: false });
    const header = [section.num, section.heading].filter(Boolean).join(' ');
    // PDF/HTML/text parsers use the first body line as the heading; don't print it twice.
    const firstLine = body.trimStart().split('\n')[0] ?? '';
    const repeated =
      header === '' ||
      body.trimStart().startsWith(header) ||
      (section.heading !== undefined && firstLine.includes(section.heading));
    text += `${repeated ? '' : `${header}\n`}${body}\n`;
    if (text.length >= MAX_METADATA_CHARS) break;
  }
  return text.slice(0, MAX_METADATA_CHARS);
}

const GENERIC_URL_SEGMENTS = new Set([
  'pdf',
  'xml',
  'html',
  'htm',
  'txt',
  'text',
  'download',
  'file',
  'files',
  'view',
  'content',
  'latest',
]);

export function hostLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean).reverse();
    for (const segment of segments) {
      const decoded = decodeURIComponent(segment);
      if (
        !GENERIC_URL_SEGMENTS.has(decoded.toLowerCase()) &&
        !/^[0-9]{2}_[a-z]{2}$/i.test(decoded)
      )
        return decoded;
    }
    return parsed.hostname;
  } catch {
    return '';
  }
}

/** Default label: bill number, else title, else a meaningful URL segment. Unique among labels. */
function chooseLabel(doc: NormalizedDoc, taken: ReadonlySet<string>): string {
  const base =
    [doc.metadata.billNumber, doc.metadata.title, hostLabel(doc.sourceUrl)]
      .map((v) => v?.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL))
      .find((v) => v) ?? doc.docId.slice(0, 12);
  if (!taken.has(base)) return base;
  const suffix = ` (${doc.docId.slice(0, 6)})`;
  return `${base.slice(0, MAX_LABEL - suffix.length)}${suffix}`;
}

/** Chunk and enrich is deterministic and free, so reuse recomputes it to report stats. */
function chunkAndEnrich(
  doc: NormalizedDoc,
  deps: IngestDeps,
  signal?: AbortSignal,
): {
  doc: NormalizedDoc;
  chunks: Chunk[];
} {
  const limits = deps.parseLimits ?? readParseLimits();
  assertPageLimit(doc.pageCount ?? 0, limits.maxPages, limits.publicMode);
  const chunks = chunkDocument(doc, {
    maxChunks: limits.maxChunks,
    timeoutMs: limits.timeoutMs,
    signal,
  });
  assertChunkLimit(chunks.length, limits.maxChunks);
  const enriched = enrichDocument(doc, chunks);
  // Definition enrichment may split chunks further. Count the final indexed records too.
  assertChunkLimit(enriched.chunks.length, limits.maxChunks);
  return enriched;
}

// Ingests of the same document run one at a time: two racing ingests of one docId could
// otherwise clean up (delete the namespace of) each other's work.
const inFlight = new Map<string, Promise<unknown>>();
async function withDocLock<T>(
  docId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = inFlight.get(docId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  inFlight.set(docId, next);
  try {
    return await next;
  } finally {
    if (inFlight.get(docId) === next) inFlight.delete(docId);
  }
}

/**
 * Enforce the cap after the new document is safely registered, so a failed ingest never costs
 * the user an old one. Entries of another backend are left alone: their namespaces can only be
 * deleted through that backend, and dropping the entry would orphan them. Best effort: the
 * ingest itself already succeeded, and a failure here leaves registry and index consistent
 * (the backend delete happens first).
 */
async function enforceCap(deps: IngestDeps, keep: string): Promise<void> {
  const { backend, registry } = deps;
  const guard = deps.evictionGuard;
  try {
    const cap = Math.max(1, deps.maxDocs ?? DEFAULT_MAX_DOCS);
    let listed: ReadonlySet<string> = new Set();
    try {
      listed = (await guard?.listed()) ?? listed;
    } catch {
      // Without the lists nothing can be called unlisted; a server that never evicts listed
      // documents must then evict nothing.
      if (guard?.neverEvictListed) return;
    }
    // The document just ingested and any other being ingested right now must not be the first
    // to go, even though they are on no list yet.
    const protectedIds = new Set([keep, ...(guard?.inFlight() ?? [])]);
    const spared = new Set([...listed, ...protectedIds]);
    for (const old of await registry.evictionCandidates(cap, spared)) {
      if (protectedIds.has(old.docId) || old.backend !== backend.kind) continue;
      if (guard?.neverEvictListed && listed.has(old.docId)) continue;
      await deleteIndexedDocument(backend, old.docId);
      await registry.remove(old.docId);
    }
  } catch {
    // See above: not worth failing a completed ingest.
  }
}

export async function ingest(
  url: string,
  deps: IngestDeps,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const limits = deps.limits ?? sharedLimits();
  const release = await limits.acquire('ingest', opts.signal);
  try {
    return await ingestWithinLimits(
      url,
      { ...deps, provider: limits.meter(deps.provider) },
      opts,
    );
  } finally {
    release();
  }
}

async function ingestWithinLimits(
  url: string,
  deps: IngestDeps,
  opts: IngestOptions,
): Promise<IngestResult> {
  const { signal } = opts;
  deps = { ...deps, parseLimits: deps.parseLimits ?? readParseLimits() };
  opts.onProgress?.({ stage: 'fetching', detail: url });
  // WRAPPER_PAGE (with candidate links in `details`) propagates untouched for callers to offer.
  const newYork = resolveNewYork(url);
  const newJersey = newYork ? undefined : resolveNewJersey(url);
  const plan = newYork || newJersey ? undefined : resolveHistory(url);
  let attachment: HistoryAttachment | undefined;
  let fetchUrl = newYork?.textUrl ?? newJersey?.textUrl ?? url;
  let validateUrl: (url: URL) => void = newYork
    ? assertNewYorkFetch
    : newJersey
      ? assertNewJerseyFetch
      : assertNoCongressFetch;
  if (newJersey?.lookup) {
    // A bill page is a script-rendered shell; the site's own JSON names the newest text.
    const lookupUrl = newJerseyLookupUrl(newJersey.lookup);
    let json: unknown;
    try {
      const listing = await deps.fetcher(lookupUrl, {
        signal,
        validateUrl,
        refresh: true,
      });
      validateUrl(new URL(listing.finalUrl));
      json = JSON.parse(new TextDecoder().decode(listing.bytes));
    } catch (error) {
      // An outage or challenge page must never become a WRAPPER_PAGE offering scraped links.
      if (
        signal?.aborted ||
        (error instanceof AppError && error.code === 'SSRF_BLOCKED')
      )
        throw error;
      throw new AppError('FETCH_FAILED');
    }
    fetchUrl = chooseNewJerseyText(json, newJersey.lookup);
  }
  if (plan) {
    const source = historySource(plan.source);
    validateUrl = (url) => {
      assertHistoryUrl(plan.source, url);
    };
    let record: HistoryRecord | undefined;
    try {
      record = await source.read(
        plan,
        async (historyUrl) => {
          assertHistoryUrl(plan.source, historyUrl);
          const result = await deps.fetcher(historyUrl, {
            signal,
            validateUrl,
            refresh: true,
          });
          assertHistoryUrl(plan.source, result.finalUrl);
          return result;
        },
        deps.now,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      // An explicit version allows text ingest even when the official history is down.
    }
    const version = chooseVersion(plan, record?.history);
    fetchUrl = plan.textUrl ?? source.textUrl(plan, version);
    validateUrl(new URL(fetchUrl));
    attachment = { version, ...(record ? { record } : {}) };
  }
  const fetched = await deps.fetcher(fetchUrl, {
    signal,
    validateUrl,
    parseLimits: deps.parseLimits,
    ...(newYork?.latest ? { refresh: true } : {}),
  });
  validateUrl(new URL(fetched.finalUrl));
  signal?.throwIfAborted();
  const docId = createHash('sha256').update(fetched.bytes).digest('hex');
  if (docId !== fetched.docId)
    throw new AppError(
      'FETCH_FAILED',
      'Fetched document id does not match its bytes.',
    );
  return withDocLock(docId, () =>
    ingestLocked(docId, fetched, deps, opts, attachment),
  );
}

async function ingestLocked(
  docId: string,
  fetched: SafeFetchResult,
  deps: IngestDeps,
  opts: IngestOptions,
  attachment?: HistoryAttachment,
): Promise<IngestResult> {
  const { backend, registry } = deps;
  const { signal } = opts;
  const progress = (p: IngestProgress): void => opts.onProgress?.(p);
  // Having waited for the document lock, a caller that already gave up does no work.
  signal?.throwIfAborted();

  const entries = await registry.list();
  let known = entries.find((e) => e.docId === docId);
  // Fail before spending anything (LLM, embeddings) when the label cannot be used.
  if (!known && opts.label && entries.some((e) => e.label === opts.label))
    throw new AppError('INVALID_INPUT', 'Label already in use.', {
      userMessage:
        'That document label is already in use. Choose a different label.',
    });
  if (deps.admit && !(await deps.admit(docId, known !== undefined)))
    known = undefined;
  const alreadyIndexed = await backend.hasDocument(docId);

  // Zero-token path: nothing to fetch-parse-embed.
  if (known && alreadyIndexed) {
    let touched = await registry.touch(docId);
    const attached = attachHistory(
      await registry.getDocument(docId),
      attachment,
    );
    const sponsored = await enrichSponsors(attached, deps, attachment, signal);
    const cached = await enrichReferences(sponsored, deps, signal);
    if (attachment || cached !== attached) {
      await saveHistory(cached, deps, attachment);
      touched = await registry.updateDocument(cached);
    }
    const { chunks } = chunkAndEnrich(cached, deps, signal);
    progress({ stage: 'done', detail: 'reused' });
    return {
      doc: summarize(touched),
      stats: buildStats(cached, chunks, 0, true),
      usage: { embedTokens: 0, llmInputTokens: 0, llmOutputTokens: 0 },
      normalized: cached,
    };
  }

  await backend.ensureReady(signal);

  // Known entry whose namespace vanished: the registry's cached document already has the
  // metadata, so no parse and no LLM call. Re-embedding is the only cost (and the local
  // backend skips unchanged vectors). Residual cost elsewhere: a namespace left by a crash
  // before registration is re-parsed but not re-extracted (see below).
  const cachedDoc = known
    ? await registry.getDocument(docId).catch(() => undefined)
    : undefined;
  const meter = metered(deps.provider);
  let doc: NormalizedDoc;
  let chunks: Chunk[];
  if (cachedDoc) {
    progress({ stage: 'chunking' });
    ({ doc, chunks } = chunkAndEnrich(cachedDoc, deps, signal));
  } else {
    progress({ stage: 'parsing' });
    const parsed = await parseFetched(fetched, deps, signal);
    signal?.throwIfAborted();
    // Raw bytes reach the disk cache only once they have parsed, so a page that fails to parse
    // (or is not a bill at all) never lands there. The cache is an optimization: a write failure
    // must not fail an ingest whose document is already in hand.
    await fetched.commitCache?.().catch(() => undefined);
    let withMetadata = parsed;
    if (alreadyIndexed) {
      // A previous ingest was interrupted after indexing: don't pay for extraction again.
      withMetadata = {
        ...parsed,
        warnings: [
          ...parsed.warnings,
          'Metadata was not extracted because an earlier ingest was interrupted. Remove and ingest again to fill it in.',
        ],
      };
    } else {
      progress({ stage: 'enriching', detail: 'metadata' });
      const extracted = await extractMetadata(parsed, {
        provider: meter.provider,
        text: metadataText(parsed),
        signal,
      });
      if (extracted.failureCode)
        opts.onDiagnostic?.({
          event: 'metadata_failed',
          code: extracted.failureCode,
        });
      withMetadata = {
        ...parsed,
        metadata: extracted.metadata,
        warnings: [...parsed.warnings, ...extracted.warnings],
      };
    }
    progress({ stage: 'chunking' });
    ({ doc, chunks } = chunkAndEnrich(withMetadata, deps, signal));
  }
  progress({ stage: 'enriching', detail: 'references' });
  doc = await enrichReferences(doc, deps, signal);
  doc = await enrichSponsors(
    attachHistory(doc, attachment),
    deps,
    attachment,
    signal,
  );
  signal?.throwIfAborted();

  let entry: RegistryEntry;
  let embedTokens = 0;
  try {
    progress({ stage: 'embedding', done: 0, total: chunks.length });
    const { usage } = await backend.upsertChunks(docId, chunks, (p) => {
      progress({ stage: 'embedding', done: p.done, total: p.total });
    });
    embedTokens = usage.embedTokens;
    // Chunks changed (or just became visible): no earlier whole-bill scan may be trusted.
    forgetDocument(backend, docId);
    signal?.throwIfAborted();
    await saveHistory(doc, deps, attachment);
    const spent = {
      embedTokens,
      llmInputTokens: meter.usage.inputTokens,
      llmOutputTokens: meter.usage.outputTokens,
    };
    if (known) {
      // Refresh recency (so the re-indexed doc is not next to be evicted) and count the spend.
      entry = await registry.touch(docId, spent);
      if (attachment) entry = await registry.updateDocument(doc);
    } else {
      const labels = new Set((await registry.list()).map((e) => e.label));
      entry = await registry.add(doc, {
        label: opts.label ?? chooseLabel(doc, labels),
        backend: backend.kind,
        usage: spent,
      });
    }
  } catch (error) {
    // Don't leave a half-indexed namespace behind, unless it was there before this attempt or
    // another process registered this document meanwhile (its entry points at the namespace).
    if (!alreadyIndexed) {
      const registeredMeanwhile =
        !known &&
        (await registry.list().catch(() => [])).some((e) => e.docId === docId);
      if (!registeredMeanwhile) {
        await deleteIndexedDocument(backend, docId).catch(() => undefined);
        if (!known)
          await deleteHistory(registry.configDir, docId).catch(() => undefined);
      }
    }
    if (error instanceof AppError || signal?.aborted) throw error;
    throw new AppError('BACKEND_UNAVAILABLE', undefined, { cause: error });
  }

  await enforceCap(deps, docId);
  progress({ stage: 'done' });
  return {
    doc: summarize(entry),
    stats: buildStats(doc, chunks, embedTokens, false),
    usage: {
      embedTokens,
      llmInputTokens: meter.usage.inputTokens,
      llmOutputTokens: meter.usage.outputTokens,
    },
    normalized: doc,
  };
}
