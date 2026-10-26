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
  | 'label-number';

export interface PictureValidation {
  entries: PictureEntry[];
  dropped: { item: number; reason: PictureDropReason }[];
}

const WORD = /[\p{L}]+/gu;
const NUMBER = /\d+(?:[.,]\d+)*/g;

function words(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter((w) => w.length >= 3);
}

/**
 * Every word of three letters or more must be one of the item's words, allowing a different
 * ending: "Federal" for "federally", "Reserves" for "reserve". Shorter words ("no", "to") carry
 * no claim on their own.
 */
function wordsFromItem(label: string, itemWords: ReadonlySet<string>): boolean {
  return words(label).every((word) => {
    if (itemWords.has(word)) return true;
    for (const own of itemWords)
      if (
        (own.startsWith(word) || word.startsWith(own)) &&
        Math.min(own.length, word.length) >= 4
      )
        return true;
    return false;
  });
}

/** Every number in a label must be written the same way in the item. */
function numbersFromItem(label: string, itemNumbers: ReadonlySet<string>) {
  return (label.match(NUMBER) ?? []).every((n) => itemNumbers.has(n));
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

function panelReason(
  panel: PicturePanel,
  itemWords: ReadonlySet<string>,
  itemNumbers: ReadonlySet<string>,
): PictureDropReason | undefined {
  if (!shapeIsSound(panel)) return 'shape';
  for (const label of labels(panel)) {
    if (markup(label)) return 'label-markup';
    if (evaluative(label)) return 'label-judgment';
    if (!numbersFromItem(label, itemNumbers)) return 'label-number';
    if (!wordsFromItem(label, itemWords)) return 'label-words';
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
    const plain = stripCitations(item.text);
    const itemWords = new Set(words(plain));
    const itemNumbers = new Set(plain.match(NUMBER) ?? []);
    const reason = picture.panels
      .map((panel) => panelReason(panel, itemWords, itemNumbers))
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
