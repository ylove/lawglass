import { describe, expect, it } from 'vitest';
import {
  createTermMatcher,
  extractDefinitions,
  mergeDefinitions,
  segmentDefinitions,
} from './definitions.js';
import { sec } from './fixtures.js';

const terms = (text: string): string[] =>
  segmentDefinitions(text).map((s) => s.term);

describe('segmentDefinitions', () => {
  it.each([
    ['straight quotes', '"Employee" means a person hired.', ['Employee']],
    ['curly quotes', '“Employee” means a person hired.', ['Employee']],
    ['includes', '"Vehicle" includes a motorcycle.', ['Vehicle']],
    [
      'the term, quoted',
      'The term "State" means each of the States.',
      ['State'],
    ],
    [
      'the term, unquoted',
      'The term State means each of the States.',
      ['State'],
    ],
    ['has the meaning', '"Tax" has the meaning given in section 2.', ['Tax']],
    [
      'Ohio enumerated',
      '(A) "Taxpayer" means a person.\n(B) "Return" means a form.',
      ['Taxpayer', 'Return'],
    ],
    [
      'federal headed paragraphs',
      '(1) Administrator.—The term "Administrator" means the head.\n(2) Small business.—The term "small business" means a firm.',
      ['Administrator', 'small business'],
    ],
    [
      'lead-in with comma',
      'As used in this section, "Fund" means the state fund.',
      ['Fund'],
    ],
    [
      'inline sequence separated by semicolons',
      '"A" means one; (B) "B" means two.',
      ['A', 'B'],
    ],
  ])('finds %s', (_name, text, expected) => {
    expect(terms(text)).toEqual(expected);
  });

  it('ignores a mid-sentence quoted word', () => {
    expect(
      terms('The agency uses the word "fine" means nothing here.'),
    ).toEqual([]);
  });

  it('returns nothing for text with no definitions', () => {
    expect(terms('Employers shall file a return.')).toEqual([]);
    expect(terms('')).toEqual([]);
  });

  it('covers the whole text with contiguous segments, starting after the preamble', () => {
    const text =
      'As used in this section:\n(A) "X" means one.\n(B) "Y" means two.';
    const segments = segmentDefinitions(text);
    expect(text.slice(0, segments[0]?.start)).toBe('As used in this section:');
    expect(segments[0]?.end).toBe(segments[1]?.start);
    expect(segments[1]?.end).toBe(text.length);
    expect(text.slice(segments[1]?.start)).toContain('"Y" means two.');
  });

  it('does not double count the quoted and unquoted patterns on one sentence', () => {
    expect(terms('The term "Fund" means the fund.')).toEqual(['Fund']);
  });
});

describe('extractDefinitions', () => {
  it('scopes "As used in this section" to the enclosing section', () => {
    const defs = extractDefinitions([
      sec('sec-1', 'As used in this section:\n(A) "Fee" means a charge.', {
        num: '1',
        heading: 'Definitions',
      }),
    ]);
    expect(defs).toEqual([
      {
        term: 'Fee',
        text: '(A) "Fee" means a charge.',
        sectionId: 'sec-1',
        scope: 'section',
        scopeSectionId: 'sec-1',
      },
    ]);
  });

  it.each([
    ['As used in this chapter', 'document'],
    ['In this Act', 'document'],
    ['As used in this title', 'document'],
    ['For purposes of this bill', 'document'],
    ['As used in this part', 'unknown'],
  ])('maps "%s" to scope %s', (phrase, scope) => {
    const [def] = extractDefinitions([
      sec('sec-2', `${phrase}, "Zed" means a letter.`, { num: '2' }),
    ]);
    expect(def?.scope).toBe(scope);
    expect(def?.scopeSectionId).toBeUndefined();
  });

  it('is unknown when the text states no scope', () => {
    const [def] = extractDefinitions([sec('sec-1', '"Zed" means a letter.')]);
    expect(def?.scope).toBe('unknown');
  });

  it('climbs out of subdivisions for "this section" but not for "this subsection"', () => {
    const tree = [
      sec('sec-4', '', {
        num: '4',
        children: [
          sec('sec-4/a', 'As used in this section, "Fee" means a charge.', {
            num: '(a)',
            level: 2,
          }),
          sec('sec-4/b', 'As used in this subsection, "Levy" means a tax.', {
            num: '(b)',
            level: 2,
          }),
        ],
      }),
    ];
    const defs = extractDefinitions(tree);
    expect(defs.map((d) => [d.term, d.scopeSectionId])).toEqual([
      ['Fee', 'sec-4'],
      ['Levy', 'sec-4/b'],
    ]);
  });

  it('inherits scope from an ancestor lead-in (federal "In this Act:")', () => {
    const defs = extractDefinitions([
      sec('sec-2', 'In this Act:', {
        num: '2',
        heading: 'Definitions',
        children: [
          sec('sec-2/1', 'The term "Secretary" means the Secretary of Labor.', {
            num: '(1)',
            level: 2,
          }),
        ],
      }),
    ]);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ term: 'Secretary', scope: 'document' });
  });

  it('ignores struck text and de-duplicates a repeated term in one section', () => {
    const defs = extractDefinitions([
      sec('sec-1', '', {
        spans: [
          { text: '"Old" means gone.', status: 'deleted' },
          { text: '"New" means here. "new" means again.', status: 'unchanged' },
        ],
      }),
    ]);
    expect(defs.map((d) => d.term)).toEqual(['New']);
  });
});

