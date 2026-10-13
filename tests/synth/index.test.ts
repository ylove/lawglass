import { describe, expect, it } from 'vitest';
import {
  makeAmendingBillPdf,
  makeScannedPdf,
  makeFederalStylePdf,
  makeCongressionalBillXml,
  makeUslmXml,
  makeAmendmentHtml,
  makeSectionedText,
  makeInjectionText,
  type SyntheticSample,
} from './index.js';

const generators: {
  name: string;
  make: () => SyntheticSample | Promise<SyntheticSample>;
}[] = [
  { name: 'amending PDF', make: makeAmendingBillPdf },
  {
    name: 'three-page amending PDF',
    make: () => makeAmendingBillPdf({ pageCount: 3 }),
  },
  { name: 'scanned PDF', make: makeScannedPdf },
  { name: 'federal PDF', make: makeFederalStylePdf },
  { name: 'congressional XML', make: makeCongressionalBillXml },
  { name: 'USLM XML', make: makeUslmXml },
  { name: 'amendment HTML', make: makeAmendmentHtml },
  { name: 'sectioned text', make: makeSectionedText },
  { name: 'injection text', make: makeInjectionText },
];

describe('synthetic sample API', () => {
  it.each(generators)(
    '$name produces identical bytes and independent ground truth on every call',
    async ({ make }) => {
      const first = await make();
      const second = await make();
      expect(first).toEqual(second);
      expect(first.bytes.byteLength).toBeGreaterThan(0);
      expect(first.bytes.buffer).not.toBe(second.bytes.buffer);
      first.bytes.fill(0);
      first.groundTruth.deletedStrings.push('test mutation');
      first.groundTruth.sections.splice(0);
      expect(await make()).toEqual(second);
    },
  );
});
