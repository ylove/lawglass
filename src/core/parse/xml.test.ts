import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  NormalizedDoc,
  walkSections,
  type Section,
} from '../model/index.js';
import {
  fixturePath,
  describeWithFixture,
} from '../../../tests/support/fixtures.js';
import {
  makeCongressionalBillXml,
  makeUslmXml,
} from '../../../tests/synth/xml.js';
import { parseXml } from './xml.js';

const options = {
  sourceUrl: 'https://example.test/bill.xml',
  fetchedAt: '2026-10-13T12:00:00.000Z',
};

const parse = (xml: string) => parseXml(xml, options);
const ids = (sections: Section[]) =>
  [...walkSections(sections)].map((s) => s.id);
const bill = (body: string, attrs = '') =>
  `<?xml version="1.0"?><bill ${attrs}><legis-body>${body}</legis-body></bill>`;

function failure(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected parseXml to throw');
}

describe('congressional bill XML (synthetic)', () => {
  const { bytes, groundTruth } = makeCongressionalBillXml();
  const doc = parseXml(bytes, options);

  it('produces a valid NormalizedDoc with the expected section tree', () => {
    expect(NormalizedDoc.safeParse(doc).success).toBe(true);
    expect(doc.format).toBe('xml');
    expect(doc.docId).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(doc.sections).toEqual(groundTruth.sections);
    expect(doc.warnings).toEqual([]);
  });

  it('reads structured metadata from the form, not Dublin Core', () => {
    expect(doc.metadata).toEqual(groundTruth.metadata);
  });

  it('extracts definitions with their scope and external references', () => {
    expect(doc.definitions).toEqual(groundTruth.definitions);
    expect(doc.externalRefs).toEqual(groundTruth.externalRefs);
  });

  it('builds ids from enums and never from opaque XML ids', () => {
    expect(ids(doc.sections).join(' ')).not.toMatch(/id[0-9a-f]{32}/);
    expect(ids(doc.sections)).toEqual([
      'sec-1',
      'sec-1/a',
      'sec-1/a/1',
      'sec-2',
      'sec-3',
    ]);
  });

  it('accepts a string as well as bytes, with the same hash for the same bytes', () => {
    const fromString = parseXml(new TextDecoder().decode(bytes), options);
    expect(fromString).toEqual(doc);
  });

  it('tolerates the DOCTYPE and never fetches the DTD', () => {
    // The network guard in tests/setup.node.ts fails the test if a fetch/connect is attempted.
    const xml = bill(
      '<section><enum>1.</enum><header>One</header><text>Body.</text></section>',
    ).replace(
      '<bill',
      '<!DOCTYPE bill PUBLIC "-//US Congress//DTDs/bill.dtd//EN" "http://127.0.0.1:9/bill.dtd"><bill',
    );
    expect(parse(xml).sections[0]!.id).toBe('sec-1');
  });
});

