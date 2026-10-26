/**
 * Events the answer layer reports for operators. Counts and reason codes only: sentence text
 * comes from the model and the bill, and the server's structured log never carries either.
 */
export type AnswerLogEvent =
  | { event: 'excerpt_talk_dropped'; count: number }
  | { event: 'excerpt_talk_reworded'; count: number }
  | { event: 'regeneration_refused'; reason: string };

export type AnswerLog = (event: AnswerLogEvent) => void;
