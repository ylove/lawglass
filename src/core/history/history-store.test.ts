import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { configFileSystem } from '../config-files.js';
import { type BillHistory } from '../model/index.js';
import { deleteHistory, readHistory, writeHistory } from './history-store.js';

let dir: string;
const docId = 'a'.repeat(64);
const history: BillHistory = {
  versions: [],
  actions: [],
  amendments: [],
  sources: [],
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'history-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('round-trips validated history in a private sidecar and removes it idempotently', async () => {
  expect(await readHistory(dir, docId)).toBeUndefined();
  await writeHistory(dir, docId, history);
  expect(await readHistory(dir, docId)).toEqual(history);
  expect((await stat(join(dir, 'history', `${docId}.json`))).mode & 0o777).toBe(
    0o600,
  );
  expect((await stat(join(dir, 'history'))).mode & 0o777).toBe(0o700);
  await deleteHistory(dir, docId);
  await deleteHistory(dir, docId);
  expect(await readHistory(dir, docId)).toBeUndefined();
});
test('validates full doc ids before constructing paths', async () => {
  for (const id of ['../secret', '', 'a'.repeat(63)]) {
    await expect(writeHistory(dir, id, history)).rejects.toThrow();
    await expect(readHistory(dir, id)).rejects.toThrow();
    await expect(deleteHistory(dir, id)).rejects.toThrow();
  }
});
test('invalid input and corrupt sidecars fail with safe storage errors', async () => {
  await expect(
    writeHistory(dir, docId, {
      ...history,
      versions: [
        { code: 'ih', label: 'Introduced', url: 'http://example.gov' },
      ],
    }),
  ).rejects.toThrow('The bill history is invalid.');
  await writeHistory(dir, docId, history);
  await writeFile(join(dir, 'history', `${docId}.json`), '{}');
  await expect(readHistory(dir, docId)).rejects.toThrow(
    'The cached bill history is invalid.',
  );
});
test('deletion errors are surfaced without filesystem details', async () => {
  const fs = {
    ...configFileSystem,
    unlink: vi.fn().mockRejectedValue(new Error('private detail')),
  };
  await expect(deleteHistory(dir, docId, fs)).rejects.toThrow(
    'The cached bill history could not be removed.',
  );
});
