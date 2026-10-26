/** Query functions called directly: caps, cursors and id resolution without the protocol. */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { makeAmendmentHtml } from '../../tests/synth/index.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { ingest } from '../core/pipeline/index.js';
import {
  estimateTokens,
  getSection,
  HARD_CAP_TOKENS,
  outlineDocument,
  resolveDocId,
  searchDocument,
  type QueryDeps,
} from './queries.js';
import { UntrustedText } from './untrusted.js';

let env: PipelineEnv;
let docId: string;
beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(
    'https://example.gov/permit.html',
    makeAmendmentHtml(),
    'text/html',
  );
  const result = await ingest(
    'https://example.gov/permit.html',
    {
      backend: env.backend,
      provider: env.provider,
      registry: env.registry,
      fetcher: env.runtime.fetcher,
      now: env.runtime.now,
    },
    {},
  );
  docId = result.doc.docId;
});
afterEach(async () => {
  await env.cleanup();
});

const deps = (capTokens?: number): QueryDeps => ({
  backend: env.backend,
  registry: env.registry,
  retrievalMode: 'hybrid_rerank',
  capTokens,
});

test('estimateTokens is characters over four, rounded up', () => {
  expect(estimateTokens('')).toBe(0);
  expect(estimateTokens('abcd')).toBe(1);
  expect(estimateTokens('abcde')).toBe(2);
  // Non-ASCII counts a whole token per UTF-16 unit, so CJK can't hide under the cap.
  expect(estimateTokens('日本語の条文')).toBe(6);
  expect(estimateTokens('abcd日')).toBe(2);
  expect(HARD_CAP_TOKENS).toBe(8000);
});

test('resolveDocId needs hex of 8+ characters and ignores labels', async () => {
  await expect(
    resolveDocId(env.registry, 'local', 'permit.html'),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(resolveDocId(env.registry, 'local', 42)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  await expect(
    resolveDocId(env.registry, 'local', docId.slice(0, 8)),
  ).resolves.toBe(docId);
  await expect(resolveDocId(env.registry, 'local', docId)).resolves.toBe(docId);
  await expect(
    resolveDocId(env.registry, 'local', '0'.repeat(64)),
  ).rejects.toMatchObject({ code: 'NOT_INGESTED' });
  // A document held by another backend is not searchable here.
  await expect(
    resolveDocId(env.registry, 'pinecone', docId),
  ).rejects.toMatchObject({ code: 'NOT_INGESTED' });
});

test('resolveDocId refuses an ambiguous prefix', async () => {
  const registry = {
    list: () =>
      Promise.resolve([
        { docId: `abcdef12${'0'.repeat(56)}`, backend: 'local' },
        { docId: `abcdef12${'1'.repeat(56)}`, backend: 'local' },
      ]),
  } as unknown as PipelineEnv['registry'];
  await expect(
    resolveDocId(registry, 'local', 'abcdef12'),
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('ambiguous') as string,
  });
  await expect(
    resolveDocId(registry, 'local', `abcdef12${'1'.repeat(56)}`),
  ).resolves.toBe(`abcdef12${'1'.repeat(56)}`);
});

test('a lowered cap shrinks the page, flags truncation and the cursor resumes after it', async () => {
  const full = await getSection(
    deps(),
    docId,
    { section: 'sec-1', view: 'redline' },
    new UntrustedText(),
  );
  expect(full.truncated).toBe(false);
  const total = (full.segments ?? []).length;

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: Awaited<ReturnType<typeof getSection>> = await getSection(
      deps(450),
      docId,
      { section: 'sec-1', view: 'redline', cursor },
      new UntrustedText(),
    );
    expect(estimateTokens(JSON.stringify(page))).toBeLessThanOrEqual(450);
    expect((page.segments ?? []).length).toBeGreaterThan(0);
    seen.push(...(page.segments ?? []).map((s) => s.s));
    cursor = page.cursor;
    expect(page.truncated).toBe(cursor !== null);
    pages++;
  } while (cursor && pages < 30);
  expect(pages).toBeGreaterThan(1);
  expect(seen).toHaveLength(total);
});

test('search under a tiny cap returns fewer hits and a cursor to the rest', async () => {
  const wide = await searchDocument(
    deps(),
    docId,
    { query: 'fees' },
    new UntrustedText(),
  );
  expect(wide.hits.length).toBe(2);
  const tight = await searchDocument(
    deps(250),
    docId,
    { query: 'fees' },
    new UntrustedText(),
  );
  expect(tight.hits).toHaveLength(1);
  expect(tight.truncated).toBe(true);
  expect(tight.cursor).not.toBeNull();
  const rest = await searchDocument(
    deps(),
    docId,
    { query: 'fees', cursor: tight.cursor },
    new UntrustedText(),
  );
  expect(rest.hits[0]?.rank).toBe(2);
});

test('search queries get the core question hygiene: invisibles removed, 500-character cap, fixed error', async () => {
  const clean = await searchDocument(
    deps(),
    docId,
    { query: 'fe\u200Bes' },
    new UntrustedText(),
  );
  expect(clean.hits.length).toBeGreaterThan(0);
  for (const query of ['', '   ', '\u200B', 'x'.repeat(501), 42])
    await expect(
      searchDocument(deps(), docId, { query }, new UntrustedText()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  // The cap is measured on the raw input, so invisible padding can't dodge it.
  await expect(
    searchDocument(
      deps(),
      docId,
      { query: `fees${'\u200B'.repeat(500)}` },
      new UntrustedText(),
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

test('outline depth, cursors and a cursor from another request', async () => {
  const flat = await outlineDocument(
    deps(),
    docId,
    { max_level: 1 },
    new UntrustedText(),
  );
  expect(flat.sections_total).toBe(2);
  const small = await outlineDocument(
    deps(130),
    docId,
    {},
    new UntrustedText(),
  );
  expect(small.outline.split('\n')).toHaveLength(1);
  expect(small.truncated).toBe(true);
  const next = await outlineDocument(
    deps(),
    docId,
    { cursor: small.cursor },
    new UntrustedText(),
  );
  expect(next.outline).toContain('sec-2');
  await expect(
    outlineDocument(
      deps(),
      docId,
      { max_level: 1, cursor: small.cursor },
      new UntrustedText(),
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    outlineDocument(deps(), docId, { max_level: 1.5 }, new UntrustedText()),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

test('get_section rejects a bad view and a missing document', async () => {
  await expect(
    getSection(
      deps(),
      docId,
      { section: 'sec-1', view: 'raw' },
      new UntrustedText(),
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    getSection(
      deps(),
      '1'.repeat(64),
      { section: 'sec-1' },
      new UntrustedText(),
    ),
  ).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' });
});

test('a number shared by two sections is ambiguous, not guessed', async () => {
  const doc = await env.registry.getDocument(docId);
  const section = doc.sections[0];
  if (!section) throw new Error('fixture has no section');
  const twin = { ...section, id: 'sec-1b', num: section.num ?? '1' };
  await env.registry.updateDocument({
    ...doc,
    sections: [...doc.sections, twin],
  });
  await expect(
    getSection(deps(), docId, { section: '1' }, new UntrustedText()),
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('more than one') as string,
  });
  const exact = await getSection(
    deps(),
    docId,
    { section: 'sec-1b' },
    new UntrustedText(),
  );
  expect(exact.section).toBe('sec-1b');
});