describe('XML external entities and entity expansion', () => {
  const secretDir = mkdtempSync(join(tmpdir(), 'xxe-'));
  const secretFile = join(secretDir, 'secret.txt');
  writeFileSync(secretFile, 'TOP-SECRET-CONTENT');
  const withEntities = (declarations: string, reference: string) =>
    `<?xml version="1.0"?><!DOCTYPE bill [${declarations}]>` +
    bill(
      `<section><enum>1.</enum><text>Before ${reference} after.</text></section>`,
    ).replace('<?xml version="1.0"?>', '');

  it('does not read local files through a SYSTEM entity', () => {
    const error = failure(() =>
      parse(
        withEntities(`<!ENTITY xxe SYSTEM "file://${secretFile}">`, '&xxe;'),
      ),
    );
    expect(error.code).toBe('PARSE_FAILED');
    expect(error.message).not.toContain('TOP-SECRET-CONTENT');
    rmSync(secretDir, { recursive: true });
  });

  it('does not fetch a remote entity or parameter entity', () => {
    expect(
      failure(() =>
        parse(
          withEntities(
            '<!ENTITY xxe SYSTEM "http://127.0.0.1:9/evil">',
            '&xxe;',
          ),
        ),
      ).code,
    ).toBe('PARSE_FAILED');
    // An unused external declaration is skipped, not resolved.
    const doc = parse(
      withEntities(
        '<!ENTITY % remote SYSTEM "http://127.0.0.1:9/evil.dtd"> %remote;',
        'plain',
      ),
    );
    expect(doc.sections[0]!.spans[0]!.text).toBe('Before plain after.');
  });

  it('does not expand internal entities (entity-expansion bombs fail fast)', () => {
    const bomb = withEntities(
      '<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">',
      '&c;',
    );
    const started = Date.now();
    expect(failure(() => parse(bomb)).code).toBe('PARSE_FAILED');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still decodes the five predefined entities and numeric references', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><text>A &amp; B &lt; C &#x2014; D</text></section>',
      ),
    );
    expect(doc.sections[0]!.spans[0]!.text).toBe('A & B < C — D');
  });
});

describe('amendment markup in congressional bills', () => {
  it('maps ins/del (also nested and inside quoted blocks) to span status', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><header>Edit</header><text>Strike <del>old <ins>kept?</ins></del> and add <ins>new</ins>.</text>' +
          '<quoted-block><text>Quoted <del>gone</del>.</text></quoted-block></section>',
      ),
    );
    expect(doc.sections[0]!.spans).toEqual([
      { text: 'Strike ', status: 'unchanged' },
      { text: 'old kept?', status: 'deleted' },
      { text: ' and add ', status: 'unchanged' },
      { text: 'new', status: 'inserted' },
      { text: '. Quoted ', status: 'unchanged' },
      { text: 'gone', status: 'deleted' },
      { text: '.', status: 'unchanged' },
    ]);
  });

  it('excludes struck text from definitions', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><text>In this section:</text><paragraph><enum>(1)</enum>' +
          '<text>The term <term>widget</term> means a <del>tiny </del>thing.</text></paragraph></section>',
      ),
    );
    expect(doc.definitions).toEqual([
      {
        term: 'widget',
        text: 'The term widget means a thing.',
        sectionId: 'sec-1/1',
        scope: 'section',
        scopeSectionId: 'sec-1',
      },
    ]);
  });
});

