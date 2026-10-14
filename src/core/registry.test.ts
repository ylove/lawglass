import {
  mkdtemp,
  readFile,
  rm,
  stat,
  readdir,
  chmod,
  writeFile,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerCache, type AnswerCacheKey } from './answer-cache.js';
import { BRAND } from './brand.js';
import { Registry } from './registry.js';
import {
  EMPTY_METADATA,
  type AnswerResult,
  type NormalizedDoc,
} from './model/index.js';

let dir: string;
beforeEach(async () => {
  dir = join(
    await mkdtemp(join(tmpdir(), 'registry-test-')),
    BRAND.configDirName,
  );
});
afterEach(async () => {
  await rm(join(dir, '..'), { recursive: true, force: true });
});

const id = (c: string): string => c.repeat(64);
function doc(docId: string, title: string | null = 'Bill'): NormalizedDoc {
  return {
    docId,
    sourceUrl: 'https://example.com/bill',
    format: 'html',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    metadata: { ...EMPTY_METADATA, title, billNumber: 'HB 1' },
    sections: [],
    definitions: [],
    externalRefs: [],
    warnings: [],
  };
}
function clock(): { now: () => Date; set: (iso: string) => void } {
  let t = new Date('2026-01-01T00:00:00.000Z');
  return {
    now: () => t,
    set: (iso) => {
      t = new Date(iso);
    },
  };
}

