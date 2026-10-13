import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../model/index.js';
import { documentId, writeCache } from './cache.js';
import { safeFetch, type SafeFetchOptions } from './index.js';
import type { Resolver } from './resolve.js';

let agent: MockAgent;
let cacheDir: string;
let opts: SafeFetchOptions;
const publicAddress = { address: '8.8.8.8', family: 4 as const };
const origin = 'https://example.gov';
const fixedNow = () => new Date('2026-10-13T00:00:00.000Z');
beforeEach(async () => {
  agent = new MockAgent();
  agent.disableNetConnect();
  cacheDir = await mkdtemp(join(tmpdir(), 'safe-fetch-'));
  opts = {
    cacheDir,
    resolver: () => Promise.resolve([publicAddress]),
    dispatcherFactory: () => agent,
    now: fixedNow,
  };
});
afterEach(async () => {
  await agent.close();
  await rm(cacheDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('safeFetch', () => {
  it('validates input with default options without touching the network or cache', async () => {
    await expect(safeFetch('invalid url')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
  it('uses the real clock when no clock is injected', async () => {
    agent.get(origin).intercept({ path: '/' }).reply(200, 'bill');
    const result = await safeFetch(origin, {
      cacheDir,
      resolver: opts.resolver,
      dispatcherFactory: opts.dispatcherFactory,
    });
    const metadata = JSON.parse(
      await readFile(join(cacheDir, `${result.docId}.json`), 'utf8'),
    ) as { fetchedAt: string };
    expect(Date.parse(metadata.fetchedAt)).toBeGreaterThan(0);
  });
  it('fetches, hashes, caches and reuses a document with the exact result shape', async () => {
    agent
      .get(origin)
      .intercept({ path: '/bill' })
      .reply(200, '<bill/>', { headers: { 'content-type': 'text/html' } });
    const factory = vi.fn(() => agent);
    const fetched = await safeFetch(`${origin}/bill#fragment`, {
      ...opts,
      dispatcherFactory: factory,
    });
    expect(fetched).toEqual({
      docId: documentId(new TextEncoder().encode('<bill/>')),
      bytes: new TextEncoder().encode('<bill/>'),
      finalUrl: `${origin}/bill`,
      contentType: 'text/html',
      format: 'xml',
      fromCache: false,
    });
    expect(factory).toHaveBeenCalledWith(new URL(`${origin}/bill`), [
      publicAddress,
    ]);
    const metadata = JSON.parse(
      await readFile(join(cacheDir, `${fetched.docId}.json`), 'utf8'),
    ) as unknown;
    expect(metadata).toEqual({
      url: `${origin}/bill`,
      finalUrl: `${origin}/bill`,
      contentType: 'text/html',
      fetchedAt: fixedNow().toISOString(),
    });
    expect(await safeFetch(`${origin}/bill`, opts)).toEqual({
      ...fetched,
      fromCache: true,
      bytes: Buffer.from(fetched.bytes),
    });
    agent.assertNoPendingInterceptors();
  });
  it.each([
    'localhost',
    '127.0.0.1',
    '169.254.169.254',
    '[::1]',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '100.64.0.1',
    '[fd00:ec2::254]',
    '[::ffff:127.0.0.1]',
    '2130706433',
    '0x7f.0.0.1',
  ])('rejects %s before dispatch', async (host) => {
    const factory = vi.fn(() => agent);
    await expect(
      safeFetch(`http://${host}/`, {
        ...opts,
        resolver: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
        dispatcherFactory: factory,
      }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([
    'file:///tmp/bill.xml',
    'ftp://example.gov/bill',
    'data:text/plain,bill',
  ])('rejects non-HTTP URLs %s', async (url) => {
    await expect(safeFetch(url, opts)).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
  });
  it.each(['not a url', 'https://name:secret@example.gov'])(
    'rejects invalid or credential-bearing input without exposing it',
    async (url) => {
      await expect(safeFetch(url, opts)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    },
  );
  it.each([
    { maxBytes: 0 },
    { maxBytes: NaN },
    { timeoutMs: -1 },
    { timeoutMs: 0x1_0000_0000 },
    { maxRedirects: -1 },
    { maxRedirects: 1.5 },
    { allowedPorts: [0] },
    { allowedPorts: [65536] },
    { allowedPorts: [443.5] },
    { allowedPorts: [NaN] },
  ])('rejects invalid limits %j', async (limits) => {
    await expect(
      safeFetch(origin, { ...opts, ...limits }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it.each([
    'http://example.gov',
    'https://example.gov',
    'http://example.gov:80',
    'https://example.gov:443',
    'http://example.gov:8080',
    'https://example.gov:8443',
  ])('allows the default document ports at %s', async (url) => {
    agent
      .get(new URL(url).origin)
      .intercept({ path: '/' })
      .reply(200, 'bill text');
    expect((await safeFetch(url, opts)).fromCache).toBe(false);
    agent.assertNoPendingInterceptors();
  });
  it.each([22, 3000, 8000, 9000])(
    'blocks port %s before DNS or dispatch',
    async (port) => {
      const resolver = vi.fn<Resolver>();
      const factory = vi.fn(() => agent);
      await expect(
        safeFetch(`${origin}:${String(port)}`, {
          ...opts,
          resolver,
          dispatcherFactory: factory,
        }),
      ).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
        message: `Port ${String(port)} is not allowed for document downloads.`,
      });
      expect(resolver).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
    },
  );
  it('uses allowedPorts as an override, including default ports and an empty allowlist', async () => {
    const url = `${origin}:9000`;
    agent.get(url).intercept({ path: '/' }).reply(200, 'bill text');
    expect(
      (await safeFetch(url, { ...opts, allowedPorts: [9000] })).fromCache,
    ).toBe(false);
    await expect(
      safeFetch(origin, { ...opts, allowedPorts: [9000] }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    await expect(
      safeFetch(origin, { ...opts, allowedPorts: [] }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });
  it('blocks a redirect to a disallowed port before resolving or dispatching that hop', async () => {
    agent
      .get(origin)
      .intercept({ path: '/' })
      .reply(302, '', { headers: { location: `${origin}:9000/bill` } });
    const resolver = vi.fn<Resolver>().mockResolvedValue([publicAddress]);
    const factory = vi.fn(() => agent);
    await expect(
      safeFetch(origin, { ...opts, resolver, dispatcherFactory: factory }),
    ).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
      message: 'Port 9000 is not allowed for document downloads.',
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    agent.assertNoPendingInterceptors();
  });
  it('rechecks port restrictions on cached final URLs', async () => {
    await writeCache(
      new TextEncoder().encode('bill text'),
      {
        url: `${origin}/`,
        finalUrl: `${origin}:9000/bill`,
        contentType: 'text/plain',
        fetchedAt: fixedNow().toISOString(),
      },
      cacheDir,
    );
    await expect(safeFetch(origin, opts)).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
    expect(
      (await safeFetch(origin, { ...opts, allowedPorts: [443, 9000] }))
        .fromCache,
    ).toBe(true);
  });
  it('keeps an HTML fragment in HTML format and accepts a one-section bill with a PDF link', async () => {
    agent
      .get(origin)
      .intercept({ path: '/fragment' })
      .reply(200, '<p>hi', { headers: { 'content-type': 'text/html' } });
    expect((await safeFetch(`${origin}/fragment`, opts)).format).toBe('html');
    agent
      .get(origin)
      .intercept({ path: '/bill' })
      .reply(
        200,
        '<h2>SECTION 1.</h2><p>(a) Grants.</p><p>(1) Eligibility.</p><a href="bill.pdf">Bill Text (PDF)</a>',
        { headers: { 'content-type': 'text/html' } },
      );
    expect((await safeFetch(`${origin}/bill`, opts)).format).toBe('html');
  });
  it('rejects mixed records and a hostname that rebinds on a redirect', async () => {
    await expect(
      safeFetch(origin, {
        ...opts,
        resolver: () =>
          Promise.resolve([
            publicAddress,
            { address: '192.168.1.1', family: 4 },
          ]),
      }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    agent
      .get(origin)
      .intercept({ path: '/start' })
      .reply(302, '', { headers: { location: '/end' } });
    const resolver = vi
      .fn<Resolver>()
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      safeFetch(`${origin}/start`, { ...opts, resolver }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    expect(resolver).toHaveBeenCalledTimes(2);
    agent.assertNoPendingInterceptors();
  });
  it.each([
    'http://localhost/',
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://[::1]/',
    'http://10.0.0.1/',
    'file:///tmp/bill.xml',
  ])('revalidates redirects to %s', async (location) => {
    agent
      .get(origin)
      .intercept({ path: '/' })
      .reply(302, '', { headers: { location } });
    const resolver: Resolver = (host) =>
      Promise.resolve([
        { address: host === 'localhost' ? '127.0.0.1' : '8.8.8.8', family: 4 },
      ]);
    await expect(
      safeFetch(origin, { ...opts, resolver }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    agent.assertNoPendingInterceptors();
  });
  it('allows five redirects, validates every hop, and preserves the final URL', async () => {
    const statuses = [301, 302, 303, 307, 308];
    for (let i = 0; i < statuses.length; i++) {
      agent
        .get(origin)
        .intercept({ path: `/hop${String(i)}` })
        .reply(statuses[i]!, 'ignored', {
          headers: { location: `hop${String(i + 1)}` },
        });
    }
    agent.get(origin).intercept({ path: '/hop5' }).reply(200, '%PDF-1.7');
    const resolver = vi.fn<Resolver>().mockResolvedValue([publicAddress]);
    const result = await safeFetch(`${origin}/hop0`, { ...opts, resolver });
    expect(result.finalUrl).toBe(`${origin}/hop5`);
    expect(result.format).toBe('pdf');
    expect(resolver).toHaveBeenCalledTimes(6);
    agent.assertNoPendingInterceptors();
  });
  it('rejects a sixth redirect and honors a smaller injected limit', async () => {
    agent
      .get(origin)
      .intercept({ path: '/' })
      .reply(302, '', { headers: { location: '/' } })
      .times(6);
    await expect(safeFetch(origin, opts)).rejects.toMatchObject({
      code: 'TOO_MANY_REDIRECTS',
    });
    agent
      .get(origin)
      .intercept({ path: '/none' })
      .reply(302, '', { headers: { location: '/' } });
    await expect(
      safeFetch(`${origin}/none`, { ...opts, maxRedirects: 0 }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
    agent.assertNoPendingInterceptors();
  });
  it('follows cross-origin redirects without following wrapper links', async () => {
    agent
      .get(origin)
      .intercept({ path: '/start' })
      .reply(302, '', { headers: { location: 'http://other.gov/bill.xml' } });
    agent
      .get('http://other.gov')
      .intercept({ path: '/bill.xml' })
      .reply(200, '<bill/>');
    const factory = vi.fn(() => agent);
    expect(
      (
        await safeFetch(`${origin}/start`, {
          ...opts,
          dispatcherFactory: factory,
        })
      ).finalUrl,
    ).toBe('http://other.gov/bill.xml');
    expect(factory.mock.calls).toHaveLength(2);
  });
  it.each([
    ['length', '123', 'small'],
    ['stream', undefined, '123456789'],
    ['lying length', '1', '123456789'],
  ])('enforces the %s size cap', async (_name, length, body) => {
    agent
      .get(origin)
      .intercept({ path: '/' })
      .reply(200, body, {
        headers: length ? { 'content-length': length } : {},
      });
    await expect(
      safeFetch(origin, { ...opts, maxBytes: 5 }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(await readdir(cacheDir)).toEqual([]);
  });
  it('allows exactly the cap and handles malformed Content-Length', async () => {
    agent
      .get(origin)
      .intercept({ path: '/' })
      .reply(200, '12345', { headers: { 'content-length': 'malformed' } });
    expect(
      (await safeFetch(origin, { ...opts, maxBytes: 5 })).bytes,
    ).toHaveLength(5);
  });
  it('handles an empty body and distinguishes binary unknown data', async () => {
    agent.get(origin).intercept({ path: '/empty' }).reply(204, '');
    expect((await safeFetch(`${origin}/empty`, opts)).bytes).toHaveLength(0);
    agent
      .get(origin)
      .intercept({ path: '/binary' })
      .reply(200, Buffer.from([255, 0, 1]));
    expect((await safeFetch(`${origin}/binary`, opts)).format).toBe('unknown');
  });
  it('returns candidate details for wrappers and caches no wrapper', async () => {
    agent
      .get(origin)
      .intercept({ path: '/wrapper' })
      .reply(
        200,
        '<html><a href="/bill.pdf">PDF</a><a href="bill.xml">XML</a></html>',
      );
    await expect(safeFetch(`${origin}/wrapper`, opts)).rejects.toMatchObject({
      code: 'WRAPPER_PAGE',
      details: {
        links: [
          { url: `${origin}/bill.pdf`, text: 'PDF', format: 'pdf' },
          { url: `${origin}/bill.xml`, text: 'XML', format: 'xml' },
        ],
      },
    });
    agent.assertNoPendingInterceptors();
    expect(await readdir(cacheDir)).toEqual([]);
  });
  it.each([404, 500, 300])('maps HTTP %s to FETCH_FAILED', async (status) => {
    agent.get(origin).intercept({ path: '/' }).reply(status, 'error');
    await expect(safeFetch(origin, opts)).rejects.toBeInstanceOf(AppError);
  });
  it('handles missing and invalid redirect destinations', async () => {
    agent.get(origin).intercept({ path: '/missing' }).reply(302, '');
    await expect(safeFetch(`${origin}/missing`, opts)).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    });
    agent
      .get(origin)
      .intercept({ path: '/bad' })
      .reply(302, '', { headers: { location: 'http://[bad' } });
    await expect(safeFetch(`${origin}/bad`, opts)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
  it('maps DNS and transport errors without exposing credentials', async () => {
    await expect(
      safeFetch(origin, {
        ...opts,
        resolver: () => Promise.reject(new Error('secret-key')),
      }),
    ).rejects.toMatchObject({
      code: 'FETCH_FAILED',
      message: 'The document could not be downloaded.',
      cause: undefined,
    });
    agent
      .get(origin)
      .intercept({ path: '/' })
      .replyWithError(new Error('secret-key'));
    await expect(safeFetch(origin, opts)).rejects.toMatchObject({
      code: 'FETCH_FAILED',
      message: 'The document could not be downloaded.',
      cause: undefined,
    });
  });
  it('times out transport and hanging resolution', async () => {
    agent.get(origin).intercept({ path: '/' }).reply(200, '<bill/>').delay(100);
    await expect(
      safeFetch(origin, { ...opts, timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'FETCH_TIMEOUT' });
    await expect(
      safeFetch(origin, {
        ...opts,
        timeoutMs: 10,
        resolver: () =>
          new Promise(() => {
            /* Deliberately never resolves. */
          }),
      }),
    ).rejects.toMatchObject({ code: 'FETCH_TIMEOUT' });
  });
  it('revalidates cached final URLs, caps cached bytes, and detects cached wrappers', async () => {
    const metadata = {
      url: `${origin}/`,
      finalUrl: 'http://127.0.0.1/',
      contentType: 'text/plain',
      fetchedAt: fixedNow().toISOString(),
    };
    await writeCache(new TextEncoder().encode('text'), metadata, cacheDir);
    await expect(safeFetch(origin, opts)).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
    await expect(
      safeFetch(origin, { ...opts, maxBytes: 1 }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await rm(cacheDir, { recursive: true });
    await writeCache(
      new TextEncoder().encode('<html><a href="bill.pdf">PDF</a></html>'),
      { ...metadata, finalUrl: `${origin}/` },
      cacheDir,
    );
    await expect(safeFetch(origin, opts)).rejects.toMatchObject({
      code: 'WRAPPER_PAGE',
    });
  });
  it('reuses a redirected cache snapshot and refetches corrupt bytes', async () => {
    agent
      .get(origin)
      .intercept({ path: '/start' })
      .reply(302, '', { headers: { location: '/end' } });
    agent.get(origin).intercept({ path: '/end' }).reply(200, 'bill text');
    const fetched = await safeFetch(`${origin}/start`, opts);
    expect((await safeFetch(`${origin}/start`, opts)).fromCache).toBe(true);
    await writeFile(join(cacheDir, fetched.docId), 'corrupt');
    agent.get(origin).intercept({ path: '/start' }).reply(200, 'new bill text');
    expect((await safeFetch(`${origin}/start`, opts)).fromCache).toBe(false);
  });
  it('cleans up a production dispatcher after transport failure under the network guard', async () => {
    await expect(
      safeFetch(origin, { cacheDir, resolver: opts.resolver }),
    ).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });
  it('maps cache write failures to a stable application error', async () => {
    const file = join(cacheDir, 'file');
    await writeFile(file, 'x');
    await expect(
      safeFetch(origin, { ...opts, cacheDir: file }),
    ).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });
});
