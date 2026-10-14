/**
 * Hallucination guards for model-extracted bill metadata (issue #20).
 *
 * Every check works on whole tokens, never on squashed substrings: squashing joins words
 * across boundaries ("S. 20" would match inside "S. 202"; "Lee" inside "...to do each...").
 * Each guard returns the value to keep (possibly canonicalised) or null to discard it.
 */

/** Lowercased letter/digit runs. "2025-2026" gives ["2025", "2026"]; "136th" stays whole. */
export function words(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// --- billNumber -------------------------------------------------------------------------

/** Printed prefix forms mapped to one token each. Longer / more specific forms come first. */
const BILL_ALIASES: readonly (readonly [RegExp, string])[] = [
  [/\bs\.?\s*j\.?\s*res(?![a-z])\.?/g, ' sjres '],
  [/\bh\.?\s*j\.?\s*res(?![a-z])\.?/g, ' hjres '],
  [/\bs\.?\s*con\.?\s*res(?![a-z])\.?/g, ' sconres '],
  [/\bh\.?\s*con\.?\s*res(?![a-z])\.?/g, ' hconres '],
  [/\bs\.?\s*res(?![a-z])\.?/g, ' sres '],
  [/\bh\.?\s*res(?![a-z])\.?/g, ' hres '],
  [/\bsenate\s+bill\b/g, ' sb '],
  [/\bhouse\s+bill\b/g, ' hb '],
  [/\bs\.?\s*b(?![a-z])\.?/g, ' sb '],
  [/\bh\.?\s*b(?![a-z])\.?/g, ' hb '],
  [/\bh\.?\s*r(?![a-z])\.?/g, ' hr '],
  [/\bs(?![a-z])\.?(?=\s*\d)/g, ' s '],
];

const CHAMBER_TOKENS = new Set([
  's',
  'sb',
  'hb',
  'hr',
  'sjres',
  'hjres',
  'sconres',
  'hconres',
  'sres',
  'hres',
]);

/** "S. B. No. 113", "Senate Bill 113" and "SB 113" all become ["sb", "113"]. */
function billTokens(s: string): string[] {
  let t = s.toLowerCase().replace(/['’]/g, '');
  for (const [re, to] of BILL_ALIASES) t = t.replace(re, to);
  return words(t).filter((w) => w !== 'no');
}

/** Adjacent (chamber, number) pairs: the unit a bill number is verified by. */
function billPairs(tokens: string[]): string[] {
  const pairs: string[] = [];
  tokens.forEach((tok, i) => {
    const next = tokens[i + 1];
    if (CHAMBER_TOKENS.has(tok) && next !== undefined && /^\d+$/.test(next))
      pairs.push(`${tok} ${next}`);
  });
  return pairs;
}

/** Chamber token and exact number must both appear, adjacent, as whole tokens. */
export function verifyBillNumber(value: string, text: string): boolean {
  const claimed = billTokens(value);
  const pairs = billPairs(claimed);
  if (pairs.length === 0) return false; // no chamber, or no number: cannot be verified
  const source = billTokens(text);
  const sourcePairs = new Set(billPairs(source));
  const sourceNums = new Set(source.filter((t) => /^\d+$/.test(t)));
  return (
    pairs.every((p) => sourcePairs.has(p)) &&
    claimed.filter((t) => /^\d+$/.test(t)).every((n) => sourceNums.has(n))
  );
}

// --- session ----------------------------------------------------------------------------

const NUMERIC_TOKEN = /^\d+(?:st|nd|rd|th)?$/;
const ORDINAL_TOKEN = /^\d+(?:st|nd|rd|th)$/;
const YEAR_TOKEN = /^(?:19|20)\d\d$/;
const BODY_WORDS = new Set(['congress', 'assembly', 'legislature']);
const SESSION_KIND_WORDS = new Set(['regular', 'special', 'extraordinary']);

/**
 * Every number/ordinal must be a whole token of the source. The claim must also be anchored:
 * an ordinal body ("136th General Assembly", "119th Congress") or a year range. A bare
 * "1st" or "119" is therefore never enough, and "1st Session" alone cannot validate anything.
 */
export function verifySession(value: string, text: string): boolean {
  const claimed = words(value);
  const source = new Set(words(text));
  const anchored = claimed.some((tok, i) => {
    if (ORDINAL_TOKEN.test(tok)) {
      // "136th General Assembly": the ordinal is followed by the body name (possibly "General").
      const rest = claimed.slice(i + 1, i + 3);
      return rest.some((w) => BODY_WORDS.has(w));
    }
    const next = claimed[i + 1];
    return YEAR_TOKEN.test(tok) && next !== undefined && YEAR_TOKEN.test(next);
  });
  if (!anchored) return false;
  return claimed.every((tok) => {
    if (NUMERIC_TOKEN.test(tok)) return source.has(tok);
    if (BODY_WORDS.has(tok) || SESSION_KIND_WORDS.has(tok))
      return source.has(tok);
    return true; // filler such as "General", "Session", "of", "the"
  });
}

// --- version ----------------------------------------------------------------------------

/** The claimed version must appear verbatim (modulo case and spacing) as a token sequence. */
export function verifyVersion(value: string, text: string): boolean {
  const claimed = words(value);
  if (claimed.length === 0) return false;
  return containsSequence(words(text), claimed);
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((w, j) => haystack[i + j] === w)) return true;
  }
  return false;
}

// --- title ------------------------------------------------------------------------------

export const TITLE_MIN_OVERLAP = 0.6;

/**
 * At least 60% of the title's tokens must fall inside one contiguous source span (a window a
 * little longer than the title, to tolerate a word or two of difference). Source text may be
 * the official title ("A BILL To amend ...") or the short title ("... may be cited as ...").
 */
export function verifyTitle(value: string, text: string): boolean {
  const claimed = words(value);
  if (claimed.length < 2) return false; // a single word proves nothing
  const source = words(text);
  const windowSize = claimed.length + 2;
  const need = Math.ceil(claimed.length * TITLE_MIN_OVERLAP);
  const counts = new Map<string, number>();
  for (const w of claimed) counts.set(w, (counts.get(w) ?? 0) + 1);
  for (let start = 0; start < source.length; start++) {
    const left = new Map(counts);
    let hit = 0;
    for (const w of source.slice(start, start + windowSize)) {
      const n = left.get(w) ?? 0;
      if (n > 0) {
        left.set(w, n - 1);
        hit++;
      }
    }
    if (hit >= need) return true;
  }
  return false;
}

// --- jurisdiction -----------------------------------------------------------------------

const STATES = [
  'Alabama',
  'Alaska',
  'Arizona',
  'Arkansas',
  'California',
  'Colorado',
  'Connecticut',
  'Delaware',
  'Florida',
  'Georgia',
  'Hawaii',
  'Idaho',
  'Illinois',
  'Indiana',
  'Iowa',
  'Kansas',
  'Kentucky',
  'Louisiana',
  'Maine',
  'Maryland',
  'Massachusetts',
  'Michigan',
  'Minnesota',
  'Mississippi',
  'Missouri',
  'Montana',
  'Nebraska',
  'Nevada',
  'New Hampshire',
  'New Jersey',
  'New Mexico',
  'New York',
  'North Carolina',
  'North Dakota',
  'Ohio',
  'Oklahoma',
  'Oregon',
  'Pennsylvania',
  'Rhode Island',
  'South Carolina',
  'South Dakota',
  'Tennessee',
  'Texas',
  'Utah',
  'Vermont',
  'Virginia',
  'Washington',
  'West Virginia',
  'Wisconsin',
  'Wyoming',
];

export const FEDERAL = 'United States';

const FEDERAL_ALIASES = new Set([
  'united states',
  'united states of america',
  'us',
  'u s',
  'usa',
  'federal',
  'u s federal',
  'united states federal',
  'united states congress',
]);

/** Explicit federal markers; "United States Code" in a bill body does not count. */
const FEDERAL_MARKER =
  /\b(?:united\s+states\s+(?:senate|house\s+of\s+representatives|congress)|u\.\s?s\.\s+(?:senate|house)|(?:senate|house\s+of\s+representatives|congress)\s+of\s+the\s+united\s+states|in\s+the\s+(?:senate|house)\s+of\s+the\s+united\s+states|\d+(?:st|nd|rd|th)\s+congress)\b/i;

function stateMarker(state: string): RegExp {
  const name = state.replace(/ /g, '\\s+');
  // "General Assembly of the State of Ohio", "Legislature of Ohio", "Commonwealth of Virginia".
  return new RegExp(
    `\\b(?:general\\s+assembly|legislature|assembly|senate|house\\s+of\\s+representatives|house|state|commonwealth|people)\\s+of\\s+(?:the\\s+)?(?:(?:state|commonwealth)\\s+of\\s+)?${name}\\b`,
    'i',
  );
}

/**
 * Returns the canonical jurisdiction if the value is a state or federal name AND the text
 * carries an explicit marker for it; otherwise null. A state mentioned in passing (or
 * inferred from "Revised Code") is not a marker.
 */
export function verifyJurisdiction(value: string, text: string): string | null {
  const norm = words(value.replace(/^\s*(?:the\s+)?state\s+of\s+/i, '')).join(
    ' ',
  );
  if (FEDERAL_ALIASES.has(norm)) {
    return FEDERAL_MARKER.test(text) ? FEDERAL : null;
  }
  const state = STATES.find((s) => words(s).join(' ') === norm);
  if (state === undefined) return null;
  return stateMarker(state).test(text) ? state : null;
}

// --- sponsors ---------------------------------------------------------------------------

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'md', 'esq']);
const HONORIFIC =
  /^(?:the\s+)?(?:hon(?:orable)?|rep(?:resentative)?s?|sen(?:ator)?s?|mr|mrs|ms|mx|dr|delegate|del|congressman|congresswoman)\b\.?\s*/i;
