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

/** Record text is untrusted: drop control characters and line breaks, then cut it short. */
export function cleanRecordText(
  text: string,
  max: number = MAX_FIELD_CHARS,
): string {
  const plain = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
  const oneLine = plain.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max
    ? oneLine
    : `${oneLine.slice(0, max - 3).trimEnd()}...`;
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
  unknown: 'has a status that is not stated',
};

function withRecord(line: string, url: string | undefined): string {
  return url === undefined ? line : `${line} (Record: ${url})`;
}

function more(total: number): string[] {
  return total > MAX_HISTORY_ITEMS
    ? [`- and ${String(total - MAX_HISTORY_ITEMS)} more.`]
    : [];
}

function versionLines(history: BillHistory): string[] {
  if (history.versions.length === 0) return [];
  const lines = history.versions.slice(0, MAX_HISTORY_ITEMS).map((v) => {
    const label = cleanRecordText(v.label);
    const date = v.date === undefined ? '' : `, ${cleanRecordText(v.date, 40)}`;
    return withRecord(`- ${label}${date}.`, v.url);
  });
  return ['Versions of the bill:', ...lines, ...more(history.versions.length)];
}

function actionLines(history: BillHistory): string[] {
  if (history.actions.length === 0) return [];
  // ISO dates sort as text. Array.prototype.sort is stable, so same-day actions keep record order.
  const ordered = [...history.actions].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const lines = ordered.slice(0, MAX_HISTORY_ITEMS).map((a) => {
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
  return ['Key actions:', ...lines, ...more(history.actions.length)];
}

function amendmentLine(a: BillHistory['amendments'][number]): string {
  const sponsor = a.sponsor?.name.trim();
  const committee = a.committee?.trim();
  // Name a person or committee only when the record names one.
  const who =
    sponsor !== undefined && sponsor !== ''
      ? `An amendment offered by ${cleanRecordText(sponsor, 100)}`
      : committee !== undefined && committee !== ''
        ? `An amendment from ${cleanRecordText(committee, 100)}`
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
    return ['The record lists no amendments to this bill.'];
  return [
    'Amendments to the bill, as recorded:',
    ...history.amendments.slice(0, MAX_HISTORY_ITEMS).map(amendmentLine),
    ...more(history.amendments.length),
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
