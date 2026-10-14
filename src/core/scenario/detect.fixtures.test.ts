/** Local-only: real bills from fixtures/downloads (skipped when absent). */
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import {
  describeWithFixture,
  fixturePath,
} from '../../../tests/support/fixtures.js';
import { parsePdf, parseXml } from '../parse/index.js';
import type { NormalizedDoc } from '../model/index.js';
import { classifyBill } from './detect.js';

const base = {
  sourceUrl: 'https://search-prod.lis.state.oh.us/fixture.pdf',
  fetchedAt: '2026-10-13T00:00:00.000Z',
};

for (const name of ['oh-hb62-135-in', 'oh-sb113-136-in', 'oh-sb203-133-in']) {
  describeWithFixture(name, () => {
    let doc: NormalizedDoc;
    beforeAll(async () => {
      doc = await parsePdf(readFileSync(fixturePath(name)!), base);
    });
    it('is single-subject', () => {
      expect(classifyBill(doc.sections)).toBe('single-subject');
    });
  });
}

describeWithFixture('us-hr5009-118-enr', () => {
  it('the NDAA is omnibus', () => {
    const doc = parseXml(readFileSync(fixturePath('us-hr5009-118-enr')!), {
      sourceUrl: 'https://www.govinfo.gov/fixture.xml',
      fetchedAt: '2026-10-13T00:00:00.000Z',
    });
    expect(classifyBill(doc.sections)).toBe('omnibus');
  });
});
