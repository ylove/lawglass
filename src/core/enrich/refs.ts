import {
  sectionText,
  walkSections,
  type ExternalRef,
  type Section,
} from '../model/index.js';
import {
  ancestry,
  enclosingSection,
  normalizeDesignator,
  normalizeSectionNum,
  type SectionIndex,
} from './section-index.js';

// ---------------------------------------------------------------------------------------
// External references: law outside this document. Listed as "referenced, not loaded".
// ---------------------------------------------------------------------------------------

export interface ExternalMatch {
  start: number;
  end: number;
  text: string;
  citation: string;
  kind: ExternalRef['kind'];
  /** Set for a single Revised Code or charter section, so a document that contains it can link inward. */
  sectionNum?: string;
  /** Finer grouping for `kind: other` refs (charter, city code, general law). */
  category?: ExternalRef['category'];
  /** For charter refs, the city the text names ("Charter of the City of Columbus"), if any. */
  city?: string;
}

export interface ExternalOptions {
  /** `metadata.jurisdiction`. The Ohio Revised Code mapping applies only when this says Ohio. */
  jurisdiction?: string | null | undefined;
}

export function isOhio(jurisdiction: string | null | undefined): boolean {
  return /\bOhio\b/i.test(jurisdiction ?? '');
}

const PAREN = String.raw`\([A-Za-z0-9]+\)`;
const PAREN_LIST = String.raw`(?:${PAREN})+(?:\s*(?:,|and|or)\s*(?:${PAREN})+)*`;
// "division (A)(2) of " before "section 5747.01 of the Revised Code".
const DIVISION_PREFIX = String.raw`(?:(?:divisions?|subdivisions?|subsections?|paragraphs?|clauses?)\s+${PAREN_LIST}\s+(?:of|in)\s+)?`;
const RC_ITEM = String.raw`\d+\.\d+(?:\.\d+)?(?:${PAREN})*`;
const RC_SECTIONS = new RegExp(
  String.raw`${DIVISION_PREFIX}sections?\s+(${RC_ITEM}(?:\s*(?:,\s*(?:and\s+|or\s+)?|\s+(?:and|or|to|through)\s+)${RC_ITEM})*)\s+of\s+the\s+(?:Ohio\s+)?Revised\s+Code`,
  'gi',
);
const RC_CHAPTERS =
  /\bchapters?\s+(\d+(?:\.\d+)?)\.?\s+of\s+the\s+(?:Ohio\s+)?Revised\s+Code/gi;
const USC_TITLE_FIRST =
  /\b(\d{1,2})\s+(?:U\.\s?S\.\s?C\.?|USC)(?:\s+(?:§§?|secs?\.|sections?))?\s*(\d+[A-Za-z0-9]*(?:-\d+[A-Za-z0-9]*)?)/g;
const USC_ITEM = String.raw`\d+[A-Za-z0-9]*(?:\([A-Za-z0-9]+\))*`;
const USC_LIST = String.raw`${USC_ITEM}(?:\s*(?:,\s*(?:and\s+|or\s+)?|\s+(?:and|or|to|through)\s+)${USC_ITEM})*`;
const USC_CODE = String.raw`(?:United\s+States\s+Code|U\.\s?S\.\s+Code|U\.\s?S\.\s?C\.)`;
const USC_SECTION_FIRST = new RegExp(
  String.raw`\bsections?\s+(${USC_LIST})\s+of\s+title\s+(\d{1,2})\s*,?\s+${USC_CODE}`,
  'gi',
);
// "title 5, United States Code, section 552"
const USC_TITLE_SECTION = new RegExp(
  String.raw`\btitle\s+(\d{1,2})\s*,?\s+${USC_CODE},?\s+sections?\s+(${USC_LIST})`,
  'gi',
);
const IRC =
  /\bsections?\s+(\d+[A-Za-z]?)(?:\([A-Za-z0-9]+\))*\s+of\s+the\s+Internal\s+Revenue\s+Code(?:\s+of\s+19\d\d)?/gi;
