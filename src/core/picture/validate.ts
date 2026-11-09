/**
 * Deterministic checks on a drawn picture (#344). The glyphs come from closed sets, so what can
 * go wrong is the words: a label that says something the item does not ("Unsafe", "$500"), or
 * a panel whose shape makes no sense. A picture with any such problem is dropped whole and its
 * item stays text-only; nothing is repaired, because a repaired picture is one nobody checked.
 */
import { stripCitations } from '../answer/readability.js';
import type { PictureEntry, PicturePanel, StampId } from '../model/index.js';
import { evaluative, markup } from '../scenario/validate.js';
import type { PictureItem, PictureSet } from './prompt.js';

export type PictureDropReason =
  | 'unknown-item'
  | 'repeat'
  | 'shape'
  | 'stamp-unsupported'
  | 'label-markup'
  | 'label-judgment'
  | 'label-words'
  | 'label-number'
  | 'label-negation'
  | 'label-chars';

export interface PictureValidation {
  entries: PictureEntry[];
  dropped: { item: number; reason: PictureDropReason }[];
}

/** Validation and retry rule changes must invalidate pictures checked under older rules. */
export const PICTURE_RULES_VERSION = 2;

const WORD = /\p{L}+/gu;
/**
 * What a label may be made of, after NFKC: Latin letters, digits and plain punctuation. No
 * emoji or symbols ("🚫", "≠", "✗" all say something on their own), and no look-alike letters
 * from other scripts ("Nо" with a Cyrillic о is not "No").
 */
const LABEL_CHARS = /^[\p{Script=Latin}\p{Nd} .,'’%$&/:()-]+$/u;
/** Words too small to make a claim; any other word must come from the item. */
const FUNCTION_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'per',
  'the',
  'to',
  'with',
]);
/** Any script's digits: after NFKC, fullwidth digits are ASCII; others still count as numbers. */
const NUMBER = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu;
/** Words that turn a label into its opposite; a label may use one only if the item does. */
const NEGATION =
  /\b(?:no|not|non|un|never|none|nor|without|cannot)\b|n['’]t\b/iu;
const PROHIBITION = /\b(?:prohibit\w*|bans?|banned|forbid\w*|bars?|barred)\b/iu;
const OTHER_MONTHS =
  '(?:january|february|march|april|june|july|august|september|october|november|december)';
const MONTH = `(?:may|${OTHER_MONTHS})`;
const TIME_UNIT =
  '(?:seconds?|minutes?|hours?|days?|weeks?|months?|quarters?|years?)';
const TIME_SUPPORT = new RegExp(
  [
    `\\b(?:${TIME_UNIT}|daily|weekly|monthly|yearly|annual(?:ly)?|quarterly|deadline|within|${OTHER_MONTHS}|(?:19|20)\\d{2}|(?:no|not) later than)\\b`,
    // "May" also grants permission. Require date context for that month.
    '\\b(?:(?:by|in|each|every|before|after|during|until) may|may \\d+)\\b',
    // A relative word alone ("after consultation") makes no timing claim. Allow at most
    // three connecting words before a number, date, month or time unit.
    `\\b(?:before|after|by)\\s+(?:\\p{L}+\\s+){0,3}(?:\\d+|${MONTH}|${TIME_UNIT})\\b`,
  ].join('|'),
  'iu',
);
const RULE_BREACH =
  /\b(?:break(?:s|ing)?|broke(?:n)?|breach(?:es|ed|ing)?)\s+(?:(?:a|the|any|of)\s+){0,2}(?:rules?|laws?|regulations?)\b/iu;
const NONCOMPLIANCE =
  /\b(?:break(?:s|ing)?|broke(?:n)?|violat\w*|fail\w*|noncomply\w*|noncompli\w*|non-comply\w*|non-compli\w*)\b/iu;
const CAPPED_PAYMENT = /\bup to\s+\$\d/iu;
/** Stamps make claims even without labels; their meanings come from the drawing prompt. */
const STAMP_SUPPORT: Record<StampId, RegExp> = {
  // A warning says the actor faces a penalty or risk.
  warning:
    /\b(?:penalt\w*|penali[sz]\w*|fines?|fined|violat\w*|sanction\w*|liab\w*|risk\w*|revok\w*|revoc\w*|suspen\w*|prison\w*|imprison\w*|civil action\w*|forfeit\w*|criminal|(?:charged with|charges? (?:of|for)) (?:an? )?(?:crime|offen[cs]e)|shut down|cease(?:-| )and(?:-| )desist)\b/iu,
  // A seal says the actor is approved, licensed or under official oversight.
  seal: /\b(?:approv|licens|charter|certif|regist|authori[sz]|permit|regulat|supervis|accredit|oversee|oversight)\w*\b/iu,
  // A no badge needs the same negation as labels, or an explicit prohibition.
  no: new RegExp(`${NEGATION.source}|${PROHIBITION.source}`, 'iu'),
  // A calendar says when the actor must act, so the item must mention time.
  calendar: TIME_SUPPORT,
  // A clock makes the same timing claim as a calendar.
  clock: new RegExp(
    `${TIME_SUPPORT.source}|\\b(?:promptly|immediately|without delay|as soon as)\\b`,
    'iu',
  ),
  // A check says the actor may or must act, or qualifies to do so.
  check:
    /\b(?:may|must|shall|can|able|require\w*|allow\w*|permit\w*|eligib\w*|entitle\w*|authori[sz]ed)\b/iu,
};
/**
 * Inflections only. "Federal" may label "federally" and "Reserves" "reserve", but derivations
 * are other words: "Billion" is not "bill", "Statement" is not "state".
 */
const ENDINGS = ['ally', 'ing', 'ers', 'ly', 'ed', 'es', 'er', 'al', 's', 'd'];

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase();
}

