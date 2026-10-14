/**
 * Vetting a reader-requested scenario subject ("a renter", "someone running for city council").
 *
 * The subject is untrusted text that ends up in a model prompt and, paraphrased, in a profile
 * label. It is checked BEFORE any model call with the validator's own rules, so a subject such
 * as "unfair burden" is refused up front instead of producing a scenario the validator would
 * drop after the call was paid for.
 */
import { markup, evaluative } from './validate.js';

export const MAX_SUBJECT_LENGTH = 80;

// Bidi controls and zero-width characters can hide text from the reader; strip them first.
const INVISIBLE = /[­͏؜᠎​-‏‪-‮⁠-⁩﻿]/gu;
// Letters (any script), digits, spaces and a few punctuation marks that appear in role names.
const ALLOWED = /^[\p{L}\p{N} '\-,.()/&]+$/u;

export type SubjectCheck =
  { ok: true; subject: string } | { ok: false; reason: string };

export function checkScenarioSubject(raw: string): SubjectCheck {
  const subject = raw
    .replace(INVISIBLE, '')
    // Typographic apostrophes are ordinary in names of roles; fold them to the allowed one.
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!subject) return { ok: false, reason: 'Enter who the example is about.' };
  if (Array.from(subject).length > MAX_SUBJECT_LENGTH)
    return {
      ok: false,
      reason: `Keep it to ${String(MAX_SUBJECT_LENGTH)} characters or fewer.`,
    };
  if (!ALLOWED.test(subject) || !/\p{L}/u.test(subject))
    return {
      ok: false,
      reason:
        "Use only letters, numbers, spaces and these marks: ' - , . ( ) / &",
    };
  if (markup(subject))
    return { ok: false, reason: 'Describe the person in plain words.' };
  if (evaluative(subject))
    return {
      ok: false,
      reason:
        'Describe who the example is about in neutral words, without judging the bill.',
    };
  return { ok: true, subject };
}
