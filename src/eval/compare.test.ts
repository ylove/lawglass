import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createProgram } from '../cli/program.js';
import { BRAND } from '../core/brand.js';
import {
  type DetailedEvalRow,
  type DetailedEvalRun,
  type QuestionDetail,
} from './details.js';
import { renderCompare, runCompareCommand } from './compare.js';

function question(id: string, rank: number | null): QuestionDetail {
  return {
    id,
    kind: 'paraphrase',
    question: `Question ${id}?`,
    expectedSectionIds: ['sec-2'],
    firstRelevantRank: rank,
    top10: Array.from({ length: rank ?? 0 }, (_, i) => ({
      sectionId: i + 1 === rank ? 'sec-2/a' : 'sec-9',
      breadcrumb: i + 1 === rank ? 'Sec. 2 > (a) Grants' : 'Sec. 9 Other rules',
      score: 1 / (i + 1),
    })),
  };
}

function row(
  mode: DetailedEvalRow['mode'],
  questions: QuestionDetail[],
): DetailedEvalRow {
  return {
    fixture: 'orchard',
    backend: 'local',
    mode,
    retrieval: {
      recallAt5: 0,
      recallAt10: 0,
      mrr: 0,
      p50LatencyMs: 0,
      embedTokens: 0,
      rerankUnits: 0,
    },
    questions,
  };
}

function run(rows: DetailedEvalRow[]): DetailedEvalRun {
  return {
    runAt: '2026-10-13T00:00:00.000Z',
    commit: 'abc',
    goldenFrozenAtCommit: null,
    rows,
  };
}

const options = { a: 'dense', b: 'hybrid_rerank' };

test('terminal output shows gains, losses, both ranks and breadcrumbs in stable id order', () => {
  const a = row('dense', [
    question('loss', 5),
    question('gain', null),
    question('same', 1),
    question('both-miss', 6),
  ]);
  const b = row('hybrid_rerank', [
    question('both-miss', null),
    question('same', 5),
    question('gain', 1),
    question('loss', 6),
  ]);
  const output = renderCompare(run([b, a]), options);
  expect(output).toBe(`Top-5 relevance differences: dense vs hybrid_rerank

orchard / local / gain (paraphrase)
Question gain?
Expected: sec-2
  dense: first relevant rank null (not in top 10)
    (no hits)
  hybrid_rerank: first relevant rank 1
     1. sec-2/a | Sec. 2 > (a) Grants

orchard / local / loss (paraphrase)
Question loss?
Expected: sec-2
  dense: first relevant rank 5
     1. sec-9 | Sec. 9 Other rules
     2. sec-9 | Sec. 9 Other rules
     3. sec-9 | Sec. 9 Other rules
     4. sec-9 | Sec. 9 Other rules
     5. sec-2/a | Sec. 2 > (a) Grants
  hybrid_rerank: first relevant rank 6
     1. sec-9 | Sec. 9 Other rules
     2. sec-9 | Sec. 9 Other rules
     3. sec-9 | Sec. 9 Other rules
     4. sec-9 | Sec. 9 Other rules
     5. sec-9 | Sec. 9 Other rules
     6. sec-2/a | Sec. 2 > (a) Grants
`);
  expect(renderCompare(run([a, b]), options)).toBe(output);
});

test('pairs fixture/backend rows separately, filters fixtures and selects weighted fusion explicitly', () => {
  const a = row('dense', [question('q', null)]);
  const rrf = {
    ...row('hybrid', [question('q', null)]),
    fusion: 'rrf' as const,
  };
  const weighted = {
    ...row('hybrid', [question('q', 1)]),
    fusion: 'weighted' as const,
  };
  const rows = [a, rrf, weighted];
  const input = run([
    ...rows.map((r) => ({ ...r, backend: 'pinecone' as const })),
    ...rows.map((r) => ({ ...r, fixture: 'other' })),
    ...rows,
  ]);
  expect(renderCompare(input, { a: 'dense', b: 'hybrid' })).toContain(
    'No questions differ',
  );
  const output = renderCompare(input, {
    a: 'dense',
    b: 'hybrid/weighted',
    fixture: 'orchard',
  });
  expect(output).not.toContain('other /');
  expect(output.indexOf('orchard / local')).toBeLessThan(
    output.indexOf('orchard / pinecone'),
  );
  expect(
    renderCompare(run(rows), { a: 'hybrid/rrf', b: 'hybrid/weighted' }),
  ).toContain('first relevant rank 1');
});

test('uses covered sibling ids when validating relevance', () => {
  const q = question('merged', 1);
  q.top10 = [
    {
      sectionId: 'sec-1',
      coveredSectionIds: ['sec-1', 'sec-2'],
      breadcrumb: 'Merged sections',
      score: 1,
    },
  ];
  expect(
    renderCompare(
      run([
        row('dense', [q]),
        row('hybrid_rerank', [question('merged', null)]),
      ]),
      options,
    ),
  ).toContain('Merged sections');
});