export const MIN_SURNAME_LENGTH = 3;

export interface ParsedSponsor {
  surname: string;
  first?: string;
  chamber?: 'senate' | 'house';
}

/** Handles "Rep. John Smith Jr. (D-OH)", "Smith, John" and a bare "Shaheen". */
export function parseSponsor(raw: string): ParsedSponsor | null {
  let s = raw.replace(/\([^)]*\)/g, ' ').replace(/’/g, "'");
  let chamber: ParsedSponsor['chamber'];
  for (;;) {
    const m = HONORIFIC.exec(s.trimStart());
    if (!m) break;
    if (/^(?:the\s+)?sen/i.test(m[0])) chamber = 'senate';
    else if (/^(?:the\s+)?rep/i.test(m[0])) chamber = 'house';
    s = s.trimStart().slice(m[0].length);
  }
  const clean = (part: string): string =>
    part
      .split(/[\s,]+/)
      .map((t) => t.replace(/^\.+|\.+$/g, ''))
      .filter((t) => t.length > 0 && !NAME_SUFFIXES.has(t.toLowerCase()))
      .join(' ');
  let surname: string;
  let first: string | undefined;
  if (s.includes(',')) {
    const [a = '', b = ''] = s.split(',', 2);
    surname = clean(a);
    const given = clean(b).split(' ')[0];
    first = given !== undefined && given !== '' ? given : undefined;
  } else {
    const parts = clean(s).split(' ').filter(Boolean);
    surname = parts.at(-1) ?? '';
    first = parts.length > 1 ? parts[0] : undefined;
  }
  if (!surname) return null;
  const parsed: ParsedSponsor = { surname };
  if (first !== undefined) parsed.first = first;
  if (chamber !== undefined) parsed.chamber = chamber;
  return parsed;
}

