/**
 * Deterministic "would a scenario help?" checks (spec amendment 13, ADR 0009). No model call.
 *
 * Two questions, answered separately:
 *
 *   1. Is the BILL single-subject? Read from the outline alone. A focused bill gets a scenario
 *      beside its summary; an omnibus or mixed bill keeps a descriptive summary, because one
 *      made-up person cannot stand for twelve unrelated subjects.
 *   2. Is the QUESTION one a story helps with? A small, explicit phrase list, in the same style
 *      as the change-question detection in `core/retrieve`.
 *
 * Both are deliberately conservative: a missed story costs little, a misleading one costs more.
 */
import { isContainer } from '../chip-summary.js';
import { type Section } from '../model/index.js';

/** Three or more top-level divisions or titles means the bill is organised around many topics. */
export const OMNIBUS_MIN_DIVISIONS = 3;
/** More than this many substantive sections is too broad for one person's story. */
export const OMNIBUS_MAX_SECTIONS = 40;
/** At or below this many substantive sections the bill is short enough to count as one subject. */
export const SHORT_BILL_MAX_SECTIONS = 6;
/** Longer bills are single-subject when one heading word appears in at least this share of them. */
export const DOMINANT_TERM_SHARE = 0.5;

/** Headings every bill has, which say nothing about its subject. */
const BOILERPLATE_HEADING =
  /\b(?:short title|table of contents|definitions?|findings?|purposes?|effective date|severability|rule of construction|authorization|appropriations?|regulations?|technical|conforming|savings|repeal|amendments?)\b/i;

/** Words too common to name a subject. Heading words are compared after lowercasing. */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'act',
  'bill',
  'law',
  'state',
  'federal',
  'certain',
  'section',
  'sections',
  'program',
  'programs',
  'requirements',
  'requirement',
  'provisions',
  'general',
  'additional',
  'other',
]);

export type BillShape = 'single-subject' | 'omnibus';

/** Sections after descending through division/title containers, with the container count. */
function outlineUnits(sections: readonly Section[]): {
  units: Section[];
  topLevelContainers: number;
} {
  const units: Section[] = [];
  const visit = (section: Section): void => {
    if (isContainer(section)) section.children.forEach(visit);
    else units.push(section);
  };
  sections.forEach(visit);
  return { units, topLevelContainers: sections.filter(isContainer).length };
}

/** Lowercased heading words that could name a subject, with a crude plural fold. */
function subjectWords(heading: string): Set<string> {
  const words = heading
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(?:ies|es|s)$/, '') : w));
  return new Set(words);
}

/**
 * Single-subject versus omnibus, from the outline (the rules run in this order):
 *
 *   - no substantive sections: omnibus (no basis for a story)
 *   - `OMNIBUS_MIN_DIVISIONS` or more top-level divisions/titles: omnibus
 *   - more than `OMNIBUS_MAX_SECTIONS` substantive sections: omnibus
 *   - at most `SHORT_BILL_MAX_SECTIONS` substantive sections: single-subject
 *   - otherwise: single-subject only if one heading word recurs in at least
 *     `DOMINANT_TERM_SHARE` of the substantive section headings
 *
 * Substantive sections exclude boilerplate (short title, definitions, effective date, ...), so
 * those do not dilute the dominant-term share.
 */
export function classifyBill(sections: readonly Section[]): BillShape {
  const { units, topLevelContainers } = outlineUnits(sections);
  const substantive = units.filter(
    (s) => !BOILERPLATE_HEADING.test(s.heading ?? ''),
  );
  if (substantive.length === 0) return 'omnibus';
  if (topLevelContainers >= OMNIBUS_MIN_DIVISIONS) return 'omnibus';
  if (substantive.length > OMNIBUS_MAX_SECTIONS) return 'omnibus';
  if (substantive.length <= SHORT_BILL_MAX_SECTIONS) return 'single-subject';

  const counts = new Map<string, number>();
  for (const section of substantive)
    for (const word of subjectWords(section.heading ?? ''))
      counts.set(word, (counts.get(word) ?? 0) + 1);
  const top = Math.max(0, ...counts.values());
  return top / substantive.length >= DOMINANT_TERM_SHARE
    ? 'single-subject'
    : 'omnibus';
}

/** Groups people ask about by name. A story about them is the natural answer. */
const GROUP =
  '(?:renters?|tenants?|landlords?|homeowners?|famil(?:y|ies)|households?|parents?|kids?|children|workers?|employees?|employers?|(?:small )?business(?:es)?|retirees?|seniors?|students?|farmers?|veterans?|drivers?|taxpayers?)';

/**
 * Affect-me, family, household and business phrasings. Each entry is one shape of question,
 * kept readable on purpose. Questions about wording ("what does section 3 say") match none.
 */
const STORY_PATTERNS: readonly RegExp[] = [
  // "how will this affect me", "does it apply to my family", "what does this mean for us".
  /\b(?:affect|impact|apply to|mean for|matter to|change things for|help|hurt)\s+(?:\w+\s+){0,2}(?:me|us|my|our)\b/i,
  /\bwhat\s+(?:does|would|will)\s+(?:this|it|the\s+(?:bill|law|act))\s+mean\s+for\b/i,
  // "my family", "our household", "my rent", "my small business".
  /\b(?:my|our)\s+(?:family|household|kids?|children|parents|home|rent|taxes|paycheck|job|(?:small\s+)?business|mortgage|bills?)\b/i,
  // "what does this mean for renters", "how do businesses respond", "how are families affected".
  new RegExp(
    `\\b(?:how|what)\\b[^.?!]{0,40}\\b${GROUP}\\b[^.?!]{0,25}\\b(?:affect|impact|respond|pay|owe|change|mean|handle|comply)`,
    'i',
  ),
  new RegExp(
    `\\b(?:mean|means|affect|affects|impact|impacts)\\s+(?:for\\s+)?(?:the\\s+)?${GROUP}\\b`,
    'i',
  ),
  // "would I pay more", "do I have to", "will I qualify", "can I still deduct".
  /\b(?:would|will|do|does|am|can|could|should)\s+i\s+(?:\w+\s+){0,2}(?:pay|owe|lose|get|qualify|save|need|have to|still|be)\b/i,
];

/** True when the question is the kind a short illustrated example helps with. */
export function wantsScenario(question: string): boolean {
  return STORY_PATTERNS.some((pattern) => pattern.test(question));
}
