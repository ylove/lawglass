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

/** Remove `[S:id]` markers so they are not scored as words. Newlines are kept (they end sentences). */
export function stripCitations(text: string): string {
  return text
    .replace(new RegExp(CITATION_PATTERN.source, 'g'), ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

const ABBREVIATION = /(?:^|[^A-Za-z])(?:Sec|Secs|No|Nos|(?:[A-Z]\.)+[A-Z])$/;

/**
 * A sentence ends at . ! ? followed by space or end, or at a line break (list items).
 * A "." after "Sec" or inside an initialism ("U.S.C.") is not an end; "Part A." is.
 */
function countSentences(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) {
    if (!/[A-Za-z0-9]/.test(line)) continue;
    // Starting only at the beginning of a run keeps this linear on "!!!!!!!x".
    const re = /(?<![.!?])[.!?]+(?=\s|$)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let ends = 0;
    while ((m = re.exec(line)) !== null) {
      const before = line.slice(last, m.index);
      if (m[0] === '.' && ABBREVIATION.test(before)) continue;
      if (/[A-Za-z0-9]/.test(before)) ends++;
      last = m.index + m[0].length;
    }
    const tail = line.slice(last);
    count += ends + (/[A-Za-z0-9]/.test(tail) ? 1 : 0);
  }
  return count;
}

/** Grade level of `text`, or null when it has no words. Citation markers are ignored. */
export function fleschKincaidGrade(text: string): number | null {
  const clean = stripCitations(text);
  const words = clean.match(/[A-Za-z0-9][A-Za-z0-9'’]*/g) ?? [];
  if (words.length === 0) return null;
  const sentences = Math.max(1, countSentences(clean));
  const syllables = words.reduce((n, w) => n + (countSyllables(w) || 1), 0);
  const grade =
    0.39 * (words.length / sentences) +
    11.8 * (syllables / words.length) -
    15.59;
  return Math.round(grade * 10) / 10;
}
