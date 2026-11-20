/**
 * Real Pennsylvania bills stay local (see scripts/fetch-fixtures.ts); every suite skips when its
 * file is absent. Expected runs were counted on the extracted text layer and the drawn rules of
 * the official PDFs, and the bracket pairs were checked against the printed brackets.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import {
  describeWithFixtureAsync as describeWithFixture,
  fixturePathAsync as fixturePath,
} from '../../../tests/support/fixtures.js';
import { readManifest } from '../../../scripts/fixture-manifest.js';
import {
  sectionText,
  walkSections,
  type NormalizedDoc,
  type Span,
} from '../model/index.js';
import { parsePdf } from './pdf.js';
import { pennsylvaniaSections } from './change-marks.js';

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const spans = (doc: NormalizedDoc): Span[] =>
  [...walkSections(doc.sections)].flatMap((section) => section.spans);
/** Join a continued mark across printed lines and section boundaries. */
function runs(doc: NormalizedDoc, status: Span['status']): string[] {
  const found: string[] = [];
  let current = '';
  for (const span of spans(doc)) {
    // Whitespace between two words of one mark (a line break) belongs to the run.
    if (span.status === status || (!span.text.trim() && current))
      current += span.text;
    else if (span.text.trim() && current) {
      found.push(normalize(current));
      current = '';
    }
  }
  if (current) found.push(normalize(current));
  return found;
}
const currentLaw = (doc: NormalizedDoc): string =>
  normalize(
    [...walkSections(doc.sections)]
      .map((section) => sectionText(section, { includeDeleted: false }))
      .join(' '),
  );
function load(name: string): () => NormalizedDoc {
  let doc: NormalizedDoc;
  beforeAll(async () => {
    const fixture = readManifest().fixtures.find((f) => f.name === name)!;
    const bytes = readFileSync((await fixturePath(name))!);
    doc = await parsePdf(bytes, {
      sourceUrl: fixture.url,
      fetchedAt: '2026-11-19T00:00:00.000Z',
    });
  }, 120_000);
  return () => doc;
}
const noMarkWarnings = (doc: NormalizedDoc) =>
  doc.warnings.filter((w) => !w.includes('struck through and underlined'));

const gvw =
  '[with a gross weight or gross vehicle weight rating of greater than 17,000 pounds]';
await describeWithFixture('pa-hb170-2025-pn2721', () => {
  const doc = load('pa-hb170-2025-pn2721');
  it('amends existing law: two bracketed deletions and four underlined insertions', () => {
    expect(runs(doc(), 'deleted')).toEqual([gvw, gvw]);
    const inserted = runs(doc(), 'inserted');
    expect(inserted).toHaveLength(4);
    expect(inserted[0]).toMatch(/^\(i\.5\) Type AA--Such a farm vehicle/);
    expect(inserted.slice(2)).toEqual([
      ', Type AA, Type BB or Type CC',
      ', Type AA, Type BB or Type CC',
    ]);
    // Deleted old law is not current law; the inserted words are.
    expect(currentLaw(doc())).not.toContain(
      'gross vehicle weight rating of greater than 17,000 pounds]',
    );
    expect(currentLaw(doc())).toContain(
      'farm vehicles for which a Type D, Type AA, Type BB or Type CC biennial certificate',
    );
    expect(noMarkWarnings(doc())).toEqual([]);
  });
  it('reads the cover', () => {
    expect(doc().metadata).toMatchObject({
      billNumber: 'HB 170',
      jurisdiction: 'Pennsylvania',
      session: '2025-2026 Regular Session',
      version: "Printer's No. 2721",
      sponsors: ['LAWRENCE'],
      docKind: 'bill',
    });
    expect(doc().metadata.title).toMatch(
      /^Amending Title 75 \(Vehicles\) of the Pennsylvania Consolidated Statutes,/,
    );
  });
});

await describeWithFixture('pa-sb1273-2025-pn1610', () => {
  const doc = load('pa-sb1273-2025-pn1610');
  it('only adds new law: one underlined run, no deletions', () => {
    expect(runs(doc(), 'deleted')).toEqual([]);
    const inserted = runs(doc(), 'inserted');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatch(
      /^\(iv\) Preclude the provision of information to law enforcement/,
    );
    expect(inserted[0]).toMatch(
      /Pennsylvania Amber Alert System Law, or any successor system established by law\.$/,
    );
    expect(doc().metadata).toMatchObject({
      billNumber: 'SB 1273',
      version: "Printer's No. 1610",
      sponsors: ['BARTOLOTTA'],
    });
  });
});

