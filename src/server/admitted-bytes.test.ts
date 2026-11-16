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
import { DOWNLOAD_STORE_CAP } from './quotes.js';

const url = 'https://govinfo.gov/a.txt';
let env: PipelineEnv;
let downloads: string[];

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
  env.runtime.fetcher = async (u, o) => {
    downloads.push(u);
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
  for (let i = 0; i < DOWNLOAD_STORE_CAP; i++) {
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

test('a source with no usable text version is a 502, not a 500', async () => {
  const res = await post(hosted(), '/api/quote', {
    url: 'https://govinfo.gov/missing.txt',
  });
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({
    error: { code: 'FETCH_FAILED' },
  });
});
