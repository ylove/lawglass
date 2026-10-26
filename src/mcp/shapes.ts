/**
 * Strict shape checks for the few document-derived values that must appear OUTSIDE the
 * untrusted wrapper (inside `cite`, `ref` and `section`). A heuristic that looks for command
 * words can be phrased around, so these accept only values that look like what they claim to be
 * and are short; anything else is replaced by a neutral label by the caller. Free text (titles,
 * headings, labels, section ids that are not number-shaped) never passes and stays inside the
 * wrapper.
 */
import {
  walkSections,
  type NormalizedDoc,
  type Section,
} from '../core/model/index.js';

/**
 * "H.B. 62", "S. 9001", "HR 1234", "Am. Sub. H.B. 62", "H. Con. Res. 12": up to four designator
 * groups (short capitals, a capitalised abbreviation with a dot, or dotted initials), then a
 * number. Ordinary words fail, so a bill number cannot carry a phrase.
 */
const DESIGNATOR = String.raw`(?:[A-Z]{1,4}|[A-Z][a-z]{1,3}\.|(?:[A-Z]\.){1,4})`;
const BILL_NUMBER = new RegExp(
  String.raw`^${DESIGNATOR}(?: ${DESIGNATOR}){0,3} ?\d{1,6}[A-Za-z]?$`,
);
export function billNumberShape(
  value: string | null | undefined,
): string | undefined {
  const text = value?.trim();
  return text && text.length <= 24 && BILL_NUMBER.test(text) ? text : undefined;
}

const JURISDICTIONS = [
  'United States',
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
  'District of Columbia',
  'Puerto Rico',
  'Guam',
  'American Samoa',
  'U.S. Virgin Islands',
  'Northern Mariana Islands',
] as const;
const JURISDICTION_BY_LOWER = new Map(
  JURISDICTIONS.map((name) => [name.toLowerCase(), name]),
);
/** A jurisdiction from the fixed list, in its canonical spelling, else omitted. */
export function jurisdictionName(
  value: string | null | undefined,
): string | undefined {
  return JURISDICTION_BY_LOWER.get(value?.trim().toLowerCase() ?? '');
}

const ORDINAL = String.raw`\d{1,3}(?:st|nd|rd|th)?`;
const SESSION = new RegExp(
  String.raw`^(?:${ORDINAL}(?: (?:Congress|General Assembly|G\.A\.|Legislature|Session|Regular Session))?(?:, ${ORDINAL} Session)?|\d{4}-\d{4}(?: Regular Sessions?)?)$`,
  'i',
);
/** "119th Congress", "119th CONGRESS, 1st Session", "135th G.A.", "2025-2026 Regular Sessions". */
export function sessionShape(
  value: string | null | undefined,
): string | undefined {
  const text = value?.trim();
  return text && text.length <= 32 && SESSION.test(text) ? text : undefined;
}

const VERSION =
  /^(?:as )?(?:introduced|enrolled|engrossed|reported|passed|amended|signed|vetoed|substituted|reprinted)(?:(?: in (?:the )?|-in-)(?:house|senate|assembly))?(?: \([A-Z]\))?$/i;
/** Common bill stages only ("As Introduced"); any other wording is omitted. */
export function versionShape(
  value: string | null | undefined,
): string | undefined {
  const text = value?.trim();
  return text && text.length <= 40 && VERSION.test(text) ? text : undefined;
}

/**
 * A printed section number: "4", "2901.09", "5747.01a", "101-3", "399-zzzzz". Digits, dots and
 * hyphens, then at most one trailing run of up to five letters: no word can sit between
 * punctuation ("9.Visit.evil.io" fails).
 */
const SECTION_NUM = /^\d[0-9.-]{0,15}[A-Za-z]{0,5}$/;
export function sectionNumShape(
  value: string | null | undefined,
): string | undefined {
  const text = value?.trim();
  return text && SECTION_NUM.test(text) ? text : undefined;
}
/** Roman numerals up to 3999 or one capital letter: the numbers of titles, divisions and parts. */
const ROMAN =
  /^(?=[IVXLCDM])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;
