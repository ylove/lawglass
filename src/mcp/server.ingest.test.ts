/** Async ingest: the wait limit, status polling, de-duplication, progress and cancellation. */
import { afterEach, expect, test, vi } from 'vitest';
import type { CliRuntime } from '../cli/runtime.js';
import { makeAmendmentHtml } from '../../tests/synth/index.js';
import { makeMcpEnv, type McpEnv } from '../../tests/support/mcp-env.js';
import { TOOL_NAMES } from './server.js';

const URL_A = 'https://example.gov/a.html';

/** Polls the way an agent would: repeat the call until the status is no longer "ingesting". */
async function untilDone(
  env: McpEnv,
  url: string,
): Promise<Awaited<ReturnType<McpEnv['call']>>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await env.call(TOOL_NAMES.ingest, { url });
    if (result.json.status !== 'ingesting') return result;
  }
  throw new Error('ingest never finished');
}
let m: McpEnv | undefined;
afterEach(async () => {
  await m?.close();
  m = undefined;
});

/** A fetcher that holds every request until `release()` (or its signal aborts). */
function gate(): {
  wrap: (base: CliRuntime) => CliRuntime;
  release: () => void;
  state: { started: number; aborted: number };
} {
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { started: 0, aborted: 0 };
  return {
    release,
    state,
    wrap: (base) => ({
      ...base,
      fetcher: async (url, options) => {
        state.started++;
        await new Promise<void>((resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              state.aborted++;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
          void open.then(resolve);
        });
        return base.fetcher(url, options);
      },
    }),
  };
}

test('a slow ingest answers "ingesting", dedupes repeat calls, then reports ready', async () => {
  const g = gate();
  m = await makeMcpEnv({
    runtime: g.wrap,
    server: {
      waitMs: 30,
      retryAfterSeconds: 7,
      randomHex: () => '0123456789abcdef',
    },
  });
  m.env.serve(URL_A, makeAmendmentHtml(), 'text/html');

  const first = await m.call(TOOL_NAMES.ingest, { url: URL_A });
  expect(first.isError).toBe(false);
  expect(first.json).toMatchObject({
    status: 'ingesting',
    retry_after_s: 7,
    progress: { stage: 'fetching' },
  });
  // Polling (and racing) calls find the same job: one fetch, not three.
  const polls = await Promise.all([
    m.call(TOOL_NAMES.ingest, { url: URL_A }),
    m.call(TOOL_NAMES.ingest, { url: URL_A }),
  ]);
  for (const poll of polls) expect(poll.json.status).toBe('ingesting');
  expect(g.state.started).toBe(1);

  g.release();
  const done = await untilDone(m, URL_A);
  expect(done.json.status).toBe('ready');
  expect(g.state.started).toBe(1);
  expect((done.json.doc as { doc_id: string }).doc_id).toMatch(
    /^[a-f0-9]{64}$/,
  );

  // Ready is remembered while the document stays registered ...
  const again = await m.call(TOOL_NAMES.ingest, { url: URL_A });
  expect(again.json.status).toBe('ready');
  expect(g.state.started).toBe(1);
  // ... and re-ingested when it was removed meanwhile.
  const docId = (done.json.doc as { doc_id: string }).doc_id;
  await m.env.backend.deleteDocument(docId);
  await m.env.registry.remove(docId);
  const restarted = await untilDone(m, URL_A);
  expect(restarted.json.status).toBe('ready');
  expect(g.state.started).toBe(2);
});

