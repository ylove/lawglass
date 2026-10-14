/**
 * System-prompt echo defense. If a reply repeats any run of `ECHO_RUN_WORDS` consecutive words
 * from the system prompt, the model has been talked into reciting its instructions; the reply is
 * withheld. Two parts, both pure:
 *  - `echoesSystemPrompt`: the final check, run after citation validation;
 *  - `createEchoGuard`: a streaming guard that stops emitting tokens once a shorter run
 *    (`GUARD_RUN_WORDS`) matches, so the full run never reaches `onToken` (CLI output, SSE).
 *
 * Both compare normalized words (NFKC, invisible and bidi characters removed, case folded,
 * punctuation dropped), so zero-width characters or commas between words do not evade them.
 */
import { DECLINE_TEXT } from '../model/index.js';
import { stripInvisibles } from '../pipeline/question.js';

export const ECHO_RUN_WORDS = 12;
/** Streaming stops at this many matching words, safely under the 12 that count as an echo. */
export const GUARD_RUN_WORDS = 8;

/** Normalize to comparable words. Citation markers are dropped so they cannot split a run. */
export function normalizeWords(text: string): string[] {
  return stripInvisibles(text.normalize('NFKC'))
    .replace(/\[S:[^\]]*\]/g, ' ')
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

/** Only the tail of the reply can hold a newly completed run, so rescanning stays cheap. */
const TAIL_CHARS = 600;

export function createEchoGuard(systemPrompt: string): EchoGuard {
  const runs = runsOf(promptWords(systemPrompt), GUARD_RUN_WORDS);
  let raw = '';
  let emitted = 0;
  let tripped = false;
  return {
    push(text) {
      raw += text;
      if (!tripped)
        tripped = hasRun(
          normalizeWords(raw.slice(-TAIL_CHARS)),
          GUARD_RUN_WORDS,
          runs,
        );
      if (tripped) return '';
      emitted = raw.length;
      return text;
    },
    withheld: () => raw.slice(emitted),
  };
}
