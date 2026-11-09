// Mentions of other bills ("H.R. 1234", "Senate Bill 5") and the address Lawglass reads each
// from. A bill is not a statute: it can be opened and analyzed like a pasted address, so a
// mention becomes a reference only when exactly one bill is certain. Ambiguity means no link.
//
// A bill reference is an ordinary `kind: 'other'` ExternalRef whose citation encodes the bill
// in one of four fixed shapes, so no contract field is needed:
//   "H.R. 1234 (118th Congress)"        federal; type is H.R., S., H.J.Res., S.J.Res.,
//                                       H.Con.Res., S.Con.Res., H.Res. or S.Res.
//   "H.B. 9001 (135th General Assembly)"  Ohio (H.B., S.B., also H.J.R./S.J.R. never matched)
//   "N.Y. S1234 (2025)"                 New York; the year starts the two-year session
//   "N.J. S1234 (2024)"                 New Jersey; the year starts the two-year session
// `billIngestUrl` turns a citation back into the address the ingest resolvers already accept.

const ORDINAL = String.raw`(\d{1,3})(?:st|nd|rd|th)`;

/** Federal chamber/type designators, as printed in bill text, and their congress.gov slugs. */
const FEDERAL_TYPES: Readonly<Record<string, { label: string; slug: string }>> =
  {
    hr: { label: 'H.R.', slug: 'house-bill' },
    s: { label: 'S.', slug: 'senate-bill' },
    hjres: { label: 'H.J.Res.', slug: 'house-joint-resolution' },
    sjres: { label: 'S.J.Res.', slug: 'senate-joint-resolution' },
    hconres: { label: 'H.Con.Res.', slug: 'house-concurrent-resolution' },
    sconres: { label: 'S.Con.Res.', slug: 'senate-concurrent-resolution' },
    hres: { label: 'H.Res.', slug: 'house-resolution' },
    sres: { label: 'S.Res.', slug: 'senate-resolution' },
  };

/**
 * The oldest congress whose bill status is published as data; the federal resolver needs it
 * to find the latest text.
 */
const FIRST_FEDERAL_CONGRESS = 113;
const FIRST_OHIO_GA = 126;
const MIN_YEAR = 1996;

// Not preceded by a letter, period, section sign or dollar sign (keeps "S." out of "U.S. 113"
// and "U.S.C."), nor by a single capital initial and a space ("347 U. S. 483", "98 S. Ct."), nor
// by a figure ("5 S. 12"). A lone initial, not any abbreviation: "Am. Sub. H.B. 110", "Sub. H.B.
// 166" and "Cf. H.R. 5" must still match. A trailing ".5", ",5" or "%" means a figure.
const NOT_AFTER = String.raw`(?<![A-Za-z.§$]|\b[A-Z]\.\s|\d\s)`;
const NUMBER = String.raw`(\d{1,5})(?![\d]|[.,]\d|%)`;
const FEDERAL_DESIGNATOR = String.raw`(H\.\s?R\.|S\.|H\.\s?J\.\s?Res\.|S\.\s?J\.\s?Res\.|H\.\s?Con\.\s?Res\.|S\.\s?Con\.\s?Res\.|H\.\s?Res\.|S\.\s?Res\.)`;
const FEDERAL_BILL = new RegExp(
  String.raw`${NOT_AFTER}${FEDERAL_DESIGNATOR}\s?${NUMBER}`,
  'g',
);
const OHIO_BILL_ABBR = new RegExp(
  String.raw`${NOT_AFTER}(H\.\s?B\.|S\.\s?B\.)\s?(?:No\.\s*)?${NUMBER}`,
  'g',
);
/** "House Bill 5" names a federal or an Ohio bill; the session decides which. */
const BILL_WORDS = new RegExp(
  String.raw`\b(House|Senate)\s+Bill\s+(?:No\.\s*)?${NUMBER}`,
  'g',
);
// "Senate Bill S1234", "Assembly Bill No. A567"; a bare "S1234" needs three or more digits.
const STATE_WORDS = new RegExp(
  String.raw`\b(Senate|Assembly)\s+Bill\s+(?:No\.\s*)?([SA])?0*${NUMBER}`,
  'g',
);
// "S. 1000", "A. 3000", "S1000", "A-3000": a letter alone is too common, so three or more digits
// are required, a trailing ":digit" or "-digit" means a statute chapter, and a label word before
// it ("Exhibit A-100", "Route S-100", "Part A-1000") means it is not a bill at all.
const LABELS =
  'Exhibit Schedule Form Part Subpart Appendix Route Room Model Type Rule Table Figure Chapter Title Article Section Class Grade Zone Plan Lot Block Unit Suite Policy Level Tier Category Item Annex Attachment Highway Interstate'
    .split(' ')
    .map(
      (word) =>
        `[${word.charAt(0)}${word.charAt(0).toLowerCase()}]${word.slice(1)}`,
    )
    .join('|');
