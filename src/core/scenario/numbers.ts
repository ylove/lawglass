const SMALL =
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(
    ' ',
  );
const TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
const WORDS = new Map<string, number>([
  ...SMALL.map((word, value): [string, number] => [word, value]),
  ...TENS.map((word, index): [string, number] => [word, (index + 2) * 10]),
]);

export function normalizeUnit(unit: string): string {
  const lower = unit.toLowerCase().trim();
  if (['$', 'usd', 'dollar', 'dollars'].includes(lower)) return 'usd';
  if (['%', 'percent', 'percentage', 'per cent'].includes(lower))
    return 'percent';
  return lower.replace(/s$/, '');
}

function spelledNumbers(text: string): string {
  const pattern = new RegExp(
    `\\b(?:${[...WORDS.keys()].join('|')})(?:[ -]+(?:${TENS.concat(SMALL).join('|')}))?\\b`,
    'gi',
  );
  let normalized = text.replace(pattern, (phrase) => {
    const parts = phrase.toLowerCase().split(/[ -]+/);
    const first = WORDS.get(parts[0] ?? '') ?? 0;
    const second = parts[1] === undefined ? 0 : (WORDS.get(parts[1]) ?? 0);
    // Only compound tens (twenty-one), not a sequence such as "one two".
    if (parts.length === 2 && (first < 20 || second > 9))
      return phrase.replace(/\b[a-z]+\b/g, (word) => String(WORDS.get(word)));
    return String(first + second);
  });
  normalized = normalized.replace(
    /\b(\d+)\s+hundred(?:\s+and)?(?:\s+(\d+))?\b/gi,
    (_match, hundreds: string, rest: string | undefined) =>
      String(Number(hundreds) * 100 + Number(rest ?? 0)),
  );
  for (const [word, scale] of [
    ['thousand', 1000],
    ['million', 1000000],
    ['billion', 1000000000],
  ] as const) {
    normalized = normalized.replace(
      new RegExp(`\\b(\\d+)\\s+${word}(?:\\s+and)?(?:\\s+(\\d+))?\\b`, 'gi'),
      (_match, amount: string, rest: string | undefined) =>
        String(Number(amount) * scale + Number(rest ?? 0)),
    );
  }
  return normalized;
}

export interface TextNumber {
  value: number;
  unit: string;
}

/** Whole numeric tokens, with common units; never match 5 inside 500 or a section id. */
export function textNumbers(text: string): TextNumber[] {
  const normalized = spelledNumbers(text).replace(
    /(?<=\d),(?=\d{3}(?:\D|$))/g,
    '',
  );
  const pattern =
    /(?<![\w.\-])(?<currency>\$)?(?<value>[+-]?(?:\d+(?:\.\d+)?|\.\d+))(?!\w|\.\d|,\d)(?:[\s-]*(?<unit>%|percent\b|per cent\b|USD\b|dollars?\b|days?\b|years?\b|months?\b|bedrooms?\b|residents?\b|employees?\b|people\b|hours?\b|weeks?\b))?/gi;
  return Array.from(normalized.matchAll(pattern), (match) => ({
    value: Number(match.groups?.value),
    unit: normalizeUnit(match.groups?.currency ?? match.groups?.unit ?? ''),
  }));
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