/** The printed number of any level: a section number, a Roman numeral or a single capital. */
export function levelNumberShape(
  value: string | null | undefined,
): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (sectionNumShape(text)) return text;
  return /^[A-Z]$/.test(text) || (text.length <= 8 && ROMAN.test(text))
    ? text
    : undefined;
}

const ROMAN_ANY =
  /^(?=.)m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/i;
/** An enumerator: digits, one or two letters, or a Roman numeral. Never a word. */
function isEnumerator(text: string): boolean {
  return (
    /^(?:\d{1,3}|[A-Za-z]{1,2})$/.test(text) ||
    (text.length <= 8 && ROMAN_ANY.test(text))
  );
}

export const subsectionNumShape = (
  value: string | undefined,
): string | undefined => {
  const inner = /^\((.{1,8})\)$/.exec(value ?? '')?.[1];
  return value && inner && isEnumerator(inner) ? value : undefined;
};

/** One number inside an id: the section-number grammar, or a Roman numeral (title-ii). */
const ID_NUM = /^(?:\d[0-9.-]{0,11}[A-Za-z]{0,5}|[ivxlcdmIVXLCDM]{1,8})$/;
const ID_NUMBERED = /^[a-z]{2,8}-(.+)$/;
const isIdNum = (text: string): boolean =>
  ID_NUM.test(text) && (/^\d/.test(text) || ROMAN_ANY.test(text));

/**
 * Ids the parsers build from numbers ("sec-4/b/2", "sec-5747.01/a"). Every part is a number in
 * the section-number grammar, an enumerator (digits, one or two letters, a Roman numeral) or a
 * level prefix and such a number, so an id cannot carry a word or a sentence.
 */
export function isShapedId(id: string): boolean {
  if (id.length > 40) return false;
  const [first, ...rest] = id.split('/');
  const head = ID_NUMBERED.exec(first ?? '')?.[1];
  if (!head || !isIdNum(head) || rest.length > 5) return false;
  return rest.every((part) => {
    const bare = /^\((.*)\)$/.exec(part)?.[1] ?? part;
    if (isEnumerator(bare)) return true;
    const numbered = ID_NUMBERED.exec(part)?.[1];
    return isIdNum(numbered ?? part);
  });
}

export interface SectionHandles {
  /** The id an agent sees and sends back: the id itself when number-shaped, else `s<n>`. */
  handleOf(id: string): string;
  /** The real id for a handle or a number-shaped id; undefined if neither. */
  idOf(handle: string): string | undefined;
  ordinalOf(id: string): number;
}

/**
 * Opaque handles by depth-first position. The original id of a non-number-shaped section
 * appears only inside the wrapper (see the outline).
 */
export function sectionHandles(
  doc: Pick<NormalizedDoc, 'sections'>,
): SectionHandles {
  const handles = new Map<string, string>();
  const ids = new Map<string, string>();
  const ordinals = new Map<string, number>();
  const byOrdinal = new Map<number, string>();
  let n = 0;
  for (const section of walkSections(doc.sections) as Iterable<Section>) {
    n++;
    ordinals.set(section.id, n);
    byOrdinal.set(n, section.id);
    const handle = isShapedId(section.id) ? section.id : `s${String(n)}`;
    if (!handles.has(section.id)) handles.set(section.id, handle);
    if (!ids.has(handle)) ids.set(handle, section.id);
  }
  return {
    handleOf: (id) => handles.get(id) ?? 's0',
    idOf: (handle) => {
      const byHandle = ids.get(handle);
      if (byHandle) return byHandle;
      // Any cited `s<ordinal>` resolves, even for a section whose id is itself number-shaped.
      const ordinal = /^s([1-9]\d{0,6})$/.exec(handle)?.[1];
      return ordinal === undefined ? undefined : byOrdinal.get(Number(ordinal));
    },
    ordinalOf: (id) => ordinals.get(id) ?? 0,
  };
}
