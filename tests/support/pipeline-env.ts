/**
 * End-to-end pipeline harness: a real LocalBackend (fake embedder/reranker), a real Registry
 * in a temp dir, the shipped mock LLM, and an injected fetcher. No network, no model downloads.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SafeFetchResult } from '../../src/core/fetch/index.js';
import { sniffFormat } from '../../src/core/fetch/index.js';
import { LocalBackend } from '../../src/core/index/index.js';
import { MockProvider } from '../../src/core/llm/mock.js';
import { AppError, type NormalizedDoc } from '../../src/core/model/index.js';
import type { CliRuntime } from '../../src/cli/runtime.js';
import type { PdfParser } from '../../src/core/pipeline/index.js';
import { Registry } from '../../src/core/registry.js';
import { FakeEmbedder, FakeReranker } from '../contracts/fake-local-models.js';
import type { SyntheticSample } from '../synth/types.js';

export interface PipelineEnv {
  dir: string;
  backend: LocalBackend;
  embedder: FakeEmbedder;
  reranker: FakeReranker;
  registry: Registry;
  provider: MockProvider;
  /** Serve a sample at a URL. */
  serve(
    url: string,
    sample: Pick<SyntheticSample, 'bytes'>,
    contentType?: string,
  ): void;
  fetches: string[];
  runtime: CliRuntime;
  cleanup(): Promise<void>;
}

export async function makePipelineEnv(
  options: { parsePdf?: PdfParser } = {},
): Promise<PipelineEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'pipeline-env-'));
  let tick = 0;
  // Strictly increasing clock so LRU order is deterministic.
  const now = (): Date => new Date(Date.UTC(2026, 9, 13, 0, 0, tick++));
  const embedder = new FakeEmbedder();
  const reranker = new FakeReranker();
  const backend = new LocalBackend({
    root: join(dir, 'store'),
    embedder,
    reranker,
  });
  const registry = new Registry(join(dir, 'config'), { now });
  const provider = new MockProvider();
  const pages = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const fetches: string[] = [];
  const fetcher = (url: string): Promise<SafeFetchResult> => {
    fetches.push(url);
    const page = pages.get(url);
    if (!page) return Promise.reject(new AppError('FETCH_FAILED'));
    return Promise.resolve({
      docId: createHash('sha256').update(page.bytes).digest('hex'),
      bytes: page.bytes,
      finalUrl: url,
      contentType: page.contentType,
      format: sniffFormat(page.bytes, page.contentType, url),
      fromCache: false,
    });
  };
  const runtime: CliRuntime = {
    backend,
    registry,
    fetcher,
    now,
    maxDocs: 5,
    retrievalMode: 'hybrid_rerank',
    port: 4317,
    answerProvider: provider,
    extractProvider: provider,
    parsePdf: options.parsePdf,
  };
  return {
    dir,
    backend,
    embedder,
    reranker,
    registry,
    provider,
    fetches,
    runtime,
    serve: (url, sample, contentType = 'application/octet-stream') => {
      pages.set(url, { bytes: sample.bytes, contentType });
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Stand-in for the PDF parser (not on main yet): uses a synthetic sample's ground truth. */
export function stubPdfParser(sample: SyntheticSample): PdfParser {
  return (bytes, context): NormalizedDoc => ({
    docId: createHash('sha256').update(bytes).digest('hex'),
    sourceUrl: context.sourceUrl,
    format: 'pdf',
    fetchedAt: context.fetchedAt,
    metadata: {
      title: null,
      billNumber: null,
      jurisdiction: null,
      session: null,
      version: null,
      sponsors: null,
      source: 'none',
    },
    sections: sample.groundTruth.sections,
    definitions: [],
    externalRefs: [],
    warnings: [],
    pageCount: 1,
  });
}
