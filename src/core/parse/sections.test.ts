import { describe, expect, it } from 'vitest';
import {
  AppError,
  Section,
  SectionId,
  sectionText,
  type SpanStatus,
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
    ['Section 1 Short title', 'sec-1', '1', 'Short title'],
    ['Sec 2. Foo', 'sec-2', '2', 'Foo'],
    ['Sec 2 Foo', 'sec-2', '2', 'Foo'],
    ['§ 1395x. Definitions', 'sec-1395x', '1395x', 'Definitions'],
    ['§ 1395x Definitions', 'sec-1395x', '1395x', 'Definitions'],
    ['§ 5747.01. Definitions', 'sec-5747.01', '5747.01', 'Definitions'],
    ['§ 5747.01 Definitions', 'sec-5747.01', '5747.01', 'Definitions'],
    ['SEC. 1. SHORT TITLE', 'sec-1', '1', 'SHORT TITLE'],
    ['SEC. 1 SHORT TITLE', 'sec-1', '1', 'SHORT TITLE'],
    ['Section 3 Existing reference', 'sec-3', '3', 'Existing reference'],
    ['SECTION 2. Findings', 'sec-2', '2', 'Findings'],
    ['Sec. 101. Definitions', 'sec-101', '101', 'Definitions'],
    ['SEC. 2. Grants', 'sec-2', '2', 'Grants'],
    ['Sec. 5747.01. Tax', 'sec-5747.01', '5747.01', 'Tax'],
    [
      'Section 1. That section 5747.01 be amended',
      'sec-1',
      '1',
      'That section 5747.01 be amended',
    ],
    [
      'Section 1 That section 5747.01 be amended',
      'sec-1',
      '1',
      'That section 5747.01 be amended',
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
    'Section 5747.01 of the Revised Code is amended to read as follows:',
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

describe('review layout regressions', () => {
  it('opens Ohio divisions on the section-heading line and returns to (B)', () => {
    const sections = detectSections(
      lines(
        'Sec. 5747.01. (A) As used in this chapter:',
        '(1) "Adjusted gross income" means…',
        '(a) …',
        '(i) …',
        '(ii) …',
        '(B) …',
      ),
    );
    expect([...walkSections(sections)].map((section) => section.id)).toEqual([
      'sec-5747.01',
      'sec-5747.01/a',
      'sec-5747.01/a/1',
      'sec-5747.01/a/1/a',
      'sec-5747.01/a/1/a/i',
      'sec-5747.01/a/1/a/ii',
      'sec-5747.01/b',
    ]);
    expect(sections[0]?.heading).toBeUndefined();
    expect(sections[0]?.children[0]?.heading).toBe('As used in this chapter:');
  });

  it('separates federal heading text and inline enumerators while retaining source coordinates', () => {
    const text = 'SEC. 2. DEFINITIONS. (a) In General.— (1) foo';
    const source = [{ text, page: 2, line: 7, x: 10 }];
    const sections = detectSections(source);
    const nodes = [...walkSections(sections)];
    expect(nodes.map((section) => section.id)).toEqual([
      'sec-2',
      'sec-2/a',
      'sec-2/a/1',
    ]);
    expect(nodes.map((section) => section.heading)).toEqual([
      'DEFINITIONS.',
      'In General.—',
      'foo',
    ]);
    expect(nodes.map((section) => section.level)).toEqual([1, 2, 3]);
    expect(
      nodes.map((section) => sectionText(section, { includeDeleted: false })),
    ).toEqual(['SEC. 2. DEFINITIONS. ', '(a) In General.— ', '(1) foo']);
    expect(
      nodes
        .flatMap((section) => section.spans)
        .map((span) => span.text)
        .join(''),
    ).toBe(text);
    for (const node of nodes) {
      expect(node).toMatchObject({
        pageStart: 2,
        pageEnd: 2,
        lineStart: 7,
        lineEnd: 7,
      });
      expect(node.spans[0]).toMatchObject({
        status: 'unchanged',
        page: 2,
        line: 7,
      });
    }
    expect(source).toEqual([{ text, page: 2, line: 7, x: 10 }]);
  });

  it.each(['(a) … (1) foo', '(a)(1) text', '(a) (1) text'])(
    'opens chained leading markers: %s',
    (text) => {
      expect(ids(lines('Sec. 2.', text))).toEqual([
        'sec-2',
        'sec-2/a',
        'sec-2/a/1',
      ]);
    },
  );

  it('opens same-line markers as children even when their alphabet matches an ancestor', () => {
    expect(ids(lines('Sec. 3.', '(h)(1)(i) text', '(j) Next item'))).toEqual([
      'sec-3',
      'sec-3/h',
      'sec-3/h/1',
      'sec-3/h/1/i',
      'sec-3/j',
    ]);
    expect(ids(lines('Sec. 3. (a)(a) text'))).toEqual([
      'sec-3',
      'sec-3/a',
      'sec-3/a/a',
    ]);
  });

  it.each([
    'section 5747.02 of the Revised Code and',
    'Section 3 of H.B. 1 as enacted',
    'Section 5747.01 of the Revised Code is amended to read as follows:',
    'section 3.',
    'sec. 3.',
    'sEc. 3.',
    'Section 3 and the following provisions',
    'SEC. 3 is amended',
    'SECTION 3 as enacted',
    'Sec. 3 to provide funding',
    'Section 3. of H.B. 1 as enacted',
  ])('keeps wrapped cross-references inside Sec. 7: %s', (text) => {
    const sections = detectSections(lines('Sec. 7.', text));
    expect([...walkSections(sections)].map((section) => section.id)).toEqual([
      'sec-7',
    ]);
    expect(sectionText(sections[0]!, { includeDeleted: false })).toBe(
      `Sec. 7.\n${text}`,
    );
  });

  it.each(['Section 3', 'Sec 3', 'SEC. 3', '§ 1395x', '§ 5747.01'])(
    'rejects connective references with and without a period after %s',
    (prefix) => {
      for (const separator of [' ', '. ']) {
        for (const connective of [
          'of',
          'and',
          'or',
          'is',
          'are',
          'was',
          'were',
          'as',
          'to',
          'in',
          'on',
          'for',
          'by',
          'with',
          'under',
          'from',
        ]) {
          const text = `${prefix}${separator}${connective} H.B. 1`;
          const sections = detectSections(lines('Sec. 7.', text));
          expect(
            [...walkSections(sections)].map((section) => section.id),
          ).toEqual(['sec-7']);
          expect(sectionText(sections[0]!, { includeDeleted: false })).toBe(
            `Sec. 7.\n${text}`,
          );
        }
      }
    },
  );

  it.each([
    ['(b) Under section 3. (c) is fine', 'b'],
    ['(a) … the term (1) means x. (2) y', 'a'],
    ['(a) The term (1) means x. (2) y', 'a'],
    ['(a) First. (c) Third', 'a'],
    ['(1) First. (3) Third', '1'],
    ['(a) First. (b) are applicable', 'a'],
    ['(a) First. (1) means x', 'a'],
    ['(a) First. (b) shall apply', 'a'],
    ['(a) First. (1) must apply', 'a'],
    ['(2) First. (1) Earlier item', '2'],
    ['(b) First. (a) Earlier division', 'b'],
  ])('keeps implausible inline continuations as text: %s', (text, marker) => {
    const sections = detectSections(lines('Sec. 4.', text));
    const nodes = [...walkSections(sections)];
    expect(nodes.map((section) => section.id)).toEqual([
      'sec-4',
      `sec-4/${marker}`,
    ]);
    expect(nodes[1]?.children).toEqual([]);
    expect(sectionText(nodes[1]!, { includeDeleted: false })).toBe(text);
    expect(nodes[1]?.heading).toBe(text.slice(marker.length + 2).trim());
  });

  it.each([
    ['Sec. 4. (a) text', ['sec-4', 'sec-4/a']],
    ['Sec. 4. (a)(1) text', ['sec-4', 'sec-4/a', 'sec-4/a/1']],
    ['Sec. 4. (a) First. (b) Second', ['sec-4', 'sec-4/a', 'sec-4/b']],
    [
      'Sec. 4. (a)(1) First. (2) Second',
      ['sec-4', 'sec-4/a', 'sec-4/a/1', 'sec-4/a/2'],
    ],
    ['Sec. 4. (1) First. (a) Child', ['sec-4', 'sec-4/1', 'sec-4/1/a']],
    ['Sec. 4. (1) First. (A) Child', ['sec-4', 'sec-4/1', 'sec-4/1/a']],
    [
      'Sec. 4. (a) First. (i) Detail. (ii) Next',
      ['sec-4', 'sec-4/a', 'sec-4/a/i', 'sec-4/a/ii'],
    ],
    [
      'Sec. 4. (i) First. (I) Detail. (II) Next',
      ['sec-4', 'sec-4/i', 'sec-4/i/i', 'sec-4/i/ii'],
    ],
  ])(
    'splits plausible inline children and next siblings: %s',
    (text, expectedIds) => {
      const source = [{ text, page: 2, line: 7, x: 10 }];
      const nodes = [...walkSections(detectSections(source))];
      expect(nodes.map((section) => section.id)).toEqual(expectedIds);
      expect(
        nodes
          .flatMap((section) => section.spans)
          .map((span) => span.text)
          .join(''),
      ).toBe(text);
      for (const node of nodes) {
        expect(node).toMatchObject({
          pageStart: 2,
          pageEnd: 2,
          lineStart: 7,
          lineEnd: 7,
        });
      }
    },
  );

  it.each([
    ['(h) First. (i) Second. (j) Third', ['h', 'i', 'j']],
    ['(z) First. (aa) Second', ['z', 'aa']],
    ['(H) First. (I) Second', ['h', 'i']],
    ['(ii) First. (iii) Second', ['ii', 'iii']],
    ['(iv) First. (v) Second', ['iv', 'v']],
  ])(
    'keeps inline successors in the established alphabet: %s',
    (text, markers) => {
      expect(ids(lines('Sec. 4.', text))).toEqual([
        'sec-4',
        ...markers.map((marker) => `sec-4/${marker}`),
      ]);
    },
  );

  it.each([
    'Text mentions subsection (a).',
    '(a) Text mentions subsection (b) and paragraph (1).',
    '(a) A sentence. See subsection (b).',
    'SEC. 2. DEFINITIONS. Under subsection (a), a term is defined.',
  ])('does not split mid-sentence references: %s', (text) => {
    const expected = text.startsWith('(a)') ? ['sec-2', 'sec-2/a'] : ['sec-2'];
    expect(
      ids(lines(...(text.startsWith('SEC.') ? [text] : ['Sec. 2.', text]))),
    ).toEqual(expected);
  });

  it.each([
    ['h', 'i', 'j'],
    ['u', 'v', 'w'],
    ['w', 'x', 'y'],
    ['H', 'I', 'J'],
    ['U', 'V', 'W'],
    ['W', 'X', 'Y'],
  ])(
    'continues the enclosing letter sequence after numbered children: %s, %s, %s',
    (first, second, third) => {
      const prefix = `sec-3/${first.toLowerCase()}`;
      expect(
        ids(
          lines(
            'Sec. 3.',
            `(${first})`,
            '(1)',
            '(2)',
            `(${second})`,
            `(${third})`,
          ),
        ),
      ).toEqual([
        'sec-3',
        prefix,
        `${prefix}/1`,
        `${prefix}/2`,
        `sec-3/${second.toLowerCase()}`,
        `sec-3/${third.toLowerCase()}`,
      ]);
    },
  );

  it.each(['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'])(
    'supports doubled letters throughout the %s sequence',
    (alphabet) => {
      const markers = [
        'y',
        'z',
        ...Array.from(alphabet, (letter) => letter.repeat(2)),
      ];
      if (alphabet === alphabet.toUpperCase()) markers.splice(0, 2, 'Y', 'Z');
      expect(
        ids(
          lines('Sec. 1.', ...markers.map((marker) => `(${marker}) Content`)),
        ),
      ).toEqual([
        'sec-1',
        ...markers.map((marker) => `sec-1/${marker.toLowerCase()}`),
      ]);
    },
  );

  it.each([
    ['SEC. 101A.', 'sec-101a', '101A'],
    ['Sec. 5747.01a.', 'sec-5747.01a', '5747.01a'],
    ['§ 1395x', 'sec-1395x', '1395x'],
    ['§ 1395x-1', 'sec-1395x-1', '1395x-1'],
  ])(
    'detects lettered section number %s with citation-safe collision ids',
    (text, id, num) => {
      const sections = detectSections(lines(text, '(a)', text, '(a)'));
      const nodes = [...walkSections(sections)];
      expect(nodes.map((section) => section.id)).toEqual([
        id,
        `${id}/a`,
        `${id}~2`,
        `${id}~2/a`,
      ]);
      expect(sections.map((section) => section.num)).toEqual([num, num]);
      for (const section of nodes)
        expect(SectionId.safeParse(section.id).success).toBe(true);
    },
  );

  it('keeps recitals and NOW, THEREFORE in the preamble', () => {
    expect(
      ids(
        lines(
          'WHEREAS, Section 1. describes a need;',
          'NOW, THEREFORE, be it enacted:',
          'Section 1. That section 5747.01 be amended',
        ),
      ),
    ).toEqual(['preamble', 'sec-1']);
  });

  it('preserves the flat (g)(h)(i)(j)(k) letter sequence across lines', () => {
    expect(ids(lines('Sec. 3.', '(g)', '(h)', '(i)', '(j)', '(k)'))).toEqual([
      'sec-3',
      'sec-3/g',
      'sec-3/h',
      'sec-3/i',
      'sec-3/j',
      'sec-3/k',
    ]);
  });
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

describe('issue #51 edge cases', () => {
  it('splits every item of a colon-introduced inline list into siblings', () => {
    const sections = detectSections(
      lines(
        'Sec. 4.',
        '(a) The following: (1) x; (2) y; and (3) z.',
        '(b) Next',
      ),
    );
    const nodes = [...walkSections(sections)];
    expect(nodes.map((section) => section.id)).toEqual([
      'sec-4',
      'sec-4/a',
      'sec-4/a/1',
      'sec-4/a/2',
      'sec-4/a/3',
      'sec-4/b',
    ]);
    expect(
      nodes.map((section) => sectionText(section, { includeDeleted: true })),
    ).toEqual([
      'Sec. 4.\n',
      '(a) The following: ',
      '(1) x; ',
      '(2) y; and ',
      '(3) z.\n',
      '(b) Next',
    ]);
    expect(nodes[3]?.heading).toBe('y; and');
  });

  it.each([
    ['or', '(a) Either: (1) x; or (2) y.'],
    ['no connector', '(a) Both: (1) x; (2) y.'],
  ])('accepts a semicolon list with %s', (_, text) => {
    expect(ids(lines('Sec. 4.', text))).toEqual([
      'sec-4',
      'sec-4/a',
      'sec-4/a/1',
      'sec-4/a/2',
    ]);
  });

  it.each([
    [
      'a semicolon without a colon introducer',
      '(a) Duties (1) x; (2) y.',
      ['sec-4', 'sec-4/a'],
    ],
    [
      'a non-sibling marker after the semicolon',
      '(a) The following: (1) x; (3) y.',
      ['sec-4', 'sec-4/a', 'sec-4/a/1'],
    ],
    [
      'a prose reference after the semicolon',
      '(a) The following: (1) x; (2) is void.',
      ['sec-4', 'sec-4/a', 'sec-4/a/1'],
    ],
    [
      'no semicolon at all',
      '(a) The following: (1) x and (2) y.',
      ['sec-4', 'sec-4/a', 'sec-4/a/1'],
    ],
  ])('does not split %s', (_, text, expected) => {
    expect(ids(lines('Sec. 4.', text))).toEqual(expected);
  });

  it.each([
    'Section 9 shall apply',
    'Section 9 may be cited',
    'Section 9 must be read',
    'Section 9 applies to',
    'Section 9 takes effect',
    'Sec. 9 does not',
    '§ 9 governs',
  ])('keeps a wrapped reference as text: %s', (wrapped) => {
    const sections = detectSections(
      lines('Section 1.', 'as provided in', wrapped),
    );
    expect([...walkSections(sections)].map((section) => section.id)).toEqual([
      'sec-1',
    ]);
    expect(sectionText(sections[0]!, { includeDeleted: true })).toContain(
      wrapped,
    );
  });

  it('still opens a heading whose next word is capitalized or not a verb', () => {
    expect(
      ids(lines('Section 9 Shall Apply', 'Section 10 Applicability')),
    ).toEqual(['sec-9', 'sec-10']);
  });
});

describe('amendment statuses on source lines', () => {
  const struck = (text: string, from: number, to: number, status: SpanStatus) =>
    Array.from(text, (_, index) =>
      index >= from && index < to ? status : 'unchanged',
    );

  it('splits spans by status runs, including inside inline heading parts', () => {
    const text = 'Sec. 4. (A) The fee is ten twenty dollars.';
    const statuses = struck(text, 23, 26, 'deleted').map((status, index) =>
      index >= 27 && index < 33 ? 'inserted' : status,
    );
    const sections = detectSections([
      { text, page: 2, line: 7, statuses },
      { text: 'Next line', page: 2, line: 8 },
    ]);
    const division = sections[0]!.children[0]!;
    expect(sections[0]!.spans).toEqual([
      { text: 'Sec. 4. ', status: 'unchanged', page: 2, line: 7 },
    ]);
    expect(division.spans).toEqual([
      { text: '(A) The fee is ', status: 'unchanged', page: 2, line: 7 },
      { text: 'ten', status: 'deleted', page: 2, line: 7 },
      { text: ' ', status: 'unchanged', page: 2, line: 7 },
      { text: 'twenty', status: 'inserted', page: 2, line: 7 },
      { text: ' dollars.\n', status: 'unchanged', page: 2, line: 7 },
      { text: 'Next line', status: 'unchanged', page: 2, line: 8 },
    ]);
    expect(sectionText(division, { includeDeleted: false })).toBe(
      '(A) The fee is  twenty dollars.\nNext line',
    );
  });

  it('attaches the newline to the final run so struck lines vanish whole', () => {
    const sections = detectSections([
      { text: 'Section 1.' },
      { text: 'old words', statuses: struck('old words', 0, 9, 'deleted') },
      { text: 'kept' },
    ]);
    expect(sections[0]!.spans.map((span) => [span.text, span.status])).toEqual([
      ['Section 1.\n', 'unchanged'],
      ['old words\n', 'deleted'],
      ['kept', 'unchanged'],
    ]);
    expect(sectionText(sections[0]!, { includeDeleted: false })).toBe(
      'Section 1.\nkept',
    );
  });

  it('carries statuses on leading preamble lines and keeps empty lines', () => {
    const sections = detectSections([
      { text: '', statuses: [] },
      { text: 'new title', statuses: struck('new title', 0, 9, 'inserted') },
    ]);
    expect(sections[0]!.spans).toEqual([
      { text: '\n', status: 'unchanged' },
      { text: 'new title', status: 'inserted' },
    ]);
  });

  it('rejects statuses that do not cover the text exactly', () => {
    expect(() =>
      detectSections([{ text: 'abc', statuses: ['deleted'] }]),
    ).toThrow('Invalid section source lines.');
  });
});

describe('structure is read from the text as amended (struck text never names a section)', () => {
  /** Mark every occurrence of each `[[...]]` run deleted, and strip the brackets. */
  const amended = (source: string): SourceLine => {
    let text = '';
    const statuses: SpanStatus[] = [];
    for (const [index, part] of source.split(/\[\[|\]\]/).entries()) {
      text += part;
      statuses.push(
        ...Array.from(part, (): SpanStatus =>
          index % 2 === 1 ? 'deleted' : 'unchanged',
        ),
      );
    }
    return { text, statuses };
  };

  it('takes a heading from the kept text only', () => {
    const [section] = detectSections([
      amended('Section 2. [[Old rate.]] New rate.'),
    ]);
    expect(section).toMatchObject({
      id: 'sec-2',
      num: '2',
      heading: 'New rate.',
    });
    expect(section!.spans.map((span) => [span.text, span.status])).toEqual([
      ['Section 2. ', 'unchanged'],
      ['Old rate.', 'deleted'],
      [' New rate.', 'unchanged'],
    ]);
  });

  it('numbers a relettered division by its new marker', () => {
    const sections = detectSections([
      { text: 'Sec. 7.' },
      amended('[[(C)]] (B) The fee is due.'),
    ]);
    const division = sections[0]!.children[0]!;
    expect(division).toMatchObject({
      id: 'sec-7/b',
      num: '(B)',
      heading: 'The fee is due.',
    });
    expect(division.spans.map((span) => [span.text, span.status])).toEqual([
      ['(C)', 'deleted'],
      [' (B) The fee is due.', 'unchanged'],
    ]);
  });

  it('never opens a section for a wholly struck heading line', () => {
    const sections = detectSections([
      { text: 'Section 1. Kept.' },
      amended('[[Section 2. Repealed rate.]]'),
      { text: 'Still section 1 text.' },
    ]);
    expect(sections.map((section) => section.id)).toEqual(['sec-1']);
    expect(sections[0]!.spans.map((span) => [span.text, span.status])).toEqual([
      ['Section 1. Kept.\n', 'unchanged'],
      ['Section 2. Repealed rate.\n', 'deleted'],
      ['Still section 1 text.', 'unchanged'],
    ]);
  });

  it('keeps struck text out of inline headings and in the part where it was printed', () => {
    const sections = detectSections([
      { text: 'Sec. 8.' },
      amended('(a) [[Old intro:]] (1) [[stale]] fresh item'),
    ]);
    const [division] = sections[0]!.children;
    const item = division!.children[0]!;
    expect(division!.heading).toBeUndefined();
    expect(item).toMatchObject({ num: '(1)', heading: 'fresh item' });
    expect(division!.spans.map((span) => [span.text, span.status])).toEqual([
      ['(a) ', 'unchanged'],
      ['Old intro:', 'deleted'],
      [' ', 'unchanged'],
    ]);
    expect(item.spans.map((span) => [span.text, span.status])).toEqual([
      ['(1) ', 'unchanged'],
      ['stale', 'deleted'],
      [' fresh item', 'unchanged'],
    ]);
  });

  it('leaves lines without struck text byte-for-byte as before', () => {
    const text = '  (a)  Spaced   heading  ';
    const sections = detectSections([{ text: 'Sec. 9.' }, { text }]);
    expect(sections[0]!.children[0]!.spans[0]!.text).toBe(text);
  });
});
