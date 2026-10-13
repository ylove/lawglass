/**
 * Flesch-Kincaid grade level, dependency-free:
 *   0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59
 * Syllables are counted with a vowel-group heuristic; it is not exact but is within a few
 * percent on plain English, which is enough to check a "7th-grade" target.
 */
import { CITATION_PATTERN } from '../model/index.js';

/** Heuristic syllable count for one word (at least 1). */
export function countSyllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  // Silent endings: "-e", "-es", "-ed" do not add a syllable ("make", "makes", "walked"),
  // except "-le" after a consonant ("table") and "-ted"/"-ded" ("wanted").
  if (!/[^aeiouyl]le$/.test(w))
    w = w.replace(/(?:[^aeiouyl]es|[^aeiouytd]ed|[^aeiouy]e)$/, (m) =>
      m.slice(0, 1),
    );
  w = w.replace(/^y/, '');
  const groups = w.match(/[aeiouy]+/g);
  return Math.max(1, groups?.length ?? 1);
}

/** Remove `[S:id]` markers so they are not scored as words. */
export function stripCitations(text: string): string {
  return text
    .replace(new RegExp(CITATION_PATTERN.source, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Grade level of `text`, or null when it has no words. Citation markers are ignored. */
export function fleschKincaidGrade(text: string): number | null {
  const clean = stripCitations(text);
  const words = clean.match(/[A-Za-z0-9][A-Za-z0-9'’]*/g) ?? [];
  if (words.length === 0) return null;
  // A sentence ends at . ! ? or a line break; a text with no terminator counts as one.
  const sentences = Math.max(
    1,
    clean.split(/[.!?]+(?:\s|$)|\n+/).filter((s) => /[A-Za-z0-9]/.test(s))
      .length,
  );
  const syllables = words.reduce((n, w) => n + (countSyllables(w) || 1), 0);
  const grade =
    0.39 * (words.length / sentences) +
    11.8 * (syllables / words.length) -
    15.59;
  return Math.round(grade * 10) / 10;
}
