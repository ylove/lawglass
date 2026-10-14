import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AppError } from '../model/index.js';
import { DEFAULT_MAX_BYTES, documentId } from './cache.js';
import { readLocalFile } from './local-file.js';

vi.mock('node:fs/promises', { spy: true });

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'local-file-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

async function file(
  name = 'bill.txt',
  body = 'Section 1. Grants\nTowns may apply.',
) {
  const path = join(dir, name);
  await fs.writeFile(path, body);
  return path;
}

test('reads paths and encoded file URLs into the fetch result shape', async () => {
  const path = await file('bill #1 ü.txt');
  const bytes = await fs.readFile(path);
  for (const input of [
    path,
    relative(process.cwd(), path),
    pathToFileURL(path).href,
  ]) {
    const result = await readLocalFile(input);
    expect(result).toEqual({
      bytes,
      docId: documentId(bytes),
      finalUrl: pathToFileURL(path).href,
      contentType: '',
      format: 'text',
      fromCache: false,
    });
  }
});

test('sniffs bytes before extensions, with the same fallback as network fetch', async () => {
  const path = await file('bill.txt', '<?xml version="1.0"?><bill/>');
  expect((await readLocalFile(path)).format).toBe('xml');
  await fs.writeFile(path, '%PDF-1.7');
  expect((await readLocalFile(path)).format).toBe('pdf');
  await fs.writeFile(path, '<html><body>Bill</body></html>');
  expect((await readLocalFile(path)).format).toBe('html');
  const binary = join(dir, 'blob');
  await fs.writeFile(binary, Uint8Array.of(0, 255, 254));
  expect((await readLocalFile(binary)).format).toBe('unknown');
});

test('always hashes fresh bytes; unchanged files have the same id', async () => {
  const path = await file();
  const first = await readLocalFile(path);
  expect((await readLocalFile(path)).docId).toBe(first.docId);
  await fs.writeFile(path, 'Section 1. New grants\nCounties may apply.');
  expect((await readLocalFile(path)).docId).not.toBe(first.docId);
});

test.each(['missing.txt', 'missing/child.txt'])(
  'missing %s has a friendly AppError',
  async (name) => {
    await expect(readLocalFile(join(dir, name))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      userMessage: expect.stringContaining('could not be found') as string,
    });
  },
);

test('directories and non-files are rejected before reading', async () => {
  await expect(readLocalFile(dir)).rejects.toMatchObject({
    userMessage: expect.stringContaining('directory') as string,
  });
  const path = await file();
  const info = await fs.stat(path);
  vi.spyOn(fs, 'stat').mockResolvedValueOnce(
    Object.assign(info, { isFile: () => false }),
  );
  await expect(readLocalFile(path)).rejects.toMatchObject({
    userMessage: expect.stringContaining('not a regular file') as string,
  });
});

test('an unreadable file has a friendly AppError', async () => {
  const path = await file();
  // Simulate permission denial independently of root privileges or platform ACLs.
  vi.spyOn(fs, 'open').mockRejectedValueOnce(
    Object.assign(new Error('EACCES'), { code: 'EACCES' }),
  );
  await expect(readLocalFile(path)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    userMessage: expect.stringContaining('Check its permissions') as string,
  });
});

test('the default size cap matches safeFetch and is checked before open', async () => {
  const path = await file();
  const handle = await fs.open(path, 'r+');
  await handle.truncate(DEFAULT_MAX_BYTES + 1);
  await handle.close();
  const open = vi.spyOn(fs, 'open').mockClear();
  await expect(readLocalFile(path)).rejects.toMatchObject({
    code: 'TOO_LARGE',
  });
  expect(open).not.toHaveBeenCalled();
});

test('files exactly at a custom cap are allowed', async () => {
  const path = await file('exact.txt', 'abc');
  expect((await readLocalFile(path, { maxBytes: 3 })).bytes.length).toBe(3);
});

