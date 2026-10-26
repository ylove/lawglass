/**
 * System-prompt echo defense. If a reply repeats any run of `ECHO_RUN_WORDS` consecutive words
 * from the system prompt, the model has been talked into reciting its instructions; the reply is
 * withheld. Two parts, both pure:
 *  - `echoesSystemPrompt`: the final check, run after citation validation;
 *  - `createEchoGuard`: a streaming guard that stops emitting tokens once a shorter run
 *    (`GUARD_RUN_WORDS`) matches, so the full run never reaches `onToken` (CLI output, SSE).
 *
 * This is an n-gram filter, not a complete defense: a recital with filler words interleaved
 * passes. The prompt's own rule against disclosure is the primary defense.
 *
 * Both compare normalized words (NFKC, invisible and bidi characters removed, case folded,
 * punctuation dropped), so zero-width characters or commas between words do not evade them.
 */
import { DECLINE_TEXT } from '../model/index.js';
import { stripInvisibles } from '../pipeline/question.js';

export const ECHO_RUN_WORDS = 12;
/** Streaming stops at this many matching words, safely under the 12 that count as an echo. */
export const GUARD_RUN_WORDS = 8;

function normalizeText(text: string): string {
  // Default_Ignorable covers variation selectors, U+034F, tag characters, U+3164 and the like;
  // stripInvisibles adds the bidi/zero-width set. Both go before tokenizing so none can split a word.
  // NFKD then dropping combining marks (\p{M}) also defeats a stray accent or mark that would
  // otherwise split a word; it folds accents the same way for the prompt and the reply.
  return stripInvisibles(text.normalize('NFKD'))
    .replace(/[\p{Default_Ignorable_Code_Point}\p{M}]/gu, '')
    .replace(/\[S:[^\]]*\]/g, ' ');
}

/** Normalize to comparable words. Citation markers are dropped so they cannot split a run. */
export function normalizeWords(text: string): string[] {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

function promptWords(systemPrompt: string): string[] {
  // The decline sentence is part of the prompt by design and is a legitimate thing to say.
  return normalizeWords(systemPrompt.split(DECLINE_TEXT).join(' '));
}

function runsOf(words: readonly string[], size: number): Set<string> {
  const runs = new Set<string>();
  for (let i = 0; i + size <= words.length; i += 1)
    runs.add(words.slice(i, i + size).join(' '));
  return runs;
}

function hasRun(
  words: readonly string[],
  size: number,
  runs: ReadonlySet<string>,
): boolean {
  for (let i = 0; i + size <= words.length; i += 1)
    if (runs.has(words.slice(i, i + size).join(' '))) return true;
  return false;
}

export function echoesSystemPrompt(
  reply: string,
  systemPrompt: string,
): boolean {
  const replyWords = normalizeWords(reply.split(DECLINE_TEXT).join(' '));
  return hasRun(
    replyWords,
    ECHO_RUN_WORDS,
    runsOf(promptWords(systemPrompt), ECHO_RUN_WORDS),
  );
}

export interface EchoGuard {
  /** Returns the text safe to emit for this token: the token itself, or '' once tripped. */
  push(text: string): string;
  /** Text that was withheld after tripping (emit it only if the final reply is not an echo). */
  withheld(): string;
}

/**
 * Retain the last normalized words, plus raw text that may still be an unfinished word or
 * citation marker. Padding cannot evict the history, and each event is scanned before trimming
 * so even a huge event cannot hide a recital in its middle.
 */
export function createEchoGuard(systemPrompt: string): EchoGuard {
  const runs = runsOf(promptWords(systemPrompt), GUARD_RUN_WORDS);
  let raw = '';
  let emitted = 0;
  let tripped = false;
  let history: string[] = [];
  let pending = '';
  return {
    push(text) {
      raw += text;
      if (tripped) return '';
      pending = normalizeText(pending + text);
      tripped = hasRun(
        [...history, ...normalizeWords(pending)],
        GUARD_RUN_WORDS,
        runs,
      );
      if (tripped) return '';

      // A whitespace boundary fixes the preceding words. Do not commit any part of a citation
      // until its closing bracket arrives: normalization must be able to remove it as a whole.
      const openCitation = pending.indexOf('[S:');
      const stable =
        openCitation >= 0 ? pending.slice(0, openCitation) : pending;
      let end = 0;
      for (const boundary of stable.matchAll(/\s+/gu))
        end = boundary.index + boundary[0].length;
      if (end > 0) {
        history = [...history, ...normalizeWords(pending.slice(0, end))].slice(
          -(GUARD_RUN_WORDS - 1),
        );
        pending = pending.slice(end);
      }
      emitted = raw.length;
      return text;
    },
    withheld: () => raw.slice(emitted),
  };
}