describe('structure and ids', () => {
  it('nests divisions, titles and sections, keeping ids unique across divisions', () => {
    const doc = parse(
      bill(
        '<division><enum>A</enum><header>First</header><title><enum>I</enum><header>T</header>' +
          '<section><enum>101.</enum><header>X</header><text>x</text></section></title></division>' +
          '<division><enum>B</enum><header>Second</header>' +
          '<section><enum>101.</enum><header>Y</header><text>y</text></section></division>',
      ),
    );
    expect(ids(doc.sections)).toEqual([
      'division-A',
      'title-I',
      'sec-101',
      'division-B',
      'division-B/sec-101',
    ]);
    expect(doc.sections[0]!.children[0]!.children[0]!.level).toBe(3);
  });

  it('disambiguates repeated and missing enums', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><text>a</text><paragraph><enum>(1)</enum><text>p1</text></paragraph>' +
          '<paragraph><enum>(1)</enum><text>p1 again</text></paragraph><paragraph><text>no enum</text></paragraph></section>',
      ),
    );
    const all = ids(doc.sections);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain('sec-1/n3');
    expect(all.some((id) => id.includes('~2'))).toBe(true);
  });

  it('produces citation-safe ids even for odd enums', () => {
    const doc = parse(
      bill('<section><enum>[5 / 6] x.</enum><text>t</text></section>'),
    );
    expect(NormalizedDoc.safeParse(doc).success).toBe(true);
    expect(doc.sections[0]!.num).toBe('[5 / 6] x');
  });

  it('keeps nested quoted law as text of the quoting section, not as subsections', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><text>Amend by adding:</text><quoted-block><section><enum>9.</enum><header>New</header>' +
          '<text>Fresh rule (<external-xref legal-doc="usc" parsable-cite="usc/5/101">5 U.S.C. 101</external-xref>).</text></section></quoted-block></section>',
      ),
    );
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]!.children).toEqual([]);
    expect(doc.sections[0]!.spans[0]!.text).toBe(
      'Amend by adding: 9. New Fresh rule (5 U.S.C. 101).',
    );
    expect(doc.externalRefs.map((r) => r.citation)).toEqual(['5 U.S.C. 101']);
  });

  it('wraps <quote> in typographic quotes and renders tables with row and cell breaks', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><text>Say <quote>hello</quote><linebreak/>now.</text>' +
          '<table><tgroup><tbody><row><entry>A</entry><entry>B</entry></row><row><entry>C</entry><entry>D</entry></row></tbody></tgroup></table></section>',
      ),
    );
    expect(doc.sections[0]!.spans[0]!.text).toBe(
      'Say “hello” now.\nA | B\nC | D',
    );
  });

  it('skips tables of contents and handles CDATA', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><toc><toc-entry>1. Hidden</toc-entry></toc><text><![CDATA[<raw> & text]]></text></section>',
      ),
    );
    expect(doc.sections[0]!.spans[0]!.text).toBe('<raw> & text');
  });

  it('ignores text outside body sections and treats headerless appropriations levels as levels', () => {
    const doc = parse(
      bill(
        '<enacting-clause>Be it enacted</enacting-clause><appropriations-major><header>Dept</header>' +
          '<appropriations-intermediate><header>Office</header><text>Money.</text></appropriations-intermediate></appropriations-major>',
      ),
    );
    expect(ids(doc.sections)).toEqual([
      'appropriations-major-n1',
      'appropriations-intermediate-n1',
    ]);
    expect(doc.sections[0]!.heading).toBe('Dept');
  });
});

describe('definitions and references', () => {
  it('classifies scope as document, section or unknown and skips quoted definitions', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><text>For purposes of this section:</text><paragraph><enum>(1)</enum><text>The term <term>alpha</term> means a.</text></paragraph></section>' +
          '<section><enum>2.</enum><text>Words.</text><paragraph><enum>(1)</enum><text>The term <term>beta</term> means b.</text></paragraph></section>' +
          '<section><enum>3.</enum><text>Insert:</text><quoted-block><paragraph><enum>(1)</enum><text>The term <term>gamma</term> means g.</text></paragraph></quoted-block></section>' +
          '<section><enum>4.</enum><text>As used in this Act, the term <term>delta</term> means d, and <term>epsilon</term> is a word.</text></section>' +
          '<section><enum>5.</enum><text>The <term>zeta</term> is bold.</text></section>',
      ),
    );
    expect(
      doc.definitions.map((d) => [
        d.term,
        d.scope,
        d.sectionId,
        d.scopeSectionId,
      ]),
    ).toEqual([
      ['alpha', 'section', 'sec-1/1', 'sec-1'],
      ['beta', 'unknown', 'sec-2/1', undefined],
      ['delta', 'document', 'sec-4', undefined],
      ['epsilon', 'document', 'sec-4', undefined],
    ]);
  });

  it('normalizes citations, merges repeats and lists every citing section', () => {
    const xref = (attrs: string, text: string) =>
      `<external-xref ${attrs}>${text}</external-xref>`;
    const doc = parse(
      bill(
        `<section><enum>1.</enum><text>${xref('legal-doc="usc" parsable-cite="usc/7/1a"', '7 U.S.C. 1a')} ${xref('legal-doc="public-law" parsable-cite="public-law/117/58"', 'Public Law 117-58')} ${xref('legal-doc="regulation"', '12 CFR 5')} ${xref('legal-doc="statute-at-large"', '')} ${xref('legal-doc="other"', '124 Stat. 119')}</text></section>` +
          `<section><enum>2.</enum><text>${xref('legal-doc="usc" parsable-cite="usc/7/1a"', 'seven USC 1a')} ${xref('legal-doc="usc" parsable-cite="usc/7/1a"', 'again')}</text></section>`,
      ),
    );
    expect(doc.externalRefs).toEqual([
      {
        text: '7 U.S.C. 1a',
        citation: '7 U.S.C. 1a',
        kind: 'us_code',
        sectionIds: ['sec-1', 'sec-2'],
      },
      {
        text: 'Public Law 117-58',
        citation: 'Pub. L. 117-58',
        kind: 'public_law',
        sectionIds: ['sec-1'],
      },
      {
        text: '12 CFR 5',
        citation: '12 CFR 5',
        kind: 'cfr',
        sectionIds: ['sec-1'],
      },
      {
        text: '124 Stat. 119',
        citation: '124 Stat. 119',
        kind: 'other',
        sectionIds: ['sec-1'],
      },
    ]);
  });
});