const LABEL_BEFORE = String.raw`(?<!\b(?:${LABELS})s?\s)`;
const STATE_LETTER = new RegExp(
  String.raw`${NOT_AFTER}${LABEL_BEFORE}(?<!\d-)\b([SA])(?:\.\s?|-)?0*(\d{3,5})(?![\w]|[.,:;]\d|-\d|%)`,
  'g',
);

// ---------------------------------------------------------------------------------------
// Sessions. A mention takes its session from, in order: a qualifier right after it, a list
// qualifier after the bills it shares ("H.B. 214, H.B. 250, and S.B. 168, all of the 135th
// General Assembly"), or the current document, but only when its whole sentence has no
// session-like phrase. Anything else stays plain text: a wrong link is worse than none.
// ---------------------------------------------------------------------------------------

const ORDINAL_ANY = String.raw`(\d{1,3}(?:st|nd|rd|th)|One\s+Hundred\s+(?:and\s+)?[A-Za-z]+(?:-[A-Za-z]+)?)`;
const SESSION_NAME = String.raw`(Congress|Cong\.|General\s+Assembly|G\.\s?A\.|GA\b)`;
/** ", 118th Congress", "(118th Cong.)", "of the 134th G.A.", "as enacted by the 133rd General Assembly". */
const QUALIFIER = new RegExp(
  String.raw`^(?:,?\s+of\s+the\s+|\s*\(\s*(?:the\s+)?|,\s*(?:the\s+)?|,?\s+as\s+(?:enacted|passed|adopted)\s+by\s+the\s+|\s+in\s+the\s+)${ORDINAL_ANY}\s+${SESSION_NAME}(?:\s*\))?`,
  'i',
);
const LIST_BILL = String.raw`(?:(?:Am\.|Sub\.|Substitute|Amended)\s+)*(?:H\.\s?B\.|S\.\s?B\.|H\.\s?R\.|S\.|H\.\s?J\.\s?Res\.|S\.\s?J\.\s?Res\.|H\.\s?Con\.\s?Res\.|S\.\s?Con\.\s?Res\.|H\.\s?Res\.|S\.\s?Res\.)\s?(?:No\.\s*)?\d{1,5}`;
/** What follows a list of bills when one qualifier covers them all. */
const LIST_TAIL = new RegExp(
  String.raw`^(?:[\s,]+(?:(?:and|or)\s+)?${LIST_BILL})*[\s,]+(?:all|each|both)\s+of\s+the\s+${ORDINAL_ANY}\s+${SESSION_NAME}`,
  'i',
);
const SESSION_LIKE = new RegExp(
  // A Public Law number ("Public Law 117-58") also names a congress.
  String.raw`\b(?:Congress|Cong\b|General\s+Assembly|G\.\s?A\b|GA|Legislature|Sessions?|One\s+Hundred)\b|\b(?:19|20)\d{2}\s*[-–]\s*(?:19|20)?\d{2}\b|\b(?:Public\s+Law|Pub\.\s*L\.|P\.\s*L\.)\s*(?:No\.\s*)?\d{1,3}\s*[-–]`,
  'i',
);
/**
 * A qualifier the parsers above did not read, e.g. "H.R. 5 in the 117th". Only matters for a
 * mention that would inherit the document's session.
 */
