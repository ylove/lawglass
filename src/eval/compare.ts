/** Offline comparison of the same questions on the same fixture and backend. */
import { readFile } from 'node:fs/promises';
import { safeText } from '../cli/sanitize.js';
import { AppError, RETRIEVAL_MODES } from '../core/model/index.js';
import {
  DetailedEvalRun,
  firstRelevantRank,
  type DetailedEvalRow,
  type QuestionDetail,
} from './details.js';

export interface CompareOptions {
  a: string;
  b: string;
  fixture?: string | undefined;
}

function invalid(message: string): never {
  throw new AppError('INVALID_INPUT', safeText(message), {
    userMessage: safeText(message),
  });
}

function selector(value: string): (row: DetailedEvalRow) => boolean {
  const [mode, fusion, extra] = value.split('/');
  if (
    !RETRIEVAL_MODES.some((m) => m === mode) ||
    extra !== undefined ||
    (fusion !== undefined &&
      (!mode?.startsWith('hybrid') || !['rrf', 'weighted'].includes(fusion)))
  )
    invalid(
      `Unknown mode "${safeText(value)}". Use dense, sparse, hybrid, hybrid_rerank, or a hybrid mode with /rrf or /weighted.`,
    );
  return (row) =>
    row.mode === mode &&
    (!mode.startsWith('hybrid') || (row.fusion ?? 'rrf') === (fusion ?? 'rrf'));
}

// Compare code points, independent of the machine's locale.
const alphabetical = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
const lineText = (value: string): string =>
  safeText(value).replace(/\s+/g, ' ').trim();
const inTop5 = (rank: number | null): boolean => rank !== null && rank <= 5;

function questionMap(row: DetailedEvalRow): Map<string, QuestionDetail> {
  const map = new Map(row.questions.map((q) => [q.id, q]));
  if (map.size !== row.questions.length)
    invalid('Run contains duplicate question ids.');
  for (const q of row.questions) {
    if (
      q.firstRelevantRank !== firstRelevantRank(q.top10, q.expectedSectionIds)
    )
      invalid('Run contains a firstRelevantRank inconsistent with its hits.');
  }
  return map;
}

function ranking(label: string, q: QuestionDetail): string[] {
  return [
    `  ${lineText(label)}: first relevant rank ${q.firstRelevantRank === null ? 'null (not in top 10)' : String(q.firstRelevantRank)}`,
    ...q.top10.map(
      (hit, i) =>
        `    ${String(i + 1).padStart(2)}. ${lineText(hit.sectionId)} | ${lineText(hit.breadcrumb)}`,
    ),
    ...(q.top10.length === 0 ? ['    (no hits)'] : []),
  ];
}

export function renderCompare(
  run: DetailedEvalRun,
  options: CompareOptions,
): string {
  const matchesA = selector(options.a);
  const matchesB = selector(options.b);
  if (options.a === options.b) invalid('Choose two different modes.');
  const rows = run.rows.filter(
    (row) => options.fixture === undefined || row.fixture === options.fixture,
  );
  if (rows.length === 0) invalid('No rows match the requested fixture.');
  const groups = [
    ...new Set(rows.map((row) => JSON.stringify([row.fixture, row.backend]))),
  ].sort(alphabetical);
  const out = [
    `Top-5 relevance differences: ${lineText(options.a)} vs ${lineText(options.b)}`,
  ];
  let differences = 0;
  for (const group of groups) {
    const members = rows.filter(
      (row) => JSON.stringify([row.fixture, row.backend]) === group,
    );
    const a = members.filter(matchesA);
    const b = members.filter(matchesB);
    const rowA = a[0];
    const rowB = b[0];
    if (a.length !== 1 || b.length !== 1 || !rowA || !rowB)
      invalid(`Expected exactly one row for each mode in ${group}.`);
    const questionsA = questionMap(rowA);
    const questionsB = questionMap(rowB);
    if (questionsA.size !== questionsB.size)
      invalid('Compared rows have different question sets.');
    for (const qa of [...questionsA.values()].sort((a, b) =>
      alphabetical(a.id, b.id),
    )) {
      const qb = questionsB.get(qa.id);
      if (
        qa.question !== qb?.question ||
        qa.kind !== qb.kind ||
        JSON.stringify(qa.expectedSectionIds) !==
          JSON.stringify(qb.expectedSectionIds)
      )
        invalid('Compared rows have different question sets or expectations.');
      if (inTop5(qa.firstRelevantRank) === inTop5(qb.firstRelevantRank))
        continue;
      differences++;
      out.push(
        '',
        `${lineText(rowA.fixture)} / ${rowA.backend} / ${lineText(qa.id)} (${qa.kind})`,
        lineText(qa.question),
        `Expected: ${qa.expectedSectionIds.map(lineText).join(', ')}`,
        ...ranking(options.a, qa),
        ...ranking(options.b, qb),
      );
    }
  }
  if (differences === 0) out.push('No questions differ in top-5 relevance.');
  return `${out.join('\n')}\n`;
}

export async function runCompareCommand(
  file: string,
  options: CompareOptions,
  write: (text: string) => void,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    invalid(
      'Could not read the run JSON. Check the file path and JSON syntax.',
    );
  }
  const parsed = DetailedEvalRun.safeParse(raw);
  if (!parsed.success)
    invalid(
      'Invalid run JSON or missing per-question details. Generate a new eval run.',
    );
  write(renderCompare(parsed.data, options));
}
