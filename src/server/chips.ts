import type { ClientConfig } from '../core/model/index.js';

/**
 * Labels the UI shows on the question chips. TODO(#31): derive from the chip definitions in
 * core/chips.ts once that lands; until then this list mirrors the ChipId enum.
 */
export const CHIP_LABELS: ClientConfig['chips'] = [
  { id: 'summary', label: 'Summarize this bill' },
  { id: 'what-changes', label: 'What does it change?' },
  { id: 'who-affected', label: 'Who does it affect?' },
  { id: 'history', label: 'How did it get here?' },
  { id: 'penalties', label: 'Penalties and enforcement' },
  { id: 'effective-date', label: 'When does it take effect?' },
  { id: 'money', label: 'Taxes, fees, and spending' },
  { id: 'definitions', label: 'Key definitions' },
  { id: 'sponsors', label: 'Who sponsored it?' },
];