const LEFTOVER_QUALIFIER = new RegExp(
  String.raw`^\s*(?:\((?=[^)]{0,60}(?:Congress|General\s+Assembly|Legislature|Session|\b(?:19|20)\d{2}\b))|(?:of|in|from)\s+the\s+(?:${ORDINAL}|(?:19|20)\d{2})\b)`,
  'i',
);

const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
};
const TENS_WORDS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30 };

/** "118th" or "One Hundred Eighteenth" as a number, or undefined. */
function parseOrdinal(raw: string): number | undefined {
  const numeric = /^(\d{1,3})(?:st|nd|rd|th)$/i.exec(raw);
  if (numeric) return Number(numeric[1]);
  const words = raw
    .toLowerCase()
    .replace(/^one\s+hundred\s+(?:and\s+)?/, '')
    .split(/[\s-]+/);
  const [first, second] = words;
  if (words.length === 1 && first && first in ORDINAL_WORDS)
    return 100 + (ORDINAL_WORDS[first] ?? 0);
  if (
    words.length === 2 &&
    first &&
    second &&
    first in TENS_WORDS &&
    second in ORDINAL_WORDS
  )
    return 100 + (TENS_WORDS[first] ?? 0) + (ORDINAL_WORDS[second] ?? 0);
  return undefined;
}

/** Words whose final period does not end a sentence. */
const ABBREVIATIONS = new Set(
  'sub am cong sess stat supp rept rep sen res sec subsec sect secs inc art vol ann rev amd adm admin dept govt fed reg ch cl pub jr sr mr ms mrs messrs mmes dr gov hon gen comm st co corp div prof rec const ord no nos vs cf ed ct'.split(
    ' ',
  ),
);

/**
 * Where sentences end, found in one pass: `ends[i]` is the index just past a sentence's final
 * period and `starts[i]` the index of the next sentence's first letter. A period ends a
 * sentence when a capital follows and it closes a word that is not a known abbreviation. A
 * short capitalized word ("Mr", "Act") is not trusted to end one either, so a doubtful split
 * keeps the sentence longer, which only ever makes inheriting the document's session rarer.
 *
 * Known limit: a session named in an EARLIER sentence ("The following bills of the 118th
 * Congress are cited. H.R. 5.") is not seen; such text is rare and the mention would take
 * the document's session.
 */
function sentenceBoundaries(text: string): {
  ends: number[];
  starts: number[];
} {
  const ends: number[] = [];
  const starts: number[] = [];
  for (const m of text.matchAll(/\.\s+(?=[A-Z])/g)) {
    const period = m.index;
    // The word the period ends: letters going back, or a digit or ")" for a figure.
    let wordStart = period;
    while (wordStart > 0 && /[A-Za-z]/.test(text.charAt(wordStart - 1)))
      wordStart--;
    const word = text.slice(wordStart, period);
    const endsWord = word.length >= 2 || /[\d)]/.test(text.charAt(period - 1));
    const shortCapitalized = word.length <= 4 && /^[A-Z]/.test(word);
    if (!endsWord || shortCapitalized || ABBREVIATIONS.has(word.toLowerCase()))
      continue;
    ends.push(period + 1);
    starts.push(period + m[0].length);
  }
  return { ends, starts };
}

/** Index of the first element of the sorted `values` greater than `target` (or the length). */
function firstAbove(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((values[mid] ?? 0) > target) high = mid;
    else low = mid + 1;
  }
  return low;
}

type Family = 'federal' | 'ohio';
interface Resolved {
  session: number;
  /** Undefined when inherited by a New York or New Jersey document, whose bills are not these. */
  family: Family | undefined;
  /** End of the mention, including a qualifier that was read. */
  end: number;
  /** True when no session was stated and the document's own was taken. */
  inherited: boolean;
}

const familyOf = (name: string): Family =>
  /^con/i.test(name) ? 'federal' : 'ohio';

export interface BillMention {
  start: number;
  end: number;
  text: string;
  /** Canonical citation, parseable by `billIngestUrl`. */
  citation: string;
}