await describeWithFixture('pa-hb150-2025-pn2066', () => {
  const doc = load('pa-hb150-2025-pn2066');
  it('reads a repealed section, printed whole in brackets, as deleted', () => {
    const deleted = runs(doc(), 'deleted');
    expect(deleted[0]).toMatch(
      /^\[§ 9777\. Transfer of inmates in need of medical treatment\./,
    );
    expect(deleted[0]).toMatch(/\]$/);
    // No bracket is left open, and the repealed text is not current law.
    expect(doc().warnings.join(' ')).not.toMatch(/not closed|unmatched/i);
    expect(currentLaw(doc())).not.toContain(
      'Transfer of inmates in need of medical treatment',
    );
    expect(runs(doc(), 'inserted')).toContain(
      '§ 9778. Modification of an imposed term of imprisonment for reasons of illness.',
    );
    // The cover's printer numbers are not insertions.
    expect(runs(doc(), 'inserted').join(' ')).not.toMatch(/PRINTER'S/);
    expect(doc().metadata.title).toContain(
      'repealing provisions relating to transfer of inmates',
    );
  });
});

await describeWithFixture('pa-hb2443-2025-pn4082', () => {
  const doc = load('pa-hb2443-2025-pn4082');
  it('a Senate-amended new act: struck text is deleted and capitals are insertions', () => {
    const deleted = runs(doc(), 'deleted');
    expect(deleted).toHaveLength(4);
    expect(deleted[0]).toMatch(
      /^"Indigent\." An individual determined by a court/,
    );
    expect(deleted[1]).toMatch(
      /^in each case in which any of the following applies:/,
    );
    expect(deleted[3]).toBe('(f)');
    const inserted = runs(doc(), 'inserted');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatch(
      /^ON EACH COVERED OFFENSE FOR WHICH A DEFENDANT IS CONVICTED/,
    );
    expect(currentLaw(doc())).not.toContain('"Indigent."');
    expect(doc().metadata).toMatchObject({
      billNumber: 'HB 2443',
      version: "Printer's No. 4082",
      sponsors: ['MULLINS'],
      title:
        'Providing for Child Victim Recovery Fee; establishing the Child Victim Recovery Fund; and imposing duties on the Pennsylvania Commission on Crime and Delinquency.',
    });
  });
});

for (const [name, billNumber, sponsor] of [
  ['pa-sr374-2025-pn1942', 'SR 374', 'HUTCHINSON'],
  ['pa-hr607-2025-pn3853', 'HR 607', 'SANCHEZ'],
  ['pa-hr125-2025-pn1009', 'HR 125', 'ROAE'],
] as const)
  await describeWithFixture(name, () => {
    const doc = load(name);
    it('a resolution has no change marks and is a resolution', () => {
      expect(runs(doc(), 'deleted')).toEqual([]);
      expect(runs(doc(), 'inserted')).toEqual([]);
      expect(noMarkWarnings(doc())).toEqual([]);
      expect(doc().metadata).toMatchObject({
        billNumber,
        jurisdiction: 'Pennsylvania',
        sponsors: [sponsor],
        docKind: 'resolution',
      });
    });
  });

await describeWithFixture('pa-sb605-2025-pn0613', () => {
  const doc = load('pa-sb605-2025-pn0613');
  it('a joint resolution is numbered as a bill but read as a resolution, with its insertion', () => {
    const inserted = runs(doc(), 'inserted');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatch(/^§ 33\. Interstate compacts\./);
    expect(runs(doc(), 'deleted')).toEqual([]);
    expect(doc().metadata).toMatchObject({
      billNumber: 'SB 605',
      docKind: 'resolution',
      title:
        'Proposing an amendment to the Constitution of the Commonwealth of Pennsylvania, providing for interstate compacts.',
    });
  });
});

await describeWithFixture('pa-hb918-2011-pn981', () => {
  const doc = load('pa-hb918-2011-pn981');
  it('a 2011 joint resolution with numbered directives is an amending measure read as a resolution', () => {
    expect(doc().metadata).toMatchObject({
      billNumber: 'HB 918',
      docKind: 'resolution',
      session: '2011-2012 Regular Session',
      version: "Printer's No. 981",
    });
    expect(runs(doc(), 'inserted').length).toBeGreaterThan(50);
    // The whole text parses with no unclosed-bracket or missing-cover warning.
    expect(noMarkWarnings(doc()).join(' ')).not.toMatch(/bracket|cover/i);
  });
});

await describeWithFixture('pa-hb2073-2019-pn2927', () => {
  const doc = load('pa-hb2073-2019-pn2927');
  it('one bracket pair enclosing quoted sections 404 to 406 deletes all of them', () => {
    expect(currentLaw(doc())).not.toMatch(/Section 40[456]\./);
    expect(currentLaw(doc())).not.toMatch(/[[\]]/);
    expect(runs(doc(), 'deleted').length).toBeGreaterThan(0);
    expect(doc().metadata.title).toMatch(/^Amending the act of June 24, 1931/);
  });
});

await describeWithFixture('pa-hr1-2025-pn1', () => {
  const doc = load('pa-hr1-2025-pn1');
  it('a resolution adopting chamber rules reads its bracketed deletions as deleted', () => {
    expect(runs(doc(), 'deleted').length).toBeGreaterThan(0);
    expect(currentLaw(doc())).not.toMatch(/[[\]]/);
    expect(doc().metadata).toMatchObject({
      billNumber: 'HR 1',
      docKind: 'resolution',
    });
  });
});

await describeWithFixture('pa-hb1257-1971-pn1408', () => {
  const doc = load('pa-hb1257-1971-pn1408');
  it('a constitutional amendment whose title names an article and section is amending', () => {
    expect(runs(doc(), 'deleted').length).toBeGreaterThan(0);
    expect(currentLaw(doc())).not.toMatch(/[[\]]/);
  });
});

const sectionCount = (doc: NormalizedDoc): number =>
  pennsylvaniaSections(
    spans(doc)
      .map((span) => span.text)
      .join('')
      .split('\n'),
  ).length;
await describeWithFixture('pa-hb150-2025-pn2066', () => {
  const doc = load('pa-hb150-2025-pn2066');
  it('detects all five bill sections, including the one with no directive', () => {
    expect(sectionCount(doc())).toBe(5);
    expect(doc().warnings.join(' ')).not.toMatch(/outside amended text/);
  });
});
await describeWithFixture('pa-hb2073-2019-pn2927', () => {
  const doc = load('pa-hb2073-2019-pn2927');
  it('detects every bill section, past the wrapped directives and decimal sections', () => {
    expect(sectionCount(doc())).toBeGreaterThanOrEqual(170);
    expect(doc().warnings.join(' ')).not.toMatch(/outside amended text/);
  });
});
