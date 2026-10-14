import type { AnswerResult } from '../../core/model/index.js';

export type Phase = 'searching' | 'writing' | 'done' | 'error';

/** One question and its streamed answer. Owned by DocumentView, which runs the SSE stream. */
export interface Turn {
  id: number;
  label: string;
  phase: Phase;
  text: string;
  result: AnswerResult | null;
  error: string | null;
}
