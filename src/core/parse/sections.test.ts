import { describe, expect, it } from 'vitest';
import {
  AppError,
  Section,
  sectionText,
  walkSections,
} from '../model/index.js';
import {
  DEFAULT_SECTION_PATTERNS,
  detectSections,
  type SourceLine,
} from './sections.js';

const lines = (...texts: string[]): SourceLine[] =>
  texts.map((text) => ({ text }));
const ids = (source: SourceLine[]): string[] =>
  [...walkSections(detectSections(source))].map((section) => section.id);

describe('section heading patterns', () => {
  it.each([
    ['Section 1. Short title', 'sec-1', '1', 'Short title'],
    ['SECTION 2. Findings', 'sec-2', '2', 'Findings'],
    ['Sec. 101. Definitions', 'sec-101', '101', 'Definitions'],
    ['SEC. 2. Grants', 'sec-2', '2', 'Grants'],
    ['Sec. 5747.01. Tax', 'sec-5747.01', '5747.01', 'Tax'],
    [
      'Section 5747.01 of the Revised Code is amended to read as follows:',
      'sec-5747.01',
      '5747.01',
      'of the Revised Code is amended to read as follows:',
    ],
    ['§ 5747.01', 'sec-5747.01', '5747.01', undefined],
    ['§5747.01. Tax', 'sec-5747.01', '5747.01', 'Tax'],
    [
      'ARTICLE IV. General provisions',
      'article-iv',
      'IV',
      'General provisions',
    ],
    ['Article 1: General provisions', 'article-1', '1', 'General provisions'],
    ['CHAPTER 2. Powers', 'chapter-2', '2', 'Powers'],
    ['Chapter II', 'chapter-ii', 'II', undefined],
    ['\t Section 3.', 'sec-3', '3', undefined],
    ['Section 1.2.3. Local rule', 'sec-1.2.3', '1.2.3', 'Local rule'],
  ])('detects %s', (text, id, num, heading) => {
    const sections = detectSections(lines(text));
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      id,
      num,
      level: 1,
      spans: [{ text, status: 'unchanged' }],
      children: [],
    });
    expect(sections[0]?.heading).toBe(heading);
    expect(Section.safeParse(sections[0]).success).toBe(true);
  });

  it.each(['(a)', '(1)', '(A)', '(i)', '(I)', '(ii)', '(IV)'])(
    'detects line-start enumeration %s',
    (marker) => {
      const sections = detectSections(
        lines('Section 4.', `${marker} Content.`),
      );
      expect(sections[0]?.children[0]).toMatchObject({
        id: `sec-4/${marker.slice(1, -1).toLowerCase()}`,
        num: marker,
        level: 2,
        spans: [{ text: `${marker} Content.`, status: 'unchanged' }],
      });
    },
  );

  it.each([
    'See Section 1. for the rule.',
    'Text (a) inside a sentence.',
    'Subsection (1) applies.',
    '(abc) not a marker',
    '(civil) not a Roman numeral',
    '(iiii) not a canonical numeral',
    '(a)word',
    'Section 12abc.',
    '§ 5747.01abc',
    'Chapterhouse 2.',
    'Article grants funding.',
  ])('keeps ordinary text as content: %s', (text) => {
    const sections = detectSections(lines('Section 1.', text));
    expect(sections).toHaveLength(1);
    expect(sections[0]?.children).toEqual([]);
    expect(sectionText(sections[0]!, { includeDeleted: false })).toBe(
      `Section 1.\n${text}`,
    );
  });

  it('allows replacing, extending and disabling the regex set', () => {
    const custom = { kind: 'section' as const, regex: /^Rule (\d+):\s*/g };
    const source = lines('Rule 5: Rule heading', 'Section 2. Default heading');
    const customOnly = detectSections(source, { patterns: [custom] });
    expect(customOnly.map((section) => section.id)).toEqual(['sec-5']);
    expect(customOnly[0]?.heading).toBe('Rule heading');
    expect(
      detectSections(source, {
        patterns: [...DEFAULT_SECTION_PATTERNS, custom],
      }).map((section) => section.id),
    ).toEqual(['sec-5', 'sec-2']);
    expect(detectSections(source, { patterns: [] })[0]?.id).toBe('preamble');
  });

  it('never shares global or sticky regex state and still enforces line start', () => {
    const regex = /Rule (\d+):/gy;
    regex.lastIndex = 50;
    const source = lines('Rule 1:', 'Rule 2:', 'See Rule 3: in the appendix.');
    const options = { patterns: [{ kind: 'section' as const, regex }] };
    for (let n = 0; n < 2; n++) {
      expect(
        detectSections(source, options).map((section) => section.id),
      ).toEqual(['sec-1', 'sec-2']);
    }
    expect(regex.lastIndex).toBe(50);
    expect(
      detectSections(lines('See Rule 3:'), {
        patterns: [{ kind: 'section', regex: /Rule (\d+):/ }],
      })[0]?.id,
    ).toBe('preamble');
  });

  it.each([
    { regex: /^Rule \d+:/, text: 'Rule 1:' },
    { regex: /^Rule (.*):/, text: 'Rule bad/id:' },
  ])(
    'rejects a configuration without a safe marker: $text',
    ({ regex, text }) => {
      expect(() =>
        detectSections(lines(text), { patterns: [{ kind: 'section', regex }] }),
      ).toThrow(AppError);
      expect(() =>
        detectSections(lines(text), { patterns: [{ kind: 'section', regex }] }),
      ).toThrow('must capture');
    },
  );
});