test('multiple read buffers preserve the complete byte sequence', async () => {
  const bytes = Buffer.alloc(150_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const path = join(dir, 'large.bin');
  await fs.writeFile(path, bytes);
  const result = await readLocalFile(path);
  expect(result.bytes).toEqual(bytes);
  expect(result.docId).toBe(documentId(bytes));
});

test('a path through a regular file is reported as missing', async () => {
  const path = await file();
  await expect(readLocalFile(join(path, 'child.txt'))).rejects.toMatchObject({
    userMessage: expect.stringContaining('could not be found') as string,
  });
});

test.each([0, -1, 1.5, NaN, Infinity])(
  'invalid cap %s is rejected',
  async (maxBytes) => {
    await expect(readLocalFile('bill', { maxBytes })).rejects.toBeInstanceOf(
      AppError,
    );
  },
);

test.each([
  '',
  'file://remote-host/bill.txt',
  'file:///bill%2Fname.txt',
  'file://[',
])('invalid input %s is friendly', async (input) => {
  await expect(readLocalFile(input)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
});

async function openedFile(body: string) {
  const path = await file('race.txt', body);
  const handle = await fs.open(path, 'r');
  const info = await handle.stat();
  vi.spyOn(fs, 'stat').mockResolvedValueOnce(
    Object.assign(Object.create(info) as typeof info, {
      size: 0,
      isFile: () => true,
    }),
  );
  vi.spyOn(fs, 'open').mockResolvedValueOnce(handle);
  return { path, handle, info };
}

test('a file growing before open is bounded and the handle is closed', async () => {
  const { path, handle } = await openedFile('abcdef');
  const close = vi.spyOn(handle, 'close');
  await expect(readLocalFile(path, { maxBytes: 3 })).rejects.toMatchObject({
    code: 'TOO_LARGE',
  });
  expect(close).toHaveBeenCalledOnce();
});

test('a file growing after stat is bounded while reading', async () => {
  const { path, handle, info } = await openedFile('abcdef');
  vi.spyOn(handle, 'stat').mockResolvedValueOnce(
    Object.assign(info, { size: 0 }),
  );
  const close = vi.spyOn(handle, 'close');
  await expect(readLocalFile(path, { maxBytes: 3 })).rejects.toMatchObject({
    code: 'TOO_LARGE',
  });
  expect(close).toHaveBeenCalledOnce();
});

test('a path replaced with a non-file after stat is rejected', async () => {
  const { path, handle, info } = await openedFile('abc');
  vi.spyOn(handle, 'stat').mockResolvedValueOnce(
    Object.assign(info, { isFile: () => false }),
  );
  const close = vi.spyOn(handle, 'close');
  await expect(readLocalFile(path)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(close).toHaveBeenCalledOnce();
});

test('read failures are friendly and still close the handle', async () => {
  const { path, handle } = await openedFile('abc');
  vi.spyOn(handle, 'read').mockRejectedValueOnce(new Error('disk error'));
  const close = vi.spyOn(handle, 'close');
  await expect(readLocalFile(path)).rejects.toMatchObject({
    userMessage: expect.stringContaining('could not be read') as string,
  });
  expect(close).toHaveBeenCalledOnce();
});

test('an already-aborted read never opens a file', async () => {
  const signal = AbortSignal.abort();
  const open = vi.spyOn(fs, 'open');
  await expect(readLocalFile(await file(), { signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(open).not.toHaveBeenCalled();
});

test('aborting during a read closes the file and preserves the abort error', async () => {
  const { path, handle } = await openedFile('abc');
  const controller = new AbortController();
  const read = handle.read.bind(handle);
  vi.spyOn(handle, 'read').mockImplementationOnce(async (...args) => {
    const result = await read(...args);
    controller.abort();
    return result;
  });
  const close = vi.spyOn(handle, 'close');
  await expect(
    readLocalFile(path, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(close).toHaveBeenCalledOnce();
});
