/**
 * System-prompt echo filter. If a reply repeats any run of `RUN_WORDS` consecutive words from
 * the system prompt, the model has been talked into reciting its instructions; the reply is
 * withheld. Pure; runs after citation validation.
 */
import { DECLINE_TEXT } from '../model/index.js';

export const ECHO_RUN_WORDS = 12;

function words(text: string): string[] {
  // The decline sentence is part of the prompt by design and is a legitimate thing to say.
  return text
    .split(DECLINE_TEXT)
    .join(' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function echoesSystemPrompt(
  reply: string,
  systemPrompt: string,
): boolean {
  const promptWords = words(systemPrompt);
  const replyWords = words(reply);
  if (replyWords.length < ECHO_RUN_WORDS) return false;
  const runs = new Set<string>();
  for (let i = 0; i + ECHO_RUN_WORDS <= promptWords.length; i += 1)
    runs.add(promptWords.slice(i, i + ECHO_RUN_WORDS).join(' '));
  for (let i = 0; i + ECHO_RUN_WORDS <= replyWords.length; i += 1)
    if (runs.has(replyWords.slice(i, i + ECHO_RUN_WORDS).join(' ')))
      return true;
  return false;
}
