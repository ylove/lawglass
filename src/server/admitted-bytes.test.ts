/**
 * An admitted ingest reads the bytes that were priced (#407). New York pages carry random
 * cache-busters, so a second download never hashes like the first; the ingest must not need one.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Hono } from 'hono';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { makeSectionedText } from '../../tests/synth/index.js';
import { envVar } from '../core/brand.js';
import { IngestEvent } from '../core/model/index.js';
import { resetSharedLimits } from '../core/pipeline/limits.js';
import { readSseEvents } from '../web/sse.js';
import { createApp, type AppOptions, type ExternalAuth } from './app.js';
import { DOWNLOAD_PER_READER_CAP } from './quotes.js';

const url = 'https://govinfo.gov/a.txt';
let env: PipelineEnv;
let downloads: string[];
/** Lets a test hold a download open; called as each download starts. */
let fetchGate: (() => Promise<void>) | undefined;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
/** Long enough for any request that is not waiting on something to reach where it will wait. */
const flush = async () => {
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => setImmediate(resolve));
};

const auth: ExternalAuth = {
  middleware: async (c, next) =>
    c.req.header('x-reader') ? next() : c.text('Sign in', 401),
  readerId: (c) => c.req.header('x-reader') ?? 'nobody',
};
const RATE = { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 };

beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(url, makeSectionedText(), 'text/plain');
  vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '10000');
  vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), '0');
  resetSharedLimits();
  // Every download of the same page differs in its bytes, like nyassembly.gov.
  const real = env.runtime.fetcher;
  let n = 0;
  downloads = [];
  fetchGate = undefined;
  env.runtime.fetcher = async (u, o) => {
    downloads.push(u);
    await fetchGate?.();
    const page = await real(u, o);
    // A fixed-length counter in a trailing line: the bytes differ, the bill's size does not.
    const suffix = new TextEncoder().encode(String(++n).padStart(6, '0'));
    const bytes = new Uint8Array([...page.bytes, ...suffix]);
    return { ...page, bytes, docId: await sha256(bytes) };
  };
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetSharedLimits();
  await env.cleanup();
});

async function sha256(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

const hosted = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, {
    auth,
    backgroundScope: () => Promise.resolve(undefined),
    admission: () => Promise.resolve({ allow: true, ref: 'ref' }),
    logWriter: () => undefined,
    summaryWaitMs: 20,
    ...options,
    quote: {
      prices: { deterministic: RATE },
      perHour: 1000,
      perReaderPerHour: 1000,
      ...options.quote,
    },
  });
