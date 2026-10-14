import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  NormalizedDoc,
  sectionText,
  walkSections,
  type Section,
  type SpanStatus,
} from '../model/index.js';
import {
  makeAmendmentHtml,
  makeStyledAmendmentHtml,
  type HtmlGroundTruth,
} from '../../../tests/synth/html.js';
import type { SyntheticSample } from '../../../tests/synth/types.js';
import {
  describeWithFixture,
  fixturePath,
} from '../../../tests/support/fixtures.js';
import { chunkDocument } from '../chunk/index.js';
import { parseHtml } from './html.js';

const options = {
  sourceUrl: 'https://example.com/bill.html',
  fetchedAt: '2026-10-13T00:00:00.000Z',
};

const parse = (html: string | Uint8Array) => parseHtml(html, options);
const page = (body: string, head = '') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('issue #69 HTML subdivisions', () => {
  it('merges <pre> sibling spans without repeating their headings or body lead-ins', () => {
    const doc = parse(
      page(
        '<pre>Sec. 4.\n(a) one\n\n\n(b) two\n(c) In general.— Residents may apply.</pre>',
      ),
    );
    const children = doc.sections[0]!.children;
    expect(children.map((s) => s.heading)).toEqual([
      undefined,
      undefined,
      'In general.—',
    ]);
    const merged = chunkDocument(doc).find((c) => c.coveredSectionIds);
    expect(merged?.text).toBe(
      '(a) one\n\n(b) two\n\n(c) In general.— Residents may apply.',
    );
    for (const chunk of chunkDocument(doc)) {
      for (const lead of ['(a) one', '(b) two', '(c) In general.—'])
        expect(chunk.text.split(lead).length - 1).toBeLessThanOrEqual(1);
      expect(chunk.text).not.toMatch(/\n{3,}/);
    }
  });

  it('retains titles explicitly printed in heading elements and uses amended title text', () => {
    const doc = parse(
      page(
        '<h2>Sec. 4. Definitions.</h2><h3>(a) <del>Obsolete</del> <ins>Current</ins> rules.</h3><p>Residents shall comply.</p><p>(b) Residents shall apply.</p>',
      ),
    );
    expect(doc.sections[0]!.children[0]!.heading).toBe('Current rules.');
    expect(doc.sections[0]!.children[1]!.heading).toBeUndefined();
    expect(
      chunkDocument(doc).find((c) => c.sectionId === 'sec-4/a')?.breadcrumb,
    ).toBe('Sec. 4 Definitions. > (a) Current rules.');
  });

  it('keeps inline body text out of dash headings after removing struck title words', () => {
    const doc = parse(
      page(
        '<p>Sec. 4.</p><p>(a) <del>Old</del> <ins>New</ins> rules.— Residents shall comply.</p>',
      ),
    );
    expect(doc.sections[0]!.children[0]!.heading).toBe('New rules.—');
  });
});

/**
 * Text of every span with this status, across the whole tree, in document order. Edge
 * whitespace is trimmed: collapsing the gap a deleted span leaves moves it into the struck text.
 */
