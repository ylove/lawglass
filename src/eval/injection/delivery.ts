/**
 * Kept apart from `assertions.ts` because it needs `escapeText`, which pulls in node:crypto; the
 * browser-side render test imports `assertions.ts` and must not.
 */
import { escapeText } from '../../core/answer/prompt.js';

/** Whether `needle` reached the model, as the prompt writer would have escaped it. */
export function reachedPrompt(userPrompt: string, needle: string): boolean {
  return userPrompt.includes(escapeText(needle));
}
