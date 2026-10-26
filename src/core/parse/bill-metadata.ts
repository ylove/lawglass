import type { BillMetadata } from '../model/index.js';
import type { ChangeMarkContext } from './change-marks.js';
import { newJerseyMetadata } from './new-jersey.js';
import { newYorkMetadata } from './new-york.js';

/** Deterministic cover-page metadata for the states whose bills print a recognizable header. */
export function stateBillMetadata(
  text: string,
  context: ChangeMarkContext,
  /** PDF callers pass unfiltered text where a footer legend still survives. */
  legendText: string = text,
): BillMetadata {
  const ny = newYorkMetadata(text, context);
  return ny.source === 'none'
    ? newJerseyMetadata(text, context, legendText)
    : ny;
}