describe('Registry', () => {
  it('adds entries and stores the document privately (0600 file, 0700 dir)', async () => {
    const r = new Registry(dir);
    const entry = await r.add(doc(id('a')), { label: 'one', backend: 'local' });
    expect(entry).toMatchObject({
      docId: id('a'),
      label: 'one',
      title: 'Bill',
      billNumber: 'HB 1',
      backend: 'local',
    });
    expect(entry.usage).toEqual({
      embedTokens: 0,
      rerankUnits: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
    });
    expect((await stat(join(dir, 'registry.json'))).mode & 0o777).toBe(0o600);
    expect(
      (await stat(join(dir, 'docs', `${id('a')}.json`))).mode & 0o777,
    ).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await r.list()).toEqual([entry]);
    expect((await r.getDocument(id('a'))).docId).toBe(id('a'));
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('list is empty with no registry; re-adding the same doc is a no-op', async () => {
    const r = new Registry(dir);
    expect(await r.list()).toEqual([]);
    const first = await r.add(doc(id('a')), {
      label: 'one',
      backend: 'local',
      usage: { embedTokens: 5 },
    });
    const again = await r.add(doc(id('a')), {
      label: 'other',
      backend: 'local',
      usage: { embedTokens: 5 },
    });
    expect(again).toEqual(first);
    expect((await r.list())[0]?.usage.embedTokens).toBe(5);
  });

  it('rejects duplicate labels, bad labels, and invalid docs', async () => {
    const r = new Registry(dir);
    await r.add(doc(id('a')), { label: 'one', backend: 'local' });
    await expect(
      r.add(doc(id('b')), { label: 'one', backend: 'local' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      r.add(doc(id('b')), { label: '  ', backend: 'local' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      r.add(doc('nothex'), { label: 'x', backend: 'local' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await r.list()).toHaveLength(1);
  });

  it('touch updates lastUsedAt and accumulates usage', async () => {
    const c = clock();
    const r = new Registry(dir, { now: c.now });
    await r.add(doc(id('a')), { label: 'one', backend: 'local' });
    c.set('2026-02-01T00:00:00.000Z');
    await r.touch(id('a'), { llmInputTokens: 10 });
    const entry = await r.touch(id('a'), { llmInputTokens: 5, rerankUnits: 2 });
    expect(entry.lastUsedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(entry.ingestedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(entry.usage).toMatchObject({ llmInputTokens: 15, rerankUnits: 2 });
    await expect(r.touch(id('f'))).rejects.toMatchObject({
      code: 'DOC_NOT_FOUND',
    });
    await expect(r.touch('../x')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(r.touch(id('a'), { embedTokens: -1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('remove deletes entry and cached doc, tolerating a missing file', async () => {
    const r = new Registry(dir);
    await r.add(doc(id('a')), { label: 'one', backend: 'local' });
    await r.remove(id('a'));
    expect(await r.list()).toEqual([]);
    await expect(
      readFile(join(dir, 'docs', `${id('a')}.json`)),
    ).rejects.toThrow();
    await r.remove(id('a'));
    await expect(r.getDocument(id('a'))).rejects.toMatchObject({
      code: 'DOC_NOT_FOUND',
    });
  });

  it('remove evicts on-disk answers and preserves answers for other documents', async () => {
    const registry = new Registry(dir);
    const cache = new AnswerCache({ dir: join(dir, 'cache', 'answers') });
    const key: AnswerCacheKey = {
      docId: id('a'),
      chipId: 'summary',
      provider: 'mock',
      model: 'test',
      promptVersion: '1',
    };
    const answer: AnswerResult = {
      text: 'Grants are funded [S:sec-1].',
      citations: [{ sectionId: 'sec-1', valid: true, chunkIds: [] }],
      invalidCitations: [],
      warnings: [],
      declined: false,
      readingGrade: 5,
      provider: key.provider,
      model: key.model,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    await registry.add(doc(id('a')), { label: 'a', backend: 'local' });
    await registry.add(doc(id('b')), { label: 'b', backend: 'local' });
    await cache.set(key, answer);
    await cache.set({ ...key, docId: id('b') }, answer);
    await registry.remove(id('a'));
    expect(await cache.get(key)).toBeUndefined();
    expect(await cache.get({ ...key, docId: id('b') })).toEqual(answer);
    expect((await registry.list()).map((entry) => entry.docId)).toEqual([
      id('b'),
    ]);
  });

  it('keeps the document registered if answer eviction fails, allowing removal to retry', async () => {
    const evictDocument = vi
      .fn()
      .mockRejectedValueOnce(new Error('cache failure'))
      .mockResolvedValue(undefined);
    const registry = new Registry(dir, { answerCache: { evictDocument } });
    await registry.add(doc(id('a')), { label: 'a', backend: 'local' });
    await expect(registry.remove(id('a'))).rejects.toThrow('cache failure');
    expect(await registry.getDocument(id('a'))).toEqual(doc(id('a')));
    await registry.remove(id('a'));
    expect(await registry.list()).toEqual([]);
    expect(evictDocument).toHaveBeenCalledTimes(2);
  });

  it('findByLabelOrPrefix matches label, unique prefix, and rejects ambiguity', async () => {
    const r = new Registry(dir);
    await r.add(doc(id('a')), { label: 'one', backend: 'local' });
    await r.add(doc(`abcdef${'0'.repeat(58)}`), {
      label: 'two',
      backend: 'pinecone',
    });
    expect((await r.findByLabelOrPrefix('one')).docId).toBe(id('a'));
    expect((await r.findByLabelOrPrefix('abcdef')).label).toBe('two');
    expect((await r.findByLabelOrPrefix('aaaaaa')).label).toBe('one');
    expect((await r.findByLabelOrPrefix('ABCDEF')).label).toBe('two');
    await expect(r.findByLabelOrPrefix('aaaaa')).rejects.toMatchObject({
      code: 'DOC_NOT_FOUND',
    });
    await expect(r.findByLabelOrPrefix('missing')).rejects.toMatchObject({
      code: 'DOC_NOT_FOUND',
    });
    await expect(r.findByLabelOrPrefix('bbbbbb')).rejects.toMatchObject({
      code: 'DOC_NOT_FOUND',
    });
    await expect(r.findByLabelOrPrefix('')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await r.add(doc(`aaaaaab${'1'.repeat(57)}`), {
      label: 'three',
      backend: 'local',
    });
    await expect(r.findByLabelOrPrefix('aaaaaa')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      userMessage: expect.stringContaining('ambiguous') as unknown,
    });
  });

  it('findByLabelOrPrefix refuses a label that is also a docId prefix of another document', async () => {
    const r = new Registry(dir);
    await r.add(doc(`abcdef${'0'.repeat(58)}`), {
      label: 'real',
      backend: 'local',
    });
    await r.add(doc(id('b')), { label: 'abcdef', backend: 'local' });
    await expect(r.findByLabelOrPrefix('abcdef')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      userMessage: expect.stringMatching(/label.*abcdef0+.*real/) as unknown,
    });
    expect((await r.findByLabelOrPrefix(`abcdef${'0'.repeat(58)}`)).label).toBe(
      'real',
    );
    // A label that equals its own document's prefix is unambiguous.
    await r.add(doc(`cafe00${'1'.repeat(58)}`), {
      label: 'cafe00',
      backend: 'local',
    });
    expect((await r.findByLabelOrPrefix('cafe00')).label).toBe('cafe00');
  });

  it('evictionCandidates returns least recently used beyond the cap', async () => {
    const c = clock();
    const r = new Registry(dir, { now: c.now });
    await r.add(doc(id('a')), { label: 'a', backend: 'local' });
    c.set('2026-01-02T00:00:00.000Z');
    await r.add(doc(id('b')), { label: 'b', backend: 'local' });
    c.set('2026-01-03T00:00:00.000Z');
    await r.add(doc(id('c')), { label: 'c', backend: 'local' });
    c.set('2026-01-04T00:00:00.000Z');
    await r.touch(id('a'));
    expect((await r.evictionCandidates(2)).map((e) => e.label)).toEqual(['b']);
    expect((await r.evictionCandidates(1)).map((e) => e.label)).toEqual([
      'b',
      'c',
    ]);
    expect(await r.evictionCandidates(5)).toEqual([]);
    expect(await r.evictionCandidates(0)).toHaveLength(3);
    await expect(r.evictionCandidates(-1)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('serializes concurrent adds without losing entries', async () => {
    const r1 = new Registry(dir);
    const r2 = new Registry(dir);
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((ch, i) =>
        (i % 2 ? r1 : r2).add(doc(id(ch)), { label: ch, backend: 'local' }),
      ),
    );
    expect(await r1.list()).toHaveLength(4);
  });

  it('serializes adds from separate processes without losing entries', async () => {
    const script = fileURLToPath(
      new URL('../../tests/support/registry-child.ts', import.meta.url),
    );
    const run = (char: string) =>
      promisify(execFile)(process.execPath, [
        '--import',
        'tsx',
        script,
        dir,
        char,
        '4',
      ]);
    await Promise.all([run('a'), run('b')]);
    const entries = await new Registry(dir).list();
    expect(entries.map((e) => e.label).sort()).toEqual(
      ['a', 'b'].flatMap((c) => [0, 1, 2, 3].map((i) => `${c}-${String(i)}`)),
    );
    expect(await readdir(dir)).not.toContain('registry.json.lock');
  }, 60_000);

  it('breaks a stale lock file left by a crashed process', async () => {
    const r = new Registry(dir);
    await r.list();
    const lock = join(dir, 'registry.json.lock');
    await writeFile(lock, '', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await r.add(doc(id('a')), { label: 'one', backend: 'local' });
    expect(await r.list()).toHaveLength(1);
  });

  it('fails clearly on corrupt, duplicate, or world-readable registry files', async () => {
    const r = new Registry(dir);
    await r.add(doc(id('a')), { label: 'one', backend: 'local' });
    const path = join(dir, 'registry.json');
    await writeFile(path, '{not json', { mode: 0o600 });
    await expect(r.list()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await writeFile(path, '{"x":1}');
    await expect(r.list()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const e = {
      docId: id('a'),
      label: 'one',
      sourceUrl: 'https://e.com',
      format: 'html',
      title: null,
      billNumber: null,
      backend: 'local',
      ingestedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-01-01T00:00:00.000Z',
      usage: {
        embedTokens: 0,
        rerankUnits: 0,
        llmInputTokens: 0,
        llmOutputTokens: 0,
      },
    };
    await writeFile(path, JSON.stringify([e, e]));
    await expect(r.list()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await chmod(path, 0o644);
    await expect(r.list()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('getDocument rejects tampered or unregistered cache files', async () => {
    const r = new Registry(dir);
    await r.add(doc(id('a')), { label: 'one', backend: 'local' });
    await expect(r.getDocument(id('b'))).rejects.toMatchObject({
      code: 'DOC_NOT_FOUND',
    });
    const p = join(dir, 'docs', `${id('a')}.json`);
    await writeFile(p, JSON.stringify(doc(id('b'))), { mode: 0o600 });
    await expect(r.getDocument(id('a'))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await rm(p);
    await expect(r.getDocument(id('a'))).rejects.toMatchObject({
      code: 'DOC_NOT_FOUND',
    });
  });
});
