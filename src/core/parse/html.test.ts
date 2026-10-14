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
import { parseHtml } from './html.js';

const options = {
  sourceUrl: 'https://example.com/bill.html',
  fetchedAt: '2026-10-13T00:00:00.000Z',
};

const parse = (html: string | Uint8Array) => parseHtml(html, options);
const page = (body: string, head = '') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

/** Text of every span with this status, across the whole tree, in document order. */
function textWithStatus(sections: Section[], status: SpanStatus): string[] {
  return [...walkSections(sections)].flatMap((section) =>
    section.spans.filter((s) => s.status === status).map((s) => s.text),
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
        groundTruth.deletedStrings,
      );
      expect(textWithStatus(doc.sections, 'inserted')).toEqual(
        groundTruth.insertedStrings,
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
    expect(textWithStatus(sections, 'inserted')).toEqual(['b ', ' d']);
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
