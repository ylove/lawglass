import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  makeUsCodePage,
  SYNTH_USCODE_URL,
} from '../../../tests/synth/govinfo-uscode.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../../tests/support/pipeline-env.js';
import { ingest, type Fetcher, type IngestDeps } from './ingest.js';

const BILL = 'https://example.gov/plots.txt';
const BILL_TEXT = [
  'Synthetic Plots Bill',
  'SECTION 1. Definitions',
  'In this Act:',
  '(1) Plot',
  'The term "plot" has the meaning given that term in section 9001 of title 54, United States Code.',
  'SECTION 2. Rules',
  'A plot shall be registered.',
  '',
].join('\n');

let env: PipelineEnv;
beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(BILL, { bytes: new TextEncoder().encode(BILL_TEXT) }, 'text/plain');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

/** The pipeline's fake fetcher, plus the GovInfo link service answering with a synthetic page. */
function govinfo(available: () => boolean, requested: string[] = []): Fetcher {
  return (url, options) => {
    if (!url.startsWith('https://www.govinfo.gov/link/uscode/'))
      return env.runtime.fetcher(url, options);
    requested.push(url);
    if (!available()) return Promise.reject(new Error('offline'));
    return Promise.resolve({
      docId: 'f'.repeat(64),
      bytes: new TextEncoder().encode(makeUsCodePage()),
      finalUrl: SYNTH_USCODE_URL,
      contentType: 'text/html',
      format: 'html',
      fromCache: false,
    });
  };
}

function deps(fetcher: Fetcher): IngestDeps {
  const { runtime } = env;
  return {
    backend: runtime.backend,
    provider: runtime.extractProvider,
    registry: runtime.registry,
    fetcher,
    now: runtime.now,
  };
}

test('reads the U.S. Code definition a bill relies on and stores it with the document', async () => {
  const requested: string[] = [];
  const stages: string[] = [];
  const result = await ingest(BILL, deps(govinfo(() => true, requested)), {
    onProgress: (p) => stages.push(`${p.stage}:${p.detail ?? ''}`),
  });
  expect(requested).toEqual([
    'https://www.govinfo.gov/link/uscode/54/9001?link-type=html',
  ]);
  expect(stages).toContain('enriching:references');
  const [reference] = result.normalized.references ?? [];
  expect(reference).toMatchObject({
    sectionId: 'ref:usc/54/9001',
    citation: '54 U.S.C. 9001',
    heading: '§9001. Definitions (2024 edition)',
    terms: ['plot'],
  });
  expect(reference?.text).toContain('parcel of land');
  expect(
    result.normalized.externalRefs.find((r) => r.citation === '54 U.S.C. 9001')
      ?.referenceId,
  ).toBe('ref:usc/54/9001');
  // The stored copy is what answers and the sections route read.
  const stored = await env.registry.getDocument(result.doc.docId);
  expect(stored.references).toHaveLength(1);
});

test('a failing reference fetch never fails the ingest or adds a warning', async () => {
  const result = await ingest(BILL, deps(govinfo(() => false)));
  expect(result.normalized.references).toBeUndefined();
  expect(result.normalized.warnings.join(' ')).not.toMatch(
    /U\.S\.C|reference/i,
  );
  expect(await env.backend.hasDocument(result.doc.docId)).toBe(true);
});

test('re-ingesting a document whose references were not read tries again, and then stops asking', async () => {
  let online = false;
  const requested: string[] = [];
  const fetcher = govinfo(() => online, requested);
  const first = await ingest(BILL, deps(fetcher));
  expect(first.normalized.references).toBeUndefined();

  online = true;
  const second = await ingest(BILL, deps(fetcher));
  expect(second.stats.reused).toBe(true);
  expect(second.normalized.references).toHaveLength(1);
  expect(
    (await env.registry.getDocument(second.doc.docId)).references,
  ).toHaveLength(1);

  const asked = requested.length;
  await ingest(BILL, deps(fetcher));
  expect(requested).toHaveLength(asked);
});

test('reference failures reach the log sink as a citation and a code only', async () => {
  const skipped: string[][] = [];
  await ingest(BILL, {
    ...deps(govinfo(() => false)),
    onReferenceSkip: (citation, code) => skipped.push([citation, code]),
  });
  expect(skipped).toEqual([['54 U.S.C. 9001', 'ERROR']]);
});
