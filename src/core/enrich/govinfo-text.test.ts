import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  makeLetteredUsCodePage,
  makeUsCodePage,
} from '../../../tests/synth/govinfo-uscode.js';
import {
  describeWithFixture,
  fixturePath,
} from '../../../tests/support/fixtures.js';
import {
  editionYear,
  findSubsection,
  findTermBlock,
  MAX_SECTION_CHARS,
  MAX_TERM_CHARS,
  parseUsCodePage,
  sectionPlainText,
  shorten,
} from './govinfo-text.js';

describe('parseUsCodePage', () => {
  const page = parseUsCodePage(makeUsCodePage());

  it('reads the printed heading and drops the page header, notes and source credit', () => {
    expect(page.heading).toBe('§9001. Definitions');
    const text = sectionPlainText(page);
    expect(text).toContain('As used in this chapter:');
    expect(text).not.toContain('United States Code, 2024 Edition');
    expect(text).not.toContain('Amendments');
    expect(text).not.toContain('Pub. L.');
  });

  it('decodes entities and keeps the nesting from the class names', () => {
    const hedges = page.lines.find((l) => l.text.includes('Hedges'));
    expect(hedges).toEqual({
      kind: 'body',
      level: 2,
      text: '(B) the Office of Hedges & Borders.',
    });
    expect(page.lines.find((l) => l.text.startsWith('(1) Garden'))).toEqual({
      kind: 'head',
      level: 2,
      text: '(1) Garden agency',
    });
  });

  it('reads a trimmed page that has no field markers', () => {
    const trimmed = parseUsCodePage(
      '<h3 class="section-head">&sect;5. Short</h3><p class="statutory-body">Text here.</p>',
    );
    expect(trimmed.heading).toBe('§5. Short');
    expect(trimmed.lines.map((l) => l.text)).toEqual(['Text here.']);
  });

  it('survives stray angle brackets and non-pages', () => {
    expect(parseUsCodePage('<<<<<<< not html >>>').lines).toEqual([]);
    expect(parseUsCodePage('').heading).toBeUndefined();
  });
});

describe('findTermBlock', () => {
  const page = parseUsCodePage(makeUsCodePage());

  it('cuts the block under a heading that names the term, with its nested lines', () => {
    const block = findTermBlock(page, ['garden agency']);
    expect(block).toBe(
      [
        '(1) Garden agency',
        'The term "garden agency" means—',
        '(A) the Bureau of Gardens; and',
        '(B) the Office of Hedges & Borders.',
      ].join('\n'),
    );
  });

  it('includes every subparagraph under the heading, and stops at the next paragraph', () => {
    const block = findTermBlock(page, ['Permit Holder']) ?? '';
    expect(block).toContain('(A) In general');
    expect(block).toContain('(B) Exclusion');
    expect(block).not.toContain('(3) Plot');
  });

  it('finds a paragraph that says `The term "X" means`, quoted either way or not at all', () => {
    expect(findTermBlock(page, ['trellis'])).toContain(
      'a frame that supports climbing plants',
    );
    expect(findTermBlock(page, ['mulch'])).toBe(
      'The term mulch means ground bark used to cover soil.',
    );
    // A sibling paragraph at the same indent is not part of the block, nor is the next heading.
    expect(findTermBlock(page, ['trellis'])).not.toContain('mulch');
    expect(findTermBlock(page, ['plot'])).not.toContain('trellis');
  });

  it('tries each lookup in turn and reports nothing for an unknown term', () => {
    expect(findTermBlock(page, ['no such term', 'plot'])).toContain('one acre');
    expect(findTermBlock(page, ['no such term'])).toBeUndefined();
    expect(findTermBlock(page, [''])).toBeUndefined();
  });

  it('does not treat regex characters in a term as a pattern', () => {
    expect(findTermBlock(page, ['.*'])).toBeUndefined();
    expect(findTermBlock(page, ['plot(s'])).toBeUndefined();
  });

  it('caps a term block and the whole-section fallback', () => {
    const long = `<h3 class="section-head">§1. Long</h3><h4 class="paragraph-head">(1) Big</h4><p class="statutory-body-1em">${'word '.repeat(2000)}</p>`;
    const parsed = parseUsCodePage(long);
    const block = findTermBlock(parsed, ['big']) ?? '';
    expect(block.length).toBeLessThanOrEqual(MAX_TERM_CHARS + 1);
    expect(block.endsWith('…')).toBe(true);
    expect(sectionPlainText(parsed).length).toBeLessThanOrEqual(
      MAX_SECTION_CHARS + 1,
    );
  });
});

