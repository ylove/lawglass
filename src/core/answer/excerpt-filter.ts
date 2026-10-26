/**
 * Rule 9 backstop (#274): the reader never sees "The excerpts don't show...". Retrieval is an
 * internal detail, and a sentence about what the model was or was not shown says nothing about
 * the bill. The prompt forbids it; this deterministic filter removes what slips through.
 *
 * A sentence is dropped when it names the material the model was given (the excerpts, the
 * provided text, "what I was shown") AND talks about showing, providing or covering it AND has
 * no citation. A cited sentence states a fact about the bill, so it is never touched, whole or
 * in part: sentences are split abbreviation-aware ("U.S.C.", "Sec."), so one is never cut.
 */
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

export interface FilteredText {
  text: string;
  /** The sentences removed, for a log line. */
  dropped: string[];
}

export function dropExcerptTalk(text: string): FilteredText {
  const dropped: string[] = [];
  const kept = splitSentences(text).filter((s) => {
    if (!talksAboutExcerpts(s)) return true;
    dropped.push(s.trim());
    return false;
  });
  if (dropped.length === 0) return { text, dropped };
  return {
    text: kept
      .join('')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim(),
    dropped,
  };
}
