/**
 * Sentence splitting for answer text. Shared by the excerpt filter and the rewrite checks, so
 * both agree on where a sentence ends.
 *
 * A sentence ends at . ! ? followed by whitespace or the end, or at a line break (list items).
 * A "." after an abbreviation ("Sec.", "No.", "e.g.", "Dr.") or inside an initialism ("U.S.",
 * "U.S.C.") is not an end: legal answers are full of them, and splitting there would cut a
 * cited sentence in two. Written as a scan, not a regex, so a long run of punctuation costs
 * one pass.
 */

const ABBREVIATIONS = new Set([
  'sec',
  'secs',
  'no',
  'nos',
  'mr',
  'mrs',
  'ms',
  'dr',
  'st',
  'vs',
  'etc',
  'inc',
  'co',
  'corp',
  'jr',
  'sr',
  'art',
  'para',
  'pub',
  'stat',
  'cong',
  'rep',
  'sen',
  'gov',
  'dept',
  'approx',
  'cf',
  'ch',
  'subsec',
  'ss',
]);

/** The word just before index `dot`, including any dots inside it ("U.S.C"). */
function wordBefore(text: string, dot: number): string {
  let i = dot;
  while (i > 0 && !/\s/.test(text[i - 1] ?? ' ')) i -= 1;
  return text.slice(i, dot);
}

function isAbbreviation(word: string): boolean {
  if (word === '') return false;
  if (ABBREVIATIONS.has(word.toLowerCase())) return true;
  // Initialisms: "U.S", "U.S.C", "e.g", "i.e", "a.m". Letters separated by dots.
  const parts = word.split('.');
  return (
    parts.length >= 2 &&
    parts.every((p) => p.length === 1 && /[A-Za-z]/.test(p))
  );
}

const SENTENCE_STARTERS = new Set([
  'the',
  'this',
  'that',
  'these',
  'those',
  'it',
  'a',
  'an',
  'in',
  'each',
  'any',
  'under',
  'if',
  'he',
  'she',
  'they',
  'there',
  'for',
  'some',
  'no',
]);

/**
 * "...in the U.S. The agency..." ends a sentence even though "U.S." is an initialism. Only a
 * dotted initialism followed by an ordinary sentence opener counts; "U.S. Department" does not.
 */
function endsWithInitialism(text: string, dot: number): boolean {
  if (!wordBefore(text, dot).includes('.')) return false;
  const rest = text.slice(dot + 1).trimStart();
  const next = /^[A-Za-z]+/.exec(rest)?.[0] ?? '';
  return (
    next !== '' &&
    SENTENCE_STARTERS.has(next.toLowerCase()) &&
    /^[A-Z]/.test(next)
  );
}

/** Sentences, each keeping its trailing whitespace, so joining them gives the text back exactly. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    let end = -1;
    if (ch === '\n') end = i + 1;
    else if ('.!?'.includes(ch)) {
      let j = i;
      while ('.!?'.includes(text[j + 1] ?? 'x')) j += 1;
      const next = text[j + 1];
      const atBoundary = next === undefined || /\s/.test(next);
      const abbreviation =
        j === i &&
        ch === '.' &&
        isAbbreviation(wordBefore(text, i)) &&
        !endsWithInitialism(text, i);
      if (atBoundary && !abbreviation) end = j + 1;
      i = j;
    }
    i += 1;
    if (end < 0) continue;
    while (end < text.length && /\s/.test(text[end] ?? '')) end += 1;
    out.push(text.slice(start, end));
    start = end;
    i = end;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}
