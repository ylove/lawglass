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

// "(?<![A-Za-z.])" keeps "S." out of "U.S. 113", "U.S.C." and "H.R." out of other initials.
// A trailing ".5", ",5" or "%" means it was a figure, not a bill number.
// Not preceded by a letter, period, section sign or dollar sign, nor by "U. " (spaced reporter
// abbreviations: "347 U. S. 483", "98 S. Ct.") or a figure ("5 S. 12").
const NOT_AFTER = String.raw`(?<![A-Za-z.§$]|[A-Za-z]\.\s|\d\s)`;
const FEDERAL_DESIGNATOR = String.raw`(H\.\s?R\.|S\.|H\.\s?J\.\s?Res\.|S\.\s?J\.\s?Res\.|H\.\s?Con\.\s?Res\.|S\.\s?Con\.\s?Res\.|H\.\s?Res\.|S\.\s?Res\.)`;
const FEDERAL_BILL = new RegExp(
  String.raw`${NOT_AFTER}${FEDERAL_DESIGNATOR}\s?(\d{1,5})(?![\d]|[.,]\d|%)(?:\s*(?:\(|of\s+the\s+)${ORDINAL}\s+Congress\)?)?`,
  'g',
);
const FEDERAL_WORDS = new RegExp(
  String.raw`\b(House|Senate)\s+Bill\s+(?:No\.\s*)?(\d{1,5})(?![\d]|[.,]\d|%)(?:\s*(?:\(|of\s+the\s+)${ORDINAL}\s+Congress\)?)?`,
  'g',
);
/** "of the 135th General Assembly" or "(135th General Assembly)". */
export const OHIO_SESSION = String.raw`(?:\s+of\s+the\s+${ORDINAL}\s+General\s+Assembly|\s*\(${ORDINAL}\s+General\s+Assembly\))?`;
const OHIO_BILL_ABBR = new RegExp(
  String.raw`${NOT_AFTER}(H\.\s?B\.|S\.\s?B\.)\s?(?:No\.\s*)?(\d{1,5})(?![\d]|[.,]\d|%)${OHIO_SESSION}`,
  'g',
);
const OHIO_BILL_WORDS = new RegExp(
  String.raw`\b(House|Senate)\s+Bill\s+(?:No\.\s*)?(\d{1,5})(?![\d]|[.,]\d|%)${OHIO_SESSION}`,
  'g',
);
// "Senate Bill S1234", "Assembly Bill No. A567"; a bare "S1234" needs three or more digits.
const STATE_WORDS = new RegExp(
  String.raw`\b(Senate|Assembly)\s+Bill\s+(?:No\.\s*)?([SA])?0*(\d{1,5})(?![\d]|[.,]\d|%)`,
  'g',
);
// "S. 1000", "A. 3000", "S1000", "A-3000": a letter alone is too common, so three or more digits
// are required, and a trailing ":digit" or "-digit" means a statute chapter, not a bill.
const STATE_LETTER = new RegExp(
  String.raw`${NOT_AFTER}(?<!\d-)\b([SA])(?:\.\s?|-)?0*(\d{3,5})(?![\w]|[.,:;]\d|-\d|%)`,
  'g',
);

/**
 * An explicit session or year qualifier left over after a mention was parsed ("(134th General
 * Assembly)" on a federal match, "(2021-2022 session)", "of the 2019 Legislature"). It names a
 * session this extractor did not read, so the mention must stay plain text rather than inherit
 * the current document's session.
 */
const LEFTOVER_QUALIFIER = new RegExp(
  String.raw`^\s*(?:\((?=[^)]{0,60}(?:Congress|General\s+Assembly|Legislature|Session|\b(?:19|20)\d{2}\b))|(?:of|in|from)\s+the\s+(?:${ORDINAL}|(?:19|20)\d{2})\b)`,
  'i',
);

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
): BillMention[] {
  const here = currentPlace(ctx);
  const out: BillMention[] = [];
  const push = (m: RegExpMatchArray, citation: string | undefined): void => {
    if (citation === undefined) return;
    const start = m.index ?? 0;
    if (
      LEFTOVER_QUALIFIER.test(
        text.slice(start + m[0].length, start + m[0].length + 80),
      )
    )
      return;
    out.push({ start, end: start + m[0].length, text: m[0], citation });
  };

  for (const m of text.matchAll(FEDERAL_BILL)) {
    const stated = m[3] ? Number(m[3]) : undefined;
    const congress =
      stated ?? (here?.place === 'federal' ? here.session : undefined);
    const type = federalType(m[1] ?? '');
    if (type && congress !== undefined)
      push(m, federalCitation(type, m[2] ?? '', congress));
  }
  for (const m of text.matchAll(FEDERAL_WORDS)) {
    const stated = m[3] ? Number(m[3]) : undefined;
    // Without a stated congress, "House Bill 5" is federal only inside a federal document.
    const congress =
      stated ?? (here?.place === 'federal' ? here.session : undefined);
    const type = m[1] === 'House' ? 'hr' : 's';
    if (congress !== undefined)
      push(m, federalCitation(type, m[2] ?? '', congress));
  }
  const ohio = (m: RegExpMatchArray, chamber: string): void => {
    const given = m[3] ?? m[4];
    const stated = given ? Number(given) : undefined;
    const ga = stated ?? (here?.place === 'ohio' ? here.session : undefined);
    if (ga === undefined || ga < FIRST_OHIO_GA || Number(m[2]) < 1) return;
    const label = /^h/i.test(chamber) ? 'H.B.' : 'S.B.';
    push(
      m,
      `${label} ${String(Number(m[2]))} (${ordinal(ga)} General Assembly)`,
    );
  };
  for (const m of text.matchAll(OHIO_BILL_ABBR)) ohio(m, m[1] ?? '');
  for (const m of text.matchAll(OHIO_BILL_WORDS)) ohio(m, m[1] ?? '');

  if (here?.place === 'new-york' || here?.place === 'new-jersey') {
    const prefix = here.place === 'new-york' ? 'N.Y.' : 'N.J.';
    const add = (m: RegExpMatchArray, letter: string, n: string): void => {
      if (here.session !== undefined && here.session >= MIN_YEAR)
        push(
          m,
          `${prefix} ${letter}${String(Number(n))} (${String(here.session)})`,
        );
    };
    for (const m of text.matchAll(STATE_WORDS)) {
      const letter = (m[2] ?? (m[1] === 'Senate' ? 'S' : 'A')).toUpperCase();
      // "Senate Bill A12" contradicts itself; skip rather than guess.
      if (m[2] && (m[1] === 'Senate') !== (letter === 'S')) continue;
      add(m, letter, m[3] ?? '');
    }
    for (const m of text.matchAll(STATE_LETTER)) add(m, m[1] ?? '', m[2] ?? '');
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
