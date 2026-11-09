import {
  contextMode,
  WHOLE_BILL_MAX_TOKENS,
  type ContextMode,
} from '../answer/context.js';
import { chooseBreakdownUnits } from '../breakdown/units.js';
import { unitCapOf, type BreakdownMaxUnits } from '../breakdown/coverage.js';
import { UNIT_TOKEN_BUDGET } from '../breakdown/context.js';
import { buildOutline, chooseMapUnits } from '../chip-summary.js';
import { sectionText, walkSections, type Section } from '../model/index.js';
import { classifyBill } from '../scenario/detect.js';

export interface BillFactsOptions {
  /** The same value as the server's `breakdownMaxUnits`: a count, or `'all'`. Default 30. */
  breakdownUnitCap?: BreakdownMaxUnits;
  wholeBillMaxTokens?: number;
}

export interface BillFacts {
  sectionCount: number;
  /** Live text only, matching the normal summary and whole-bill policy. */
  characters: number;
  estimatedTokens: number;
  mode: ContextMode;
  breakdownUnits: number;
  omittedBreakdownUnits: number;
  mapUnits: number;
  omittedMapUnits: number;
  singleSubject: boolean;
  /** Forecast: one summary list item per map unit and one picture per brief. */
  eligiblePictureItems: { summary: number; breakdown: number };
  /** Input sizes in document order, for batching without sections or a backend. */
  mapUnitTokens: number[];
  breakdownUnitTokens: number[];
}

/** Parse-only and deterministic: environment, providers and indexes are never consulted.
 * The mode is a forecast: near the threshold the runtime's indexed scan can choose differently.
 */
export function billFacts(
  sections: readonly Section[],
  opts: BillFactsOptions = {},
): BillFacts {
  const budget = opts.wholeBillMaxTokens ?? WHOLE_BILL_MAX_TOKENS;
  if (!Number.isSafeInteger(budget) || budget < 0)
    throw new RangeError(
      'Whole-bill token budget must be a nonnegative integer.',
    );
  const all = [...walkSections(sections)];
  const characters = all.reduce(
    (n, s) => n + sectionText(s, { includeDeleted: false }).length,
    0,
  );
  const tokens = Math.ceil(characters / 4);
  const map = chooseMapUnits(sections);
  const breakdown = chooseBreakdownUnits(
    sections,
    unitCapOf(opts.breakdownUnitCap),
  );
  const ownTokens = (unit: Section): number =>
    Math.ceil(
      [...walkSections([unit])].reduce(
        (n, s) => n + sectionText(s, { includeDeleted: false }).length,
        0,
      ) / 4,
    );
  return {
    sectionCount: all.length,
    characters,
    estimatedTokens: tokens,
    mode: contextMode(tokens, budget),
    breakdownUnits: breakdown.units.length,
    omittedBreakdownUnits: breakdown.omitted,
    mapUnits: map.units.length,
    omittedMapUnits: map.omitted,
    singleSubject: classifyBill(sections) === 'single-subject',
    eligiblePictureItems: {
      summary: map.units.length,
      breakdown: breakdown.units.length,
    },
    mapUnitTokens: map.units.map(
      (u) =>
        Math.ceil(buildOutline(u).text.length / 4) +
        Math.min(450, ownTokens(u)),
    ),
    breakdownUnitTokens: breakdown.units.map((u) =>
      Math.min(UNIT_TOKEN_BUDGET, ownTokens(u)),
    ),
  };
}