const post = (a: Hono, path: string, body: unknown, reader = 'alice') =>
  a.request(path, {
    method: 'POST',
    headers: { 'x-reader': reader, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
/** Pushes this reader's kept download of `url` out by quoting other addresses (the count bound). */
async function evictKept(a: Hono): Promise<void> {
  for (let i = 0; i < DOWNLOAD_PER_READER_CAP; i++) {
    const other = `https://govinfo.gov/filler-${String(i)}.txt`;
    env.serve(other, makeSectionedText(), 'text/plain');
    await quote(a, other);
  }
}
const quote = async (a: Hono, source = url) =>
  (await (await post(a, '/api/quote', { url: source })).json()) as {
    quoteId: string;
  };
async function ingest(
  a: Hono,
  body: { url: string; quoteId?: string },
  reader = 'alice',
) {
  const res = await post(a, '/api/ingest', body, reader);
  const events = [];
  for await (const e of readSseEvents(res, IngestEvent)) events.push(e);
  return events.at(-1);
}

describe('an admitted ingest of a source whose bytes change on every download', () => {
  test('with a live quote: reads the quoted bytes, downloading once', async () => {
    const a = hosted();
    const { quoteId } = await quote(a);
    expect(await ingest(a, { url, quoteId })).toMatchObject({ type: 'done' });
    expect(downloads).toHaveLength(1);
    expect(await env.registry.list()).toHaveLength(1);
  });

  test('with no quote: measures once and reads those bytes', async () => {
    const a = hosted();
    expect(await ingest(a, { url })).toMatchObject({ type: 'done' });
    expect(downloads).toHaveLength(1);
  });

  test('the kept bytes survive an ingest, so a retry reads them too', async () => {
    const a = hosted();
    const { quoteId } = await quote(a);
    await ingest(a, { url, quoteId });
    expect(await ingest(a, { url, quoteId })).toMatchObject({ type: 'done' });
    expect(downloads).toHaveLength(1);
  });

  test('another reader does not get these bytes: they download their own', async () => {
    const a = hosted();
    await quote(a);
    expect(await ingest(a, { url }, 'bob')).toMatchObject({ type: 'done' });
    expect(downloads).toHaveLength(2);
  });

  test('a quote whose download was evicted measures again and completes', async () => {
    const a = hosted();
    const { quoteId } = await quote(a);
    await evictKept(a);
    expect(await ingest(a, { url, quoteId })).toMatchObject({ type: 'done' });
  });
});

describe('a genuinely different document is still refused', () => {
  const other = {
    bytes: new TextEncoder().encode(
      'Another Bill\nSECTION 1. Other\nA wholly different sentence about gardens.\n',
    ),
  };

  test('when the quote was evicted and the bill changed since', async () => {
    const a = hosted();
    const { quoteId } = await quote(a);
    await evictKept(a);
    env.serve(url, other, 'text/plain');
    // Refused at admission, before a stream opens.
    const res = await post(a, '/api/ingest', { url, quoteId });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      error: { code: 'PAYMENT_REQUIRED' },
    });
    expect(await env.registry.list()).toEqual([]);
  });

  test('a changed bill after the quote does not alter what the quote reads', async () => {
    const a = hosted();
    const { quoteId } = await quote(a);
    env.serve(url, other, 'text/plain');
    // The kept bytes are the priced bill, so that is what is indexed, not the new text.
    expect(await ingest(a, { url, quoteId })).toMatchObject({ type: 'done' });
    const [doc] = await env.registry.list();
    expect(
      JSON.stringify(await env.registry.getDocument(doc!.docId)),
    ).not.toContain('wholly different');
  });
});

describe('a host that binds its own quote to the docId it sees at admission', () => {
  /** Refuses the first ingest with a 402 and admits the second only for the same docId. */
  function hostQuoted() {
    const seen: string[] = [];
    const a = hosted({
      admission: (_c, job) => {
        if (job.kind !== 'ingest') return Promise.resolve({ allow: true });
        seen.push(job.docId ?? '');
        return Promise.resolve(
          seen.length === 1 || job.docId !== seen[0]
            ? {
                allow: false as const,
                status: 402 as const,
                quote: { quoteId: 'host-q', display: '$1.00' },
              }
            : { allow: true as const, ref: 'ref' },
        );
      },
    });
    return { a, seen };
  }
  const hostId = { quoteId: 'host-q' };

  test('with no earlier /api/quote: one download across the refusal and the confirm', async () => {
    const { a, seen } = hostQuoted();
    const refused = await post(a, '/api/ingest', { url, ...hostId });
    expect(refused.status).toBe(402);
    expect(await ingest(a, { url, ...hostId })).toMatchObject({ type: 'done' });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    expect(downloads).toHaveLength(1);
  });

  test('the 30 minutes run from the last admission, not from the download', async () => {
    let t = 1_000_000;
    const seen: string[] = [];
    const a = hosted({
      now: () => t,
      admission: (_c, job) => {
        seen.push(job.docId ?? '');
        return Promise.resolve(
          seen.length === 1
            ? {
                allow: false as const,
                status: 402 as const,
                quote: { quoteId: 'host-q', display: '$1.00' },
              }
            : { allow: true as const, ref: 'ref' },
        );
      },
    });
    await quote(a);
    t += 25 * 60_000; // the reader reads the quote page for a while
    expect((await post(a, '/api/ingest', { url, ...hostId })).status).toBe(402);
    t += 6 * 60_000; // 31 minutes after the download, 6 after the refusal
    expect(await ingest(a, { url, ...hostId })).toMatchObject({ type: 'done' });
    expect(seen[1]).toBe(seen[0]);
    expect(downloads).toHaveLength(1);
  });

  test("another reader's quotes do not push this reader's bytes out", async () => {
    const { a, seen } = hostQuoted();
    await post(a, '/api/ingest', { url, ...hostId });
    for (let i = 0; i < 10; i++) {
      const other = `https://govinfo.gov/bob-${String(i)}.txt`;
      env.serve(other, makeSectionedText(), 'text/plain');
      await post(a, '/api/quote', { url: other }, 'bob');
    }
    expect(await ingest(a, { url, ...hostId })).toMatchObject({ type: 'done' });
    expect(seen[1]).toBe(seen[0]);
    expect(downloads.filter((d) => d === url)).toHaveLength(1);
  });

  test('after /api/quote: no download beyond the quote', async () => {
    const { a, seen } = hostQuoted();
    const { quoteId: ours } = await quote(a);
    expect(ours).not.toBe('host-q');
    await post(a, '/api/ingest', { url, ...hostId });
    expect(await ingest(a, { url, ...hostId })).toMatchObject({ type: 'done' });
    expect(seen[1]).toBe(seen[0]);
    expect(downloads).toHaveLength(1);
  });
});

describe("a bill whose parse is too big for a reader's share", () => {
  // Calibrated below: the sample's raw bytes fit the share, its counted parse does not.
  const small = { quote: { downloadBudgetBytes: 8_000 } };

  test('keeps only the bytes, re-parses at the confirm, and still downloads once', async () => {
    const reparse = vi.spyOn(
      await import('../core/pipeline/ingest.js'),
      'parseDocument',
    );
    const seen: string[] = [];
    const a = hosted({
      ...small,
      admission: (_c, job) => {
        seen.push(job.docId ?? '');
        return Promise.resolve(
          seen.length === 1
            ? {
                allow: false as const,
                status: 402 as const,
                quote: { quoteId: 'host-q', display: '$1.00' },
              }
            : { allow: true as const, ref: 'ref' },
        );
      },
    });
    expect(
      (await post(a, '/api/ingest', { url, quoteId: 'host-q' })).status,
    ).toBe(402);
    expect(await ingest(a, { url, quoteId: 'host-q' })).toMatchObject({
      type: 'done',
    });
    expect(seen[1]).toBe(seen[0]);
    expect(downloads).toHaveLength(1);
    // The first ingest used its own fresh parse; only the confirm parses the kept bytes.
    expect(reparse).toHaveBeenCalledTimes(1);
  });

  test('a re-parse that no longer prices the same is refused', async () => {
    const a = hosted(small);
    await post(a, '/api/quote', { url });
    // The kept bytes now parse differently (a different parser build, say).
    vi.spyOn(
      await import('../core/pipeline/ingest.js'),
      'parseDocument',
    ).mockResolvedValueOnce(
      (await import('../core/parse/index.js')).parseText(
        new TextEncoder().encode('Other\nSECTION 1. X\nShort.\n'),
        { sourceUrl: url, fetchedAt: '2026-10-13T00:00:00.000Z' },
      ),
    );
    const res = await post(a, '/api/ingest', { url });
    expect(res.status).toBe(402);
    expect(await env.registry.list()).toEqual([]);
  });
});

describe('requests of one reader for one address are ordered', () => {
  const refuseFirst =
    (seen: string[]): AppOptions['admission'] =>
    (_c, job) => {
      seen.push(job.docId ?? '');
      return Promise.resolve(
        seen.length === 1
          ? {
              allow: false as const,
              status: 402 as const,
              quote: { quoteId: 'host-q', display: '$1.00' },
            }
          : { allow: true as const, ref: 'ref' },
      );
    };

  test('two ingests that both miss do not download twice: the second reads the first bytes', async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    fetchGate = () => {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    };
    const seen: string[] = [];
    const a = hosted({ admission: refuseFirst(seen) });
    const one = post(a, '/api/ingest', { url, quoteId: 'host-q' });
    const two = post(a, '/api/ingest', { url, quoteId: 'host-q' });
    await flush();
    // The second waits behind the first instead of starting a download of its own.
    expect(gates).toHaveLength(1);
    gates[0]?.resolve();
    const results = await Promise.all([one, two]);
    await Promise.all(results.map((r) => r.text()));
    expect(results.map((r) => r.status).sort()).toEqual([200, 402]);
    expect(seen[1]).toBe(seen[0]);
    expect(downloads).toHaveLength(1);
  });

  test('a quote cannot replace the kept bytes while an admission is re-parsing them', async () => {
    const ingestModule = await import('../core/pipeline/ingest.js');
    const realParse = ingestModule.parseDocument;
    const reparseGate = deferred();
    const reparseEntered = deferred();
    vi.spyOn(ingestModule, 'parseDocument').mockImplementationOnce(
      async (...args: Parameters<typeof realParse>) => {
        reparseEntered.resolve();
        await reparseGate.promise;
        return realParse(...args);
      },
    );
    const seen: string[] = [];
    // Share small enough that only the bytes are kept, so admission has to re-parse them.
    const a = hosted({
      quote: { downloadBudgetBytes: 8_000 },
      admission: refuseFirst(seen),
    });
    const first = (await (await post(a, '/api/quote', { url })).json()) as {
      facts: { contentHash: string };
    };
    const admission = post(a, '/api/ingest', { url, quoteId: 'host-q' });
    // The quote is sent while the admission is paused inside its re-parse.
    await reparseEntered.promise;
    const second = post(a, '/api/quote', { url });
    await flush();
    // The new quote waits behind the admission instead of downloading and replacing the entry.
    expect(downloads).toHaveLength(1);
    reparseGate.resolve();
    const refused = await admission;
    expect(refused.status).toBe(402);
    expect(seen[0]).toBe(first.facts.contentHash);
    const latest = (await (await second).json()) as {
      facts: { contentHash: string };
    };
    expect(latest.facts.contentHash).not.toBe(first.facts.contentHash);
    // What the reader last saw (the second quote) is what is kept for the next admission.
    await (await post(a, '/api/ingest', { url, quoteId: 'host-q' })).text();
    expect(seen[1]).toBe(latest.facts.contentHash);
  });
});

test('a source with no usable text version is a 502, not a 500', async () => {
  const res = await post(hosted(), '/api/quote', {
    url: 'https://govinfo.gov/missing.txt',
  });
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({
    error: { code: 'FETCH_FAILED' },
  });
});
