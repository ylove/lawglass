import {
  walkSections,
  type ExternalRef,
  type Section,
} from '../model/index.js';
import { segmentDefinitions } from './definitions.js';

/**
 * "Who decides later" and "what it depends on": the places a bill hands a decision to someone
 * else, or only works if something else happens first. Precision beats recall here. A missed
 * item costs the reader a lookup; a wrong "decided later" item tells them something false. So
 * every pattern names a specific rule-making or discretion phrase, and a plain duty ("the board
 * of elections shall certify the results") never matches.
 *
 * Computed at chip time from the section tree over struck-free text, like `definitions.ts`,
 * so nothing extra is stored on the document.
 */

export type DecidedLaterKind =
  | 'rulemaking'
  | 'standards'
  | 'designation'
  | 'determination'
  | 'waiver'
  | 'discretion'
  | 'direction'
  | 'approval';
export type DependsOnKind =
  'law' | 'outside_body' | 'appropriation' | 'voter_approval' | 'contingency';
export type DelegationKind =
  DecidedLaterKind | DependsOnKind | 'effective_date';

export interface DelegationItem {
  sectionId: string;
  /** Printed line and page where the match starts, when the source has them (PDFs). */
  line?: number;
  page?: number;
  /** Who decides (decided-later items) or which body/law is depended on. */
  actor?: string;
  /** What is decided or required, as a short excerpt. */
  what: string;
  /** "not later than 180 days after ..." when the same sentence sets one. */
  deadline?: string;
  kind: DelegationKind;
  /** The matched sentence, at most 200 characters, for the chip to cite. */
  quote: string;
}

export interface Delegations {
  decidedLater: DelegationItem[];
  dependsOn: DelegationItem[];
  takesEffect: DelegationItem[];
  /** Items beyond the cap, per group. Duplicates folded together are not counted. */
  truncated: { decidedLater: number; dependsOn: number; takesEffect: number };
}

export const GROUP_CAP = 25;
const QUOTE_MAX = 200;
const WHAT_MAX = 140;

// ---------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

// A sentence or clause ends at . ! ? ; before a new capital, digit, quote or "(", at a blank
// line, or before a newline that starts a "(a)"-style label.
const SPLIT =
  /(?<=[.!?;])["”’)]*\s+(?=[("“A-Z0-9])|\n\s*\n|\n(?=\s*\([A-Za-z0-9]{1,6}\)\s)/g;
// A period after these is an abbreviation, not the end of a sentence.
const ABBREVIATION =
  /\b(?:U\.S|U\.S\.C|Stat|Pub|L|Sec|Secs|No|Nos|Inc|Corp|Dept|St|Mr|Ms|Dr|cf|e\.g|i\.e)\.$/;

function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (const m of text.matchAll(SPLIT)) {
    if (ABBREVIATION.test(text.slice(0, m.index))) continue;
    spans.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  spans.push({ start, end: text.length });
  return spans.filter((s) => text.slice(s.start, s.end).trim().length > 0);
}

// ---------------------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------------------