test('a background failure is reported to the next call once, then retried', async () => {
  let fail = true;
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  m = await makeMcpEnv({
    server: { waitMs: 20 },
    runtime: (base) => ({
      ...base,
      fetcher: async (url, options) => {
        await open;
        if (fail) throw new Error('internal detail that must not leak');
        return base.fetcher(url, options);
      },
    }),
  });
  m.env.serve(URL_A, makeAmendmentHtml(), 'text/html');
  expect((await m.call(TOOL_NAMES.ingest, { url: URL_A })).json.status).toBe(
    'ingesting',
  );
  release();
  await vi.waitFor(async () => {
    const failed = await m?.call(TOOL_NAMES.ingest, { url: URL_A });
    expect(failed?.isError).toBe(true);
    expect(failed?.json).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'The request could not be completed.',
      },
    });
    expect(failed?.text).not.toContain('must not leak');
  });
  fail = false;
  const retried = await untilDone(m, URL_A);
  expect(retried.json.status).toBe('ready');
});

test('progress notifications arrive with a progress token and rise every time', async () => {
  m = await makeMcpEnv({ server: { waitMs: 5_000 } });
  m.env.serve(URL_A, makeAmendmentHtml(), 'text/html');
  const seen: { progress: number; message?: string | undefined }[] = [];
  const result = await m.call(
    TOOL_NAMES.ingest,
    { url: URL_A },
    {
      onprogress: (p) => {
        seen.push({ progress: p.progress, message: p.message });
      },
    },
  );
  expect(result.json.status).toBe('ready');
  expect(seen.length).toBeGreaterThanOrEqual(3);
  const values = seen.map((s) => s.progress);
  expect(values).toEqual([...values].sort((a, b) => a - b));
  expect(new Set(values).size).toBe(values.length);
  const messages = seen.map((s) => s.message ?? '');
  expect(messages.some((text) => text.startsWith('fetching'))).toBe(true);
  expect(messages.some((text) => /^embedding \d+\/\d+$/.test(text))).toBe(true);
});

test('cancelling a call aborts the ingest, and the next call starts afresh', async () => {
  const g = gate();
  m = await makeMcpEnv({ runtime: g.wrap, server: { waitMs: 60_000 } });
  m.env.serve(URL_A, makeAmendmentHtml(), 'text/html');
  const controller = new AbortController();
  const pending = m.client.callTool(
    { name: TOOL_NAMES.ingest, arguments: { url: URL_A } },
    undefined,
    { signal: controller.signal },
  );
  await vi.waitFor(() => {
    expect(g.state.started).toBe(1);
  });
  controller.abort();
  await expect(pending).rejects.toThrow();
  await vi.waitFor(() => {
    expect(g.state.aborted).toBe(1);
  });
  // Nothing was left half-registered, and the cancelled job is forgotten.
  expect(await m.env.registry.list()).toEqual([]);
  g.release();
  const next = await untilDone(m, URL_A);
  expect(next.json.status).toBe('ready');
  expect(g.state.started).toBe(2);
});

test('only so many new documents may be ingested per hour', async () => {
  let clock = 1_000_000;
  m = await makeMcpEnv({ server: { maxIngestsPerHour: 2, now: () => clock } });
  for (const name of ['one', 'two', 'three']) {
    m.env.serve(
      `https://example.gov/${name}.txt`,
      {
        bytes: new TextEncoder().encode(
          `${name} Act\nSection 1. Short\n${name}.\n`,
        ),
      },
      'text/plain',
    );
  }
  expect(
    (await m.call(TOOL_NAMES.ingest, { url: 'https://example.gov/one.txt' }))
      .json.status,
  ).toBe('ready');
  expect(
    (await m.call(TOOL_NAMES.ingest, { url: 'https://example.gov/two.txt' }))
      .json.status,
  ).toBe('ready');
  const limited = await m.call(TOOL_NAMES.ingest, {
    url: 'https://example.gov/three.txt',
  });
  expect(limited.json).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  // A repeat of a known URL is not a new ingest.
  expect(
    (await m.call(TOOL_NAMES.ingest, { url: 'https://example.gov/one.txt' }))
      .json.status,
  ).toBe('ready');
  clock += 3_600_001;
  expect(
    (await m.call(TOOL_NAMES.ingest, { url: 'https://example.gov/three.txt' }))
      .json.status,
  ).toBe('ready');
});
