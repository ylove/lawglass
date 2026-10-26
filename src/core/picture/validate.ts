/**
 * Deterministic checks on a drawn picture (#344). The glyphs come from closed sets, so what can
 * go wrong is the words: a label that says something the item does not ("Unsafe", "$500"), or
 * a panel whose shape makes no sense. A picture with any such problem is dropped whole and its
 * item stays text-only; nothing is repaired, because a repaired picture is one nobody checked.
 */
import { stripCitations } from '../answer/readability.js';
import type { PictureEntry, PicturePanel } from '../model/index.js';
import { evaluative, markup } from '../scenario/validate.js';
import type { PictureItem, PictureSet } from './prompt.js';

export type PictureDropReason =
  | 'unknown-item'
  | 'repeat'
  | 'shape'
  | 'label-markup'
  | 'label-judgment'
  | 'label-words'
  | 'label-number'
  | 'label-negation';

export interface PictureValidation {
  entries: PictureEntry[];
  dropped: { item: number; reason: PictureDropReason }[];
}

const WORD = /\p{L}+/gu;
/** Any script's digits: after NFKC, fullwidth digits are ASCII; others still count as numbers. */
const NUMBER = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu;
/** Words that turn a label into its opposite; a label may use one only if the item does. */
const NEGATION =
  /\b(?:no|not|non|un|never|none|nor|without|cannot)\b|n['’]t\b/iu;
/**
 * Inflections only. "Federal" may label "federally" and "Reserves" "reserve", but derivations
 * are other words: "Billion" is not "bill", "Statement" is not "state".
 */
const ENDINGS = ['ally', 'ing', 'ers', 'ly', 'ed', 'es', 'er', 'al', 's', 'd'];

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase();
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
 * Every word of three letters or more must be one of the item's words, up to an inflection.
 * Shorter words ("to", "of") carry no claim on their own, except a negation, checked apart.
 */
function wordsFromItem(label: string, itemStems: ReadonlySet<string>): boolean {
  return words(label)
    .filter((word) => word.length >= 3)
    .every((word) => [...stems(word)].some((form) => itemStems.has(form)));
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
  stems: ReadonlySet<string>;
  numbers: ReadonlySet<string>;
  negated: boolean;
}

function itemFacts(text: string): ItemFacts {
  const plain = normalize(stripCitations(text));
  return {
    stems: new Set(words(plain).flatMap((word) => [...stems(word)])),
    numbers: new Set(plain.match(NUMBER) ?? []),
    negated: NEGATION.test(plain),
  };
}

function panelReason(
  panel: PicturePanel,
  item: ItemFacts,
): PictureDropReason | undefined {
  if (!shapeIsSound(panel)) return 'shape';
  for (const label of labels(panel)) {
    if (markup(label)) return 'label-markup';
    if (evaluative(label)) return 'label-judgment';
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
