/**
 * Rule 9 backstop (#274): the reader never sees "The excerpts don't show...". Retrieval is an
 * internal detail, and a sentence about what the model was or was not shown says nothing about
 * the bill. The prompt forbids it; this deterministic filter removes what slips through.
 *
 * A sentence is dropped when it names the material the model was given (the excerpts, the
 * provided text, "what I was shown") AND talks about showing, providing or covering it AND has
 * no citation. A cited sentence states a fact about the bill, so it is never dropped or cut:
 * sentences are split abbreviation-aware ("U.S.C.", "Sec."), so one is never cut.
 *
 * A cited sentence can still be worded around the retrieval ("The excerpt gives no deadline for
 * that notice [S:…]", from a live NDAA answer). Its citation already says which section it
 * means, so two narrow rewrites change only that wrapper and keep the claim word for word: a
 * leading "Based on the excerpts," is removed, and "the excerpt" as the subject of a reporting
 * verb becomes "this section".
 */
import { createHash } from 'node:crypto';
import { CITATION_PATTERN } from '../model/index.js';
import { splitSentences } from './sentences.js';

/**
 * What the model was shown, in the retrieval sense. Anchored on a determiner or "provided" so a
 * bill's own words do not match: "the passage of the act" (followed by "of"), "safe passage",
 * "excerpts of the records" and a quoted "passage" are all about the bill, not about retrieval.
 */
const SHOWN_MATERIAL = [
  // "the excerpts", "these passages", "the provided chunks" (but not "the passage of ...")
  /\b(?:the|these|those|provided|given|retrieved|supplied|available)\s+(?:(?:provided|given|retrieved|supplied|available)\s+)?(?:excerpts?|passages?|chunks?|snippets?)\b(?!\s+of\b)/i,
  // "the provided text", "the given sections", "the available parts"
  /\b(?:provided|given|retrieved|supplied|available)\s+(?:text|sections|parts)\b/i,
  // "the sections I was given", "the text I was shown"
  /\b(?:excerpts?|passages?|chunks?|snippets?|sections|text|parts)\s+(?:that\s+)?(?:I|you|we)\s+(?:was|were|have been|had been)\s+(?:given|shown|provided)\b/i,
];
/** "I was not shown the definitions section." needs no noun. */
const I_WAS_SHOWN =
  /\bI\s+(?:was|were|am|have been)\s+(?:not\s+)?(?:given|shown|provided)\b/i;
const ABOUT_BEING_SHOWN =
  /\b(?:shows?|shown|showing|provided|provides?|given|gave|seen|see|based on|according to|available|includes?|included|contains?|contained|mentions?|mentioned|covers?|covered|reviewed|retrieved|supplied|(?:do(?:es)?\s+not|don['’]t|doesn['’]t)\s+(?:say|state|specify|describe|explain|address))\b/i;

export function talksAboutExcerpts(sentence: string): boolean {
  if (new RegExp(CITATION_PATTERN.source).test(sentence)) return false;
  if (I_WAS_SHOWN.test(sentence)) return true;
  return (
    SHOWN_MATERIAL.some((re) => re.test(sentence)) &&
    ABOUT_BEING_SHOWN.test(sentence)
  );
}

/** A list marker and a bold label ("- **Deadline:** ", "2. ") come before a sentence's own words. */
const LEAD = String.raw`^(\s*(?:(?:[-*]|\d{1,3}[.)])\s+)?(?:\*\*[^*\n]{1,80}\*\*:?\s+)?)`;
/**
 * "Based on the excerpts, ", "According to the passages given, ", "As shown in the passages from
 * Sec. 4, ": an attribution clause that opens the sentence. Only the clause goes, and only when
 * it is nothing but the retrieval phrase and what follows the comma opens a claim. "Based on the
 * excerpts from Title 10, United States Code, the …" and "Based on the excerpts, not the full
 * bill, the …" are left alone: cutting there would leave a fragment or drop a hedge.
 */
/**
 * Words that open a hedge or a tail of the attribution itself ("…excerpts, not the full bill,
 * …", "…excerpts, and subject to appropriations, …") rather than the claim. After one of these
 * the clause stays: removing it would detach the hedge from what it qualifies.
 */
