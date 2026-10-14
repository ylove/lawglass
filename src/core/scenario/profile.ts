import type { Scenario } from '../model/index.js';
import { normalizeUnit } from './numbers.js';

const CLAIM_WORD =
  /\b(?:bill|law|act|require\w*|must|shall|would|will|eligib\w*|pay\w*|owe\w*|receiv\w*|increas\w*|decreas\w*|reduc\w*|abolish\w*|exempt\w*|waiv\w*|tax(?:es|ed|ing)|ban\w*|repeal\w*|rais\w*|lower\w*|cut\w*|mandat\w*|prohibit\w*|permit\w*|allows|allowed|allowing|grant\w*|impos\w*|collect\w*|eliminat\w*|entitl\w*|chang\w*|establish\w*|creat\w*|authoriz\w*|expand\w*|restrict\w*|remove\w*|enabl\w*|includ\w*|exclud\w*|appl\w*|refund\w*|deducts|deducted|deducting|credits|credited|crediting|charg\w*|lev\w*)\b/i;

// Base-form verbs are claims only after a modal or "to" ("to allow"), so nouns like "deduction" stay valid.
const MODAL_CLAIM =
  /\b(?:to|may|can|could|will|shall)\s+(?:allow|deduct|credit|require|ban|exempt|waive|tax|raise|lower|cut|repeal|abolish|reduce|increase|decrease|impose|grant|permit|prohibit|mandate|eliminate|remove|refund|charge|levy|collect|pay|owe|receive|create|establish|expand|restrict|authorize|enable|exclude|include|apply|change|entitle)\b/i;

const ASSUMPTION_UNITS = new Set([
  'usd',
  'percent',
  'day',
  'year',
  'month',
  'bedroom',
  'resident',
  'employee',
  'people',
  'hour',
  'week',
  'count',
]);

/** Units are rendered in setup captions too, so they cannot be free-form claim text. */
export function validAssumptionUnit(unit: string): boolean {
  return ASSUMPTION_UNITS.has(normalizeUnit(unit));
}

export function validProfileLabel(label: string): boolean {
  return (
    label.length <= 60 &&
    /^[A-Za-z]+(?:[ '-][A-Za-z]+)*$/.test(label) &&
    label.split(/ +/).length <= 8 &&
    !CLAIM_WORD.test(label) &&
    !MODAL_CLAIM.test(label)
  );
}

/** The contract caps a caption at 200 characters; at most this many assumptions are composed. */
export const MAX_SETUP_ASSUMPTIONS = 3;
const MAX_CAPTION_LENGTH = 200;

function renderSetup(profile: Scenario['profile'], count: number): string {
  const assumptions = profile.assumptions.slice(0, count).map((a) => {
    const value = new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 20,
    }).format(a.value);
    const amount =
      normalizeUnit(a.unit) === 'usd' ? `$${value}` : `${value} ${a.unit}`;
    return `Example: ${a.label} ${amount}.`;
  });
  return [`This is ${profile.name}. ${profile.label}.`, ...assumptions].join(
    ' ',
  );
}

/** How many assumptions fit: at most three, fewer if the caption would be too long. */
export function setupAssumptionCount(profile: Scenario['profile']): number {
  let count = Math.min(profile.assumptions.length, MAX_SETUP_ASSUMPTIONS);
  while (count > 0 && renderSetup(profile, count).length > MAX_CAPTION_LENGTH)
    count -= 1;
  return count;
}

/** One closed template: model labels can describe a persona, never author its setup. */
export function setupCaption(profile: Scenario['profile']): string {
  return renderSetup(profile, setupAssumptionCount(profile));
}

export function composeSetupFrames(scenario: Scenario): Scenario {
  return {
    ...scenario,
    frames: scenario.frames.map((frame) =>
      frame.kind === 'setup'
        ? {
            ...frame,
            caption: setupCaption(scenario.profile),
            figures: scenario.profile.assumptions
              .slice(0, setupAssumptionCount(scenario.profile))
              .map((a) => ({
                source: 'assumption' as const,
                value: a.value,
                unit: a.unit,
              })),
          }
        : frame,
    ),
  };
}