test('sanitizes document text and keeps each heading and breadcrumb on one terminal line', () => {
  const q = question('q', 1);
  q.question = 'Question\nq?\u001b[31m';
  q.top10[0]!.breadcrumb = 'Sec.\t2\nGrants\u001b]0;bad title\u0007';
  const miss = { ...q, top10: [], firstRelevantRank: null };
  const output = renderCompare(
    run([row('dense', [q]), row('hybrid_rerank', [miss])]),
    options,
  );
  expect(output).toContain('Question q?\n');
  expect(output).toContain('Sec. 2 Grants\n');
  expect(output).not.toContain('\u001b');
  expect(output).not.toContain('bad title');
});

test.each(['unknown', 'dense/rrf', 'hybrid/nope', 'hybrid/rrf/extra'])(
  'rejects invalid selector %s',
  (a) => {
    expect(() => renderCompare(run([]), { ...options, a })).toThrow(
      'Unknown mode',
    );
  },
);

test('rejects identical modes, unknown fixtures and missing or ambiguous mode rows', () => {
  const a = row('dense', []);
  const b = row('hybrid_rerank', []);
  expect(() => renderCompare(run([a, b]), { ...options, b: 'dense' })).toThrow(
    'different modes',
  );
  expect(() =>
    renderCompare(run([a, b]), { ...options, fixture: 'missing' }),
  ).toThrow('No rows');
  expect(() => renderCompare(run([a]), options)).toThrow('exactly one row');
  expect(() => renderCompare(run([a, a, b]), options)).toThrow(
    'exactly one row',
  );
  expect(renderCompare(run([a, b]), options)).toContain('No questions differ');
});

test('rejects inconsistent ranks and duplicate or mismatched questions', () => {
  const q = question('q', 1);
  const a = row('dense', [q]);
  const b = row('hybrid_rerank', [question('q', null)]);
  expect(() =>
    renderCompare(run([{ ...a, questions: [q, q] }, b]), options),
  ).toThrow('duplicate question');
  expect(() =>
    renderCompare(
      run([{ ...a, questions: [{ ...q, firstRelevantRank: 2 }] }, b]),
      options,
    ),
  ).toThrow('inconsistent');
  expect(() =>
    renderCompare(run([a, { ...b, questions: [] }]), options),
  ).toThrow('different question sets');
  for (const changed of [
    { ...q, id: 'other' },
    { ...q, question: 'Different?' },
    { ...q, kind: 'exact' as const },
    { ...q, expectedSectionIds: ['sec-2/a'] },
  ])
    expect(() =>
      renderCompare(run([a, { ...b, questions: [changed] }]), options),
    ).toThrow('different question sets');
});

test('CLI reads a run offline and exposes usage with the brand name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eval-compare-'));
  try {
    const file = join(dir, 'run.json');
    await writeFile(
      file,
      JSON.stringify(
        run([
          row('dense', [question('q', null)]),
          row('hybrid_rerank', [question('q', 1)]),
        ]),
      ),
    );
    let output = '';
    const program = createProgram({
      runtime: () => {
        throw new Error('compare must not open a runtime');
      },
      write: (text) => {
        output += text;
      },
    });
    await program.parseAsync(
      [
        'eval',
        'compare',
        file,
        '--a',
        'dense',
        '--b',
        'hybrid_rerank',
        '--fixture',
        'orchard',
      ],
      { from: 'user' },
    );
    expect(output).toContain('orchard / local / q');
    const compare = program.commands.find((c) => c.name() === 'eval')
      ?.commands[0];
    expect(compare?.helpInformation()).toContain(`${BRAND.name} eval compare`);
    expect(compare?.helpInformation()).toContain('--a <mode>');
    expect(compare?.helpInformation()).toContain('--b <mode>');
    for (const args of [
      ['eval', 'compare', file, '--a', 'dense'],
      ['eval', 'compare', file, '--b', 'dense'],
    ]) {
      const missingOptionProgram = createProgram();
      missingOptionProgram.commands
        .find((c) => c.name() === 'eval')
        ?.commands[0]?.exitOverride()
        .configureOutput({ writeErr: () => undefined });
      await expect(
        missingOptionProgram.parseAsync(args, { from: 'user' }),
      ).rejects.toMatchObject({
        code: 'commander.missingMandatoryOptionValue',
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('command rejects missing files, malformed JSON, older runs and invalid hit data without writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eval-compare-invalid-'));
  try {
    const file = join(dir, 'run.json');
    const write = (): never => {
      throw new Error('must not write');
    };
    await expect(runCompareCommand(file, options, write)).rejects.toMatchObject(
      {
        code: 'INVALID_INPUT',
        userMessage:
          'Could not read the run JSON. Check the file path and JSON syntax.',
      },
    );
    const validRow = row('dense', [question('q', 1)]);
    const { questions: _omitted, ...oldRow } = validRow;
    for (const content of [
      '{',
      JSON.stringify({ ...run([]), rows: [oldRow] }),
      JSON.stringify({
        ...run([]),
        rows: [
          {
            ...validRow,
            questions: [
              {
                ...question('q', 1),
                top10: [{ sectionId: 'bad id', breadcrumb: '', score: 'bad' }],
              },
            ],
          },
        ],
      }),
    ]) {
      await writeFile(file, content);
      await expect(
        runCompareCommand(file, options, write),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
