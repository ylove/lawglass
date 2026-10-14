/**
 * "How did it get here?": built in code from the stored `BillHistory`, with no LLM call.
 *
 * Why no model: the question is about who did what and when. A model could only invent an
 * attribution, so every name and purpose below is copied from the official record, or left out.
 * The wording stays plain; the record's own text is shortened and cleaned but never reworded.
 */
import { fleschKincaidGrade } from './answer/index.js';
import type { ChipRun } from './chip-types.js';
import {
  walkSections,
  ZERO_USAGE,
  type BillHistory,
  type ChipDefinition,
  type Section,
} from './model/index.js';

/** Long lists are cut here and the rest are counted. */
export const MAX_HISTORY_ITEMS = 12;
/** One record field (an action, a purpose) is cut to this many characters. */
export const MAX_FIELD_CHARS = 300;

export const NO_HISTORY_TEXT =
  "Legislative history isn't available for this document. It is available for federal bills (GovInfo) and Ohio bills (Ohio LIS).";

export const STRIKE_INSERT_SENTENCE =
  'Struck-through and underlined text in this version shows how the bill would change current law. It is not a record of amendments to the bill.';

/**
 * Record text is untrusted and is shown by a renderer that understands a little markdown.
 * Drop control, zero-width and bidi-override characters and line breaks, cut it short, then
 * backslash-escape what the renderer interprets so the text displays exactly as recorded
 * (a `[S:...]` in the record must not be read as a citation either).
 */