const CONTINUATION = String.raw`(?:not|and|but|or|nor|which|who|whose|that|including|excluding|except|unless|subject|only|at|in|on|as|if|when|where|while|although|though|so|yet|plus|along|together|rather|than|then|to|with|without|because|since|assuming|provided|given|i\.e|e\.g)`;
const LEADING_ATTRIBUTION = new RegExp(
  LEAD +
    String.raw`(?:[Bb]ased on|[Aa]ccording to|[Aa]s (?:shown|seen|stated|described) in)\s+` +
    String.raw`(?:the|these|those)\s+(?:(?:provided|given|retrieved|supplied|available)\s+)?` +
    String.raw`(?:excerpts?|passages?|chunks?|snippets?)` +
    String.raw`(?:\s+(?:provided|given|retrieved|supplied|shown|above))?` +
    String.raw`(?:\s+(?:I|you|we)\s+(?:was|were|have been)\s+(?:given|shown|provided))?` +
    String.raw`(?:\s+(?:from|for|in)\s+(?:Sec\.|Section|section|§)\s?[\w().-]{1,20})?` +
    String.raw`,\s+(?!${CONTINUATION}\b)(?=\S)`,
);
/**
 * "The excerpt gives no …", "These excerpts provided show …", "The chunks do not say …": the
 * retrieval material as the subject of a verb that only retrieval talk uses with it. Verbs a bill
 * could use of its own excerpts ("the excerpt includes up to 300 words", "the excerpt does not
 * apply to …", "the chunk specifies …") are not on the list, and "passage" is never renamed
 * (bills use it: "the passage of the act").
 */
const MATERIAL_SUBJECT =
  /\b([Tt]he|[Tt]his|[Tt]hat|[Tt]hese|[Tt]hose)\s+(?:(?:provided|given|retrieved|supplied|available)\s+)?(?:excerpt|chunk|snippet)(s?)(?:\s+(?:provided|given|retrieved|supplied|shown|above))?(?=\s+(?:(?:does|do|did)\s+not|doesn['’]t|don['’]t|didn['’]t)\s+(?:say|show|state|specify|mention|give|list|describe|explain|address|cover|indicate)\b|\s+(?:only\s+)?(?:shows?|says?|states?|mentions?|indicates?)\b|\s+gives?\s+no\b)/g;

/**
 * Changes with the filter's rules. The cached summary is filtered before it is stored, so a
 * summary cached under older rules is written again rather than served with what they missed.
 */
export const EXCERPT_FILTER_VERSION = createHash('sha256')
  .update(
    JSON.stringify(
      [
        ...SHOWN_MATERIAL,
        I_WAS_SHOWN,
        ABOUT_BEING_SHOWN,
        LEADING_ATTRIBUTION,
        MATERIAL_SUBJECT,
      ].map((re) => re.source),
    ),
  )
  .digest('hex')
  .slice(0, 12);

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The cited-sentence rewrites above, or the sentence unchanged. Pure. */
export function rewordCitedExcerptTalk(sentence: string): string {
  if (!new RegExp(CITATION_PATTERN.source).test(sentence)) return sentence;
  const unattributed = sentence.replace(
    LEADING_ATTRIBUTION,
    (_match, lead: string) => lead,
  );
  const opened =
    unattributed === sentence
      ? sentence
      : unattributed.replace(
          new RegExp(LEAD + String.raw`(\S)`),
          (_m, lead: string, first: string) => lead + first.toUpperCase(),
        );
  // The noun keeps its number so the model's verb still agrees: "The excerpts show" becomes
  // "These sections show", never "This section show".
  return opened.replace(
    MATERIAL_SUBJECT,
    (_match, determiner: string, plural: string) => {
      const section = plural ? 'these sections' : 'this section';
      return /^[A-Z]/.test(determiner) ? capitalize(section) : section;
    },
  );
}

export interface FilteredText {
  text: string;
  /** The sentences removed, for a log line. */
  dropped: string[];
  /** How many cited sentences were reworded, for a log line. */
  reworded: number;
}

export function dropExcerptTalk(text: string): FilteredText {
  const dropped: string[] = [];
  let reworded = 0;
  const kept = splitSentences(text).flatMap((s) => {
    if (talksAboutExcerpts(s)) {
      dropped.push(s.trim());
      return [];
    }
    const plain = rewordCitedExcerptTalk(s);
    if (plain !== s) reworded++;
    return [plain];
  });
  if (dropped.length === 0 && reworded === 0)
    return { text, dropped, reworded };
  if (dropped.length === 0) return { text: kept.join(''), dropped, reworded };
  return {
    reworded,
    text: kept
      .join('')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim(),
    dropped,
  };
}
