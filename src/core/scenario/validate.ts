import { coveredSectionIds, validateCitations } from '../answer/citations.js';
import {
  Scenario,
  type ScenarioFrame,
  type ScenarioFigure,
  type SearchHit,
} from '../model/index.js';
import { evaluateArithmetic } from './arith.js';
import { billContains, normalizeUnit, textNumbers } from './numbers.js';

export const PERSONA_NAMES = [
  'Alex',
  'Sam',
  'Jordan',
  'Casey',
  'Morgan',
  'Avery',
  'Robin',
  'Taylor',
] as const;

export type DropReason =
  | 'schema'
  | 'markup'
  | 'profile'
  | 'setup-claim'
  | 'citation'
  | 'figure'
  | 'language';
export interface ScenarioValidation {
  scenario?: Scenario;
  /** frameIndex -1 denotes a whole-scenario schema or profile failure. */
  dropped: { frameIndex: number; reason: DropReason }[];
}

const MARKUP =
  /[<>`]|&(?:[a-z][a-z\d]*|#\d+|#x[\da-f]+);|!\[|\]\(|\*\*|__|^\s*#/i;
const EVALUATIVE =
  /\b(?:good|bad|unfair|fair|harmful|helpful|great|terrible|awful|wonderful|beneficial|disastrous|relief|burdens?|giveaway)\b/i;
const BILL_CLAIM =
  /\b(?:bill|law|act|requires?|must|shall|would|will|eligible|eligibility|pays?|owes?|receives?|increases?|decreases?|reduces?)\b/i;

function matchesAssumption(
  figure: Pick<ScenarioFigure, 'value' | 'unit'>,
  scenario: Scenario,
): boolean {
  return scenario.profile.assumptions.some(
    (assumption) =>
      assumption.value === figure.value &&
      normalizeUnit(assumption.unit) === normalizeUnit(figure.unit),
  );
}

function setupOnlyStatesProfile(
  frame: ScenarioFrame,
  scenario: Scenario,
): boolean {
  if (!/\bexample\b/i.test(frame.caption) || BILL_CLAIM.test(frame.caption))
    return false;
  const vocabulary = new Set([
    ...(`${scenario.profile.name} ${scenario.profile.label} ${scenario.profile.assumptions.map((a) => a.label).join(' ')}`
      .toLowerCase()
      .match(/[a-z]+/g) ?? []),
    ...'this is example has with a an and of annual income home value usd dollars percent days years months bedrooms'.split(
      ' ',
    ),
  ]);
  return (frame.caption.toLowerCase().match(/[a-z]+/g) ?? []).every((word) =>
    vocabulary.has(word),
  );
}

function computedIsGrounded(
  figure: ScenarioFigure,
  frame: ScenarioFrame,
  scenario: Scenario,
  citedText: string,
): boolean {
  const expression = figure.expr ?? '';
  // The calculation must actually be shown; a hidden expression cannot explain the effect.
  if (!frame.caption.includes(expression)) return false;
  const inputs: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  for (const assumption of scenario.profile.assumptions)
    inputs[assumption.key] = assumption.value;
  const billFigures = (frame.figures ?? []).filter((f) => f.source === 'bill');
  billFigures.forEach((f, index) => {
    inputs[`bill_${String(index)}`] = f.value;
  });
  const result = evaluateArithmetic(expression, inputs);
  if (
    !result ||
    Math.abs(result.value - figure.value) >
      1e-9 * Math.max(1, Math.abs(figure.value))
  )
    return false;
  const billNumbers = textNumbers(citedText).filter((number) => number.unit);
  const billInputs = new Set(
    billNumbers.flatMap((number) =>
      number.unit === 'percent'
        ? [number.value, number.value / 100]
        : [number.value],
    ),
  );
  const allowed = new Set([
    ...scenario.profile.assumptions.map((a) => a.value),
    ...billNumbers.flatMap((n) =>
      n.unit === 'percent' ? [n.value, n.value / 100] : [n.value],
    ),
  ]);
  // 100 is a unit conversion, permitted only when a cited percentage is being used.
  if (billNumbers.some((n) => n.unit === 'percent')) allowed.add(100);
  return (
    result.literals.every((value) => allowed.has(value)) &&
    (result.literals.some((value) => billInputs.has(value)) ||
      result.names.some((name) => name.startsWith('bill_')))
  );
}

function frameReason(
  frame: ScenarioFrame,
  scenario: Scenario,
  excerpts: readonly SearchHit[],
): DropReason | undefined {
  if (
    MARKUP.test(frame.caption) ||
    (frame.figures ?? []).some((f) => MARKUP.test(f.unit))
  )
    return 'markup';
  if (EVALUATIVE.test(frame.caption)) return 'language';
  if (frame.kind === 'setup' && !setupOnlyStatesProfile(frame, scenario))
    return 'setup-claim';
  const chunks = excerpts.map((hit) => hit.chunk);
  // Contract citations are bare ids; [S:id] is only the prompt notation, never array markup.
  const citations = validateCitations(
    frame.citations.map((id) => `[S:${id}]`).join(' '),
    chunks.flatMap(coveredSectionIds),
    chunks,
  );
  const valid = citations.citations.filter((citation) => citation.valid);
  if (frame.kind !== 'setup' && !valid.length) return 'citation';
  const chunkIds = new Set(valid.flatMap((citation) => citation.chunkIds));
  const citedText = chunks
    .filter((chunk) => chunkIds.has(chunk.id))
    .map((chunk) => chunk.text)
    .join('\n');
  const figures = frame.figures ?? [];
  for (const figure of figures) {
    if (frame.kind === 'setup' && figure.source !== 'assumption')
      return 'figure';
    if (
      figure.source === 'bill' &&
      !billContains(figure.value, figure.unit, citedText)
    )
      return 'figure';
    if (figure.source === 'assumption' && !matchesAssumption(figure, scenario))
      return 'figure';
    if (figure.source === 'assumption' && !/\bexample\b/i.test(frame.caption))
      return 'figure';
    if (
      figure.source === 'computed' &&
      !computedIsGrounded(figure, frame, scenario, citedText)
    )
      return 'figure';
  }
  // Audit caption numbers too: leaving figures[] empty is not a grounding bypass.
  let caption = frame.caption;
  for (const figure of figures)
    if (figure.source === 'computed' && figure.expr)
      caption = caption.replaceAll(figure.expr, '');
  if (
    textNumbers(caption).some(
      (number) =>
        !figures.some(
          (figure) =>
            figure.value === number.value &&
            (!number.unit || normalizeUnit(figure.unit) === number.unit),
        ),
    )
  )
    return 'figure';
  return undefined;
}

/** Pure, conservative validation. Failed frames are dropped intact, never rewritten. */
export function validateScenario(
  object: unknown,
  excerpts: readonly SearchHit[],
): ScenarioValidation {
  const parsed = Scenario.safeParse(object);
  if (!parsed.success)
    return { dropped: [{ frameIndex: -1, reason: 'schema' }] };
  const scenario = parsed.data;
  const profile = scenario.profile;
  const labels = [
    scenario.subject,
    profile.name,
    profile.label,
    ...profile.assumptions.flatMap((a) => [a.key, a.label, a.unit]),
  ];
  if (labels.some((label) => MARKUP.test(label)))
    return { dropped: [{ frameIndex: -1, reason: 'markup' }] };
  if (labels.some((label) => EVALUATIVE.test(label)))
    return { dropped: [{ frameIndex: -1, reason: 'language' }] };
  const keys = profile.assumptions.map((a) => a.key);
  if (
    !PERSONA_NAMES.some((name) => name === profile.name) ||
    !/\bexample\b/i.test(profile.label) ||
    new Set(keys).size !== keys.length ||
    keys.some(
      (key) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(key) || key.startsWith('bill_'),
    ) ||
    textNumbers(profile.label).some(
      (number) => !matchesAssumption(number, scenario),
    )
  )
    return { dropped: [{ frameIndex: -1, reason: 'profile' }] };
  const dropped: ScenarioValidation['dropped'] = [];
  const frames = scenario.frames.filter((frame, frameIndex) => {
    const reason = frameReason(frame, scenario, excerpts);
    if (reason) dropped.push({ frameIndex, reason });
    return reason === undefined;
  });
  return frames.length >= 3
    ? { scenario: { ...scenario, frames }, dropped }
    : { dropped };
}