// Words that end a noun phrase naming a body ("... by the Secretary of Labor before ...").
const PHRASE_STOP = new Set(
  (
    'to that which who whom whose for in and or before after if when whenever where under as on ' +
    'within by has have shall may must is are be with from at not unless until pursuant regarding ' +
    'concerning than so but then upon during while through into'
  ).split(' '),
);
const MAX_PHRASE_WORDS = 8;
const WORD = /^\s+([A-Za-z0-9][\w'’-]*(?:\.\w+)*)/;

/**
 * The noun phrase starting at `from` ("the Secretary of Health and Human Services"). "and"/"or"
 * continue the phrase only between capitalized words, so "Food and Drug Administration" stays
 * whole while "the Secretary and the Administrator" ends at the Secretary.
 */
function phraseAfter(text: string, from: number): string | undefined {
  const words: string[] = [];
  let pos = from;
  for (;;) {
    const m = WORD.exec(text.slice(pos));
    if (!m) break;
    const word = m[1] ?? '';
    const lower = word.toLowerCase();
    const after = text.charAt(pos + m[0].length);
    if (PHRASE_STOP.has(lower)) {
      const joins =
        (lower === 'and' || lower === 'or') &&
        /^[A-Z]/.test(words.at(-1) ?? '') &&
        /^\s+[A-Z]/.test(text.slice(pos + m[0].length, pos + m[0].length + 3));
      if (!joins) break;
    }
    words.push(word);
    pos += m[0].length;
    if (words.length > MAX_PHRASE_WORDS || /[,;:.)—–]/.test(after)) break;
  }
  return words.length > 0 && words.length <= MAX_PHRASE_WORDS
    ? words.join(' ')
    : undefined;
}

// A comma-separated piece that opens with one of these is a modifier, not the subject.
const MODIFIER_START =
  /^(?:in|after|with|and|or|by|not|no|within|upon|on|if|unless|subject|pursuant|consistent|acting|as|to|for|before|from|under|which|who|including|except|notwithstanding|during|at|through|jointly|of)\b/i;
const CLAUSE_BREAK =
  /\b(?:that|if|when|whenever|unless|provided|because|while|where|so)\s+(?=[^]*$)/gi;

/** The subject of the verb that follows `prefix`: "the Secretary", "the board of elections". */
function actorBefore(prefix: string): string | undefined {
  let rest = prefix.replace(/\([^()]*\)/g, ' ');
  // "(a) Rulemaking.—The Secretary" / "Sec. 4. The director": keep the last sentence part.
  rest = rest.split(/[—–:;]|(?<![A-Z])\.\s/).at(-1) ?? '';
  const pieces = rest.split(',').map((p) => p.trim());
  let candidate = '';
  for (let i = pieces.length - 1; i >= 0; i--) {
    const piece = pieces[i] ?? '';
    if (!piece || MODIFIER_START.test(piece)) continue;
    candidate = piece;
    break;
  }
  const breaks = [...candidate.matchAll(CLAUSE_BREAK)];
  const last = breaks.at(-1);
  if (last) candidate = candidate.slice(last.index + last[0].length);
  candidate = candidate.replace(/^(?:and|or|but|then)\s+/i, '').trim();
  const count = candidate.split(/\s+/).filter(Boolean).length;
  return count >= 1 && count <= MAX_PHRASE_WORDS ? candidate : undefined;
}

// A body that can make a decision in a bill. Used to tell "the Secretary may waive" from
// "a person may waive the right", where "may" is permission to the public, not discretion.
const OFFICIAL =
  /\b(?:Secretary|Administrator|Director|Commissioner|Attorney\s+General|Board|Commission|Council|Agency|Department|Office|Treasurer|Governor|President|Mayor|Auditor|Comptroller|Authorit(?:y|ies)|Superintendent|Inspector\s+General|Chief|Clerk|Committee|Bureau|Administration|Officer|Manager|Congress|Legislature|Assembly|Trustees?|Solicitor|Prosecutor|Sheriff|City|State)\b/i;
// Private parties: a "may" or "shall designate" by these is not a delegation to an official.
const PRIVATE_PARTY =
  /\b(?:persons?|individuals?|applicants?|employees?|employers?|parties|party|residents?|voters?|electors?|candidates?|citizens?|owners?|tenants?|participants?|members?|taxpayers?|students?|patients?|consumers?|customers?|licensees?|contractors?|plaintiffs?|defendants?|petitioners?)\b/i;
const VOTERS = /\b(?:electors?|voters?|residents?|people)\b/i;
const JUDICIAL = /^(?:the\s+|a\s+|any\s+)?(?:court|judge)s?\b/i;

// ---------------------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------------------

const DEADLINE =
  /\b(?:(?:not|no)\s+later\s+than\s+[^,;.]{1,100}|within\s+(?:\d+|[a-z-]+)\s+(?:business\s+|calendar\s+)?(?:days?|weeks?|months?|years?)\b[^,;.]{0,80})/i;

function deadlineIn(sentence: string): string | undefined {
  const m = DEADLINE.exec(sentence);
  return m ? clean(m[0]) : undefined;
}

// ---------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------

interface Hit {
  actor?: string | undefined;
  what: string;
  /** Position of the match start inside the sentence, for the line lookup. */
  at?: number;
}

interface Rule {
  group: 'decidedLater' | 'dependsOn' | 'takesEffect';
  kind: DelegationKind;
  pattern: RegExp;
  hit(m: RegExpExecArray, sentence: string): Hit | undefined;
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function shorten(text: string, max: number): string {
  const t = clean(text).replace(/[.;,]+$/, '');
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** The sentence from the verb on: "prescribe regulations to carry out this section". */
function fromVerb(sentence: string, from: number): string {
  return shorten(sentence.slice(from).replace(/^shall\s+/i, ''), WHAT_MAX);
}

/** The words before a trailing phrase: what the approval or determination applies to. */
function beforeMatch(sentence: string, at: number): string {
  const head = sentence
    .slice(0, at)
    .replace(/^[\s,;—–:-]+|[\s,]+$/g, '')
    .replace(/^\([A-Za-z0-9]{1,6}\)\s*/, '');
  return shorten(
    head.length > WHAT_MAX ? head.slice(-WHAT_MAX) : head,
    WHAT_MAX,
  );
}

function subjectOf(sentence: string, verbAt: number): string | undefined {
  return actorBefore(sentence.slice(0, verbAt));
}

const DIRECTION =
  /\bunder\s+the\s+(?:direction|supervision|control)\s+of(?=\s)/gi;

function directionHit(m: RegExpExecArray, s: string): Hit | undefined {
  const actor = phraseAfter(s, m.index + m[0].length);
  if (!actor || !OFFICIAL.test(actor) || JUDICIAL.test(actor)) return undefined;
  return { actor, what: beforeMatch(s, m.index), at: m.index };
}

const LAW_NOUN =
  /\b(?:laws?|codes?|charters?|acts?|statutes?|constitution|ordinances?)\b/i;
// Points into this document or its own parts, or names no particular law.
const INTERNAL =
  /\b(?:this|these|section|sections|division|paragraph|subsection|chapter|article|title)\b/i;
const BARE_LAW =
  /^(?:the|such|that|said|applicable|any|other|\s)*(?:act|law|laws|code|statute|statutes|charter)$/i;

/** True for "the general election laws of the state", false for "section 3 of this charter". */
function isNamedLaw(phrase: string): boolean {
  return (
    LAW_NOUN.test(phrase) && !INTERNAL.test(phrase) && !BARE_LAW.test(phrase)
  );
}

const MODIFIERS =
  'such|final|interim|implementing|necessary|any|a|an|the|all|appropriate|new|temporary|emergency|additional|uniform|administrative|binding';

const RULES: Rule[] = [
  {
    group: 'decidedLater',
    kind: 'rulemaking',
    pattern: new RegExp(
      String.raw`\bshall\s+(?:promptly\s+|expeditiously\s+|jointly\s+)?(?:prescribe|promulgate|issue|adopt)\s+(?:(?:${MODIFIERS})\s+){0,3}(?:regulations?|rules?)\b`,
      'gi',
    ),
    hit: (m, s) => ({
      actor: subjectOf(s, m.index),
      what: fromVerb(s, m.index),
      at: m.index,
    }),
  },
  {
    group: 'decidedLater',
    kind: 'standards',
    pattern: new RegExp(
      String.raw`\bshall\s+(?:promptly\s+)?establish\s+(?:(?:uniform|minimum|written|statewide|national|objective|clear|new|such|appropriate|and|the|a|any|other|reasonable|eligibility|performance|quality|safety)\s+){0,3}(?:standards?|criteria|procedures?|guidelines?)\b`,
      'gi',
    ),
    hit: (m, s) => ({
      actor: subjectOf(s, m.index),
      what: fromVerb(s, m.index),
      at: m.index,
    }),
  },
  {
    group: 'decidedLater',
    kind: 'designation',
    pattern: /\bshall\s+designate\b/gi,
    hit(m, s) {
      const actor = subjectOf(s, m.index);
      // "each applicant shall designate a beneficiary" is a duty of a private party.
      if (actor !== undefined && PRIVATE_PARTY.test(actor)) return undefined;
      return { actor, what: fromVerb(s, m.index), at: m.index };
    },
  },
  {
    group: 'decidedLater',
    kind: 'determination',
    // "as the Secretary determines appropriate" / "as the director considers necessary".
    pattern:
      /\bas\s+((?:the\s+)?[A-Za-z]+(?:\s+[A-Za-z]+){0,5}?)\s+(?:determines?|considers?|deems?)\s+(?:it\s+)?(?:to\s+be\s+)?(?:appropriate|necessary|advisable|proper|warranted)\b/gi,
    hit: (m, s) => ({
      actor: clean(m[1] ?? ''),
      what: beforeMatch(s, m.index),
      at: m.index,
    }),
  },
  {
    group: 'decidedLater',
    kind: 'determination',
    pattern: /\bas\s+(?:otherwise\s+)?determined\s+by(?=\s)/gi,
    hit(m, s) {
      const actor = phraseAfter(s, m.index + m[0].length);
      // "as determined by section 5" / "by a court" / "by dividing ..." name no official.
      if (!actor || !OFFICIAL.test(actor) || JUDICIAL.test(actor))
        return undefined;
      return { actor, what: beforeMatch(s, m.index), at: m.index };
    },
  },
  {
    group: 'decidedLater',
    kind: 'waiver',
    pattern: /\bmay\s+waive\b/gi,
    hit(m, s) {
      const actor = subjectOf(s, m.index);
      // "a person may waive the right" is permission to the public, not official discretion.
      if (!actor || !OFFICIAL.test(actor) || PRIVATE_PARTY.test(actor))
        return undefined;
      return { actor, what: fromVerb(s, m.index), at: m.index };
    },
  },
  {
    group: 'decidedLater',
    kind: 'waiver',
    pattern: /\bmay\s+be\s+waived\s+by(?=\s)/gi,
    hit(m, s) {
      const actor = phraseAfter(s, m.index + m[0].length);
      if (!actor || !OFFICIAL.test(actor) || PRIVATE_PARTY.test(actor))
        return undefined;
      return { actor, what: beforeMatch(s, m.index + 3), at: m.index };
    },
  },
  {
    group: 'decidedLater',
    kind: 'discretion',
    pattern:
      /\b(?:at|in)\s+the\s+(?:sole\s+|absolute\s+|exclusive\s+)?discretion\s+of(?=\s)/gi,
    hit(m, s) {
      const actor = phraseAfter(s, m.index + m[0].length);
      if (!actor || JUDICIAL.test(actor)) return undefined;
      return { actor, what: beforeMatch(s, m.index), at: m.index };
    },
  },
  {
    group: 'decidedLater',
    kind: 'approval',
    pattern:
      /\bsubject\s+to\s+(?:the\s+)?(?:(?:prior|written|final|express)\s+)*approval\s+(?:of|by)(?=\s)/gi,
    hit(m, s) {
      const actor = phraseAfter(s, m.index + m[0].length);
      // Voter approval is its own kind of dependency (below).
      if (!actor || VOTERS.test(actor)) return undefined;
      return { actor, what: beforeMatch(s, m.index), at: m.index };
    },
  },
  {
    group: 'dependsOn',
    kind: 'appropriation',
    pattern:
      /\bsubject\s+to\s+(?:the\s+)?(?:availability\s+of\s+)?(?:appropriations?|(?:funds|amounts)\s+(?:being\s+)?(?:made\s+)?available)\b|\bto\s+the\s+extent\s+(?:that\s+)?(?:funds|amounts|appropriations|resources)\s+(?:are|is)\s+(?:made\s+)?(?:available|provided|appropriated)\b/gi,
    hit: (m) => ({ what: shorten(m[0], WHAT_MAX), at: m.index }),
  },
  {
    group: 'dependsOn',
    kind: 'voter_approval',
    pattern:
      /\b(?:approved\s+by|submitted\s+to)\s+(?:a\s+(?:majority\s+of\s+the\s+)?(?:vote\s+of\s+)?)?(?:the\s+)?(?:majority\s+of\s+(?:the\s+)?)?(?:qualified\s+|registered\s+)?(?:electors|voters)\b|\bmajority\s+of\s+(?:the\s+)?(?:qualified\s+|registered\s+)?(?:electors|voters)\s+voting\b/gi,
    hit: (m, s) => ({
      what: shorten(s.slice(m.index), WHAT_MAX),
      at: m.index,
    }),
  },
  {
    group: 'dependsOn',
    kind: 'contingency',
    pattern:
      /\bcontingent\s+(?:up)?on\s+(?:the\s+)?(?:enactment|passage|approval|adoption|appropriation|funding|ratification|certification|receipt|availability)\b|\btakes?\s+effect\s+(?:only\s+)?if\b|\bupon\s+the\s+enactment\s+of\b/gi,
    hit: (m, s) => ({
      what: shorten(s.slice(m.index), WHAT_MAX),
      at: m.index,
    }),
  },
  {
    group: 'dependsOn',
    kind: 'outside_body',
    // "approved by the Department of Labor", "with the concurrence of the Governor".
    pattern:
      /\b(?:(?:approved|certified|authorized)\s+by|with\s+the\s+(?:(?:prior|written)\s+)*(?:approval|concurrence|consent)\s+of)(?=\s)/gi,
    hit(m, s) {
      const actor = phraseAfter(s, m.index + m[0].length);
      if (
        !actor ||
        !OFFICIAL.test(actor) ||
        VOTERS.test(actor) ||
        JUDICIAL.test(actor)
      )
        return undefined;
      return {
        actor,
        what: shorten(
          s.slice(m.index, m.index + m[0].length) + ' ' + actor,
          WHAT_MAX,
        ),
        at: m.index,
      };
    },
  },
  {
    group: 'decidedLater',
    kind: 'direction',
    // "decided by lot under the direction of the election authorities".
    pattern: DIRECTION,
    hit: directionHit,
  },
  {
    group: 'dependsOn',
    kind: 'outside_body',
    pattern: DIRECTION,
    hit(m, s) {
      const hit = directionHit(m, s);
      return (
        hit && { ...hit, what: shorten(`${m[0]} ${hit.actor ?? ''}`, WHAT_MAX) }
      );
    },
  },
  {
    group: 'decidedLater',
    kind: 'determination',
    // "after the city clerk determines the sufficiency of the petition".
    pattern: /\bdetermines(?=\s)/gi,
    hit(m, s) {
      const before = s.slice(0, m.index);
      // "as the Secretary determines appropriate" is the rule above.
      if (/\bas\s+(?:\S+\s+){0,6}$/i.test(before)) return undefined;
      const subject = before.replace(
        /^.*\b(?:after|before|once|until|if|when|unless|whenever|while)\s+(?=[^,;]*$)/i,
        '',
      );
      const actor = actorBefore(
        subject.replace(
          /\s+(?:otherwise|also|then|further|jointly|ultimately)\s*$/i,
          '',
        ),
      );
      if (
        !actor ||
        !OFFICIAL.test(actor) ||
        PRIVATE_PARTY.test(actor) ||
        JUDICIAL.test(actor)
      )
        return undefined;
      return { actor, what: shorten(s.slice(m.index), WHAT_MAX), at: m.index };
    },
  },
  {
    group: 'dependsOn',
    kind: 'law',
    // "as provided by the general election laws of the state", "pursuant to the Revised Code".
    pattern:
      /\b(?:as\s+provided\s+(?:by|in|under)|in\s+accordance\s+with|pursuant\s+to)(?=\s)/gi,
    hit(m, s) {
      const phrase = phraseAfter(s, m.index + m[0].length);
      if (!phrase || !isNamedLaw(phrase)) return undefined;
      return {
        actor: phrase,
        what: shorten(`${m[0]} ${phrase}`, WHAT_MAX),
        at: m.index,
      };
    },
  },
  {
    group: 'dependsOn',
    kind: 'law',
    pattern:
      /\b(?:the\s+)?general\s+(?:election\s+)?laws\s+of\s+(?:the|this)\s+state\b/gi,
    hit: (m) => ({ actor: clean(m[0]), what: clean(m[0]), at: m.index }),
  },
  {
    group: 'takesEffect',
    kind: 'effective_date',
    // The wording matches chunk/classify.ts's effective_date test.
    pattern:
      /\b(?:shall\s+)?takes?\s+effect\b|\bshall\s+(?:become\s+)?effective\b|\beffective\s+(?:on|upon|beginning|as\s+of)\b|(?<!\b(?:period|years?|months?|days?|weeks?|quarter|session|term)\s)\bbeginning\s+on\b/gi,
    hit: (m, s) => ({
      what: shorten(
        s
          .slice(m.index + m[0].length)
          .replace(/^[\s,]+/, '')
          .split(/[;.]\s|[;]/)[0] ?? '',
        WHAT_MAX,
      ),
      at: m.index,
    }),
  },
];

// ---------------------------------------------------------------------------------------
// Source positions
// ---------------------------------------------------------------------------------------

interface Located {
  text: string;
  /** Start offset in `text` of each span with a known page/line. */
  marks: {
    offset: number;
    page?: number | undefined;
    line?: number | undefined;
  }[];
}

/** Struck-free text plus where each span starts in the printed source. */
function locatedText(section: Section): Located {
  let text = '';
  const marks: Located['marks'] = [];
  for (const span of section.spans) {
    if (span.status === 'deleted') continue;
    marks.push({ offset: text.length, page: span.page, line: span.line });
    text += span.text;
  }
  return { text, marks };
}

function positionAt(
  section: Section,
  located: Located,
  offset: number,
): { page?: number; line?: number } {
  let found: Located['marks'][number] | undefined;
  for (const mark of located.marks) {
    if (mark.offset > offset) break;
    if (mark.line !== undefined || mark.page !== undefined) found = mark;
  }
  const page = found?.page ?? section.pageStart;
  const line = found?.line ?? section.lineStart;
  return {
    ...(page !== undefined && { page }),
    ...(line !== undefined && { line }),
  };
}

/** At most QUOTE_MAX characters of the sentence, centred on the match when it is long. */
function quoteOf(sentence: string, at: number): string {
  const flat = clean(sentence);
  if (flat.length <= QUOTE_MAX) return flat;
  const start = Math.max(0, Math.min(at - 60, sentence.length - QUOTE_MAX));
  const window = clean(sentence.slice(start, start + QUOTE_MAX));
  const body =
    window.length > QUOTE_MAX - 1 ? window.slice(0, QUOTE_MAX - 1) : window;
  return `${start > 0 ? '…' : ''}${body}`.slice(0, QUOTE_MAX);
}

// ---------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------

const DEPENDS_ORDER: Record<string, number> = {
  appropriation: 0,
  voter_approval: 1,
  contingency: 2,
  outside_body: 3,
  law: 4,
};

function dedupeKey(item: DelegationItem): string {
  return [
    item.sectionId,
    item.kind,
    (item.actor ?? item.what).toLowerCase().replace(/\s+/g, ' '),
  ].join('\u0000');
}

function capGroup(items: DelegationItem[]): {
  kept: DelegationItem[];
  dropped: number;
} {
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    const key = dedupeKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    kept: unique.slice(0, GROUP_CAP),
    dropped: Math.max(0, unique.length - GROUP_CAP),
  };
}

/**
 * Delegations and dependencies in current (non-struck) text, in document order. `externalRefs`
 * are the laws the reference extractor already found; they are reused, not re-detected, and
 * listed only where the cited text is still in force (not struck).
 */
export function extractDelegations(
  sections: readonly Section[],
  externalRefs: readonly ExternalRef[] = [],
): Delegations {
  const groups: Record<Rule['group'], DelegationItem[]> = {
    decidedLater: [],
    dependsOn: [],
    takesEffect: [],
  };
  const refsBySection = new Map<string, ExternalRef[]>();
  for (const ref of externalRefs)
    for (const id of ref.sectionIds)
      refsBySection.set(id, [...(refsBySection.get(id) ?? []), ref]);

  for (const section of walkSections(sections)) {
    const located = locatedText(section);
    const { text } = located;
    if (!text.trim()) continue;
    const definitions = segmentDefinitions(text);
    const inDefinition = (offset: number): boolean =>
      definitions.some((d) => offset >= d.start && offset < d.end);

    for (const span of sentenceSpans(text)) {
      // A definition ("'Director' means the person who shall designate ...") describes a term.
      if (inDefinition(span.start)) continue;
      const sentence = text.slice(span.start, span.end);
      const sentenceItems: DelegationItem[] = [];
      for (const rule of RULES) {
        for (const m of sentence.matchAll(rule.pattern)) {
          const hit = rule.hit(m, sentence);
          if (!hit?.what) continue;
          const at = hit.at ?? m.index;
          const deadline =
            rule.group === 'decidedLater' ? deadlineIn(sentence) : undefined;
          sentenceItems.push({
            sectionId: section.id,
            ...positionAt(section, located, span.start + at),
            ...(hit.actor !== undefined && { actor: hit.actor }),
            what: hit.what,
            ...(deadline !== undefined && { deadline }),
            kind: rule.kind,
            quote: quoteOf(sentence, at),
          });
        }
      }
      // "takes effect only if X" is a contingency; do not also list it as a date.
      const contingent = sentenceItems.some((i) => i.kind === 'contingency');
      for (const item of sentenceItems) {
        if (item.kind === 'effective_date' && contingent) continue;
        groups[groupOf(item.kind)].push(item);
      }
    }

    for (const ref of refsBySection.get(section.id) ?? []) {
      const at = text.indexOf(ref.text);
      if (at === -1) continue; // only cited in struck text
      const sentenceSpan = sentenceSpans(text).find(
        (s) => at >= s.start && at < s.end,
      ) ?? {
        start: 0,
        end: text.length,
      };
      groups.dependsOn.push({
        sectionId: section.id,
        ...positionAt(section, located, at),
        actor: ref.citation,
        what: ref.text,
        kind: 'law',
        quote: quoteOf(
          text.slice(sentenceSpan.start, sentenceSpan.end),
          at - sentenceSpan.start,
        ),
      });
    }
  }

  // Laws are the most numerous and least surprising, so they come last when the cap bites.
  groups.dependsOn.sort(
    (a, b) => (DEPENDS_ORDER[a.kind] ?? 9) - (DEPENDS_ORDER[b.kind] ?? 9),
  );
  const decided = capGroup(groups.decidedLater);
  const depends = capGroup(groups.dependsOn);
  const effect = capGroup(groups.takesEffect);
  return {
    decidedLater: decided.kept,
    dependsOn: depends.kept,
    takesEffect: effect.kept,
    truncated: {
      decidedLater: decided.dropped,
      dependsOn: depends.dropped,
      takesEffect: effect.dropped,
    },
  };
}

function groupOf(kind: DelegationKind): Rule['group'] {
  if (kind === 'effective_date') return 'takesEffect';
  return kind in DEPENDS_ORDER ? 'dependsOn' : 'decidedLater';
}