describe('mergeDefinitions', () => {
  it('keeps existing definitions and adds only new (section, term) pairs', () => {
    const a = {
      term: 'Fee',
      text: 'x',
      sectionId: 's',
      scope: 'unknown' as const,
    };
    const b = { ...a, term: 'fee', text: 'y' };
    const c = { ...a, term: 'Levy' };
    expect(mergeDefinitions([a], [b, c])).toEqual([a, c]);
  });
});

describe('createTermMatcher', () => {
  const def = (
    term: string,
    over: Partial<Parameters<typeof mergeDefinitions>[0][number]> = {},
  ) => ({
    term,
    text: `"${term}" means x.`,
    sectionId: 'sec-1',
    scope: 'document' as const,
    ...over,
  });

  it('matches case-insensitively on whole words only', () => {
    const match = createTermMatcher([def('Fee')]);
    expect(match('The FEE is due; fees differ; feel free.', 'sec-9')).toEqual([
      'Fee',
    ]);
    expect(match('feeling', 'sec-9')).toEqual([]);
  });

  it('prefers the longest term and hides shorter terms inside it', () => {
    const match = createTermMatcher([def('child'), def('dependent child')]);
    expect(match('A dependent child qualifies.', 'sec-9')).toEqual([
      'dependent child',
    ]);
    expect(match('A dependent child and a child.', 'sec-9')).toEqual([
      'dependent child',
      'child',
    ]);
  });

  it('honours section scope, including descendant sections', () => {
    const match = createTermMatcher([
      def('Fee', { scope: 'section', scopeSectionId: 'sec-1' }),
    ]);
    expect(match('The fee.', 'sec-1')).toEqual(['Fee']);
    expect(match('The fee.', 'sec-1/a')).toEqual(['Fee']);
    expect(match('The fee.', 'sec-12')).toEqual([]);
  });

  it('does not report a chunk as using the term it defines', () => {
    const match = createTermMatcher([def('Fee'), def('Levy')]);
    expect(match('"Fee" means a levy.', 'sec-1', 'fee')).toEqual(['Levy']);
  });

  it('treats multi-word terms flexibly about whitespace and escapes regex characters', () => {
    const match = createTermMatcher([def('small  business'), def('C+ (plan)')]);
    expect(match('A small\nbusiness and a C+ (plan).', 'sec-1')).toEqual([
      'small  business',
      'C+ (plan)',
    ]);
  });

  it('applies when any same-named definition is in scope', () => {
    const match = createTermMatcher([
      def('Fee', { scope: 'section', scopeSectionId: 'sec-1' }),
      def('fee', { sectionId: 'sec-5' }),
    ]);
    expect(match('The fee.', 'sec-9')).toEqual(['Fee']);
  });
});