// Case-sensitive on purpose: "of the Social Security Act", never "of this act".
const NAMED_ACT =
  /\bsections?\s+(\d+[A-Za-z]?)(?:\([A-Za-z0-9]+\))*\s+of\s+the\s+((?:[A-Z][A-Za-z'’-]*\s+){1,6}Act(?:\s+of\s+\d{4})?)/g;
const PUBLIC_LAW =
  /\b(?:Public\s+Law|Pub\.\s*L\.|P\.\s*L\.)\s*(?:No\.\s*)?(\d{1,3})\s*[-–]\s*(\d{1,4})/gi;
// "H.B. 110 of the 134th General Assembly": another enactment's section, never ours.
const BILL_SECTION =
  /\bsections?\s+(\d+[A-Za-z]?)(?:\([A-Za-z0-9]+\))*\s+of\s+(?:(?:Am\.|Sub\.|Substitute|Amended)\s+)*(H\.?\s?B\.?|S\.?\s?B\.?|House\s+Bill|Senate\s+Bill)\s*(?:No\.\s*)?(\d+)(?:\s+of\s+the\s+(\d+)(?:st|nd|rd|th)\s+General\s+Assembly)?/gi;
const CFR =
  /\b(\d{1,2})\s+C\.?\s?F\.?\s?R\.?\s*(?:(?:parts?|§§?|sections?)\s*)?(\d+(?:\.\d+)?(?:-\d+)?)/gi;

// Charter and local-code references. All "Charter"/"Code" words are matched case-sensitively
// where a lowercase use ("the charter school", "building code") would be a false positive.
const CITY_NAME = String.raw`[A-Z][a-z]+(?:\s[A-Z][a-z]+)?`;
const CHARTER_NUM = String.raw`\d+(?:[-.]\d+)*[A-Za-z]?`;
const CHARTER_NUM_LIST = String.raw`${CHARTER_NUM}(?:\s*(?:,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+)${CHARTER_NUM})*`;
const CHARTER_OF_CITY = String.raw`Charter\s+of\s+the\s+City\s+of\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)`;
const CHARTER_NAME = String.raw`(?:(${CITY_NAME})\s+)?[Cc]ity\s+[Cc]harter`;
/** "Section 3 of the City Charter", "Sections 3 and 46-3 of the Charter of the City of Columbus". */
const CHARTER_SECTIONS = new RegExp(
  String.raw`\b[Ss]ections?\s+(${CHARTER_NUM_LIST})\s+of\s+the\s+(?:${CHARTER_OF_CITY}|${CHARTER_NAME}|[Cc]harter(?!\s+(?:school|township)))`,
  'g',
);
const CHARTER_PLAIN = new RegExp(
  String.raw`\b(?:the\s+)?(?:${CHARTER_OF_CITY}|${CHARTER_NAME})\b|\bthe\s+Charter\b`,
  'g',
);
const LOCAL_CODE_NAME = String.raw`(?:(${CITY_NAME})\s+)?(?:City|Municipal)\s+Code`;
// "Columbus City Code Section 1234.56" and "Section 1234.56 of the Columbus City Code".
const LOCAL_CODE_AFTER = new RegExp(
  String.raw`\b${LOCAL_CODE_NAME},?\s+(?:[Ss]ections?|[Ss]ec\.|§§?)\s*(\d+(?:\.\d+)*)`,
  'g',
);
const LOCAL_CODE_BEFORE = new RegExp(
  String.raw`\b[Ss]ections?\s+(\d+(?:\.\d+)*)\s+of\s+the\s+${LOCAL_CODE_NAME}`,
  'g',
);
// Words that can start a sentence directly before "City Code" and are not a city name.
const NOT_A_CITY = new Set(
  'the this such a an of in and or see under per pursuant to for by with as at from if'.split(
    ' ',
  ),
);
const BARE_RC = new RegExp(
  String.raw`\bR\.\s?C\.\s*(?:§§?\s*)?(\d+\.\d+(?:\.\d+)?)(?:${PAREN})*`,
  'g',
);
const GENERAL_ELECTION_LAWS =
  /\bthe\s+general\s+election\s+laws\s+of\s+(?:this\s+state|the\s+state(?:\s+of\s+Ohio)?)/gi;

/** A captured city name, minus a sentence-initial "The"/"This" that the pattern swallowed. */
function cleanCity(raw: string | undefined): string | undefined {
  const words = (raw ?? '').split(/\s+/).filter(Boolean);
  while (words.length > 0 && NOT_A_CITY.has((words[0] ?? '').toLowerCase()))
    words.shift();
  return words.length > 0 ? words.join(' ') : undefined;
}

export function charterName(city: string | undefined): string {
  return city === undefined ? 'City Charter' : `${city} City Charter`;
}

function uscCitations(list: string, title: string): string[] {
  const items = [...list.matchAll(/(\d+[A-Za-z0-9]*)(?:\([A-Za-z0-9]+\))*/g)];
  const out: string[] = [];
  let rangeFrom: number | undefined;
  items.forEach((item, i) => {
    const num = item[1] ?? '';
    const prev = items[i - 1];
    const between = prev
      ? list.slice(prev.index + prev[0].length, item.index)
      : '';
    if (rangeFrom !== undefined && /\b(?:to|through)\b/i.test(between)) {
      const from = items[rangeFrom]?.[1] ?? '';
      out[out.length - 1] = `${title} U.S.C. ${from} to ${num}`;
      rangeFrom = undefined;
      return;
    }
    rangeFrom = i;
    out.push(`${title} U.S.C. ${num}`);
  });
  return out;
}

function rcCitations(
  list: string,
): { citation: string; sectionNum?: string }[] {
  const items = [
    ...list.matchAll(new RegExp(`(\\d+\\.\\d+(?:\\.\\d+)?)(?:${PAREN})*`, 'g')),
  ];
  const out: { citation: string; sectionNum?: string }[] = [];
  let rangeFrom: number | undefined;
  items.forEach((item, i) => {
    const num = item[1] ?? '';
    const before =
      i === 0
        ? ''
        : list.slice(
            (items[i - 1]?.index ?? 0) + (items[i - 1]?.[0].length ?? 0),
            item.index,
          );
    if (rangeFrom !== undefined && /\b(?:to|through)\b/i.test(before)) {
      const from = out[rangeFrom];
      if (from) {
        out[rangeFrom] = { citation: `${from.citation} to ${num}` };
        return;
      }
    }
    rangeFrom = out.length;
    out.push({ citation: `R.C. ${num}`, sectionNum: num });
  });
  return out;
}

/** Every external citation in `text`, left to right, longest match winning on overlap. */
export function findExternalMatches(
  text: string,
  options: ExternalOptions = {},
): ExternalMatch[] {
  const found: ExternalMatch[] = [];
  const add = (
    m: RegExpMatchArray,
    citation: string,
    kind: ExternalRef['kind'],
    sectionNum?: string,
    extra: Pick<ExternalMatch, 'category' | 'city'> = {},
  ): void =>
    void found.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      text: m[0],
      citation,
      kind,
      ...(sectionNum === undefined ? {} : { sectionNum }),
      ...(extra.category === undefined ? {} : { category: extra.category }),
      ...(extra.city === undefined ? {} : { city: extra.city }),
    });

  for (const m of text.matchAll(RC_SECTIONS))
    for (const { citation, sectionNum } of rcCitations(m[1] ?? ''))
      add(m, citation, 'state_code', sectionNum);
  for (const m of text.matchAll(BARE_RC))
    add(m, `R.C. ${m[1] ?? ''}`, 'state_code', m[1]);
  for (const m of text.matchAll(RC_CHAPTERS))
    add(m, `R.C. Chapter ${m[1] ?? ''}`, 'state_code');
  for (const m of text.matchAll(USC_TITLE_FIRST))
    add(m, `${m[1] ?? ''} U.S.C. ${(m[2] ?? '').replace(/-$/, '')}`, 'us_code');
  for (const m of text.matchAll(USC_SECTION_FIRST))
    for (const citation of uscCitations(m[1] ?? '', m[2] ?? ''))
      add(m, citation, 'us_code');
  for (const m of text.matchAll(USC_TITLE_SECTION))
    for (const citation of uscCitations(m[2] ?? '', m[1] ?? ''))
      add(m, citation, 'us_code');
  for (const m of text.matchAll(BILL_SECTION)) {
    const bill = `${/^s/i.test(m[2] ?? '') ? 'S.B.' : 'H.B.'} ${m[3] ?? ''}`;
    const assembly = m[4] ? ` (${m[4]}th General Assembly)` : '';
    add(m, `${bill}${assembly} § ${m[1] ?? ''}`, 'other');
  }
  for (const m of text.matchAll(IRC))
    add(m, `26 U.S.C. ${m[1] ?? ''}`, 'us_code');
  for (const m of text.matchAll(NAMED_ACT))
    add(m, `${(m[2] ?? '').trim()} § ${m[1] ?? ''}`, 'other');
  for (const m of text.matchAll(PUBLIC_LAW))
    add(m, `Public Law ${m[1] ?? ''}-${m[2] ?? ''}`, 'public_law');
  for (const m of text.matchAll(CFR))
    add(m, `${m[1] ?? ''} CFR ${m[2] ?? ''}`, 'cfr');
  for (const m of text.matchAll(CHARTER_SECTIONS)) {
    const city = cleanCity(m[2] ?? m[3]);
    for (const raw of (m[1] ?? '').match(new RegExp(CHARTER_NUM, 'g')) ?? []) {
      const num = normalizeSectionNum(raw) ?? raw;
      add(m, `${charterName(city)} § ${num}`, 'other', num, {
        category: 'charter',
        ...(city === undefined ? {} : { city }),
      });
    }
  }
  for (const m of text.matchAll(CHARTER_PLAIN)) {
    const city = cleanCity(m[1] ?? m[2]);
    add(m, charterName(city), 'other', undefined, {
      category: 'charter',
      ...(city === undefined ? {} : { city }),
    });
  }
  for (const pattern of [LOCAL_CODE_AFTER, LOCAL_CODE_BEFORE])
    for (const m of text.matchAll(pattern)) {
      const afterForm = pattern === LOCAL_CODE_AFTER;
      const num = (afterForm ? m[2] : m[1]) ?? '';
      const city = cleanCity(afterForm ? m[1] : m[2]);
      add(
        m,
        `${city === undefined ? '' : `${city} `}City Code § ${num}`,
        'other',
        undefined,
        { category: 'local_code' },
      );
    }
  for (const m of text.matchAll(GENERAL_ELECTION_LAWS))
    add(
      m,
      isOhio(options.jurisdiction)
        ? 'Ohio Revised Code, Title 35'
        : 'State general election laws',
      'other',
      undefined,
      { category: 'general_law' },
    );

  // A span claimed by an earlier/longer pattern is not re-reported (e.g. "section 3 of the
  // Internal Revenue Code" would otherwise also look like a named Act). Multi-citation
  // matches share a span, so they are kept together.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: ExternalMatch[] = [];
  let claimed: { start: number; end: number } | undefined;
  for (const match of found) {
    const sameSpan =
      claimed?.start === match.start && claimed.end === match.end;
    if (claimed && !sameSpan && match.start < claimed.end) continue;
    if (!sameSpan) claimed = { start: match.start, end: match.end };
    kept.push(match);
  }
  return kept;
}

/**
 * External refs for the whole document, deduped by citation. A Revised Code section that is
 * itself part of this document (an amending bill reprints it) is loaded, so it becomes an
 * internal ref instead.
 */
export function collectExternalRefs(
  sections: readonly Section[],
  index: SectionIndex,
  existing: readonly ExternalRef[] = [],
  options: ExternalOptions = {},
): ExternalRef[] {
  const byCitation = new Map<string, ExternalRef>();
  const addRef = (ref: ExternalRef): void => {
    const current = byCitation.get(ref.citation);
    if (!current) {
      byCitation.set(ref.citation, { ...ref, sectionIds: [...ref.sectionIds] });
      return;
    }
    for (const id of ref.sectionIds)
      if (!current.sectionIds.includes(id)) current.sectionIds.push(id);
  };
  existing.forEach(addRef);
  const hits: { match: ExternalMatch; sectionId: string }[] = [];
  for (const section of walkSections(sections)) {
    const text = sectionText(section, { includeDeleted: false });
    for (const match of findExternalMatches(text, options)) {
      if (
        match.sectionNum !== undefined &&
        index.bySectionNum.has(match.sectionNum)
      )
        continue;
      hits.push({ match, sectionId: section.id });
    }
  }
  // One document has one charter: a bare "the City Charter" is the same charter as a named
  // "Columbus City Charter" elsewhere in it, so both are listed under the named citation.
  const city = hits.find((h) => h.match.city !== undefined)?.match.city;
  for (const { match, sectionId } of hits) {
    const unnamed = match.category === 'charter' && match.city === undefined;
    const citation =
      unnamed && city !== undefined
        ? match.citation.replace(/^City Charter/, charterName(city))
        : match.citation;
    addRef({
      text: match.text,
      citation,
      kind: match.kind,
      ...(match.category === undefined ? {} : { category: match.category }),
      sectionIds: [sectionId],
    });
  }
  return [...byCitation.values()];
}

// ---------------------------------------------------------------------------------------
// Internal references: resolved to section ids of this document.
// ---------------------------------------------------------------------------------------

const NUM_ITEM = String.raw`\d+(?:\.\d+)*(?:${PAREN})*`;
const SEP = String.raw`(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|to|through)\s+)`;
const SECTION_REF = new RegExp(
  String.raw`\bsections?\s+(${NUM_ITEM}(?:${SEP}${NUM_ITEM})*)`,
  'gi',
);
const SUB_REF = new RegExp(
  String.raw`\b(?:subsections?|paragraphs?|subparagraphs?|divisions?|subdivisions?|clauses?)\s+((?:${PAREN})+(?:${SEP}(?:${PAREN})+)*)`,
  'gi',
);
type Tail =
  | { kind: 'this'; unit: string }
  | { kind: 'section'; num: string }
  /** "of such Act", "of Public Law ...", "of title 18", "of chapter 5", "of the ...". */
  | { kind: 'foreign' }
  | { kind: 'none' };

/**
 * What a reference points into, read from the words after it. Only a tail that says "this ..."
 * (or names one of our own sections) keeps it internal; any other "of <something>" points at
 * a different law, which this document does not contain.
 */
function tailOf(after: string): Tail & { length: number } {
  const lead = /^\s*,?\s*(of|in)\s+/i.exec(after);
  if (!lead) return { kind: 'none', length: 0 };
  const rest = after.slice(lead[0].length);
  const mine = /^this\s+([a-z]+)/i.exec(rest);
  if (mine)
    return {
      kind: 'this',
      unit: mine[1] ?? '',
      length: lead[0].length + mine[0].length,
    };
  const section = new RegExp(String.raw`^sections?\s+(${NUM_ITEM})`, 'i').exec(
    rest,
  );
  if (section)
    return {
      kind: 'section',
      num: section[1] ?? '',
      length: lead[0].length + section[0].length,
    };
  if (lead[1]?.toLowerCase() === 'of' || /^the\s/i.test(rest))
    return { kind: 'foreign', length: 0 };
  return { kind: 'none', length: 0 };
}

function mask(
  text: string,
  spans: readonly { start: number; end: number }[],
): string {
  let out = text;
  for (const { start, end } of spans)
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  return out;
}

function child(section: Section, token: string): Section | undefined {
  return section.children.find(
    (c) =>
      (c.num !== undefined && normalizeDesignator(c.num) === token) ||
      (c.num === undefined && c.id.split('/').at(-1) === token),
  );
}

/** Follows designator tokens down from `from`; returns the deepest section reached. */
function descend(
  from: Section,
  tokens: readonly string[],
): Section | undefined {
  let node = from;
  let moved = false;
  for (const token of tokens) {
    const next = child(node, token);
    if (!next) break;
    node = next;
    moved = true;
  }
  return moved ? node : undefined;
}

function designators(text: string): string[] {
  return [...text.matchAll(/\(([A-Za-z0-9]+)\)/g)].map((m) => m[1] ?? '');
}

function listItems(list: string): string[] {
  return list
    .split(new RegExp(SEP, 'i'))
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveSectionItem(
  index: SectionIndex,
  item: string,
): string | undefined {
  const head = /^\d+(?:\.\d+)*/.exec(item)?.[0] ?? '';
  const key = normalizeSectionNum(head);
  const id =
    key === undefined
      ? undefined
      : (index.bySectionNum.get(key) ??
        (index.byId.has(`sec-${key}`) ? `sec-${key}` : undefined));
  const root = id === undefined ? undefined : index.byId.get(id);
  if (!root) return undefined;
  return (descend(root, designators(item)) ?? root).id;
}

function resolveSubItem(
  index: SectionIndex,
  item: string,
  scopes: readonly Section[],
): string | undefined {
  const tokens = designators(item);
  for (const scope of scopes) {
    const hit = descend(scope, tokens);
    if (hit) return hit.id;
  }
  return undefined;
}

/**
 * Internal references in `text` (a chunk's text, written in `fromSectionId`), as section ids
 * in order of appearance. Self-references are dropped. Unresolvable ones are ignored rather
 * than guessed.
 */
export function findInternalRefs(
  text: string,
  fromSectionId: string,
  index: SectionIndex,
): string[] {
  const external = findExternalMatches(text);
  const ids: string[] = [];
  const push = (id: string | undefined): void => {
    if (id !== undefined && id !== fromSectionId && !ids.includes(id))
      ids.push(id);
  };
  // Revised Code sections that this document itself contains are internal links.
  for (const match of external)
    if (match.sectionNum !== undefined) {
      const id = index.bySectionNum.get(match.sectionNum);
      if (id !== undefined) push(id);
    }
  const scrubbed = mask(text, external);
  const chain = ancestry(index, fromSectionId);
  const enclosing = enclosingSection(index, fromSectionId);
  const nearestFirst = [...chain].reverse();

  const found: { at: number; ids: (string | undefined)[] }[] = [];
  // "division (A) of section 3": the section is the scope of the division, not a separate ref.
  const scopeSpans: { start: number; end: number }[] = [];
  for (const m of scrubbed.matchAll(SUB_REF)) {
    const after = m.index + m[0].length;
    const tail = tailOf(text.slice(after));
    if (tail.kind === 'foreign') continue;
    let scopes: Section[] = nearestFirst;
    if (tail.kind === 'section') {
      // "subsection (a) of section 3 of such Act": the section belongs to another law.
      if (tailOf(text.slice(after + tail.length)).kind === 'foreign') {
        scopeSpans.push({ start: after, end: after + tail.length });
        continue;
      }
      scopeSpans.push({ start: after, end: after + tail.length });
      const target = resolveSectionItem(index, tail.num);
      const section = target === undefined ? undefined : index.byId.get(target);
      scopes = section ? [section] : [];
    } else if (tail.kind === 'this') {
      const unit = tail.unit.toLowerCase();
      if (unit === 'section') scopes = enclosing ? [enclosing] : [];
      else if (['act', 'chapter', 'title', 'bill'].includes(unit))
        scopes = [...index.byId.values()].filter(
          (s) => index.parentOf.get(s.id) === undefined,
        );
      // "of this subsection/paragraph/division": nearest-first search already starts there.
    }
    found.push({
      at: m.index,
      ids: listItems(m[1] ?? '').map((item) =>
        resolveSubItem(index, item, scopes),
      ),
    });
  }
  const sectionsOnly = mask(scrubbed, scopeSpans);
  for (const m of sectionsOnly.matchAll(SECTION_REF)) {
    // "of the Internal Revenue Code", "of such Act": someone else's section, not ours. The
    // tail is read from the original text because citations were blanked out of the copy.
    if (tailOf(text.slice(m.index + m[0].length)).kind === 'foreign') continue;
    found.push({
      at: m.index,
      ids: listItems(m[1] ?? '').map((item) => resolveSectionItem(index, item)),
    });
  }
  for (const hit of found.sort((a, b) => a.at - b.at)) hit.ids.forEach(push);
  return ids;
}
