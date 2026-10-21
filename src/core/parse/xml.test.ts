import { SaxesParser } from 'saxes';
import { vi } from 'vitest';
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
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { chunkDocument } from '../chunk/index.js';
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

  it('reads structured metadata: form fields, with the short title from Dublin Core', () => {
    // The ground truth is the raw form text; the parser prefers the Dublin Core short title and
    // normalizes the session label.
    expect(doc.metadata).toEqual({
      ...groundTruth.metadata,
      title: 'Synthetic garden grants act',
      session: '119th Congress, 1st Session',
    });
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

  it('keeps each ordinary amendment body instruction before its own provision', () => {
    const doc = parse(
      '<amendment-doc>' +
        '<amendment-body><amendment-instruction>Insert the first provision.</amendment-instruction>' +
        '<amendment-block><section><enum>1.</enum><text>First provision.</text></section></amendment-block></amendment-body>' +
        '<amendment-body><amendment-instruction>Insert the second provision.</amendment-instruction>' +
        '<amendment-block><section><enum>2.</enum><text>Second provision.</text></section></amendment-block></amendment-body>' +
        '</amendment-doc>',
    );
    expect(
      doc.sections.map((s) => s.spans.map((span) => span.text).join('')),
    ).toEqual([
      'Insert the first provision.',
      'First provision.',
      'Insert the second provision.',
      'Second provision.',
    ]);
    expect(ids(doc.sections)).toEqual([
      'preamble',
      'sec-1',
      'preamble~2',
      'sec-2',
    ]);
    expect(doc.warnings).toEqual([]);
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
      { text: '. “Quoted ', status: 'unchanged' },
      { text: 'gone', status: 'deleted' },
      { text: '.”', status: 'unchanged' },
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

describe('committee-reported bill markup', () => {
  function expectReportedText(
    doc: NormalizedDoc,
    omitted: string[],
    retained: string[],
  ): void {
    const sections = [...walkSections(doc.sections)];
    const chunks = chunkDocument(doc);
    expect(chunks.length).toBeGreaterThan(0);
    for (const text of omitted) {
      expect(JSON.stringify(doc)).not.toContain(text);
      expect(JSON.stringify(chunks)).not.toContain(text);
    }
    const sectionText = sections
      .flatMap((s) => s.spans)
      .map((s) => s.text)
      .join(' ');
    const chunkText = chunks.map((c) => c.text).join(' ');
    for (const text of retained) {
      expect(sectionText).toContain(text);
      expect(chunkText).toContain(text);
    }
  }

  it.each([
    [
      'skips a section-scoped short title for the Act-level one',
      'This Act may be cited as the <quote><short-title>Shared Gardens Act</short-title></quote>.',
      'Shared Gardens Act',
    ],
    [
      'falls back to the official title when only a section is named',
      '',
      'To support gardens.',
    ],
  ])('reported bill title: %s', (_name, actText, expected) => {
    const substitute =
      '<section changed="added"><enum>1.</enum><header>Seed grants</header>' +
      '<subsection><enum>(a)</enum><header>Short title</header><text>This section may be cited as the <quote><short-title>Seed Library Grants Act</short-title></quote>.</text></subsection></section>' +
      (actText
        ? `<section changed="added"><enum>2.</enum><header>Short title</header><text>${actText}</text></section>`
        : '');
    const original =
      '<section changed="deleted"><enum>1.</enum><header>Abandoned grants</header><text>Fund obsolete orchards.</text></section>';
    const doc = parse(
      bill(original + substitute).replace(
        '<bill >',
        '<bill><metadata><dublinCore><title>119 S1 RS: Seed Library Grants Act</title></dublinCore></metadata>' +
          '<form><official-title>To support gardens.</official-title></form>',
      ),
    );
    expect(doc.metadata.title).toBe(expected);
  });

  it.each([false, true])(
    'keeps only the substitute, with stable ids (separate bodies: %s)',
    async (separateBodies) => {
      const substitute =
        '<section changed="added" reported-display-style="italic" committee-id="SYN00"><enum>1.</enum><header>Short title</header>' +
        '<text>This Act may be cited as the <quote><short-title>Shared Gardens Act</short-title></quote>.</text></section>' +
        '<section changed="added"><enum>2.</enum><header>Grants</header><text>Fund seed libraries.</text></section>';
      const original =
        '<section changed="deleted" reported-display-style="strikethrough" committee-id="SYN00"><enum>1.</enum><header>Abandoned title</header>' +
        '<text>This Act may be cited as the <quote><short-title>Obsolete Orchards Act</short-title></quote>.</text><paragraph changed="deleted"><text>Nested obsolete rule.</text></paragraph></section>' +
        '<section changed="deleted"><enum>2.</enum><header>Abandoned grants</header><text>Fund obsolete orchards.</text></section>';
      const bodyXml = separateBodies
        ? bill(original).replace(
            '</bill>',
            `<legis-body display-enacting-clause="no-display-enacting-clause">${substitute}</legis-body></bill>`,
          )
        : bill(original + substitute);
      const doc = parse(
        bodyXml.replace(
          '<bill >',
          '<bill><metadata><dublinCore><title>119 S1 RS: Obsolete Orchards Act</title></dublinCore></metadata>' +
            '<form><official-title>To support gardens.</official-title></form>',
        ),
      );
      expect(doc.metadata.title).toBe('Shared Gardens Act');
      expectReportedText(
        doc,
        ['Abandoned', 'Obsolete', 'obsolete'],
        ['Shared Gardens Act', 'Fund seed libraries.'],
      );
      expect(ids(doc.sections)).toEqual(['sec-1', 'sec-2']);
      expect(ids(doc.sections)).toEqual(ids(parse(bill(substitute)).sections));
      expect(doc.warnings).toEqual([
        'This is the version reported by committee. 2 passages the committee struck are left out; the text shown is the bill as reported.',
      ]);
      expect(
        [...walkSections(doc.sections)]
          .flatMap((s) => s.spans)
          .every((s) => s.status === 'unchanged'),
      ).toBe(true);

      const chunks = chunkDocument(doc);
      expect(chunks.every((c) => c.amendmentStatus === 'unchanged')).toBe(true);
      const backend = new MemoryBackend();
      await backend.upsertChunks(doc.docId, chunks);
      const { hits } = await backend.search({
        docId: doc.docId,
        index: 'sparse',
        query: 'obsolete',
        topK: 20,
      });
      expect(hits).toEqual([]);
      expect(
        (
          await backend.search({
            docId: doc.docId,
            index: 'sparse',
            query: 'libraries',
            topK: 20,
          })
        ).hits,
      ).toHaveLength(1);
    },
  );

  it('omits a nested paragraph before numbering its surviving siblings', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><header>Grants</header><text>Keep this introduction.</text>' +
          '<paragraph changed="deleted"><enum>(1)</enum><text>Abandoned paragraph.</text></paragraph>' +
          '<paragraph changed="added"><enum>(1)</enum><text>Replacement paragraph.</text></paragraph>' +
          '<paragraph><text>Unnumbered surviving paragraph.</text></paragraph></section>',
      ),
    );
    expectReportedText(
      doc,
      ['Abandoned'],
      [
        'Keep this introduction.',
        'Replacement paragraph.',
        'Unnumbered surviving paragraph.',
      ],
    );
    expect(ids(doc.sections)).toEqual(['sec-1', 'sec-1/1', 'sec-1/n2']);
    expect(doc.warnings).toEqual([
      'This is the version reported by committee. 1 passage the committee struck is left out; the text shown is the bill as reported.',
    ]);
  });

  it('treats added phrases as inline text, including word fragments and punctuation', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><header><deleted-phrase>Abandoned heading</deleted-phrase><added-phrase>Gardens</added-phrase></header>' +
          '<text>Support <deleted-phrase>obsolete plots</deleted-phrase><added-phrase>garden</added-phrase>s<added-phrase>,</added-phrase> today. ' +
          '<span changed="deleted">Abandoned phrase.</span><span changed="added">Keep this phrase.</span></text></section>',
      ),
    );
    expectReportedText(
      doc,
      ['Abandoned', 'obsolete'],
      ['Support gardens, today. Keep this phrase.'],
    );
    expect(doc.sections[0]!.heading).toBe('Gardens');
    expect(doc.sections[0]!.spans).toEqual([
      {
        text: 'Support gardens, today. Keep this phrase.',
        status: 'unchanged',
      },
    ]);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toContain('3 passages');
  });

  it('omits definitions and references before extraction, without counting repeated text walks', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><text>In this section, the term ' +
          '<deleted-phrase><term>obsolete group</term></deleted-phrase><term>garden group</term> means ' +
          '<deleted-phrase>an abandoned club</deleted-phrase><added-phrase>a shared garden</added-phrase>.</text>' +
          '<text>Use <external-xref changed="deleted" legal-doc="usc" parsable-cite="usc/5/999">5 U.S.C. 999</external-xref>' +
          '<external-xref changed="added" legal-doc="usc" parsable-cite="usc/5/101">5 U.S.C. 101</external-xref>.</text>' +
          '<paragraph changed="deleted"><text>The term <term>obsolete term</term> means abandoned material.</text></paragraph></section>',
      ),
    );
    expectReportedText(
      doc,
      ['obsolete', 'abandoned', '5 U.S.C. 999'],
      ['a shared garden', '5 U.S.C. 101'],
    );
    expect(doc.definitions).toEqual([
      {
        term: 'garden group',
        text: 'In this section, the term garden group means a shared garden.',
        sectionId: 'sec-1',
        scope: 'section',
        scopeSectionId: 'sec-1',
      },
    ]);
    expect(doc.externalRefs.map((r) => r.citation)).toEqual(['5 U.S.C. 101']);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toContain('4 passages');
  });

  it('counts an omitted subtree only once even with nested additions and deletions', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><text>Keep this.</text><wrapper changed="deleted">Abandoned wrapper' +
          '<deleted-phrase>Abandoned phrase</deleted-phrase><span changed="added">Abandoned addition</span>' +
          '<paragraph changed="deleted"><text>Abandoned paragraph</text></paragraph></wrapper></section>',
      ),
    );
    expectReportedText(doc, ['Abandoned'], ['Keep this.']);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toContain('1 passage');
  });

  it('preserves law-editing ins/del inside committee additions and quoted law', () => {
    const doc = parse(
      bill(
        '<section changed="added"><enum>1.</enum><quoted-block><section><enum>9.</enum>' +
          '<text>Use <deleted-phrase>abandoned</deleted-phrase><added-phrase>the <del>old rule</del><ins>new rule</ins></added-phrase>.</text>' +
          '<paragraph changed="deleted"><text>Abandoned quoted paragraph.</text></paragraph></section></quoted-block></section>',
      ),
    );
    expectReportedText(
      doc,
      ['abandoned', 'Abandoned'],
      ['old rule', 'new rule'],
    );
    expect(doc.sections[0]!.children).toEqual([]);
    expect(
      doc.sections[0]!.spans.filter((s) => s.status !== 'unchanged'),
    ).toEqual([
      { text: 'old rule', status: 'deleted' },
      { text: 'new rule', status: 'inserted' },
    ]);
    expect(
      chunkDocument(doc).some(
        (c) => c.amendmentStatus === 'deleted' && c.text === 'old rule',
      ),
    ).toBe(true);
    expect(doc.warnings[0]).toContain('2 passages');
  });

  it('does not warn or create amendment spans for a bill with only additions', () => {
    const doc = parse(
      bill(
        '<section changed="added"><enum>1.</enum><text changed="added">Fund <added-phrase>seed</added-phrase> libraries.</text>' +
          '<paragraph changed="added"><enum>(1)</enum><text>Keep records.</text></paragraph></section>',
      ),
    );
    expectReportedText(doc, [], ['Fund seed libraries.', 'Keep records.']);
    expect(doc.warnings).toEqual([]);
    expect(
      [...walkSections(doc.sections)]
        .flatMap((s) => s.spans)
        .every((s) => s.status === 'unchanged'),
    ).toBe(true);
    expect(
      chunkDocument(doc).every((c) => c.amendmentStatus === 'unchanged'),
    ).toBe(true);
  });

  it('prunes before preamble and unstructured fallback text is collected', () => {
    const doc = parse(
      bill(
        '<text changed="deleted">Abandoned preamble.</text><text>Keep the preamble.</text>',
      ),
    );
    expectReportedText(doc, ['Abandoned'], ['Keep the preamble.']);
    expect(doc.sections[0]!.id).toBe('preamble');
    const fallback = parse(
      '<root><p changed="deleted">Abandoned fallback.</p><p>Keep the fallback.</p></root>',
    );
    expectReportedText(fallback, ['Abandoned'], ['Keep the fallback.']);
    expect(fallback.sections[0]!.id).toBe('doc');
    expect(
      fallback.warnings.filter((w) => w.includes('reported by committee')),
    ).toHaveLength(1);
  });

  it.each([
    '<root changed="deleted">Abandoned root.</root>',
    '<deleted-phrase>Abandoned root.</deleted-phrase>',
    bill('<wrapper changed="deleted"><text>Abandoned body.</text></wrapper>'),
  ])('fails clearly when committee deletions leave no text: %s', (xml) => {
    const error = failure(() => parse(xml));
    expect(error.code).toBe('PARSE_FAILED');
    expect(error.message).toContain('contains no text');
    expect(error.message).not.toContain('Abandoned');
  });

  it('still validates XML inside an omitted subtree', () => {
    expect(
      failure(() =>
        parse(bill('<section changed="deleted"><text>Broken</section>')),
      ).code,
    ).toBe('PARSE_FAILED');
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
      'Amend by adding: “9. New Fresh rule (5 U.S.C. 101).”',
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
      'appropriations-major-dept',
      'appropriations-intermediate-office',
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
  it.each([false, true])(
    'keeps normal title precedence unless committee text was pruned: %s',
    (pruned) => {
      const doc = parse(
        '<bill><metadata><title>119 S1 RS: Front matter title</title></metadata>' +
          '<form><official-title>To support gardens.</official-title></form><legis-body>' +
          (pruned
            ? '<section changed="deleted"><header>Abandoned heading</header><text>Abandoned text.</text></section>'
            : '') +
          '<section><enum>1.</enum><header>Short title</header><text>This Act may be cited as the ' +
          '<quote><short-title>Shared Gardens Act</short-title></quote>.</text></section></legis-body></bill>',
      );
      expect(doc.metadata.title).toBe(
        pruned ? 'Shared Gardens Act' : 'Front matter title',
      );
      expect(JSON.stringify(doc)).not.toContain('Abandoned');
    },
  );

  it('prunes official title text and ignores short titles inside quoted law', () => {
    const doc = parse(
      '<bill><form><official-title>To fund <deleted-phrase>obsolete orchards</deleted-phrase>' +
        '<added-phrase>shared gardens</added-phrase>.</official-title></form><legis-body>' +
        '<section><enum>1.</enum><header><deleted-phrase>Abandoned heading</deleted-phrase><added-phrase>Grants</added-phrase></header>' +
        '<quoted-block><section><enum>9.</enum><text>This Act may be cited as the ' +
        '<quote><short-title>Existing Law Act</short-title></quote>.</text></section></quoted-block></section></legis-body></bill>',
    );
    expect(doc.metadata.title).toBe('To fund shared gardens.');
    expect(doc.sections[0]!.heading).toBe('Grants');
    expect(JSON.stringify(doc)).not.toMatch(/obsolete|Abandoned/);
  });

  it('takes the Dublin Core short title, minus its file prefix, and reports missing fields as null', () => {
    const doc = parse(
      '<bill bill-stage="Enrolled-Bill"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dublinCore><dc:title>HR 1 ENR: Short</dc:title></dublinCore></metadata>' +
        '<form><legis-num>H. R. 1</legis-num></form><legis-body><title><enum>I</enum><text>t</text></title></legis-body></bill>',
    );
    expect(doc.metadata).toEqual({
      title: 'Short',
      billNumber: 'H. R. 1',
      jurisdiction: 'United States',
      session: null,
      version: 'Enrolled-Bill',
      sponsors: null,
      source: 'structured',
    });
  });

  describe('Dublin Core title naming a short title', () => {
    const enrolled = (dcTitle: string, body: string): string =>
      '<bill bill-stage="Enrolled-Bill"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dublinCore>' +
      `<dc:title>HR 1 ENR: ${dcTitle}</dc:title></dublinCore></metadata>` +
      '<form><official-title>To provide for reconciliation.</official-title></form>' +
      `<legis-body>${body}</legis-body></bill>`;
    const cited = (scope: string, title: string): string =>
      `<section><enum>1.</enum><text>${scope} may be cited as the <quote><short-title>${title}</short-title></quote>.</text></section>`;

    it('falls back to the official title when the only matching short title is section-scoped', () => {
      const doc = parse(
        enrolled(
          'FEHB Protection Act of 2025',
          cited('This section', 'FEHB Protection Act of 2025'),
        ),
      );
      expect(doc.metadata.title).toBe('To provide for reconciliation.');
    });

    it('keeps it when an Act-level short title matches', () => {
      const doc = parse(enrolled('Big Act', cited('This Act', 'Big Act')));
      expect(doc.metadata.title).toBe('Big Act');
    });

    it('keeps it when the matching short title appears only in quoted law', () => {
      const doc = parse(
        enrolled(
          'Old Law Act',
          '<section><enum>1.</enum><quoted-block>' +
            cited('This Act', 'Old Law Act') +
            '</quoted-block></section>',
        ),
      );
      expect(doc.metadata.title).toBe('Old Law Act');
    });

    it('keeps it when it matches no short title in the body', () => {
      const doc = parse(
        enrolled('Disapproval of a rule', cited('This section', 'Other Act')),
      );
      expect(doc.metadata.title).toBe('Disapproval of a rule');
    });
  });

  it('lists only sponsors in document order, excluding interleaved cosponsors', () => {
    const doc = parse(
      '<resolution resolution-stage="Introduced"><form><session>2nd Session</session>' +
        '<action-desc><cosponsor>Mr. A</cosponsor> and <sponsor>Ms. B</sponsor>' +
        '<cosponsor>Ms. C</cosponsor><sponsor>Mr. D</sponsor><cosponsor>Mr. E</cosponsor></action-desc></form>' +
        '<legis-body><section><enum>1.</enum><text>x</text></section></legis-body></resolution>',
    );
    expect(doc.metadata.sponsors).toEqual(['Ms. B', 'Mr. D']);
    expect(doc.metadata.session).toBe('2nd Session');
    expect(doc.metadata.version).toBe('Introduced');
  });

  it('reports sponsors as null when the form lists only cosponsors', () => {
    const doc = parse(
      '<bill><form><action-desc><cosponsor>Mr. A</cosponsor>' +
        '<cosponsor>Ms. B</cosponsor></action-desc></form>' +
        '<legis-body><section><enum>1.</enum><text>x</text></section></legis-body></bill>',
    );
    expect(doc.metadata.sponsors).toBeNull();
    expect(doc.metadata.source).toBe('structured');
  });

  it('normalizes sponsor text and drops empty names without admitting cosponsors', () => {
    const doc = parse(
      '<bill><form><action-desc><sponsor/> <sponsor> \n </sponsor>' +
        '<sponsor> Ms. <bold>B</bold> \n Example </sponsor>' +
        '<cosponsor>Mr. A</cosponsor></action-desc></form>' +
        '<legis-body><section><enum>1.</enum><text>x</text></section></legis-body></bill>',
    );
    expect(doc.metadata.sponsors).toEqual(['Ms. B Example']);
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
    expect(ids(doc.sections)).toEqual(['part-general', 'item-1.1']);
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

describe('review fixes (resolutions, definitions, quoted law, metadata)', () => {
  const resolution =
    '<resolution resolution-stage="Introduced-in-Senate"><metadata/><form><congress>119th CONGRESS</congress>' +
    '<session>1st Session</session><legis-num>S. RES. 5</legis-num><official-title>Honoring a thing.</official-title></form>' +
    '<preamble><whereas><text>Whereas the sky is blue;</text></whereas></preamble>' +
    '<resolution-body><resolving-clause>Resolved,</resolving-clause><section><enum>1.</enum><header>Head</header><text>Resolved text.</text></section>' +
    '</resolution-body></resolution>';

  it('parses <resolution-body> with the bill dialect, keeping the preamble and form metadata', () => {
    const doc = parse(resolution);
    expect(ids(doc.sections)).toEqual(['preamble', 'sec-1']);
    expect(doc.sections[0]!.spans[0]!.text).toBe('Whereas the sky is blue;');
    expect(doc.sections[1]!.heading).toBe('Head');
    expect(doc.warnings).toEqual([]);
    expect(doc.metadata).toMatchObject({
      billNumber: 'S. RES. 5',
      title: 'Honoring a thing.',
      session: '119th Congress, 1st Session',
      version: 'Introduced-in-Senate',
      source: 'structured',
    });
  });

  it('keeps loose body text as a preamble and still skips the enacting clause', () => {
    const doc = parse(
      bill(
        '<enacting-clause>Be it enacted</enacting-clause><text>Loose text</text><section><enum>1.</enum><text>x</text></section>',
      ),
    );
    expect(ids(doc.sections)).toEqual(['preamble', 'sec-1']);
    expect(doc.sections[0]!.spans[0]!.text).toBe('Loose text');
  });

  it('reads <amendment-body> as a body too', () => {
    const doc = parse(
      '<amendment-doc><amendment-body><section><enum>1.</enum><text>x</text></section></amendment-body></amendment-doc>',
    );
    expect(ids(doc.sections)).toEqual(['sec-1']);
  });

  it('includes the subparagraphs of a multi-part definition', () => {
    const doc = parse(
      bill(
        '<section><enum>2.</enum><text>In this Act:</text><paragraph><enum>(4)</enum>' +
          '<text>The term <term>eligible entity</term>—</text>' +
          '<subparagraph><enum>(A)</enum><text>a lender; or</text></subparagraph>' +
          '<subparagraph><enum>(B)</enum><text>a borrower.</text></subparagraph></paragraph></section>',
      ),
    );
    expect(doc.definitions).toEqual([
      {
        term: 'eligible entity',
        text: 'The term eligible entity— (A) a lender; or (B) a borrower.',
        sectionId: 'sec-2/4',
        scope: 'document',
      },
    ]);
  });

  it('defines only the terms before the defining verb', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><text>The term <term>foreign national</term> has the meaning given the term <term>alien</term> in section 101.</text></section>',
      ),
    );
    expect(doc.definitions.map((d) => d.term)).toEqual(['foreign national']);
  });

  it('scopes "for the purpose of this section" and sub-section wording', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><subsection><enum>(c)</enum><text>For the purpose of this section, the term <term>alpha</term> means a.</text></subsection></section>' +
          '<section><enum>2.</enum><subsection><enum>(a)</enum><text>In this subsection:</text>' +
          '<paragraph><enum>(1)</enum><text>The term <term>beta</term> means b.</text></paragraph></subsection>' +
          '<subsection><enum>(b)</enum><paragraph><enum>(1)</enum><text>The term <term>gamma</term> means g.</text></paragraph></subsection></section>',
      ),
    );
    expect(
      doc.definitions.map((d) => [d.term, d.scope, d.scopeSectionId]),
    ).toEqual([
      ['alpha', 'section', 'sec-1'],
      ['beta', 'section', 'sec-2/a'],
      ['gamma', 'unknown', undefined],
    ]);
  });

  it('wraps quoted-block law in quotation marks but not the trailing after-quoted-block', () => {
    const doc = parse(
      bill(
        '<section><enum>1.</enum><text>Insert after section 9062:</text><quoted-block><section><enum>9062a.</enum><header>Report</header><text>Submit it.</text></section></quoted-block>' +
          '<after-quoted-block>, as amended.</after-quoted-block></section>',
      ),
    );
    expect(doc.sections[0]!.spans.map((s) => s.text).join('')).toBe(
      'Insert after section 9062: “9062a. Report Submit it.”, as amended.',
    );
  });

  it('normalizes spelled-out congress and session names', () => {
    const doc = parse(
      '<bill><form><congress>One Hundred Eighteenth Congress of the United States of America</congress><session>At the Second Session</session></form>' +
        '<legis-body><section><enum>1.</enum><text>x</text></section></legis-body></bill>',
    );
    expect(doc.metadata.session).toBe('118th Congress, 2nd Session');
  });

  it('builds ids for headings-only levels from the heading, not sibling order', () => {
    const doc = parse(
      bill(
        '<appropriations-major><header>Department of X</header><text>a</text></appropriations-major>' +
          '<appropriations-major><header>Department of X</header><text>b</text></appropriations-major>',
      ),
    );
    expect(ids(doc.sections)).toEqual([
      'appropriations-major-department-of-x',
      'appropriations-major-department-of-x~2',
    ]);
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
      session: '119th Congress, 1st Session',
      version: 'Introduced-in-Senate',
      sponsors: ['Mrs. Shaheen'],
      source: 'structured',
    });
    expect(doc.metadata.title).toMatch(
      /^Helping Small Businesses To Hedge Risk/,
    );
    expect(doc.definitions.map((d) => d.term)).toContain('covered commodity');
    expect(doc.definitions.every((d) => d.scope === 'document')).toBe(true);
    expect(doc.externalRefs.map((r) => r.citation)).toContain('7 U.S.C. 1a');
    expect(doc.warnings).toEqual([]);
  });
});