export function cleanRecordText(
  text: string,
  max: number = MAX_FIELD_CHARS,
): string {
  const plain = text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  const oneLine = plain.replace(/\s+/g, ' ').trim();
  const short =
    oneLine.length <= max
      ? oneLine
      : `${oneLine.slice(0, max - 3).trimEnd()}...`;
  return short.replace(/[\\*[]/g, (c) => `\\${c}`);
}

function hasChangedSpans(sections: readonly Section[]): boolean {
  for (const section of walkSections(sections))
    if (section.spans.some((s) => s.status !== 'unchanged')) return true;
  return false;
}

const STATUS_PHRASE: Record<
  BillHistory['amendments'][number]['status'],
  string
> = {
  adopted: 'was adopted',
  offered: 'was offered',
  rejected: 'was rejected',
  withdrawn: 'was withdrawn',
  // Never turned into a verdict: the record did not say.
  unknown: 'has a status not stated',
};

function withRecord(line: string, url: string | undefined): string {
  return url === undefined ? line : `${line} (Record: ${url})`;
}

/**
 * Long lists keep the first item (where the story starts) and the latest ones (where it stands
 * now), and say how many in between are hidden. Cutting the tail would lose passage,
 * enrollment and signing, which is the point of the chip.
 */
function capKeepingLatest<T>(
  items: readonly T[],
  noun: string,
): { shown: T[]; note: string[] } {
  if (items.length <= MAX_HISTORY_ITEMS) return { shown: [...items], note: [] };
  const hidden = items.length - MAX_HISTORY_ITEMS;
  return {
    shown: [items[0] as T, ...items.slice(-(MAX_HISTORY_ITEMS - 1))],
    note: [
      hidden === 1
        ? `- 1 ${noun} in between is not shown.`
        : `- ${String(hidden)} ${noun}s in between are not shown.`,
    ],
  };
}

/** Oldest first when every item is dated (stable); otherwise the stored order. */
function oldestFirst<T extends { date?: string | undefined }>(
  items: readonly T[],
): T[] {
  return items.every((i) => i.date !== undefined)
    ? [...items].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
    : [...items];
}

/** Lines for a list, with the "in between" note after the first item. */
function listLines<T>(
  items: readonly T[],
  noun: string,
  line: (item: T) => string,
): string[] {
  const { shown, note } = capKeepingLatest(items, noun);
  const lines = shown.map(line);
  // The note goes after the first item, where the hidden middle begins.
  return note.length === 0
    ? lines
    : [...lines.slice(0, 1), ...note, ...lines.slice(1)];
}

function versionLines(history: BillHistory): string[] {
  if (history.versions.length === 0) return [];
  const lines = listLines(oldestFirst(history.versions), 'version', (v) => {
    const label = cleanRecordText(v.label);
    const date = v.date === undefined ? '' : `, ${cleanRecordText(v.date, 40)}`;
    return withRecord(`- ${label}${date}.`, v.url);
  });
  return ['Versions of the bill:', ...lines];
}

function actionLines(history: BillHistory): string[] {
  if (history.actions.length === 0) return [];
  // ISO dates sort as text. Array.prototype.sort is stable, so same-day actions keep record order.
  const ordered = [...history.actions].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const lines = listLines(ordered, 'action', (a) => {
    // Chamber and committee are shown only when the record has them.
    const where = [a.chamber, a.committee]
      .filter((x): x is string => x !== undefined && x.trim() !== '')
      .map((x) => cleanRecordText(x, 100));
    const suffix = where.length > 0 ? ` (${where.join(', ')})` : '';
    return withRecord(
      `- ${cleanRecordText(a.date, 40)}: ${cleanRecordText(a.text)}${suffix}`,
      a.url,
    );
  });
  return ['Key actions:', ...lines];
}

function amendmentLine(a: BillHistory['amendments'][number]): string {
  const sponsor = a.sponsor?.name.trim();
  const committee = a.committee?.trim();
  // Name a person or committee only when the record names one.
  const who =
    sponsor !== undefined && sponsor !== ''
      ? `An amendment offered by ${cleanRecordText(sponsor, 100)}`
      : committee !== undefined && committee !== ''
        ? `An amendment considered in ${cleanRecordText(committee, 100)}`
        : 'An amendment';
  const number =
    a.number === undefined ? '' : ` (${cleanRecordText(a.number, 40)})`;
  const date = a.date === undefined ? '' : ` on ${cleanRecordText(a.date, 40)}`;
  const aboutText = a.purpose ?? a.description;
  const about =
    aboutText === undefined || aboutText.trim() === ''
      ? ''
      : `: ${cleanRecordText(aboutText)}`;
  const inCommittee =
    sponsor !== undefined && sponsor !== '' && committee
      ? ` Committee: ${cleanRecordText(committee, 100)}.`
      : '';
  const sentence = `- ${who}${number} ${STATUS_PHRASE[a.status]}${date}${about}`;
  return withRecord(
    `${/[.!?]$/.test(sentence) ? sentence : `${sentence}.`}${inCommittee}`,
    a.url,
  );
}

function amendmentLines(history: BillHistory): string[] {
  if (history.amendments.length === 0)
    return ['No amendments appear in the record we found.'];
  return [
    'Amendments to the bill, as recorded:',
    ...listLines(oldestFirst(history.amendments), 'amendment', amendmentLine),
  ];
}

/** The answer text. Pure, so it is tested without any document or provider. */
export function buildHistoryText(
  history: BillHistory | undefined,
  sections: readonly Section[],
): string {
  const parts: string[] = [];
  if (history === undefined) {
    parts.push(NO_HISTORY_TEXT);
  } else if (
    history.versions.length === 0 &&
    history.actions.length === 0 &&
    history.amendments.length === 0
  ) {
    parts.push(
      'The official record we found lists no versions, actions or amendments for this bill.',
    );
  } else {
    parts.push(
      'Here is what the official record says about how this bill got here.',
      versionLines(history).join('\n'),
      actionLines(history).join('\n'),
      amendmentLines(history).join('\n'),
    );
    const hosts = [...new Set(history.sources.map((s) => s.host))];
    if (hosts.length > 0)
      parts.push(
        `Source: ${hosts.map((h) => cleanRecordText(h, 100)).join(', ')}.`,
      );
  }
  if (hasChangedSpans(sections)) parts.push(STRIKE_INSERT_SENTENCE);
  return parts.filter((p) => p !== '').join('\n\n');
}

export function runHistoryChip(
  chip: ChipDefinition,
  history: BillHistory | undefined,
  sections: readonly Section[],
  onToken: ((text: string) => void) | undefined,
): ChipRun {
  const text = buildHistoryText(history, sections);
  onToken?.(text);
  return {
    answer: {
      text,
      citations: [],
      invalidCitations: [],
      warnings: [],
      declined: false,
      readingGrade: fleschKincaidGrade(text),
      provider: 'none',
      model: chip.id,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    hits: [],
    backendUsage: ZERO_USAGE,
    mode: 'none',
  };
}
