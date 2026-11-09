/**
 * Turns a calibration report (the JSON `scripts/calibrate.ts` prints) into the markdown for
 * docs/calibration.md: measured against estimated cost per run and per feature, answer and
 * brief quality, coverage, and a recommended high-bound multiplier per feature.
 *
 *   tsx scripts/calibration-report.ts report.json > docs/calibration.md
 *
 * The input may also be the saved job log: the JSON is found between the marker lines.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CalibrationReport,
  FEATURES,
  Run,
  type Feature,
} from './calibration-schema.js';

/** Margin kept above the worst measured ratio, so the next bill does not break the bound. */
export const MARGIN = 1.25;

const REPORT_PREFIX = 'CALIBRATION REPORT ';
const RUN_PREFIX = 'CALIBRATION RUN ';

function tryParse<T>(parse: () => T): T | undefined {
  try {
    return parse();
  } catch {
    return undefined;
  }
}

/**
 * Reads the report from the saved JSON, or from a job log: the final `CALIBRATION REPORT` line
 * when it is there and valid, else the report rebuilt from the `CALIBRATION RUN` lines a job that
 * was killed or timed out left behind.
 */
export function parseReport(text: string): CalibrationReport {
  const lines = text.split('\n');
  for (const line of lines.toReversed()) {
    const at = line.indexOf(REPORT_PREFIX);
    if (at < 0) continue;
    const found = tryParse(() =>
      CalibrationReport.parse(
        JSON.parse(line.slice(at + REPORT_PREFIX.length)),
      ),
    );
    if (found) return found;
  }
  const whole = tryParse(() => CalibrationReport.parse(JSON.parse(text)));
  if (whole) return whole;
  const runs = lines.flatMap((line) => {
    const at = line.indexOf(RUN_PREFIX);
    const run =
      at < 0
        ? undefined
        : tryParse(() =>
            Run.parse(JSON.parse(line.slice(at + RUN_PREFIX.length))),
          );
    return run ? [run] : [];
  });
  const first = runs[0];
  if (!first)
    throw new Error('No calibration report or run lines found in the input.');
  return CalibrationReport.parse({
    version: 1,
    generatedAt: new Date().toISOString(),
    dryRun: false,
    caps: first.caps,
    spentUsd: runs.reduce((n, r) => n + r.spentUsd, 0),
    capReached: false,
    skipped: [],
    runs,
  });
}

const usd = (n: number): string =>
  n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
const x = (n: number | null): string =>
  n === null ? 'n/a' : `${n.toFixed(2)}x`;
const pct = (n: number | null): string =>
  n === null ? 'n/a' : `${(100 * n).toFixed(1)}%`;
const cell = (s: string): string => s.replaceAll('|', '\\|');
const table = (head: string[], rows: string[][]): string =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map((_, i) => (i < 2 ? '---' : '---:')).join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');

/**
 * A run that did not fail measured at least part of the work, so its ratio is a floor: a partial
 * ratio above 1 is a real overrun, while one below 1 proves nothing. Only failed runs are left out.
 */
const usable = (r: Run): boolean =>
  r.status !== 'failed' && r.status !== 'skipped';

export interface Recommendation {
  feature: Feature | 'total';
  /** Highest measured/high dollars ratio over the usable runs. */
  worst: number | null;
  /** The factor to multiply the feature's high bound by; 1 means the bound already holds with margin. */
  multiplier: number;
  runs: number;
}

/** Round up to the next 0.05, so the advice reads as a number someone would type. */
const roundUp = (n: number): number => Math.ceil(n * 20 - 1e-9) / 20;

export function recommend(
  report: CalibrationReport,
  keep: (r: Run) => boolean = usable,
): Recommendation[] {
  const runs = report.runs.filter(keep);
  const one = (
    feature: Recommendation['feature'],
    pick: (r: Run) => number | null,
  ): Recommendation => {
    const ratios = runs.map(pick).filter((n): n is number => n !== null);
    const worst = ratios.length === 0 ? null : Math.max(...ratios);
    return {
      feature,
      worst,
      multiplier: worst === null ? 1 : Math.max(1, roundUp(worst * MARGIN)),
      runs: ratios.length,
    };
  };
  return [
    ...FEATURES.map((f) => one(f, (r) => r.features[f].ratioHigh)),
    one('total', (r) => r.total.ratioHigh),
  ];
}

