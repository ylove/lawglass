import { coveredSectionIds, validateCitations } from '../answer/citations.js';
import {
  Scenario,
  type ScenarioFrame,
  type ScenarioFigure,
  type SearchHit,
} from '../model/index.js';
import { computedIsGrounded } from './grounding.js';
import {
  MAX_SETUP_ASSUMPTIONS,
  setupAssumptionCount,
  setupCaption,
  validProfileLabel,
  validAssumptionUnit,
} from './profile.js';
import { billContains, normalizeUnit, numberTokens } from './numbers.js';

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

/** Captions are plain text. The UI must render them as text nodes, never HTML/Markdown. */
const MARKUP =
  /[<>`]|&(?:[a-z][a-z\d]*|#\d+|#x[\da-f]+);|!\[|\]\(|\*\*|__|^\s*#|:\/\/|javascript:|data:|www\./im;
const EVALUATIVE =
  /\b(?:good|bad|unfair|fair|harm(?:s|ed|ful|fully|less|lessly|ing)?|helpful|great|terrible|awful|wonderful|benefit(?:s|ed|ing)?|beneficial|disastrous|relief|relieve[sd]?|relieving|burden(?:s|ed|some|somely|ing)?|giveaway|unjust(?:ly|ice|ified|ifiable|ifiably)?|punish(?:es|ed|ing|ment|ments|able)?|windfalls?|loopholes?|handouts?|crushing|fairness)\b/i;
const LEGAL_PHRASES =
  /\b(?:good cause|fair market value|fair use|fair housing|burden of proof|in good standing|bad faith|good faith|benefits? (?:plans?|eligibility|amount|payments?|recipients?)|(?:receives?|claims?|pays?|provides?) benefits?|eligible for benefits?|applies for benefits?|employee benefits?|social security benefits?|unemployment benefits?)\b/gi;

/** Exported so a requested subject is vetted by the very rules the model's output must pass. */
export function evaluative(text: string): boolean {
  // Proper act names can contain otherwise evaluative terms, e.g. Tax Relief Act.
  const neutral = text
    .replace(/\b(?:[A-Z][A-Za-z'-]* +)+Act\b/g, '')
    .replace(LEGAL_PHRASES, '');
  return EVALUATIVE.test(neutral);
}
export function markup(text: string): boolean {
  return MARKUP.test(text.normalize('NFKC'));
}

/** Only assumptions the composed setup caption displays may support a figure. */
function shownAssumptions(
  scenario: Scenario,
): Scenario['profile']['assumptions'] {
  return scenario.profile.assumptions.slice(
    0,
    setupAssumptionCount(scenario.profile),
  );
}

function matchesAssumption(
  figure: Pick<ScenarioFigure, 'value' | 'unit'>,
  scenario: Scenario,
): boolean {
  return shownAssumptions(scenario).some(
    (assumption) =>
      assumption.value === figure.value &&
      normalizeUnit(assumption.unit) === normalizeUnit(figure.unit),
  );
}

function frameReason(
  frame: ScenarioFrame,
  scenario: Scenario,
  excerpts: readonly SearchHit[],
):
  | { reason: DropReason; frame?: never }
  | { reason?: never; frame: ScenarioFrame } {
  if (
    markup(frame.caption) ||
    (frame.figures ?? []).some((f) => markup(f.unit))
  )
    return { reason: 'markup' };
  if (evaluative(frame.caption)) return { reason: 'language' };
  if (
    frame.kind === 'setup' &&
    frame.caption !== setupCaption(scenario.profile)
  )
    return { reason: 'setup-claim' };
  const chunks = excerpts.map((hit) => hit.chunk);
  // Contract citations are bare ids; [S:id] is only the prompt notation, never array markup.
  const citations = validateCitations(
    frame.citations.map((id) => `[S:${id}]`).join(' '),
    chunks.flatMap(coveredSectionIds),
    chunks,
  );
  const valid = citations.citations.filter((citation) => citation.valid);
  if (frame.kind !== 'setup' && !valid.length) return { reason: 'citation' };
  const chunkIds = new Set(valid.flatMap((citation) => citation.chunkIds));
  const citedText = chunks
    .filter(
      (chunk) => chunkIds.has(chunk.id) && chunk.amendmentStatus !== 'deleted',
    )
    .map((chunk) => chunk.text)
    .join('\n');
  const figures = frame.figures ?? [];
  for (const figure of figures) {
    if (frame.kind === 'setup' && figure.source !== 'assumption')
      return { reason: 'figure' };
    if (
      figure.source === 'bill' &&
      !billContains(figure.value, figure.unit, citedText)
    )
      return { reason: 'figure' };
    if (figure.source === 'assumption' && !matchesAssumption(figure, scenario))
      return { reason: 'figure' };
    if (figure.source === 'assumption' && !/\bexample\b/i.test(frame.caption))
      return { reason: 'figure' };
    if (
      figure.source === 'computed' &&
      !computedIsGrounded(
        figure,
        figures,
        shownAssumptions(scenario),
        citedText,
      )
    )
      return { reason: 'figure' };
  }
  // No expression removal: every complete caption token must equal a declared value.
  const numbers = numberTokens(frame.caption, {
    ignoreOrdinals: frame.kind === 'setup',
  });
  const matches = (figure: ScenarioFigure, number: (typeof numbers)[number]) =>
    figure.value === number.value &&
    (!number.unit || normalizeUnit(figure.unit) === number.unit);
  if (
    numbers.some(
      (number) => !figures.some((figure) => matches(figure, number)),
    ) ||
    figures.some(
      (figure) =>
        figure.source === 'computed' &&
        !numbers.some((number) => matches(figure, number)),
    )
  )
    return { reason: 'figure' };
  return {
    frame: { ...frame, citations: valid.map((citation) => citation.sectionId) },
  };
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
  if (labels.some(markup))
    return { dropped: [{ frameIndex: -1, reason: 'markup' }] };
  if (labels.some(evaluative))
    return { dropped: [{ frameIndex: -1, reason: 'language' }] };
  const keys = profile.assumptions.map((a) => a.key);
  if (
    !PERSONA_NAMES.some((name) => name === profile.name) ||
    !/\bexample\b/i.test(profile.label) ||
    profile.assumptions.length > MAX_SETUP_ASSUMPTIONS ||
    new Set(keys).size !== keys.length ||
    keys.some(
      (key) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(key) || key.startsWith('bill_'),
    ) ||
    profile.assumptions.some((a) => !validAssumptionUnit(a.unit)) ||
    ![profile.label, ...profile.assumptions.map((a) => a.label)].every(
      validProfileLabel,
    )
  )
    return { dropped: [{ frameIndex: -1, reason: 'profile' }] };
  const dropped: ScenarioValidation['dropped'] = [];
  const frames: ScenarioFrame[] = [];
  scenario.frames.forEach((frame, frameIndex) => {
    const result = frameReason(frame, scenario, excerpts);
    if (result.reason !== undefined)
      dropped.push({ frameIndex, reason: result.reason });
    else frames.push(result.frame);
  });
  return frames.length >= 3 && frames.some((frame) => frame.kind !== 'setup')
    ? { scenario: { ...scenario, frames }, dropped }
    : { dropped };
}