function textWithStatus(sections: Section[], status: SpanStatus): string[] {
  return [...walkSections(sections)].flatMap((section) =>
    section.spans.filter((s) => s.status === status).map((s) => s.text.trim()),
  );
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

describe.each([
  ['amendment HTML', makeAmendmentHtml],
  ['styled amendment HTML', makeStyledAmendmentHtml],
] as [string, () => SyntheticSample<HtmlGroundTruth>][])(
  'parseHtml on synthetic %s',
  (_name, make) => {
    const { bytes, groundTruth } = make();
    const doc = parse(bytes);

    it('produces a valid html document with sections matching the ground truth', () => {
      expect(NormalizedDoc.safeParse(doc).success).toBe(true);
      expect(doc.format).toBe('html');
      expect(
        doc.sections.map((s) => [s.id, s.num, s.heading, s.level]),
      ).toEqual(
        groundTruth.sections.map((s) => [s.id, s.num, s.heading, s.level]),
      );
    });

    it('maps every strike and underline variant to span status', () => {
      expect(textWithStatus(doc.sections, 'deleted')).toEqual(
        groundTruth.deletedStrings.map((t) => t.trim()),
      );
      expect(textWithStatus(doc.sections, 'inserted')).toEqual(
        groundTruth.insertedStrings.map((t) => t.trim()),
      );
    });

    it('keeps body text and statuses per section (heading line leads the body)', () => {
      for (const [index, truth] of groundTruth.sections.entries()) {
        const parsed = doc.sections[index]!;
        for (const includeDeleted of [true, false]) {
          expect(squash(sectionText(parsed, { includeDeleted }))).toBe(
            squash(
              `Section ${truth.num!}. ${truth.heading!} ` +
                sectionText(truth, { includeDeleted }),
            ),
          );
        }
      }
    });

    it('drops page chrome and carries no printed coordinates', () => {
      const all = [...walkSections(doc.sections)]
        .map((s) => sectionText(s, { includeDeleted: true }))
        .join('');
      for (const noise of groundTruth.noiseStrings)
        expect(all).not.toContain(noise);
      for (const section of walkSections(doc.sections)) {
        expect(section).not.toHaveProperty('lineStart');
        expect(section).not.toHaveProperty('pageStart');
      }
    });
  },
);

describe('parseHtml amendment markup', () => {
  const status = (html: string, status: SpanStatus) =>
    textWithStatus(parse(page(html)).sections, status);

  it.each([
    ['<s>', '<s>x</s>'],
    ['<strike>', '<strike>x</strike>'],
    ['<del>', '<del>x</del>'],
    [
      'line-through style',
      '<span style="text-decoration: line-through">x</span>',
    ],
    [
      'text-decoration-line',
      '<span style="text-decoration-line:line-through">x</span>',
    ],
    [
      '!important and case',
      '<b style="TEXT-DECORATION: Line-Through !important">x</b>',
    ],
  ])('%s is deleted', (_name, markup) => {
    expect(status(`<p>a ${markup} b</p>`, 'deleted')).toEqual(['x']);
  });

  it.each([
    ['<u>', '<u>x</u>'],
    ['<ins>', '<ins>x</ins>'],
    ['underline style', '<span style="text-decoration:underline">x</span>'],
    [
      'text-decoration-line',
      '<span style="text-decoration-line: underline">x</span>',
    ],
  ])('%s is inserted', (_name, markup) => {
    expect(status(`<p>a ${markup} b</p>`, 'inserted')).toEqual(['x']);
  });

  it('lets a strike win when one element is both struck and underlined', () => {
    const html =
      '<p><span style="text-decoration: underline line-through">x</span></p>';
    expect(status(html, 'deleted')).toEqual(['x']);
    expect(status(html, 'inserted')).toEqual([]);
  });

  it('lets text-decoration none cancel the tag meaning of that element', () => {
    expect(
      status('<p>a <u style="text-decoration:none">x</u></p>', 'inserted'),
    ).toEqual([]);
  });

  it('treats an unrecognised decoration as unchanged', () => {
    expect(
      status(
        '<p><span style="text-decoration: overline">x</span></p>',
        'inserted',
      ),
    ).toEqual([]);
  });

  it('applies stylesheet class rules, including tag.class, lists and comments', () => {
    const head = `<style>
      /* a comment { text-decoration: underline } */
      .gone, span.cut { text-decoration: line-through }
      b.new { text-decoration-line: underline }
      a { text-decoration: underline }
      .a.b { text-decoration: underline }
      .plain { color: red }
    </style>`;
    const body = `<p><i class="gone">1</i> <span class="cut">2</span> <i class="cut">3</i>
      <b class="new">4</b> <i class="new">5</i> <a href="#">6</a> <i class="a b">7</i> <i class="plain">8</i></p>`;
    const { sections } = parse(page(body, head));
    expect(textWithStatus(sections, 'deleted')).toEqual(['1', '2']);
    expect(textWithStatus(sections, 'inserted')).toEqual(['4']);
  });

  it('lets inline style override a stylesheet class', () => {
    const head = '<style>.strike{text-decoration:line-through}</style>';
    const body =
      '<p><span class="strike" style="text-decoration:none">x</span></p>';
    expect(textWithStatus(parse(page(body, head)).sections, 'deleted')).toEqual(
      [],
    );
  });

  it('propagates marks to descendants and lets a strike beat an enclosing underline', () => {
    const { sections } = parse(
      page('<p>a <u>b <s>c</s> <b>d</b></u> <del><ins>e</ins></del></p>'),
    );
    expect(textWithStatus(sections, 'deleted')).toEqual(['c', 'e']);
    expect(textWithStatus(sections, 'inserted')).toEqual(['b', 'd']);
  });

  it('keeps marks that straddle a line break in <pre> on both lines', () => {
    const { sections } = parse(
      page('<pre>keep <s>gone\nalso gone</s> end</pre>'),
    );
    expect(textWithStatus(sections, 'deleted')).toEqual(['gone', 'also gone']);
  });
});

describe('parseHtml structure and noise', () => {
  it('strips nav, header, footer, script, style, noscript and head text', () => {
    const doc = parse(
      page(
        `<header>HEAD</header><nav>NAV</nav><script>var x='SCRIPT'</script>
         <noscript>NOSCRIPT</noscript><style>.a{}</style><p>Kept text.</p><footer>FOOT</footer>`,
        '<title>TITLE</title>',
      ),
    );
    const text = sectionText(doc.sections[0]!, { includeDeleted: true });
    expect(text).toBe('Kept text.');
  });

  it('finds sections and nested enumerations from block-level HTML', () => {
    const doc = parse(
      page(`<h1>Chapter 1</h1><h2>Section 5. Fees</h2>
        <p>(a) First rule.</p><p>(b) Second rule:</p><ul><li>(1) one</li><li>(2) two</li></ul>`),
    );
    const ids = [...walkSections(doc.sections)].map((s) => s.id);
    expect(ids).toEqual([
      'chapter-1',
      'chapter-1/sec-5',
      'chapter-1/sec-5/a',
      'chapter-1/sec-5/b',
      'chapter-1/sec-5/b/1',
      'chapter-1/sec-5/b/2',
    ]);
  });

  it('collapses whitespace in normal flow and honours <br> and table cells', () => {
    const doc = parse(
      page(
        `<p>  one \n\t two  <br>three</p><table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>`,
      ),
    );
    expect(sectionText(doc.sections[0]!, { includeDeleted: true })).toBe(
      'one two\nthree\na b\nc',
    );
  });

  it('preserves <pre> layout, blank lines and indentation, normalising CRLF', () => {
    const doc = parse(
      page(
        '<pre>\nSEC. 1. TITLE.\r\n\r\n    Indented   text &lt;DOC&gt;\n</pre>',
      ),
    );
    const section = doc.sections[0]!;
    expect(section.id).toBe('sec-1');
    expect(sectionText(section, { includeDeleted: true })).toBe(
      'SEC. 1. TITLE.\n\n    Indented   text <DOC>',
    );
  });

  it('puts text before the first heading in a preamble', () => {
    const doc = parse(
      page('<p>Intro words.</p><h2>Section 1. A</h2><p>Body.</p>'),
    );
    expect(doc.sections.map((s) => s.id)).toEqual(['preamble', 'sec-1']);
  });

  it('hashes the original bytes and accepts Uint8Array input', () => {
    const html = page('<p>Section 1. Hello</p>');
    const fromString = parse(html);
    const fromBytes = parse(new TextEncoder().encode(html));
    expect(fromBytes.docId).toBe(fromString.docId);
    expect(fromString.docId).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('parseHtml failures', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof AppError ? error.code : error;
    }
    return undefined;
  };

  it('rejects invalid source URL or timestamp', () => {
    expect(
      code(() => parseHtml('<p>x</p>', { ...options, sourceUrl: 'nope' })),
    ).toBe('INVALID_INPUT');
    expect(
      code(() => parseHtml('<p>x</p>', { ...options, fetchedAt: 'yesterday' })),
    ).toBe('INVALID_INPUT');
  });

  it('rejects bytes that are not UTF-8', () => {
    expect(code(() => parse(new Uint8Array([0xff, 0xfe, 0x3c])))).toBe(
      'PARSE_FAILED',
    );
    expect(code(() => parse(new Uint8Array([0x3c, 0xc3, 0x28])))).toBe(
      'PARSE_FAILED',
    );
  });

  it('rejects an unsupported declared charset', () => {
    expect(
      code(() => parse(Buffer.from('<meta charset="klingon-9"><p>x</p>'))),
    ).toBe('PARSE_FAILED');
  });

  it.each([
    ['empty input', ''],
    ['markup without text', page('<img src="x"><div> </div>')],
    ['only page chrome', page('<nav>menu</nav><script>1</script>')],
  ])('rejects %s', (_name, html) => {
    expect(code(() => parse(html))).toBe('PARSE_FAILED');
  });
});

describeWithFixture('us-s202-119-is-html', () => {
  it('parses the govinfo <pre> bill, keeping layout and finding sections', () => {
    const raw = readFileSync(fixturePath('us-s202-119-is-html')!);
    const doc = parse(raw);
    expect(NormalizedDoc.safeParse(doc).success).toBe(true);
    const top = doc.sections.map((s) => s.id);
    expect(top).toEqual(expect.arrayContaining(['sec-1', 'sec-2']));
    const sec1 = doc.sections.find((s) => s.id === 'sec-1')!;
    expect(sec1.heading).toBe('SHORT TITLE.');
    const text = sectionText(sec1, { includeDeleted: true });
    // <pre> indentation and the HTML-escaped brackets survive.
    expect(text).toContain('    This Act may be cited as');
    expect(text).toContain('Risk and Insure against');
    const preamble = doc.sections.find((s) => s.id === 'preamble')!;
    expect(sectionText(preamble, { includeDeleted: true })).toContain('<DOC>');
    expect(textWithStatus(doc.sections, 'deleted')).toEqual([]);
    expect(textWithStatus(doc.sections, 'inserted')).toEqual([]);
  });
});

describe('parseHtml review fixes', () => {
  /** Deleted words must not reach any non-deleted chunk's heading, breadcrumb or embedText. */
  function expectNoDeletedLeak(html: string, deleted: string[]): void {
    const doc = parse(html);
    expect(textWithStatus(doc.sections, 'deleted').join(' ')).toBeTruthy();
    const chunks = chunkDocument(doc).filter(
      (c) => c.amendmentStatus !== 'deleted',
    );
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      for (const word of deleted) {
        expect(chunk.heading ?? '').not.toContain(word);
        expect(chunk.breadcrumb).not.toContain(word);
        expect(chunk.embedText).not.toContain(word);
      }
    }
  }

  it('keeps deleted heading text out of heading, breadcrumb and embedText', () => {
    expectNoDeletedLeak(
      page(
        '<h3>Section 2. <strike>Old rate.</strike> <u>New rate.</u></h3><p>The rate is seven percent.</p>',
      ),
      ['Old rate'],
    );
    const doc = parse(
      page(
        '<h3>Section 2. <strike>Old rate.</strike> <u>New rate.</u></h3><p>x</p>',
      ),
    );
    expect(doc.sections[0]?.heading).toBe('New rate.');
  });

  it('drops the heading and num when the whole heading line is struck', () => {
    const html = page(
      '<h3><del>Section 3. Repealed heading.</del></h3><p>Body text.</p>',
    );
    expectNoDeletedLeak(html, ['Repealed', 'Sec. 3']);
    const sec = parse(html).sections[0]!;
    expect(sec.heading).toBeUndefined();
    expect(sec.num).toBeUndefined();
  });

  it('drops a struck subsection marker and heading from num and heading', () => {
    const html = page(
      '<pre>SEC. 1. TAX.\n  <strike>(a) Zebra rate.</strike>\n  (b) Kept rate.\n</pre>',
    );
    const [a, b] = parse(html).sections[0]!.children;
    expect(a?.num).toBeUndefined();
    expect(a?.heading).toBeUndefined();
    expect(b?.num).toBe('(b)');
    expectNoDeletedLeak(html, ['Zebra']);
  });

  it('keeps bill content in <header>/<footer> inside <article> or <main>', () => {
    const doc = parse(
      page(`<header><h1>State Legislature</h1></header><nav>Home</nav>
<aside><h3>Related</h3><p>Sponsor info</p></aside>
<article><header><h2>HOUSE BILL 12</h2><p>AN ACT relating to taxes.</p></header>
<h3>Section 1. Rate.</h3><p>Seven percent.</p>
<footer><p>Section 3. Effective date. This act takes effect July 1.</p></footer></article>
<h3>Section 4. Money.</h3><footer>Copyright State</footer>`),
    );
    const all = [...walkSections(doc.sections)]
      .map((s) => sectionText(s, { includeDeleted: true }))
      .join('\n');
    expect(all).toContain('HOUSE BILL 12');
    expect(all).toContain('AN ACT relating to taxes.');
    expect(doc.sections.map((s) => s.id)).toEqual(
      expect.arrayContaining(['sec-1', 'sec-3', 'sec-4']),
    );
    expect(all).not.toMatch(/State Legislature|Home|Related|Copyright/);
    expect(doc.warnings).toEqual([]);
  });

  it('warns when stripped chrome looks like a section', () => {
    const doc = parse(
      page(
        '<h3>Section 1. A.</h3><p>x</p><footer>Section 9. Effective date.</footer><div hidden>Sec. 7 hidden</div>',
      ),
    );
    expect(doc.warnings).toHaveLength(2);
    expect(doc.warnings[0]).toContain('Section 9');
  });

  it('decodes the declared charset (windows-1252, iso-8859-1)', () => {
    const text = '<p>Section 1. \x93Rate\x94 \xa7 5 \x97 end.</p>';
    const latin = (head: string) =>
      new Uint8Array(Buffer.from(`${head}${text}`, 'latin1'));
    const expected = 'Section 1. \u201cRate\u201d \u00a7 5 \u2014 end.';
    for (const head of [
      '<meta charset="windows-1252">',
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">',
    ]) {
      const doc = parse(latin(head));
      expect(sectionText(doc.sections[0]!, { includeDeleted: true })).toContain(
        expected,
      );
    }
    const viaHeader = parseHtml(latin(''), {
      ...options,
      contentType: 'text/html; charset=iso-8859-1',
    });
    expect(
      sectionText(viaHeader.sections[0]!, { includeDeleted: true }),
    ).toContain('\u00a7 5');
    const utf8 = parse(
      new Uint8Array(
        Buffer.from('<meta charset="utf-8"><p>Section 1. \u00a7 5</p>'),
      ),
    );
    expect(sectionText(utf8.sections[0]!, { includeDeleted: true })).toContain(
      '\u00a7 5',
    );
  });

  it('does not overflow the stack on a 500k-character block', () => {
    const doc = parse(`<p>${'x'.repeat(500_000)}</p>`);
    expect(
      sectionText(doc.sections[0]!, { includeDeleted: true }),
    ).toHaveLength(500_000);
  });

  it('ignores underline classes on headings and links, and print-only rules', () => {
    const doc = parse(
      page(
        '<h2 class="t">SECTION 1. SHORT TITLE.</h2><p>See <a class="link" href="x">page</a>, <span class="hide">print</span>, <span class="ins">new</span>.</p>',
        `<style>h2.t, .link{text-decoration:underline}
@media print{.hide{text-decoration:underline}}
@media screen{.ins{text-decoration:underline}}</style>`,
      ),
    );
    expect(textWithStatus(doc.sections, 'inserted')).toEqual(['new']);
  });

  it('strips aside, hidden, aria-hidden and display:none content', () => {
    const doc = parse(
      page(
        '<h3>Section 1. A.</h3><p>keep</p><aside>side</aside><p hidden>h</p><p aria-hidden="true">ah</p><div style="color:red; display : none">dn</div>',
      ),
    );
    expect(sectionText(doc.sections[0]!, { includeDeleted: true })).toBe(
      'Section 1. A.\nkeep',
    );
  });

  it('collapses the gap a deleted span leaves in kept text', () => {
    const doc = parse(
      page(
        '<h3>Section 1. A.</h3><p>The rate is <s>five</s> seven percent and <s>x</s> <s>y</s> more.</p>',
      ),
    );
    expect(sectionText(doc.sections[0]!, { includeDeleted: false })).toBe(
      'Section 1. A.\nThe rate is seven percent and more.',
    );
  });

  describe('charset prescan', () => {
    const body = '<h3>Section 1. T.</h3><p>caf\xe9 \xa7</p>';
    const textOf = (doc: NormalizedDoc) =>
      sectionText(doc.sections[0]!, { includeDeleted: true });

    it('ignores a commented-out meta and uses the real one', () => {
      const doc = parse(
        Buffer.from(
          `<html><head><!-- <meta charset="windows-1252"> --><meta charset="utf-8"></head><body><h3>Section 1. T.</h3><p>café “q” §</p></body></html>`,
        ),
      );
      expect(textOf(doc)).toContain('café “q” §');
    });

    it('ignores a meta inside a script string', () => {
      const doc = parse(
        Buffer.from(
          `<html><head><script>var s="<meta charset=utf-16le>";</script><meta charset="windows-1252"></head><body>${body}</body></html>`,
          'latin1',
        ),
      );
      expect(textOf(doc)).toContain('café §');
    });

    it('ignores charset= text in a description content attribute', () => {
      const doc = parse(
        Buffer.from(
          `<html><head><meta name="description" content="a charset=windows-1252 guide"></head><body><h3>Section 1. T.</h3><p>café §</p></body></html>`,
        ),
      );
      expect(textOf(doc)).toContain('café §');
      expect(doc.warnings).toEqual([]);
    });

    it('prefers valid multibyte UTF-8 over a wrong meta label, with a warning', () => {
      const doc = parse(
        Buffer.from(
          `<meta charset="windows-1252"><h3>Section 1. T.</h3><p>café §</p>`,
        ),
      );
      expect(textOf(doc)).toContain('café §');
      expect(doc.warnings.join()).toMatch(/valid UTF-8/);
    });

    it('treats a meta-declared UTF-16 as UTF-8', () => {
      const doc = parse(
        Buffer.from(`<meta charset="utf-16"><h3>Section 1. T.</h3><p>café</p>`),
      );
      expect(textOf(doc)).toContain('café');
    });

    it('honours an honest windows-1252 page', () => {
      const doc = parse(
        Buffer.from(
          `<html><head><meta charset="windows-1252"></head><body>${body}</body></html>`,
          'latin1',
        ),
      );
      expect(textOf(doc)).toContain('café §');
      expect(doc.warnings).toEqual([]);
    });
  });

  describe('ids follow the refined num', () => {
    it('renumbers the id with the visible num, and its descendants', () => {
      const doc = parse(
        page(
          '<pre>Section <del>2</del><ins>3</ins>. Rate.\n  (a) First.\n    (1) Deep.\n</pre>',
        ),
      );
      const sec = doc.sections[0]!;
      expect(sec.num).toBe('3');
      expect(sec.id).toBe('sec-3');
      expect(sec.children[0]?.id).toBe('sec-3/a');
      expect(sec.children[0]?.children[0]?.id).toBe('sec-3/a/1');
    });

    it('keeps the original id for a fully struck section', () => {
      const sec = parse(
        page('<h3><del>Section 3. Gone.</del></h3><p>Body.</p>'),
      ).sections[0]!;
      expect(sec.num).toBeUndefined();
      expect(sec.id).toBe('sec-3');
    });

    it('disambiguates a refined id that collides with an existing one', () => {
      const doc = parse(
        page(
          '<h3>Section 3. Kept.</h3><p>a</p><h3>Section <del>2</del><ins>3</ins>. Replacement.</h3><p>b</p>',
        ),
      );
      const ids = doc.sections.map((s) => s.id);
      expect(ids).toEqual(['sec-3', 'sec-3~2']);
      expect(
        new Set([...walkSections(doc.sections)].map((s) => s.id)).size,
      ).toBe(2);
    });
  });

  it('does not leave kept text ending a line with spaces', () => {
    const doc = parse(
      page('<pre>SEC. 1. A.\nrate and <strike>5</strike>\nmore</pre>'),
    );
    const kept = doc.sections[0]!.spans.filter((s) => s.status !== 'deleted');
    expect(kept.map((s) => s.text).join('')).not.toMatch(/[ \t]\n/);
    expect(sectionText(doc.sections[0]!, { includeDeleted: true })).toBe(
      'SEC. 1. A.\nrate and 5\nmore',
    );
  });
});