describe('metadata', () => {
  it('falls back to Dublin Core for the title and reports missing fields as null', () => {
    const doc = parse(
      '<bill bill-stage="Enrolled-Bill"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dublinCore><dc:title>HR 1 ENR: Short</dc:title></dublinCore></metadata>' +
        '<form><legis-num>H. R. 1</legis-num></form><legis-body><title><enum>I</enum><text>t</text></title></legis-body></bill>',
    );
    expect(doc.metadata).toEqual({
      title: 'HR 1 ENR: Short',
      billNumber: 'H. R. 1',
      jurisdiction: 'United States',
      session: null,
      version: 'Enrolled-Bill',
      sponsors: null,
      source: 'structured',
    });
  });

  it('lists sponsors and cosponsors in document order', () => {
    const doc = parse(
      '<resolution resolution-stage="Introduced"><form><session>2nd Session</session>' +
        '<action-desc><cosponsor>Mr. A</cosponsor> and <sponsor>Ms. B</sponsor></action-desc></form>' +
        '<legis-body><section><enum>1.</enum><text>x</text></section></legis-body></resolution>',
    );
    expect(doc.metadata.sponsors).toEqual(['Mr. A', 'Ms. B']);
    expect(doc.metadata.session).toBe('2nd Session');
    expect(doc.metadata.version).toBe('Introduced');
  });
});

describe('USLM', () => {
  const { bytes, groundTruth } = makeUslmXml();
  const doc = parseXml(bytes, options);

  it('maps ins/del to span status across nested levels', () => {
    expect(doc.sections).toEqual(groundTruth.sections);
    expect(doc.warnings).toEqual([]);
    expect(doc.metadata.title).toBe('Synthetic Seed Library Amendment');
    expect(doc.metadata.source).toBe('structured');
    const spans = [...walkSections(doc.sections)].flatMap((s) => s.spans);
    expect(
      spans.filter((s) => s.status === 'deleted').map((s) => s.text),
    ).toEqual(groundTruth.deletedStrings);
    expect(
      spans.filter((s) => s.status === 'inserted').map((s) => s.text),
    ).toEqual(groundTruth.insertedStrings);
  });

  it('links into the U.S. Code and public laws become external references', () => {
    const uslm = parse(
      '<bill xmlns="http://xml.house.gov/schemas/uslm/1.0"><main><section><num value="1">Section 1.</num>' +
        '<content><p>See <ref href="/us/usc/t15/s632">15 U.S.C. 632</ref>, <ref href="/us/pl/117/58">Pub. L. 117-58</ref> and <ref href="/us/stat/1">stat</ref>.</p></content></section></main></bill>',
    );
    expect(uslm.externalRefs.map((r) => [r.citation, r.kind])).toEqual([
      ['15 U.S.C. 632', 'us_code'],
      ['Pub. L. 117-58', 'public_law'],
    ]);
  });
});

