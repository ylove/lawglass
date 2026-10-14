import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadGoldenSets } from './golden.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'golden-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const valid = {
  fixture: 'a',
  frozenAtCommit: null,
  questions: [
    {
      id: 'q1',
      question: 'Why?',
      kind: 'exact',
      expectedSectionIds: ['sec-1'],
    },
  ],
};

test('loads valid sets and reports invalid ones without aborting', async () => {
  await writeFile(join(dir, 'a.json'), JSON.stringify(valid));
  await writeFile(
    join(dir, 'bad.json'),
    JSON.stringify({ ...valid, questions: [] }),
  );
  await writeFile(
    join(dir, 'unanswerable-with-sections.json'),
    JSON.stringify({
      ...valid,
      questions: [{ ...valid.questions[0], kind: 'unanswerable' }],
    }),
  );
  await writeFile(join(dir, 'broken.json'), '{ not json');
  await writeFile(join(dir, 'notes.txt'), 'ignored');

  const { sets, invalid } = await loadGoldenSets(dir);
  expect(sets.map((s) => s.fixture)).toEqual(['a']);
  expect(invalid.map((i) => i.file)).toEqual([
    'bad.json',
    'broken.json',
    'unanswerable-with-sections.json',
  ]);
  expect(invalid[0]?.reason).toContain('questions');
});

test('a missing directory is an empty result', async () => {
  expect(await loadGoldenSets(join(dir, 'nope'))).toEqual({
    sets: [],
    invalid: [],
  });
});

test('other read errors propagate', async () => {
  await writeFile(join(dir, 'file'), '');
  await expect(loadGoldenSets(join(dir, 'file'))).rejects.toThrow();
});

test('the committed golden sets all validate', async () => {
  const { invalid } = await loadGoldenSets(
    new URL('./golden/', import.meta.url).pathname,
  );
  expect(invalid).toEqual([]);
});