export interface BillContext {
  /** `metadata.jurisdiction`. */
  jurisdiction?: string | null | undefined;
  /** `metadata.session`, e.g. "118th Congress, 1st Session" or "2025-2026 Regular Sessions". */
  session?: string | null | undefined;
  /** `metadata.billNumber`; a mention of the document's own bill is not a reference. */
  billNumber?: string | null | undefined;
  /**
   * Bills the whole document states a session for (see `statedBills`), keyed by bill without
   * session. A bare repeat in another section then reuses that session.
   */
  statedBills?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
}

const ordinal = (n: number): string => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${String(n)}${teen ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
};

type Place = 'federal' | 'ohio' | 'new-york' | 'new-jersey';

/** Which place the document itself belongs to, and the session it states for it. */
function currentPlace(
  ctx: BillContext,
): { place: Place; session?: number } | undefined {
  const where = ctx.jurisdiction ?? '';
  const session = ctx.session ?? '';
  if (/\bUnited States\b/i.test(where)) {
    const n = new RegExp(`${ORDINAL}\\s+Congress`, 'i').exec(session)?.[1];
    return n ? { place: 'federal', session: Number(n) } : undefined;
  }
  if (/\bOhio\b/i.test(where)) {
    const n = new RegExp(`${ORDINAL}\\s+General\\s+Assembly`, 'i').exec(
      session,
    )?.[1];
    return n ? { place: 'ohio', session: Number(n) } : undefined;
  }
  if (where === 'New York') {
    const y = /\b((?:19|20)\d{2})\s*[-–]\s*(?:19|20)\d{2}\b/.exec(session)?.[1];
    return y ? { place: 'new-york', session: Number(y) } : undefined;
  }
  if (where === 'New Jersey') {
    const n = /\b(\d{3})(?:st|nd|rd|th)\b/.exec(session)?.[1];
    // The 207th Legislature began in 1996; each lasts two years.
    return n
      ? { place: 'new-jersey', session: 1996 + (Number(n) - 207) * 2 }
      : undefined;
  }
  return undefined;
}

function federalType(designator: string): string | undefined {
  const key = designator.replace(/[\s.]/g, '').toLowerCase();
  return key in FEDERAL_TYPES ? key : undefined;
}

function federalCitation(
  type: string,
  number: string,
  congress: number,
): string | undefined {
  if (congress < FIRST_FEDERAL_CONGRESS || Number(number) < 1) return undefined;
  return `${FEDERAL_TYPES[type]?.label ?? ''} ${String(Number(number))} (${ordinal(congress)} Congress)`;
}

/**
 * Every unambiguous bill mention in `text`. "S. 5" is a Senate bill only when a congress is
 * stated beside it or the document is itself a federal bill; "H.B. 9" only for Ohio, and so on.
 */
