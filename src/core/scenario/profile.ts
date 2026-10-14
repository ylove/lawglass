import type { Scenario } from '../model/index.js';
import { normalizeUnit } from './numbers.js';

const CLAIM_WORD =
  /\b(?:bill|law|act|require\w*|must|shall|would|will|eligib\w*|pay\w*|owe\w*|receiv\w*|increas\w*|decreas\w*|reduc\w*|abolish\w*|exempt\w*|waiv\w*|tax(?:es|ed|ing)|ban\w*|repeal\w*|rais\w*|lower\w*|cut\w*|mandat\w*|prohibit\w*|permit\w*|allow\w*|grant\w*|impos\w*|collect\w*|eliminat\w*|entitl\w*|chang\w*|establish\w*|creat\w*|authoriz\w*|expand\w*|restrict\w*|remove\w*|enabl\w*|includ\w*|exclud\w*|appl\w*|refund\w*|deduct\w*|credit\w*|charg\w*|lev\w*)\b/i;

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
    !CLAIM_WORD.test(label)
  );
}

/** One closed template: model labels can describe a persona, never author its setup. */
export function setupCaption(profile: Scenario['profile']): string {
  const assumptions = profile.assumptions.map((a) => {
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

export function composeSetupFrames(scenario: Scenario): Scenario {
  return {
    ...scenario,
    frames: scenario.frames.map((frame) =>
      frame.kind === 'setup'
        ? {
            ...frame,
            caption: setupCaption(scenario.profile),
            figures: scenario.profile.assumptions.map((a) => ({
              source: 'assumption' as const,
              value: a.value,
              unit: a.unit,
            })),
          }
        : frame,
    ),
  };
}
