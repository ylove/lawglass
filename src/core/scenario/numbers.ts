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
    '\\b(?:twice|thrice|halved|doubled|tripled|quadrupled|lakhs?|crores?|hundredths?|thousandths?)\\b',
    '\\b(?:a|an) (?:first|second|third|\\w+th)s? of\\b',
    '\\bquarters? of\\b',
    // Bare "quarter" as a fraction; "each/every/per quarter" is a period.
    '(?<!\\b(?:each|every|per)[ -])\\bquarter[\\s-]+(?:shares?|portions?|rates?)\\b',
    '\\b\\d+(?:\\.\\d{3})+\\b',
    '\\b0x[0-9a-f]+\\b',
    '\\b(?:halves|thirds|quarters|fourths|fifths|sixths|eighths|tenths)\\b',
  ].join('|'),
  'gi',
);
// Digits from other scripts and Roman-numeral glyphs; NFKC folds some of them to ASCII.
const FOREIGN_DIGIT = /(?![0-9])\p{Nd}/u;
const ORDINAL_WORD =
  /^(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/i;
// Nouns that make an ordinal a label, not a quantity ("third party"). Keep this list short and explicit.
const ORDINAL_NOUNS =
  'party|parties|job|jobs|home|homes|vehicle|vehicles|form|forms|reading|readings|offense|offenses|offence|offences|child|children|house|houses|property|properties|spouse|dependent|dependents|time|times|year|years|place|class|degree|amendment|clause|paragraph|subsection|tier|level|round';
const MONTHS =
  'January|February|March|April|May|June|July|August|September|October|November|December';
const ORDINALS =
  'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth';
// An ordinal is only a label when it is not the tail of a spelled fraction ("one third property tax").
const NOT_SPELLED_FRACTION =
  '(?<!\\b(?:one|two|three|four|five|six|seven|eight|nine|ten)[ -])';
const ORDINAL_LABEL = new RegExp(
  `${NOT_SPELLED_FRACTION}\\b(?:${ORDINALS})\\s+(?:${ORDINAL_NOUNS})\\b`,
  'gi',
);
// Hyphenated compounds common in tax, housing and law ("first-time homebuyer", "third-party
// administrator"). Explicit on purpose: an open "ordinal-anything" rule would hide "first-month rent".
const ORDINAL_COMPOUND_TAILS =
  'time|party|parties|hand|year|quarter|degree|class';
const ORDINAL_COMPOUND = new RegExp(
  `${NOT_SPELLED_FRACTION}\\b(?:${ORDINALS})-(?:${ORDINAL_COMPOUND_TAILS})\\b`,
  'gi',
);
// A date only when introduced by "the"/"on" and the month ends the clause or precedes a year;
// "a third of May taxes" or "the first of January's income" stay fractions.
const ORDINAL_DATE = new RegExp(
  `\\b(?:the|on)\\s+(?:${ORDINALS})\\s+of\\s+(?:${MONTHS})(?=\\s*(?:[.,;:!?)]|$)|\\s+\\d{4}\\b)`,
  'gi',
);
// A number may not continue a word or a decimal (a letter/digit, or digit-then-dot, before it).
// "_" and a bare "." do not shield: "rate_4" and "rate.4" are audited. A hyphen never shields it: after a letter
// ("rate-4 percent") it is a separator, and after a digit ("5-10 days") the range tail is its own
// number. A genuine minus sign is matched by the amount group, which starts at the hyphen.
const NOT_AFTER_WORD_OR_DOT = '(?<![A-Za-z0-9])(?<!\\d\\.)';
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
export function numberTokens(
  text: string,
  options: { ignoreOrdinals?: boolean } = {},
): NumberToken[] {
  const normalized = text
    .normalize('NFKC')
    // "first quarter" is a period of time, not a fraction.
    .replace(/\b(?:first|second|third|fourth)\s+quarter\b/gi, (m) =>
      ' '.repeat(m.length),
    )
    .replace(ORDINAL_DATE, (m) => ' '.repeat(m.length))
    .replace(ORDINAL_COMPOUND, (m) => ' '.repeat(m.length))
    .replace(ORDINAL_LABEL, (m) => ' '.repeat(m.length))
    .replace(
      /\b(?:Section|Sec\.|Form)\s+\d+(?:\.\d+)*\b|§\s*\d+(?:\.\d+)*/gi,
      (match) => ' '.repeat(match.length),
    );
  const pattern = new RegExp(
    `${NOT_AFTER_WORD_OR_DOT}(?<currency>\\$)?(?<amount>[+-]?(?:${DIGITS})(?:e[+-]?\\d+)?(?:st|nd|rd|th)?|${SPELLED}|${[...WORDS.keys()].filter((w) => w.endsWith('th') || ['first', 'second', 'third'].includes(w)).join('|')}|doubles?)(?<scale>\\s*(?:[KMB]\\b|(?:thousand|million|billion)\\b))?(?!\\w|\\.\\d|,\\d)(?:[\\s-]*(?<unit>${UNIT}))?`,
    'gi',
  );
  const numbers: NumberToken[] = [];
  if (FOREIGN_DIGIT.test(normalized) || ROMAN_GLYPH.test(text))
    numbers.push({ value: NaN, unit: '', start: 0, end: 0 });
  for (const match of normalized.matchAll(pattern)) {
    const { amount = '', currency, unit, scale } = match.groups ?? {};
    // Code-validated setup labels ("second job") may use ordinal words.
    if (options.ignoreOrdinals && ORDINAL_WORD.test(amount)) continue;
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