describe('stack-based nesting', () => {
  it('infers the federal hierarchy and returns to ancestors', () => {
    expect(
      ids(
        lines(
          'Section 4.',
          '(a) Division',
          '(1) Item',
          '(A) Subitem',
          '(i) Detail',
          '(I) Subdetail',
          '(II) Next subdetail',
          '(ii) Next detail',
          '(B) Next subitem',
          '(2) Next item',
          '(b) Next division',
          'Section 5.',
          '(a) Reset',
        ),
      ),
    ).toEqual([
      'sec-4',
      'sec-4/a',
      'sec-4/a/1',
      'sec-4/a/1/a',
      'sec-4/a/1/a/i',
      'sec-4/a/1/a/i/i',
      'sec-4/a/1/a/i/ii',
      'sec-4/a/1/a/ii',
      'sec-4/a/1/b',
      'sec-4/a/2',
      'sec-4/b',
      'sec-5',
      'sec-5/a',
    ]);
    expect(
      [
        ...walkSections(
          detectSections(
            lines('Section 4.', '(a)', '(1)', '(A)', '(i)', '(I)'),
          ),
        ),
      ].map((section) => section.level),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('infers Ohio divisions without hard-coding the federal order', () => {
    expect(
      ids(
        lines(
          'Sec. 5747.01.',
          '(A) Division',
          '(1) Item',
          '(a) Subitem',
          '(i) Detail',
          '(ii) Detail',
          '(b) Next subitem',
          '(2) Next item',
          '(B) Next division',
        ),
      ),
    ).toEqual([
      'sec-5747.01',
      'sec-5747.01/a',
      'sec-5747.01/a/1',
      'sec-5747.01/a/1/a',
      'sec-5747.01/a/1/a/i',
      'sec-5747.01/a/1/a/ii',
      'sec-5747.01/a/1/b',
      'sec-5747.01/a/2',
      'sec-5747.01/b',
    ]);
  });

  it.each([
    ['h', 'i', 'j'],
    ['H', 'I', 'J'],
    ['u', 'v', 'w'],
    ['w', 'x', 'y'],
    ['c', 'd', 'e'],
    ['k', 'l', 'm'],
  ])('recognizes letter sequences %s → %s → %s', (first, second, third) => {
    expect(
      ids(lines('Section 1.', `(${first})`, `(${second})`, `(${third})`)),
    ).toEqual([
      'sec-1',
      ...[first, second, third].map(
        (marker) => `sec-1/${marker.toLowerCase()}`,
      ),
    ]);
  });

  it('keeps established Roman numerals at the same level', () => {
    expect(
      ids(lines('Section 1.', '(a)', '(i)', '(ii)', '(iv)', '(v)', '(x)')),
    ).toEqual([
      'sec-1',
      'sec-1/a',
      'sec-1/a/i',
      'sec-1/a/ii',
      'sec-1/a/iv',
      'sec-1/a/v',
      'sec-1/a/x',
    ]);
  });

  it('uses deeper indentation for a repeated marker type, and outdents to an ancestor', () => {
    expect(
      ids([
        { text: 'Section 1.' },
        { text: '(a)', x: 10 },
        { text: '(b)', x: 30 },
        { text: '(c)', x: 30 },
        { text: '(d)', x: 10 },
        { text: '(1)', x: 20 },
        { text: '(e)', x: 5 },
      ]),
    ).toEqual([
      'sec-1',
      'sec-1/a',
      'sec-1/a/b',
      'sec-1/a/c',
      'sec-1/d',
      'sec-1/d/1',
      'sec-1/e',
    ]);
  });

  it('uses indentation to distinguish a nested Roman i from a peer letter i', () => {
    expect(
      ids([
        { text: 'Section 1.' },
        { text: '(h)', x: 10 },
        { text: '(i)', x: 30 },
        { text: '(ii)', x: 30 },
        { text: '(i)', x: 10 },
        { text: '(j)', x: 10 },
      ]),
    ).toEqual([
      'sec-1',
      'sec-1/h',
      'sec-1/h/i',
      'sec-1/h/ii',
      'sec-1/i',
      'sec-1/j',
    ]);
  });

  it('uses peer indentation even across intervening children and nonconsecutive letters', () => {
    expect(
      ids([
        { text: 'Section 1.' },
        { text: '(a)', x: 10 },
        { text: '(1)', x: 20 },
        { text: '(i)', x: 10.5 },
      ]),
    ).toEqual(['sec-1', 'sec-1/a', 'sec-1/a/1', 'sec-1/i']);
  });

  it('can outdent to a new level between two known indents', () => {
    expect(
      ids([
        { text: 'Section 1.' },
        { text: '(a)', x: 10 },
        { text: '(1)', x: 40 },
        { text: '(A)', x: 20 },
      ]),
    ).toEqual(['sec-1', 'sec-1/a', 'sec-1/a/1', 'sec-1/a/a']);
  });

  it('nests named headings and resets the enumeration stack at each heading', () => {
    expect(
      ids(
        lines(
          'Article I',
          'Chapter 1',
          'Section 1.',
          '(a)',
          'Section 2.',
          '(1)',
          'Chapter 2',
          'Section 1.',
          'Article II',
          'Section 1.',
        ),
      ),
    ).toEqual([
      'article-i',
      'article-i/chapter-1',
      'article-i/chapter-1/sec-1',
      'article-i/chapter-1/sec-1/a',
      'article-i/chapter-1/sec-2',
      'article-i/chapter-1/sec-2/1',
      'article-i/chapter-2',
      'article-i/chapter-2/sec-1',
      'article-ii',
      'article-ii/sec-1',
    ]);
  });

  it('handles enumerated documents without a numbered heading', () => {
    expect(
      ids(lines('Introductory text', '(A) First', '(1) Child', '(B) Second')),
    ).toEqual(['preamble', 'preamble/a', 'preamble/a/1', 'preamble/b']);
    expect(ids(lines('(1) First', '(2) Second'))).toEqual([
      'preamble',
      'preamble/1',
      'preamble/2',
    ]);
  });
});

describe('content, stable ids and source locations', () => {
  it('keeps recitals, numbered whereas clauses and continuation text in the preamble', () => {
    const source = [
      'An Act',
      'WHEREAS, Section 1. is discussed;',
      '(1) Whereas, grants are needed;',
      '(A) WHEREAS, local needs vary;',
      'Recitals: background',
      'continued recital text',
      'Section 1. Operative text',
      '(a) A duty',
    ];
    const sections = detectSections(lines(...source));
    expect(sections.map((section) => section.id)).toEqual([
      'preamble',
      'sec-1',
    ]);
    expect(sections[0]?.children).toEqual([]);
    expect(sectionText(sections[0]!, { includeDeleted: false })).toBe(
      source.slice(0, 6).join('\n') + '\n',
    );
  });

  it('preserves source text, whitespace and blank lines; parent text excludes children', () => {
    const sections = detectSections(
      lines(
        '',
        '  Bill title  ',
        '',
        'Section 1. Rule',
        'continued',
        '(a) Child',
        '',
        'child continuation',
      ),
    );
    expect(sectionText(sections[0]!, { includeDeleted: true })).toBe(
      '\n  Bill title  \n\n',
    );
    expect(sectionText(sections[1]!, { includeDeleted: false })).toBe(
      'Section 1. Rule\ncontinued\n',
    );
    expect(
      sectionText(sections[1]!.children[0]!, { includeDeleted: false }),
    ).toBe('(a) Child\n\nchild continuation');
  });

  it('returns no sections for an empty or whitespace-only document, without empty leading preambles', () => {
    expect(detectSections([])).toEqual([]);
    expect(detectSections(lines('', ' \t'))).toEqual([]);
    expect(ids(lines('', ' ', 'Section 1.'))).toEqual(['sec-1']);
  });

  it('allocates collision suffixes after lowercasing and uses the resolved parent id for children', () => {
    const source = lines(
      'Section 4.',
      '(a)',
      '(a)',
      '(a)',
      'Section 4.',
      '(A)',
      '(a)',
      'Section 4.',
      'Sec. 5747.01.',
      '§ 5747.01',
    );
    const expected = [
      'sec-4',
      'sec-4/a',
      'sec-4/a~2',
      'sec-4/a~3',
      'sec-4~2',
      'sec-4~2/a',
      'sec-4~2/a/a',
      'sec-4~3',
      'sec-5747.01',
      'sec-5747.01~2',
    ];
    expect(ids(source)).toEqual(expected);
    expect(ids(source)).toEqual(expected);
    for (const section of walkSections(detectSections(source)))
      expect(Section.safeParse(section).success).toBe(true);
  });

  it('keeps locations on every span and includes descendants in parent ranges across pages', () => {
    const source = [
      { text: 'Intro', page: 1, line: 2 },
      { text: 'Section 1.', page: 1, line: 8 },
      { text: '(a)', page: 1, line: 9, x: 10 },
      { text: 'Continuation', page: 2, line: 1 },
      { text: '(b)', page: 2, line: 2, x: 10 },
      { text: 'Section 2.', page: 2, line: 7 },
    ];
    const sections = detectSections(source);
    expect(sections[0]).toMatchObject({
      pageStart: 1,
      pageEnd: 1,
      lineStart: 2,
      lineEnd: 2,
    });
    expect(sections[1]).toMatchObject({
      pageStart: 1,
      pageEnd: 2,
      lineStart: 8,
      lineEnd: 2,
    });
    expect(sections[1]?.children[0]).toMatchObject({
      pageStart: 1,
      pageEnd: 2,
      lineStart: 9,
      lineEnd: 1,
      spans: [
        { text: '(a)\n', status: 'unchanged', page: 1, line: 9 },
        { text: 'Continuation\n', status: 'unchanged', page: 2, line: 1 },
      ],
    });
    expect(sections[2]).toMatchObject({
      pageStart: 2,
      pageEnd: 2,
      lineStart: 7,
      lineEnd: 7,
    });
    expect(source[2]?.text).toBe('(a)');
  });

  it('keeps optional locations absent, including partially supplied coordinates', () => {
    const sections = detectSections([
      { text: '(a)', page: 1 },
      { text: 'Body', line: 3 },
    ]);
    expect(sections[0]).toMatchObject({
      id: 'preamble',
      pageStart: 1,
      pageEnd: 1,
      lineStart: 3,
      lineEnd: 3,
    });
    const child = sections[0]!.children[0]!;
    expect(child.spans[0]).not.toHaveProperty('line');
    expect(child.spans[1]).not.toHaveProperty('page');
    expect(detectSections(lines('Section 1.'))[0]).not.toHaveProperty(
      'pageStart',
    );
  });

  it.each([
    { text: 'x', page: 0 },
    { text: 'x', page: 1.5 },
    { text: 'x', line: -1 },
    { text: 'x', line: 1.1 },
    { text: 'x', x: NaN },
    { text: 'x', x: Infinity },
  ])('rejects invalid source coordinates: %j', (line) => {
    expect(() => detectSections([line])).toThrow(
      'Invalid section source lines.',
    );
  });
});