function words(text: string): string[] {
  return normalize(text).match(WORD) ?? [];
}

/** The word and each form of it with one inflection removed, at least three letters long. */
function stems(word: string): Set<string> {
  const forms = new Set([word]);
  for (const ending of ENDINGS)
    if (word.endsWith(ending) && word.length - ending.length >= 3)
      forms.add(word.slice(0, -ending.length));
  return forms;
}

/**
 * Every word must be one of the item's words, up to an inflection, apart from a few function
 * words. A one-letter "X" or a two-letter "US" says something only if the item does.
 */
function wordsFromItem(label: string, itemStems: ReadonlySet<string>): boolean {
  return words(label)
    .filter((word) => !FUNCTION_WORDS.has(word))
    .every((word) => [...stems(word)].some((form) => itemStems.has(form)));
}

/**
 * "Non-profit" for an item that says "nonprofit" is the same word, not a negation: a hyphenated
 * pair is joined when the joined word is one of the item's.
 */
function joinItemCompounds(label: string, itemStems: ReadonlySet<string>) {
  // Split by hand rather than with a pattern over letter runs, which backtracks on long input.
  return normalize(label)
    .split(' ')
    .map((token) => {
      const parts = token.split('-');
      const joined = parts.join('');
      return parts.length === 2 &&
        /^\p{L}+$/u.test(joined) &&
        itemStems.has(joined)
        ? joined
        : token;
    })
    .join(' ');
}

/** Every number in a label must be written the same way in the item. */
function numbersFromItem(label: string, itemNumbers: ReadonlySet<string>) {
  return (normalize(label).match(NUMBER) ?? []).every((n) =>
    itemNumbers.has(n),
  );
}

function labels(panel: PicturePanel): string[] {
  return [
    panel.left.label,
    panel.right?.label,
    panel.note,
    panel.stamp?.label,
  ].filter((label): label is string => label !== undefined);
}

/** A link that relates two sides needs the right side; "none" must not have one. */
function shapeIsSound(panel: PicturePanel): boolean {
  if (panel.link === 'none') return !panel.right && !panel.carry && !panel.note;
  if (!panel.right) return false;
  // Nothing moves across "equals"; a carried glyph there would read as a payment.
  return !(panel.link === 'equals' && panel.carry);
}

interface ItemFacts {
  plain: string;
  stems: ReadonlySet<string>;
  numbers: ReadonlySet<string>;
  negated: boolean;
}

function itemFacts(text: string): ItemFacts {
  const plain = normalize(stripCitations(text));
  return {
    plain,
    stems: new Set(words(plain).flatMap((word) => [...stems(word)])),
    numbers: new Set(plain.match(NUMBER) ?? []),
    negated: STAMP_SUPPORT.no.test(plain),
  };
}

function stampSupported(stamp: StampId, item: ItemFacts): boolean {
  if (stamp === 'check' && item.negated) return false;
  if (STAMP_SUPPORT[stamp].test(item.plain)) return true;
  if (stamp !== 'warning') return false;
  if (RULE_BREACH.test(item.plain)) return true;
  // A capped payment is a penalty only alongside noncompliance in the same sentence.
  return item.plain
    .split(/[.!?\n]/u)
    .some(
      (sentence) =>
        NONCOMPLIANCE.test(sentence) && CAPPED_PAYMENT.test(sentence),
    );
}

function panelReason(
  panel: PicturePanel,
  item: ItemFacts,
): PictureDropReason | undefined {
  if (!shapeIsSound(panel)) return 'shape';
  if (panel.stamp && !stampSupported(panel.stamp.glyph, item))
    return 'stamp-unsupported';
  for (const raw of labels(panel)) {
    const plain = normalize(raw);
    if (markup(plain)) return 'label-markup';
    // Plain characters only, and at least one letter or digit: "$" or "()" alone says nothing.
    if (!LABEL_CHARS.test(plain) || !/[\p{L}\p{Nd}]/u.test(plain))
      return 'label-chars';
    const label = joinItemCompounds(raw, item.stems);
    if (evaluative(plain)) return 'label-judgment';
    if (!numbersFromItem(label, item.numbers)) return 'label-number';
    // "No" under an item that says "may pay interest" would draw the opposite of the caption.
    if (NEGATION.test(normalize(label)) && !item.negated)
      return 'label-negation';
    if (!wordsFromItem(label, item.stems)) return 'label-words';
  }
  return undefined;
}

export function validatePictures(
  reply: PictureSet,
  items: readonly PictureItem[],
): PictureValidation {
  const byIndex = new Map(items.map((item) => [item.index, item]));
  const seen = new Set<number>();
  const entries: PictureEntry[] = [];
  const dropped: PictureValidation['dropped'] = [];
  for (const picture of reply.pictures) {
    const item = byIndex.get(picture.item);
    if (!item) {
      dropped.push({ item: picture.item, reason: 'unknown-item' });
      continue;
    }
    if (seen.has(picture.item)) {
      dropped.push({ item: picture.item, reason: 'repeat' });
      continue;
    }
    seen.add(picture.item);
    const facts = itemFacts(item.text);
    const reason = picture.panels
      .map((panel) => panelReason(panel, facts))
      .find((r) => r !== undefined);
    if (reason) {
      dropped.push({ item: picture.item, reason });
      continue;
    }
    entries.push({
      item: item.index,
      text: item.text,
      ...(item.sectionId === undefined ? {} : { sectionId: item.sectionId }),
      panels: picture.panels,
    });
  }
  entries.sort((a, b) => a.item - b.item);
  return { entries, dropped };
}
