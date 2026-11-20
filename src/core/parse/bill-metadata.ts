import type { BillMetadata } from '../model/index.js';
import type { ChangeMarkContext } from './change-marks.js';
import { newJerseyMetadata } from './new-jersey.js';
import { newYorkMetadata } from './new-york.js';
import { pennsylvaniaMetadata } from './pennsylvania.js';

/** Deterministic cover-page metadata for the states whose bills print a recognizable header. */
export function stateBillMetadata(
  text: string,
  context: ChangeMarkContext,
  /** PDF callers pass unfiltered text where a footer legend still survives. */
  legendText: string = text,
): BillMetadata {
  const ny = newYorkMetadata(text, context);
  if (ny.source !== 'none') return ny;
  const nj = newJerseyMetadata(text, context, legendText);
  return nj.source === 'none' ? pennsylvaniaMetadata(text, context) : nj;
}
