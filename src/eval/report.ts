/**
 * Renders `eval/results.md`. Every row names the backend, the models and the provider that
 * produced it, and the file header names the commit. Backends that could not run appear as
 * "pending (...)" rows: a missing result is shown as missing, never filled in.
 */
import type {
  BackendKind,
  EvalRow,
  EvalRun,
  GoldenSet,
} from '../core/model/index.js';
import type { RowExtras, SkippedFixture } from './run.js';

export interface PendingBackend {
  backend: BackendKind;
  /** Short reason, e.g. "no key". Rendered as `pending (<reason>)`. */
  reason: string;
}

export interface ReportInput {
  run: EvalRun;
  extras: readonly RowExtras[];
  pending: readonly PendingBackend[];
  skipped: readonly SkippedFixture[];
  golden: readonly Pick<GoldenSet, 'fixture' | 'frozenAtCommit'>[];
  /** Embedder and reranker that produced the retrieval numbers, e.g. "bge-small + bge-reranker". */
  retrievalModels: string;
  /** Names the fixture source so fake-model smoke output cannot pass as a real result. */
  note?: string | undefined;
}

const fixed = (value: number, digits: number): string => value.toFixed(digits);
const percent = (value: number): string => `${fixed(value * 100, 1)}%`;

function table(header: readonly string[], rows: readonly string[][]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [
    line(header),
    line(header.map(() => '---')),
    ...rows.map(line),
    '',
  ].join('\n');
}

function modeLabel(row: Pick<EvalRow, 'mode' | 'fusion'>): string {
  return row.fusion ? `${row.mode} (${row.fusion})` : row.mode;
}

function retrievalRow(row: EvalRow): string[] {
  const m = row.retrieval;
  return [
    row.backend,
    modeLabel(row),
    fixed(m.recallAt5, 3),
    fixed(m.recallAt10, 3),
    fixed(m.mrr, 3),
    fixed(m.p50LatencyMs, 1),
    String(m.embedTokens),
    String(m.rerankUnits),
  ];
}

function answerRow(row: EvalRow, extra: RowExtras | undefined): string[] {
  const a = row.answers;
  if (!a) return [];
  return [
    row.backend,
    modeLabel(row),
    row.provider ?? '?',
    row.model ?? '?',
    percent(a.citationValidity),
    percent(a.declineRate),
    percent(a.deletedLeakageRate),
    a.meanReadingGrade === null ? 'n/a' : fixed(a.meanReadingGrade, 1),
    String(a.answersAboveGrade9),
    extra?.removalAcknowledgedRate === undefined
      ? 'n/a'
      : percent(extra.removalAcknowledgedRate),
  ];
}

export function renderResults(input: ReportInput): string {
  const { run } = input;
  const frozen = input.golden.map(
    (g) => `${g.fixture}: ${g.frozenAtCommit ?? 'unfrozen (draft)'}`,
  );
  const out: string[] = [
    '# Eval results',
    '',
    ...(input.note ? [`> ${input.note}`, ''] : []),
    `- Run at: ${run.runAt}`,
    `- Commit: ${run.commit}`,
    `- Retrieval models: ${input.retrievalModels}`,
    `- Golden sets frozen at: ${frozen.length ? frozen.join('; ') : 'none loaded'}`,
    '',
    'Retrieval is scored on ranked hits only (definition injection off). A hit counts when its ' +
      'section, or an ancestor or descendant of it, is an expected section. Recall is the share ' +
      'of expected sections found in the top k chunks; unanswerable questions are excluded from ' +
      'retrieval metrics. Embed tokens and rerank units are totals over the question set.',
    '',
  ];

  const fixtures = [
    ...new Set([
      ...input.golden.map((g) => g.fixture),
      ...run.rows.map((r) => r.fixture),
    ]),
  ];
  for (const fixture of fixtures) {
    out.push(`## ${fixture}`, '');
    const indexed = run.rows
      .map((row, index) => ({ row, extra: input.extras[index] }))
      .filter(({ row }) => row.fixture === fixture);

    const retrievalRows = indexed.map(({ row }) => retrievalRow(row));
    for (const p of input.pending)
      retrievalRows.push([
        p.backend,
        'all',
        ...Array.from({ length: 6 }, () => `pending (${p.reason})`),
      ]);
    for (const s of input.skipped.filter((x) => x.fixture === fixture))
      retrievalRows.push([
        s.backend,
        'all',
        ...Array.from({ length: 6 }, () => `skipped (${s.reason})`),
      ]);
    out.push(
      table(
        [
          'Backend',
          'Mode',
          'Recall@5',
          'Recall@10',
          'MRR',
          'p50 ms',
          'Embed tokens',
          'Rerank units',
        ],
        retrievalRows,
      ),
    );

    const answerRows = indexed
      .filter(({ row }) => row.answers)
      .map(({ row, extra }) => answerRow(row, extra));
    if (answerRows.length) {
      out.push(
        '### Answers',
        '',
        table(
          [
            'Backend',
            'Mode',
            'Provider',
            'Model',
            'Citation validity',
            'Decline rate',
            'Deleted-text leakage',
            'Mean FK grade',
            'Answers > grade 9',
            'Removal acknowledged',
          ],
          answerRows,
        ),
      );
    } else {
      out.push(
        'Answer metrics: not run (needs `--answers` and a live provider).',
        '',
      );
    }
  }
  if (fixtures.length === 0)
    out.push('No golden sets with a matching fixture were evaluated.', '');
  return out.join('\n');
}
