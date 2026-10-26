import type { AnswerResult } from '../../core/model/index.js';

/**
 * "Reading level: grade 7" in small muted text. Shows the measured grade, so the reader can
 * see the 7th-grade target is checked and not just claimed. Declines say nothing about the
 * bill, so they get no line.
 */
export function ReadingLevel({
  answer,
}: {
  answer: Pick<AnswerResult, 'readingGrade' | 'simplified' | 'declined'> &
    Partial<Pick<AnswerResult, 'provider'>>;
}) {
  // Chips answered from stored data (sponsors, history) report provider 'none': a grade for a
  // list of names would mean nothing.
  if (
    answer.readingGrade === null ||
    answer.declined ||
    answer.provider === 'none'
  )
    return null;
  // Flesch-Kincaid can dip below 1 on very short text; "grade -1" would only confuse.
  const grade = Math.max(1, Math.round(answer.readingGrade));
  return (
    <p className="muted reading-level">
      Reading level: grade {grade}
      {answer.simplified ? ' (simplified)' : ''}
    </p>
  );
}