describe('Akoma Ntoso and generic fallback', () => {
  it('detects Akoma Ntoso and parses it generically with a warning', () => {
    const doc = parse(
      '<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0"><act><meta><identification><FRBRWork/></identification></meta>' +
        '<preface><docTitle>The Sample Act</docTitle></preface><body><chapter eId="c1"><num>Chapter I</num><heading>General</heading>' +
        '<article eId="a1"><num>Article 1</num><heading>Scope</heading><paragraph><num>1.</num><content><p>This applies <del>never</del><ins>always</ins>.</p></content></paragraph></article></chapter></body></act></akomaNtoso>',
    );
    expect(doc.warnings).toEqual([
      'Akoma Ntoso detected; parsed using generic num/heading rules.',
    ]);
    expect(doc.metadata.title).toBe('The Sample Act');
    expect(ids(doc.sections)).toEqual([
      'chapter-I',
      'article-1',
      'article-1/1',
    ]);
    expect(doc.sections[0]!.children[0]!.children[0]!.spans).toEqual([
      { text: 'This applies ', status: 'unchanged' },
      { text: 'never', status: 'deleted' },
      { text: 'always', status: 'inserted' },
      { text: '.', status: 'unchanged' },
    ]);
  });

  it('parses unknown schemas by num/heading children and warns', () => {
    const doc = parse(
      '<law><info><title>Local Ordinance</title></info><part><heading>General</heading><item><num>1.1</num><p>First.</p><p>Second.</p></item></part></law>',
    );
    expect(doc.warnings).toEqual([
      'Unrecognized XML schema; parsed using generic num/heading rules.',
    ]);
    expect(ids(doc.sections)).toEqual(['part-n1', 'item-1.1']);
    expect(doc.sections[0]!.children[0]!.spans[0]!.text).toBe('First. Second.');
  });

  it('falls back to one section holding all text when no structure exists', () => {
    const doc = parse('<memo><p>Just some text.</p><p>More.</p></memo>');
    expect(doc.sections).toEqual([
      {
        id: 'doc',
        level: 1,
        spans: [{ text: 'Just some text. More.', status: 'unchanged' }],
        children: [],
      },
    ]);
    expect(doc.warnings).toContain(
      'No sections found in the XML; the whole text is one section.',
    );
  });

  it('treats a bill with no legis-body generically', () => {
    const doc = parse('<bill><section><num>1</num><p>Hi.</p></section></bill>');
    expect(doc.warnings[0]).toMatch(/without a legis-body/);
    expect(doc.sections[0]!.id).toBe('sec-1');
  });
});

describe('failure paths', () => {
  it.each([
    ['empty input', ''],
    ['text that is not XML', 'hello world'],
    ['unclosed elements', '<bill><legis-body><section>'],
    ['mismatched tags', '<a><b></a></b>'],
    ['an undeclared entity', '<a>&nbsp;</a>'],
    ['no text at all', '<a/>'],
  ])('throws PARSE_FAILED for %s', (_name, xml) => {
    expect(failure(() => parse(xml)).code).toBe('PARSE_FAILED');
  });

  it('rejects pathological nesting without overflowing the stack', () => {
    const deep = '<a>'.repeat(5000) + 'x' + '</a>'.repeat(5000);
    expect(failure(() => parse(deep)).code).toBe('PARSE_FAILED');
  });

  it('rejects invalid options', () => {
    expect(
      failure(() => parseXml('<a>x</a>', { ...options, sourceUrl: 'nope' }))
        .code,
    ).toBe('INVALID_INPUT');
    expect(
      failure(() =>
        parseXml('<a>x</a>', { ...options, fetchedAt: 'yesterday' }),
      ).code,
    ).toBe('INVALID_INPUT');
  });

  it('decodes the declared encoding and rejects bytes that do not match it', () => {
    const latin1 = Buffer.from(
      '<?xml version="1.0" encoding="ISO-8859-1"?><bill><legis-body><section><enum>1.</enum><text>caf\xe9</text></section></legis-body></bill>',
      'latin1',
    );
    expect(parseXml(latin1, options).sections[0]!.spans[0]!.text).toBe('café');
    const badUtf8 = Buffer.from([
      0x3c, 0x61, 0x3e, 0xff, 0x3c, 0x2f, 0x61, 0x3e,
    ]);
    expect(failure(() => parseXml(badUtf8, options)).code).toBe('PARSE_FAILED');
    const unknown = Buffer.from(
      '<?xml version="1.0" encoding="klingon"?><a>x</a>',
    );
    expect(failure(() => parseXml(unknown, options)).code).toBe('PARSE_FAILED');
  });
});