/**
 * Where sponsors are printed: everything before the bill body starts. Searching only here
 * keeps a surname in a later section ("Day", "Lee") from vouching for an invented sponsor.
 */
export function sponsorRegion(text: string): string {
  const end = text.search(
    /\bA\s*B\s*I\s*L\s*L\b|\bBE\s+IT\s+ENACTED\b|\bSection\s+1\b/,
  );
  return end > 0 ? text.slice(0, end) : text.slice(0, 1500);
}

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const LETTER = "[\\p{L}\\p{N}'’]";

/** Whole-word match whose first letter is capitalised in the text (so "Day" is not "day"). */
function capitalisedWord(re: RegExp, region: string): boolean {
  for (const m of region.matchAll(re)) {
    const first = m[0].charAt(0);
    if (first !== first.toLowerCase()) return true;
  }
  return false;
}

export function verifySponsor(raw: string, text: string): boolean {
  const p = parseSponsor(raw);
  if (p === null) return false;
  const region = sponsorRegion(text);
  if (p.chamber === 'senate' && !/\bsenat(?:e|or|ors)\b/i.test(region))
    return false;
  if (p.chamber === 'house' && !/\b(?:house|representatives?)\b/i.test(region))
    return false;

  const sur = escapeRe(p.surname);
  const surnameRe = new RegExp(`(?<!${LETTER})${sur}(?!${LETTER})`, 'giu');
  const hasFirst = p.first !== undefined;
  if (p.surname.length < MIN_SURNAME_LENGTH && !hasFirst) return false;
  if (!capitalisedWord(surnameRe, region)) return false;
  if (p.first === undefined) return true;

  // First name (or initial) must sit next to the surname: "Jane Q. Shaheen" or "Shaheen, Jane".
  const first = escapeRe(p.first);
  const firstPart =
    p.first.length === 1 ? `${first}\\.?` : `${first}(?!${LETTER})`;
  const adjacent = new RegExp(
    `(?<!${LETTER})${firstPart}\\s+(?:[\\p{L}]\\.?\\s+){0,2}${sur}(?!${LETTER})|(?<!${LETTER})${sur}\\s*,\\s*${firstPart}`,
    'iu',
  );
  return adjacent.test(region);
}
