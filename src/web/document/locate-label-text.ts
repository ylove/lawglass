import type { LocateLabel } from '../../core/model/index.js';

/** One source for the status words, shared by the card chip and the copied receipt. */
export const LABEL_TEXT: Record<LocateLabel, string> = {
  added: 'Added by this bill',
  removed: 'Being removed by this bill',
  changed: 'Changed by this bill',
  existing: 'Already law, reprinted unchanged',
  'in-bill': 'In this bill',
};
