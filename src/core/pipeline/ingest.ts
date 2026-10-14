/**
 * The shared ingest pipeline: fetch -> parse -> metadata -> chunk -> enrich -> index.
 * The CLI, the server (#29) and eval (#32) all call this, so none of them re-implements
 * dedupe, eviction or cleanup-on-failure.
 */
import { createHash } from 'node:crypto';
import { chunkDocument } from '../chunk/index.js';
import { enrichDocument, extractMetadata } from '../enrich/index.js';
import type { SafeFetchResult } from '../fetch/index.js';
import { parseHtml, parseText, parseXml } from '../parse/index.js';
import {
  AppError,
  ChunkType,
  DocSummary,
  sectionText,
  walkSections,
  type BackendUsage,
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

export type Fetcher = (
  url: string,
  opts?: { signal?: AbortSignal | undefined },
) => Promise<SafeFetchResult>;

export interface ParseContext {
  sourceUrl: string;
  fetchedAt: string;
}
/** TODO(pdf parser): `core/parse` has no `parsePdf` yet; callers inject one once it lands. */
export type PdfParser = (
  bytes: Uint8Array,
  context: ParseContext,
) => NormalizedDoc | Promise<NormalizedDoc>;

export interface IngestDeps {
  backend: RetrievalBackend;
  /** Used for metadata extraction (the cheap "extract" model). */
  provider: LlmProvider;
  registry: Registry;
  fetcher: Fetcher;
  now: () => Date;
  /** LRU cap on indexed documents. Default 5. */
  maxDocs?: number | undefined;
  parsePdf?: PdfParser | undefined;
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
const METADATA_CHARS = 6000;
const MAX_LABEL = 80;

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
): Promise<NormalizedDoc> {
  const context: ParseContext = {
    sourceUrl: fetched.finalUrl,
    fetchedAt: deps.now().toISOString(),
  };
  try {
    switch (fetched.format) {
      case 'xml':
        return parseXml(fetched.bytes, context);
      case 'html':
        return parseHtml(fetched.bytes, context);
      case 'text':
        return parseText(fetched.bytes, context);
      case 'pdf':
        if (!deps.parsePdf)
          throw new AppError(
            'UNSUPPORTED_FORMAT',
            'PDF parsing is not available in this build yet.',
          );
        return await deps.parsePdf(fetched.bytes, context);
      default:
        throw new AppError('UNSUPPORTED_FORMAT');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('PARSE_FAILED', undefined, { cause: error });
  }
}

/** Text the extraction model reads: the start of the document, headings included. */
function metadataText(doc: NormalizedDoc): string {
  let text = '';
  for (const section of walkSections(doc.sections)) {
    text += `${[section.num, section.heading].filter(Boolean).join(' ')}\n`;
    text += `${sectionText(section, { includeDeleted: false })}\n`;
    if (text.length >= METADATA_CHARS) break;
  }
  return text.slice(0, METADATA_CHARS);
}

function hostLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).at(-1);
    return last ? decodeURIComponent(last) : parsed.hostname;
  } catch {
    return '';
  }
}

/** Default label: bill number, else title, else the URL's last segment. Unique among labels. */
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
function chunkAndEnrich(doc: NormalizedDoc): {
  doc: NormalizedDoc;
  chunks: Chunk[];
} {
  return enrichDocument(doc, chunkDocument(doc));
}

export async function ingest(
  url: string,
  deps: IngestDeps,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const { backend, registry } = deps;
  const { signal } = opts;
  const progress = (p: IngestProgress): void => opts.onProgress?.(p);

  progress({ stage: 'fetching', detail: url });
  // WRAPPER_PAGE (with candidate links in `details`) propagates untouched for callers to offer.
  const fetched = await deps.fetcher(url, { signal });
  signal?.throwIfAborted();
  const docId = createHash('sha256').update(fetched.bytes).digest('hex');
  if (docId !== fetched.docId)
    throw new AppError(
      'FETCH_FAILED',
      'Fetched document id does not match its bytes.',
    );

  const entries = await registry.list();
  const known = entries.find((e) => e.docId === docId);
  const alreadyIndexed = await backend.hasDocument(docId);
  if (known && alreadyIndexed) {
    const touched = await registry.touch(docId);
    const cached = await registry.getDocument(docId);
    const { chunks } = chunkAndEnrich(cached);
    progress({ stage: 'done', detail: 'reused' });
    return {
      doc: summarize(touched),
      stats: buildStats(cached, chunks, 0, true),
      usage: { embedTokens: 0, llmInputTokens: 0, llmOutputTokens: 0 },
      normalized: cached,
    };
  }

  progress({ stage: 'parsing' });
  const parsed = await parseFetched(fetched, deps);
  signal?.throwIfAborted();

  progress({ stage: 'enriching', detail: 'metadata' });
  const meter = metered(deps.provider);
  const extracted = await extractMetadata(parsed, {
    provider: meter.provider,
    text: metadataText(parsed),
    signal,
  });
  const withMetadata: NormalizedDoc = {
    ...parsed,
    metadata: extracted.metadata,
    warnings: [...parsed.warnings, ...extracted.warnings],
  };

  progress({ stage: 'chunking' });
  const { doc, chunks } = chunkAndEnrich(withMetadata);
  signal?.throwIfAborted();

  // Make room before indexing: keep at most maxDocs - 1 others, so the new doc fits the cap.
  if (!known) {
    const maxDocs = Math.max(1, deps.maxDocs ?? DEFAULT_MAX_DOCS);
    for (const old of await registry.evictionCandidates(maxDocs - 1)) {
      if (old.backend === backend.kind) await backend.deleteDocument(old.docId);
      await registry.remove(old.docId);
    }
  }

  let usage: BackendUsage | undefined;
  let entry: RegistryEntry;
  try {
    await backend.ensureReady(signal);
    progress({ stage: 'embedding', done: 0, total: chunks.length });
    ({ usage } = await backend.upsertChunks(docId, chunks, (p) => {
      progress({ stage: 'embedding', done: p.done, total: p.total });
    }));
    signal?.throwIfAborted();
    const labels = new Set((await registry.list()).map((e) => e.label));
    entry = await registry.add(doc, {
      label: opts.label ?? chooseLabel(doc, labels),
      backend: backend.kind,
      usage: {
        embedTokens: usage.embedTokens,
        llmInputTokens: meter.usage.inputTokens,
        llmOutputTokens: meter.usage.outputTokens,
      },
    });
  } catch (error) {
    // Do not leave a half-indexed namespace behind, unless it was there before this attempt.
    if (!alreadyIndexed)
      await backend.deleteDocument(docId).catch(() => undefined);
    if (error instanceof AppError || signal?.aborted) throw error;
    throw new AppError('BACKEND_UNAVAILABLE', undefined, { cause: error });
  }

  progress({ stage: 'done' });
  return {
    doc: summarize(entry),
    stats: buildStats(doc, chunks, usage.embedTokens, false),
    usage: {
      embedTokens: usage.embedTokens,
      llmInputTokens: meter.usage.inputTokens,
      llmOutputTokens: meter.usage.outputTokens,
    },
    normalized: doc,
  };
}