describeWithFixture('us-s3235-118-rs', () => {
  it('reads the reported substitute without the struck original or duplicate section ids', () => {
    const bytes = readFileSync(fixturePath('us-s3235-118-rs')!);
    const doc = parseXml(bytes, options);
    const sections = [...walkSections(doc.sections)];
    const chunks = chunkDocument(doc);
    expect(NormalizedDoc.safeParse(doc).success).toBe(true);
    expect(doc.metadata.title).toBe('End Iranian Terrorism Act of 2024');
    expect(doc.sections.map((s) => s.id)).toEqual(
      Array.from({ length: 7 }, (_, i) => `sec-${String(i + 1)}`),
    );
    expect(new Set(ids(doc.sections)).size).toBe(sections.length);
    expect(ids(parseXml(bytes, options).sections)).toEqual(ids(doc.sections));
    expect(doc.sections[0]!.spans.map((s) => s.text).join('')).toContain(
      'End Iranian Terrorism Act of 2024',
    );
    expect(JSON.stringify(doc)).not.toContain(
      'End Iranian Terrorism Act of 2023',
    );
    expect(JSON.stringify(chunks)).not.toContain(
      'End Iranian Terrorism Act of 2023',
    );
    expect(
      chunks.some((c) => c.text.includes('End Iranian Terrorism Act of 2024')),
    ).toBe(true);
    expect(
      sections.flatMap((s) => s.spans).every((s) => s.status === 'unchanged'),
    ).toBe(true);
    expect(chunks.every((c) => c.amendmentStatus === 'unchanged')).toBe(true);
    expect(doc.warnings).toEqual([
      'This is the version reported by committee. 5 passages the committee struck are left out; the text shown is the bill as reported.',
    ]);
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

it('stops between XML input chunks on ingest cancellation', () => {
  const controller = new AbortController();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- explicitly called with the parser as this below
  const original = SaxesParser.prototype.write;
  const write = vi
    .spyOn(SaxesParser.prototype, 'write')
    .mockImplementation(function (this: SaxesParser, chunk) {
      const result = original.call(this, chunk);
      controller.abort();
      return result;
    });
  try {
    expect(() =>
      parseXml('<root>' + '<p>Bill text.</p>'.repeat(10_000) + '</root>', {
        sourceUrl: 'https://example.gov/bill.xml',
        fetchedAt: '2026-10-13T00:00:00.000Z',
        signal: controller.signal,
      }),
    ).toThrow(/aborted/);
    expect(write).toHaveBeenCalledOnce();
  } finally {
    write.mockRestore();
  }
});

it('rejects XML when its synchronous parse exceeds the deadline', () => {
  const clock = vi
    .spyOn(performance, 'now')
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValue(11);
  try {
    expect(() =>
      parseXml('<root>Bill</root>', {
        sourceUrl: 'https://example.gov/bill.xml',
        fetchedAt: '2026-10-13T00:00:00.000Z',
        timeoutMs: 10,
      }),
    ).toThrow(/time budget/);
  } finally {
    clock.mockRestore();
  }
});