export function findBillMentions(
  text: string,
  ctx: BillContext = {},
  mode: 'all' | 'stated' = 'all',
): BillMention[] {
  const here = currentPlace(ctx);
  let bounds: ReturnType<typeof sentenceBoundaries> | undefined;
  /** The sentence around [start, end), with boundaries computed once per call. */
  const sentenceAround = (start: number, end: number): string => {
    bounds ??= sentenceBoundaries(text);
    const before = firstAbove(bounds.starts, start) - 1;
    const from = before >= 0 ? (bounds.starts[before] ?? 0) : 0;
    const to = bounds.ends[firstAbove(bounds.ends, end)] ?? text.length;
    return text.slice(from, to);
  };
  // Pass 1 reads only mentions that state their own session; pass 2 may also inherit, and a
  // bare repeat of a bill the text states elsewhere takes that stated session.
  const stated = scan(undefined);
  if (mode === 'stated') return stated;
  const known = new Map<string, Set<string>>();
  for (const [key, citations] of ctx.statedBills ?? [])
    known.set(key, new Set(citations));
  for (const mention of stated) {
    const key = mention.citation.replace(/ \(.*$/, '');
    known.set(key, (known.get(key) ?? new Set()).add(mention.citation));
  }
  return scan(known);

  function scan(known: Map<string, Set<string>> | undefined): BillMention[] {
    const out: BillMention[] = [];

    /** The session of the bill matched by `m`, or undefined when it cannot be known for sure. */
    const resolve = (m: RegExpMatchArray): Resolved | undefined => {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const rest = text.slice(end, end + 300);
      const direct = QUALIFIER.exec(rest);
      const given = direct ?? LIST_TAIL.exec(rest);
      if (given) {
        const groups = given.slice(-2);
        const session = parseOrdinal(groups[0] ?? '');
        if (session === undefined) return undefined;
        return {
          session,
          family: familyOf(groups[1] ?? ''),
          // A list qualifier belongs to the whole list, so this mention ends where it did.
          end: direct ? end + direct[0].length : end,
          inherited: false,
        };
      }
      // Inheriting the document's session is safe only when nothing nearby names another one.
      if (!known) return undefined;
      if (SESSION_LIKE.test(sentenceAround(start, end))) return undefined;
      if (LEFTOVER_QUALIFIER.test(rest)) return undefined;
      if (here?.session === undefined) return undefined;
      const family =
        here.place === 'federal' || here.place === 'ohio'
          ? here.place
          : undefined;
      return { session: here.session, family, end, inherited: true };
    };

    const push = (
      m: RegExpMatchArray,
      resolved: Resolved,
      citation: string | undefined,
    ): void => {
      if (citation === undefined) return;
      const start = m.index ?? 0;
      if (resolved.inherited && known) {
        // The text states this very bill's session elsewhere: use it, or stay plain if it states two.
        const sessions = known.get(citation.replace(/ \(.*$/, ''));
        if (sessions) {
          const only = sessions.size === 1 ? [...sessions][0] : undefined;
          if (only === undefined) return;
          citation = only;
        }
      }
      out.push({
        start,
        end: resolved.end,
        text: text.slice(start, resolved.end),
        citation,
      });
    };

    const federal = (m: RegExpMatchArray, type: string | undefined): void => {
      const r = resolve(m);
      // A federal bill, whether stated or inherited from a federal document.
      if (!r || !type || r.family !== 'federal') return;
      push(m, r, federalCitation(type, m[2] ?? '', r.session));
    };
    for (const m of text.matchAll(FEDERAL_BILL))
      federal(m, federalType(m[1] ?? ''));

    const ohio = (m: RegExpMatchArray, chamber: string): void => {
      const r = resolve(m);
      if (r?.family !== 'ohio') return;
      if (r.session < FIRST_OHIO_GA || Number(m[2]) < 1) return;
      const label = /^h/i.test(chamber) ? 'H.B.' : 'S.B.';
      push(
        m,
        r,
        `${label} ${String(Number(m[2]))} (${ordinal(r.session)} General Assembly)`,
      );
    };
    for (const m of text.matchAll(OHIO_BILL_ABBR)) ohio(m, m[1] ?? '');
    for (const m of text.matchAll(BILL_WORDS)) {
      const chamber = m[1] ?? '';
      const r = resolve(m);
      if (!r) continue;
      if (r.family === 'federal') federal(m, chamber === 'House' ? 'hr' : 's');
      else ohio(m, chamber);
    }

    if (here?.place === 'new-york' || here?.place === 'new-jersey') {
      const prefix = here.place === 'new-york' ? 'N.Y.' : 'N.J.';
      const add = (m: RegExpMatchArray, letter: string, n: string): void => {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        const rest = text.slice(end, end + 300);
        // These bills belong to the document's own session; a stated one is another matter.
        if (!known || QUALIFIER.test(rest) || LIST_TAIL.test(rest)) return;
        if (SESSION_LIKE.test(sentenceAround(start, end))) return;
        if (LEFTOVER_QUALIFIER.test(rest)) return;
        if (here.session === undefined || here.session < MIN_YEAR) return;
        push(
          m,
          { session: here.session, family: undefined, end, inherited: false },
          `${prefix} ${letter}${String(Number(n))} (${String(here.session)})`,
        );
      };
      for (const m of text.matchAll(STATE_WORDS)) {
        const letter = (m[2] ?? (m[1] === 'Senate' ? 'S' : 'A')).toUpperCase();
        // "Senate Bill A12" contradicts itself; skip rather than guess.
        if (m[2] && (m[1] === 'Senate') !== (letter === 'S')) continue;
        add(m, letter, m[3] ?? '');
      }
      for (const m of text.matchAll(STATE_LETTER))
        add(m, (m[1] ?? '').toUpperCase(), m[2] ?? '');
    }

    // A span claimed by an earlier, longer match is reported once ("Senate Bill S1234").
    out.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: BillMention[] = [];
    let until = -1;
    for (const mention of out) {
      if (mention.start < until) continue;
      kept.push(mention);
      until = mention.end;
    }
    return kept;
  }
}

const FEDERAL_CITATION =
  /^(H\.R\.|S\.|H\.J\.Res\.|S\.J\.Res\.|H\.Con\.Res\.|S\.Con\.Res\.|H\.Res\.|S\.Res\.) (\d{1,5}) \((\d{1,3})(?:st|nd|rd|th) Congress\)$/;
const OHIO_CITATION =
  /^(H|S)\.B\. (\d{1,5}) \((\d{1,3})(?:st|nd|rd|th) General Assembly\)$/;
const STATE_CITATION = /^N\.(Y|J)\. ([SA]\d{1,5}) \(((?:19|20)\d{2})\)$/;

/**
 * The address that opens this bill in Lawglass, one the ingest resolvers already accept, or
 * undefined when the citation is not a bill.
 */
export function billIngestUrl(citation: string): string | undefined {
  const text = citation.trim();
  const fed = FEDERAL_CITATION.exec(text);
  if (fed) {
    const type = Object.values(FEDERAL_TYPES).find((t) => t.label === fed[1]);
    return type
      ? `https://www.congress.gov/bill/${ordinal(Number(fed[3]))}-congress/${type.slug}/${fed[2] ?? ''}`
      : undefined;
  }
  const ohio = OHIO_CITATION.exec(text);
  if (ohio)
    return `https://www.legislature.ohio.gov/legislation/${ohio[3] ?? ''}/${ohio[1] === 'H' ? 'hb' : 'sb'}${ohio[2] ?? ''}`;
  const state = STATE_CITATION.exec(text);
  if (state)
    return state[1] === 'Y'
      ? `https://www.nysenate.gov/legislation/bills/${state[3] ?? ''}/${state[2] ?? ''}`
      : `https://www.njleg.state.nj.us/bill-search/${state[3] ?? ''}/${state[2] ?? ''}`;
  return undefined;
}

/**
 * An Ohio bill named with its General Assembly stated beside it. Section-qualified mentions
 * ("section 5 of H.B. 110 of the 134th General Assembly") use this so they share one citation
 * shape with plain mentions; without a stated assembly there is no identity.
 */
export function ohioBillCitation(
  chamber: string,
  number: string,
  assembly: string | undefined,
): string | undefined {
  const ga = Number(assembly);
  if (!assembly || ga < FIRST_OHIO_GA || Number(number) < 1) return undefined;
  const label = /^h/i.test(chamber) ? 'H.B.' : 'S.B.';
  return `${label} ${String(Number(number))} (${ordinal(ga)} General Assembly)`;
}

/** The citation of the document's own bill, or undefined when its identity is not certain. */
export function selfBillCitation(ctx: BillContext): string | undefined {
  // Amendment letters ("S1234A") are versions of the same bill.
  const number = (ctx.billNumber ?? '').trim().replace(/(\d)[A-Z]$/, '$1');
  if (!number) return undefined;
  return findBillMentions(number, { ...ctx, billNumber: undefined })[0]
    ?.citation;
}

/** Which sessions the given texts state for each bill, keyed by the bill without its session. */
export function statedBills(
  texts: Iterable<string>,
  ctx: BillContext,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const text of texts)
    for (const mention of findBillMentions(
      text,
      { ...ctx, statedBills: undefined },
      'stated',
    )) {
      const key = mention.citation.replace(/ \(.*$/, '');
      map.set(key, (map.get(key) ?? new Set()).add(mention.citation));
    }
  return map;
}