describe('shorten', () => {
  it('leaves short text alone and cuts long text at a word', () => {
    expect(shorten('short', 10)).toBe('short');
    expect(shorten('alpha beta gamma', 12)).toBe('alpha beta…');
  });
});

describe('markup that tries to survive stripping', () => {
  it('leaves no angle brackets in any line', () => {
    const html =
      '<h3 class="section-head">§1. T</h3><p class="statutory-body"><<b>script>alert(1)<</b>/script> a &lt;b&gt; c <!<!-- x -->-- y -->z</p>';
    const text = parseUsCodePage(html)
      .lines.map((l) => l.text)
      .join('\n');
    expect(text).not.toMatch(/[<>]/);
    expect(text).toContain('alert(1)');
  });
});

describe('findSubsection and editionYear', () => {
  const page = parseUsCodePage(makeUsCodePage());
  it('cuts the block that starts with the cited label, and descends through designators', () => {
    const part = findSubsection(page, ['2']);
    expect(part?.lines.map((l) => l.text)).toContain('(A) In general');
    expect(findSubsection(page, ['2', 'B'])?.lines[0]?.text).toBe(
      '(B) Exclusion',
    );
    // A missing deeper designator keeps the last block found.
    expect(findSubsection(page, ['2', 'Z'])?.lines[0]?.text).toBe(
      '(2) Permit holder',
    );
    expect(findSubsection(page, ['Z'])).toBeUndefined();
    expect(findSubsection(page, [])).toBeUndefined();
  });
  it('reads the edition year from a page address', () => {
    expect(
      editionYear(
        'https://www.govinfo.gov/content/pkg/USCODE-2024-title15/html/x.htm',
      ),
    ).toBe('2024');
    expect(
      editionYear('https://www.govinfo.gov/link/uscode/15/1'),
    ).toBeUndefined();
  });
});

describe('markup parsing is linear', () => {
  it('reads 100,000 nested "<" in well under a second', () => {
    const html = `<h3 class="section-head">§1. T</h3><p class="statutory-body">${'<'.repeat(100_000)}b${'>'.repeat(100_000)} end</p>`;
    const started = Date.now();
    const page = parseUsCodePage(html);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(page.lines.map((l) => l.text).join(' ')).not.toMatch(/[<>]/);
  });
});

describe('findSubsection with lettered subsections and look-alike clauses', () => {
  const page = parseUsCodePage(makeLetteredUsCodePage());
  it('finds the printed subsection head, not a clause that starts with the same label', () => {
    const part = findSubsection(page, ['v']);
    expect(part?.lines[0]).toMatchObject({
      kind: 'head',
      text: '(v) Reasonable costs',
    });
    const text = part?.lines.map((l) => l.text).join('\n') ?? '';
    expect(text).toContain('reasonable cost of any services');
    expect(text).not.toContain('meets such other conditions');
    expect(text).not.toContain('(w) Arrangements');
  });
  it('still falls back to a body clause when no heading carries the label', () => {
    expect(findSubsection(page, ['1'])?.lines[0]?.text).toContain(
      '(1) is primarily',
    );
  });
  it('reads "The terms \"State\" and ..." as defining State', () => {
    expect(findTermBlock(findSubsection(page, ['x'])!, ['State'])).toContain(
      'meaning given to them',
    );
  });
});

describeWithFixture('us-code-42-1395x', () => {
  // Parsed in beforeAll, not at collection: vitest collects a skipped suite's body too.
  let page: ReturnType<typeof parseUsCodePage>;
  beforeAll(() => {
    page = parseUsCodePage(
      readFileSync(fixturePath('us-code-42-1395x')!, 'utf8'),
    );
  });
  it('cuts 1395x(v) and 1395x(x) as subsections, not as clauses of (e)', () => {
    const v = findSubsection(page, ['v']);
    expect(v?.lines[0]?.text).toBe('(v) Reasonable costs');
    expect(
      v?.lines.some((l) => l.text.startsWith('(1)(A) The reasonable cost')),
    ).toBe(true);
    expect(findSubsection(page, ['x'])?.lines[0]?.text).toBe(
      '(x) State and United States',
    );
    expect(findTermBlock(page, ['spell of illness'])).toContain(
      'spell of illness',
    );
  });
});