export function renderReport(report: CalibrationReport): string {
  const out: string[] = [];
  out.push(
    '# Cost estimator calibration',
    '',
    `Generated ${report.generatedAt}${report.dryRun ? ' (DRY RUN: mock provider, no real spend)' : ''}. ` +
      `Spent ${usd(report.spentUsd)} of a ${usd(report.caps.maxUsd)} cap (${usd(report.caps.maxUsdPerRun)} per run).`,
    '',
    'Measured is what the providers reported for each call, priced with the same table the budgets use. ' +
      'Estimated is `estimateBill` for the same bill, model plan and coverage settings. ' +
      "Ratio is measured over the estimate's **high** bound; the bound holds when it is at most 1.00x.",
    '',
  );
  if (report.skipped.length > 0) {
    out.push(
      '## Not run',
      '',
      ...report.skipped.map((s) => `- ${s.bill} on ${s.plan}: ${s.reason}`),
      '',
    );
  }

  out.push(
    '## Totals by run',
    '',
    table(
      [
        'Bill',
        'Plan',
        'Status',
        'Sections',
        'Briefs',
        'Estimate low',
        'Estimate high',
        'Measured',
        'Measured / high',
      ],
      report.runs.map((r) => [
        r.bill,
        r.plan,
        r.status,
        String(r.facts?.sections ?? 'n/a'),
        String(r.coverage.briefs),
        usd(r.total.estimate.low.dollars),
        usd(r.total.estimate.high.dollars),
        usd(r.total.measured.dollars),
        x(r.total.ratioHigh),
      ]),
    ),
    '',
    "Totals cover the bill's generation (metadata, summary and its story, breakdown, pictures, examples). Questions are below.",
    '',
  );
  const notes = report.runs.filter((r) => r.note);
  if (notes.length > 0)
    out.push(
      ...notes.map((r) => `- ${r.bill} on ${r.plan}: ${r.note ?? ''}`),
      '',
    );

  out.push(
    '## Measured / high by feature',
    '',
    table(
      ['Bill', 'Plan', ...FEATURES, 'Question'],
      report.runs.map((r) => [
        r.bill,
        r.plan,
        ...FEATURES.map((f) => x(r.features[f].ratioHigh)),
        x(r.questions.ratioHigh),
      ]),
    ),
    '',
    'Question is the average of the two questions asked against the one-question estimate.',
    '',
    '## Calls',
    '',
    "Measured calls (of which the provider gave no usage, so a conservative guess was charged) against the estimate's high call count.",
    '',
    table(
      ['Bill', 'Plan', ...FEATURES],
      report.runs.map((r) => [
        r.bill,
        r.plan,
        ...FEATURES.map((f) => {
          const m = r.features[f].measured;
          const flagged =
            m.estimatedCalls > 0
              ? ` (${String(m.estimatedCalls)} estimated)`
              : '';
          return `${String(m.calls)}${flagged} / ${String(r.features[f].estimate.high.calls)}`;
        }),
      ]),
    ),
    '',
    '## Quality',
    '',
    'Citation validity is valid citations over all citations; declines are answers that said the bill does not address the question, or briefs left empty.',
    '',
    table(
      [
        'Bill',
        'Plan',
        'Answer citations',
        'Answer validity',
        'Answer declines',
        'Brief citations',
        'Brief validity',
        'Brief declines',
      ],
      report.runs.map((r) => [
        r.bill,
        r.plan,
        String(r.quality.answers.citations + r.quality.summary.citations),
        pct(
          r.quality.answers.citations + r.quality.summary.citations === 0
            ? null
            : (r.quality.answers.validCitations +
                r.quality.summary.validCitations) /
                (r.quality.answers.citations + r.quality.summary.citations),
        ),
        String(r.quality.answers.declines + r.quality.summary.declines),
        String(r.quality.briefs.citations),
        pct(r.quality.briefs.validityRate),
        String(r.quality.briefs.declines),
      ]),
    ),
    '',
    'Answers include the summary and the two fixed questions.',
    '',
    '## Coverage',
    '',
    table(
      [
        'Bill',
        'Plan',
        'Briefs',
        'Left out',
        'Example available',
        'With picture',
        'With example',
      ],
      report.runs.map((r) => [
        r.bill,
        r.plan,
        String(r.coverage.briefs),
        String(r.coverage.omitted),
        String(r.coverage.eligible),
        `${String(r.coverage.pictures)} (${pct(r.coverage.eligible === 0 ? null : r.coverage.pictures / r.coverage.eligible)})`,
        r.coverage.examples === null
          ? 'not measured'
          : `${String(r.coverage.examples)} (${pct(r.coverage.eligible === 0 ? null : r.coverage.examples / r.coverage.eligible)})`,
      ]),
    ),
    '',
  );

  const capped = report.runs.filter(
    (r) =>
      r.facts && r.facts.unitsUncapped > r.facts.units && r.coverage.briefs > 0,
  );
  if (capped.length > 0) {
    out.push(
      '## Extrapolating a capped run',
      '',
      'Dollars per brief from the measured run, scaled to every part the bill would brief with no cap. Pictures scale with briefs; examples are scaled only by the count measured, so this is a floor for the `small` policy.',
      '',
      table(
        [
          'Bill',
          'Plan',
          'Briefed',
          'All parts',
          'Breakdown $/brief',
          'Pictures $/brief',
          'Breakdown + pictures, all parts',
        ],
        capped.map((r) => {
          const all = r.facts?.unitsUncapped ?? 0;
          const b = r.perUnit.breakdownDollarsPerBrief;
          const p = r.perUnit.picturesDollarsPerBrief;
          return [
            r.bill,
            r.plan,
            String(r.coverage.briefs),
            String(all),
            b === null ? 'n/a' : usd(b),
            p === null ? 'n/a' : usd(p),
            b === null || p === null ? 'n/a' : usd((b + p) * all),
          ];
        }),
      ),
      '',
    );
  }

  const recs = recommend(report);
  out.push(
    '## Recommendation for the high bound',
    '',
    `Worst measured/high ratio over the ${String(report.runs.filter(usable).length)} runs that did not fail, with a ${String(Math.round((MARGIN - 1) * 100))}% margin on top, rounded up to 0.05. ` +
      "Multiply a feature's high-bound dollars by this factor; 1.00 means the bound already holds with room to spare. " +
      'Stopped and timed-out runs are included as floors (they measured part of the work, so a ratio above 1.00x there is a real overrun). Failed runs are left out.',
    '',
    ...(report.runs.some((r) => !usable(r) || r.status !== 'completed')
      ? [
          'Not complete: ' +
            report.runs
              .filter((r) => r.status !== 'completed')
              .map(
                (r) =>
                  `${r.bill} on ${r.plan} (${r.status}${usable(r) ? `, ${x(r.total.ratioHigh)} of its high bound so far` : ', excluded'})`,
              )
              .join('; ') +
            '.',
          '',
        ]
      : []),
    table(
      ['Feature', 'Runs', 'Worst measured/high', 'Multiplier'],
      recs.map((r) => [
        r.feature,
        String(r.runs),
        x(r.worst),
        r.multiplier.toFixed(2),
      ]),
    ),
    '',
  );
  const under = recs.filter((r) => r.worst !== null && r.worst > 1);
  out.push(
    under.length === 0
      ? 'Every feature stayed within its high bound on every run that did not fail.'
      : `The high bound was exceeded for: ${under.map((r) => r.feature).join(', ')}. Raise those bounds before relying on them as a budget.`,
    '',
  );
  const tight = recommend(report, (r) => r.status === 'completed').filter(
    (r) =>
      r.worst !== null && r.worst > 0 && r.worst < 0.3 && r.feature !== 'total',
  );
  if (tight.length > 0)
    out.push(
      `Features whose bound is more than 3x too high (consider tightening, which makes quotes cheaper): ${tight.map((r) => r.feature).join(', ')}.`,
      '',
    );
  return out.join('\n');
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error(
      'Usage: tsx scripts/calibration-report.ts <report.json or job log>',
    );
    process.exitCode = 2;
    return;
  }
  console.log(renderReport(parseReport(await readFile(file, 'utf8'))));
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