describeWithFixture('us-s202-119-is', () => {
  // describeWithFixture still runs this callback when skipped, so parse lazily in the tests.
  let cached: NormalizedDoc | undefined;
  const load = () =>
    (cached ??= parseXml(
      readFileSync(fixturePath('us-s202-119-is')!),
      options,
    ));

  it('parses to the S.202 section tree', () => {
    const doc = load();
    expect(NormalizedDoc.safeParse(doc).success).toBe(true);
    expect(doc.sections.map((s) => [s.id, s.num, s.heading])).toEqual([
      ['sec-1', '1', 'Short title'],
      ['sec-2', '2', 'Definitions'],
      ['sec-3', '3', 'Helping Small Businesses Thrive Program'],
      ['sec-4', '4', expect.any(String)],
      ['sec-5', '5', expect.any(String)],
    ]);
    expect([...walkSections(doc.sections)]).toHaveLength(105);
    const eligible = doc.sections[1]!.children[3]!;
    expect(eligible.id).toBe('sec-2/4');
    expect(eligible.children.map((c) => c.id)).toEqual([
      'sec-2/4/A',
      'sec-2/4/B',
    ]);
    expect(eligible.children[1]!.children.map((c) => c.id)).toEqual(
      ['i', 'ii', 'iii', 'iv', 'v', 'vi'].map((n) => `sec-2/4/B/${n}`),
    );
    expect(new Set(ids(doc.sections)).size).toBe(105);
  });

  it('reads metadata, definitions and references', () => {
    const doc = load();
    expect(doc.metadata).toMatchObject({
      billNumber: 'S. 202',
      session: '119th CONGRESS, 1st Session',
      version: 'Introduced-in-Senate',
      sponsors: ['Mrs. Shaheen', 'Mr. Cassidy'],
      source: 'structured',
    });
    expect(doc.metadata.title).toMatch(/^To require the Administrator/);
    expect(doc.definitions.map((d) => d.term)).toContain('covered commodity');
    expect(doc.definitions.every((d) => d.scope === 'document')).toBe(true);
    expect(doc.externalRefs.map((r) => r.citation)).toContain('7 U.S.C. 1a');
    expect(doc.warnings).toEqual([]);
  });
});

describeWithFixture('us-hr5009-118-enr', () => {
  it('parses the 5.6 MB NDAA quickly and within a bounded memory growth', () => {
    const bytes = readFileSync(fixturePath('us-hr5009-118-enr')!);
    const heapBefore = process.memoryUsage().heapUsed;
    const started = Date.now();
    const doc = parseXml(bytes, options);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(1.5e9);
    expect(doc.sections.map((s) => s.id).slice(-7)).toEqual(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((d) => `division-${d}`),
    );
    const all = ids(doc.sections);
    expect(all.length).toBeGreaterThan(8000);
    expect(new Set(all).size).toBe(all.length);
    expect(doc.metadata.billNumber).toBe('H. R. 5009');
    expect(doc.metadata.sponsors).toBeNull();
  });
});
