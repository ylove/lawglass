const SMALL =
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(
    ' ',
  );
const TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
const WORDS = new Map<string, number>([
  ...SMALL.map((word, value): [string, number] => [word, value]),
  ...TENS.map((word, index): [string, number] => [word, (index + 2) * 10]),
  ['half', 0.5],
  ['dozen', 12],
  ...'first second third fourth fifth sixth seventh eighth ninth tenth'
    .split(' ')
    .map((word, index): [string, number] => [word, index + 1]),
]);
const SCALES: Readonly<Record<string, number>> = {
  hundred: 100,
  thousand: 1000,
  million: 1000000,
  billion: 1000000000,
  k: 1000,
  m: 1000000,
  b: 1000000000,
};
const UNIT =
  '%|percent\\b|per cent\\b|USD\\b|dollars?\\b|days?\\b|years?\\b|months?\\b|bedrooms?\\b|residents?\\b|employees?\\b|people\\b|hours?\\b|weeks?\\b';
const BASE = `(?:${SMALL.join('|')}|(?:${TENS.join('|')})(?:[ -](?:${SMALL.slice(1, 10).join('|')}))?|half|(?:a )?dozen)`;
const HUNDREDS = `(?:${BASE}(?: +hundred(?: +and)?(?: +${BASE})?)?)`;
const SPELLED = `${HUNDREDS}(?: +(?:thousand|million|billion)(?: +and)?(?: +${HUNDREDS})?)*`;
const DIGITS = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+';

/**
 * Quantities with no numeral to parse ("a grand", "tenfold", "2x", non-Latin digits).
 * They are reported as NaN so they can never equal a declared figure: fail closed.
 */
const UNPARSEABLE_QUANTITY = new RegExp(
  [
    '\\b(?:hundreds?|thousands?|millions?|billions?|grand|scores?|gross|dozens?)\\b',
    `\\b(?:${[...SMALL, ...TENS, 'hundred', 'thousand', 'million', 'billion'].join('|')}|\\d+)-?fold\\b`,
    '\\b\\d+(?:\\.\\d+)?\\s*[x\u00d7](?!\\w)',
    '\\b(?:one|two|three|four|five|a|an)[ -](?:half|third|quarter|fourth|fifth|tenth)s?\\b',
    '\\b(?:halves|thirds|quarters|fourths|fifths|sixths|eighths|tenths)\\b',
  ].join('|'),
  'gi',
);
// Digits from other scripts and Roman-numeral glyphs; NFKC folds some of them to ASCII.
const FOREIGN_DIGIT = /(?![0-9])\p{Nd}/u;
const ROMAN_GLYPH = /[\u2160-\u2188]/;

export function normalizeUnit(unit: string): string {
  const lower = unit.toLowerCase().trim();
  if (['$', 'usd', 'dollar', 'dollars'].includes(lower)) return 'usd';
  if (['%', 'percent', 'percentage', 'per cent'].includes(lower))
    return 'percent';
  return lower.replace(/s$/, '');
}

function wordValue(phrase: string): number {
  let total = 0;
  let group = 0;
  for (const word of phrase.toLowerCase().split(/[ -]+/)) {
    if (word === 'hundred') group *= 100;
    else if (SCALES[word]) {
      total += group * SCALES[word];
      group = 0;
    } else group += WORDS.get(word) ?? 0;
  }
  return total + group;
}

export interface TextNumber {
  value: number;
  unit: string;
}
export interface NumberToken extends TextNumber {
  start: number;
  end: number;
}

/** Whole tokens and their boundaries; labels are blanked, never numeric substrings. */
export function numberTokens(text: string): NumberToken[] {
  const normalized = text
    .normalize('NFKC')
    .replace(
      /\b(?:Section|Sec\.|Form)\s+\d+(?:\.\d+)*\b|§\s*\d+(?:\.\d+)*/gi,
      (match) => ' '.repeat(match.length),
    );
  const pattern = new RegExp(
    `(?<![\\w.\\-])(?<currency>\\$)?(?<amount>[+-]?(?:${DIGITS})(?:e[+-]?\\d+)?(?:st|nd|rd|th)?|${SPELLED}|${[...WORDS.keys()].filter((w) => w.endsWith('th') || ['first', 'second', 'third'].includes(w)).join('|')}|doubles?)(?<scale>\\s*(?:[KMB]\\b|(?:thousand|million|billion)\\b))?(?!\\w|\\.\\d|,\\d)(?:[\\s-]*(?<unit>${UNIT}))?`,
    'gi',
  );
  const numbers: NumberToken[] = [];
  if (FOREIGN_DIGIT.test(normalized) || ROMAN_GLYPH.test(text))
    numbers.push({ value: NaN, unit: '', start: 0, end: 0 });
  for (const match of normalized.matchAll(pattern)) {
    const { amount = '', currency, unit, scale } = match.groups ?? {};
    // Ordinary pronouns/adjectives ("no one", "one-time") are qualitative.
    if (amount.toLowerCase() === 'one' && !unit && !currency && !scale)
      continue;
    const raw = amount.replaceAll(',', '').replace(/(?:st|nd|rd|th)$/i, '');
    const value = /^double/i.test(amount)
      ? 2
      : /^[+\-.\d]/.test(raw)
        ? Number(raw)
        : wordValue(amount);
    numbers.push({
      value: value * (scale ? (SCALES[scale.trim().toLowerCase()] ?? 1) : 1),
      unit: normalizeUnit(currency ?? unit ?? ''),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  for (const match of normalized.matchAll(UNPARSEABLE_QUANTITY)) {
    const start = match.index;
    const end = start + match[0].length;
    if (numbers.some((n) => n.start < end && start < n.end)) continue;
    numbers.push({ value: NaN, unit: '', start, end });
  }
  return numbers.sort((a, b) => a.start - b.start);
}

export function textNumbers(text: string): TextNumber[] {
  return numberTokens(text).map(({ value, unit }) => ({ value, unit }));
}

export function billContains(
  value: number,
  unit: string,
  text: string,
): boolean {
  const expectedUnit = normalizeUnit(unit);
  return textNumbers(text).some(
    (number) => number.value === value && number.unit === expectedUnit,
  );
}
