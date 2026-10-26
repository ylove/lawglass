import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  isReaderId,
  newReaderId,
  readerKey,
  ReaderLibrary,
} from './readers.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'readers-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const doc = (ch: string) => ch.repeat(64);

describe('reader ids', () => {
  test('issued ids are 22 base64url characters and pass validation', () => {
    const id = newReaderId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(isReaderId(id)).toBe(true);
    expect(newReaderId()).not.toBe(id);
  });

  test.each([
    undefined,
    '',
    '../x',
    '../../etc/passwd',
    'a'.repeat(23),
    'a'.repeat(21),
    'a'.repeat(5000),
    'abc def ghi jkl mno pq',
    'abcdefghijklmnopqrst+/',
    'abcdefghijklmnopqrst=\n',
  ])('%j is not a reader id', (value) => {
    expect(isReaderId(value)).toBe(false);
  });

  test('the file key is a sha256 hex digest, never the id', () => {
    const id = newReaderId();
    expect(readerKey(id)).toMatch(/^[a-f0-9]{64}$/);
    expect(readerKey(id)).not.toContain(id);
  });
});

describe('ReaderLibrary', () => {
  test('lists most recently used first and keeps addedAt', async () => {
    let time = Date.parse('2026-01-01T00:00:00Z');
    const lib = new ReaderLibrary(dir, { now: () => new Date((time += 1000)) });
    const id = newReaderId();
    await lib.markUsed(id, doc('a'));
    await lib.markUsed(id, doc('b'));
    await lib.markUsed(id, doc('a'));
    const list = await lib.list(id);
    expect(list.map((d) => d.docId)).toEqual([doc('a'), doc('b')]);
    expect(list[0]!.addedAt < list[0]!.lastUsedAt).toBe(true);
  });

  test('readers are isolated and removal touches one list only', async () => {
    const lib = new ReaderLibrary(dir);
    const [a, b] = [newReaderId(), newReaderId()];
    await lib.markUsed(a, doc('a'));
    await lib.markUsed(b, doc('a'));
    await lib.remove(a, doc('a'));
    await lib.remove(a, doc('c')); // unknown: a no-op
    expect(await lib.list(a)).toEqual([]);
    expect((await lib.list(b)).map((d) => d.docId)).toEqual([doc('a')]);
    expect([...(await lib.listedDocIds())]).toEqual([doc('a')]);
  });

  test('stores lists under hashed 0600 files, never under the raw id', async () => {
    const lib = new ReaderLibrary(dir);
    const id = newReaderId();
    await lib.markUsed(id, doc('a'));
    const names = await readdir(join(dir, 'readers'));
    expect(names).toEqual([`${readerKey(id)}.json`]);
    const file = await stat(join(dir, 'readers', names[0]!));
    expect(file.mode & 0o777).toBe(0o600);
  });

  test('refuses a malformed id before touching the filesystem', async () => {
    const lib = new ReaderLibrary(dir);
    await expect(lib.markUsed('../x', doc('a'))).rejects.toThrow();
    await expect(lib.list('a'.repeat(5000))).rejects.toThrow();
    await expect(readdir(join(dir, 'readers'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('an empty library has no listed documents and concurrent writes are kept', async () => {
    const lib = new ReaderLibrary(dir);
    expect((await lib.listedDocIds()).size).toBe(0);
    const id = newReaderId();
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((ch) => lib.markUsed(id, doc(ch))),
    );
    expect(await lib.list(id)).toHaveLength(4);
  });
});
