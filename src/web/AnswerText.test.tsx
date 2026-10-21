import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Citation } from '../core/model/index.js';
import { ScriptedProvider } from '../../tests/contracts/scripted-provider.js';
import { AnswerText, stripMarkers } from './AnswerText.js';

afterEach(cleanup);

const citations: Citation[] = [
  { sectionId: 'sec-2307.601/a/1', valid: true, chunkIds: [] },
  { sectionId: 'sec-2', valid: true, chunkIds: [] },
  { sectionId: 'invalid', valid: false, chunkIds: [] },
];
const example =
  '**Section 2307.601 (civil lawsuits)** - In division (A)(1), the bill removes "has" and "meaning" from the definition line [S:sec-2307.601/a/1]. The line will say ...';

function answer(text: string, sources = citations) {
  const open = vi.fn();
  return {
    ...render(
      <AnswerText text={text} citations={sources} onOpenCitation={open} />,
    ),
    open,
  };
}

describe('answer markdown', () => {
  test('an escaped bracket is literal text, not a citation', () => {
    const { container } = answer('See \\[S:sec-2] and \\[x] here.');
    expect(container.textContent).toBe('See [S:sec-2] and [x] here.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('renders the Sonnet example as a bold-led paragraph with a source button', () => {
    const { container } = answer(example);
    expect(container.querySelector('p strong')?.textContent).toBe(
      'Section 2307.601 (civil lawsuits)',
    );
    expect(container.textContent).toContain(' - In division (A)(1)');
    expect(screen.getByRole('button', { name: 'Source 1' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/\*\*|\[S:/);
  });

  test('renders bold and italic inside bullets, including citations inside emphasis', () => {
    const { container, open } = answer(
      `- ${example}\n* **Added [S:sec-2]** and *removed [S:sec-2307.601/a/1]*.`,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    const second = screen.getAllByRole('listitem')[1]!;
    const source = screen.getByRole('button', { name: 'Source 2' });
    expect(source.closest('strong')).toBeTruthy();
    expect(second.querySelector('em button')?.textContent).toBe('1');
    fireEvent.click(source);
    expect(open).toHaveBeenCalledWith('sec-2', source);
    expect(container.textContent).not.toMatch(/\*|\[S:/);
  });

  test('splits adjacent paragraphs, unordered lists and ordered lists without blank lines', () => {
    const { container } = answer(
      'Intro\n- First\n* Second\n3. **Third** [S:sec-2]\n4. Fourth\nOutro',
    );
    expect([...container.children].map((node) => node.tagName)).toEqual([
      'P',
      'UL',
      'OL',
      'P',
    ]);
    expect(container.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(container.querySelector('ul')?.hasAttribute('start')).toBe(false);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(container.querySelector('ol strong')?.textContent).toBe('Third');
  });

  test('preserves line breaks and normalizes CRLF and whitespace-only paragraph separators', () => {
    const { container } = answer('First\r\nsecond\r\n  \r\nThird\rfourth');
    expect(container.querySelectorAll('p')).toHaveLength(2);
    expect(container.querySelectorAll('br')).toHaveLength(2);
    expect(container.querySelectorAll('p')[0]?.textContent).toBe('Firstsecond');
  });

  test('renders no blocks for an empty or whitespace-only answer', () => {
    const { container } = answer(' \n\t\r\n');
    expect(container.childElementCount).toBe(0);
  });

  test.each([
    ['**bold *italic* bold**', 'strong em'],
    ['*italic **bold** italic*', 'em strong'],
    ['***both***', 'strong em'],
    ['**unclosed *nested', 'strong em'],
  ])('supports nested emphasis in %s', (text, selector) => {
    const { container } = answer(text);
    expect(container.querySelector(selector)).toBeTruthy();
    expect(container.textContent).not.toContain('*');
  });

  test('limits formatted nesting to three levels and keeps deeper paired markers literal', () => {
    const { container } = answer(
      '**one *two **three *four **five** four* three** two* one**',
    );
    expect(container.querySelectorAll('strong, em')).toHaveLength(3);
    expect(container.querySelector('strong em strong')?.textContent).toBe(
      'three *four **five** four* three',
    );
    expect(
      container.querySelector('strong em strong strong, strong em strong em'),
    ).toBeNull();
    expect(container.textContent).toBe(
      'one two three *four **five** four* three two one',
    );
  });

  test.each([
    ['the reviewer nesting probe', '*a **b '.repeat(2000)],
    ['a 50,000-character answer', '*a **b '.repeat(7143).slice(0, 50_000)],
  ])('renders %s without throwing or freezing', (_, text) => {
    const start = performance.now();
    const { container } = answer(text);
    const elapsed = performance.now() - start;
    // Normal local runs should be under 100 ms; leave room for busy CI workers.
    expect(elapsed).toBeLessThan(1000);
    expect(container.querySelectorAll('strong, em').length).toBeLessThanOrEqual(
      3,
    );
    expect(container.textContent).toContain('*a **b ');
    console.info(
      `Answer render (${String(text.length)} characters): ${elapsed.toFixed(1)} ms`,
    );
  });

  test.each([
    '** x **',
    '* * *',
    '**',
    '*',
    '****',
    '*[S:unknown]*',
    '**[S:invalid]**',
  ])('never emits empty emphasis for %s', (text) => {
    const { container } = answer(text);
    expect(container.querySelector('strong, em')).toBeNull();
    expect(container.textContent).toContain('*');
    if (text === '** x **') expect(container.textContent).toBe(text);
  });

  test.each(['- ', '* ', '1. ', '- \t '])(
    'keeps a bare list prefix %s plain until content arrives',
    (prefix) => {
      const { container, rerender } = answer(prefix);
      expect(container.querySelector('ul, ol, li')).toBeNull();
      expect(container.querySelector('p')?.textContent).toBe(prefix);
      rerender(
        <AnswerText
          text={`${prefix}Item`}
          citations={[]}
          onOpenCitation={vi.fn()}
        />,
      );
      expect(container.querySelector('li')?.textContent).toBe('Item');
    },
  );

  test('omits list items whose only content is a hidden citation', () => {
    const { container } = answer(
      '- [S:unknown]\n- [S:invalid]\n- Visible [S:sec-2]',
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(container.querySelector('li')?.textContent).toBe('Visible 1');
    const empty = answer('- [S:unknown]');
    expect(empty.container.querySelector('ul, li')).toBeNull();
  });

  test('resets unclosed emphasis at a blank line', () => {
    const { container } = answer('**bold unclosed\n\nnext paragraph');
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs[0]?.querySelector('strong')?.textContent).toBe(
      'bold unclosed',
    );
    expect(paragraphs[1]?.querySelector('strong')).toBeNull();
    expect(paragraphs[1]?.textContent).toBe('next paragraph');
  });

  test('keeps open bold elements stable as the stream grows and closes', () => {
    const open = vi.fn();
    const { container, rerender } = render(
      <AnswerText text="- **Section" citations={[]} onOpenCitation={open} />,
    );
    const bold = container.querySelector('strong');
    const item = container.querySelector('li');
    expect(bold?.textContent).toBe('Section');
    for (const text of ['- **Section 2', '- **Section 2*', '- **Section 2**']) {
      rerender(<AnswerText text={text} citations={[]} onOpenCitation={open} />);
      expect(container.querySelector('strong')).toBe(bold);
      expect(container.querySelector('li')).toBe(item);
      expect(bold?.textContent).toBe(
        text.endsWith('2*') ? 'Section 2*' : 'Section 2',
      );
      expect(container.querySelector('em')).toBeNull();
    }
  });

  test('renders a scripted model stream with open emphasis and partial citations', async () => {
    const provider = new ScriptedProvider({ reply: `- ${example}` });
    const open = vi.fn();
    const { container, rerender } = render(
      <AnswerText text="" citations={[]} onOpenCitation={open} />,
    );
    let text = '';
    let sawOpenBold = false;
    for await (const event of provider.streamText({
      system: 'Answer with citations.',
      messages: [{ role: 'user', content: 'What does it change?' }],
      maxTokens: 200,
    })) {
      if (event.type === 'text') text += event.text;
      rerender(
        <AnswerText
          text={event.type === 'done' ? text : stripMarkers(text)}
          citations={event.type === 'done' ? citations : []}
          onOpenCitation={open}
        />,
      );
      if (text.includes('**Section ') && !text.includes('lawsuits)**')) {
        sawOpenBold = true;
        expect(container.querySelector('strong')?.textContent).toContain(
          'Section',
        );
      }
      expect(container.textContent).not.toMatch(/\*\*|\[S:/);
    }
    expect(sawOpenBold).toBe(true);
    expect(screen.getByRole('button', { name: 'Source 1' })).toBeTruthy();
  });

  test('keeps HTML, links, and images as escaped text even inside emphasis', () => {
    const payload = '<script>alert(1)</script> <img src=x onerror=alert(1)>';
    const { container } = answer(
      `- **${payload}**\n\n[click](javascript:alert(1)) ![image](https://example.org/x)`,
    );
    expect(container.querySelector('strong')?.textContent).toBe(payload);
    expect(container.querySelector('script, img, a')).toBeNull();
    expect(container.textContent).toContain('[click](javascript:alert(1))');
  });

  test('skips unknown and invalid citations without breaking emphasis or numbering', () => {
    const { container } = answer(
      '**[S:unknown] [S:invalid] [S:sec-2]** then [S:sec-2307.601/a/1] [S:sec-2]',
    );
    expect(screen.getAllByRole('button', { name: 'Source 1' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Source 2' })).toHaveLength(1);
    expect(container.querySelector('strong button')?.textContent).toBe('1');
    expect(container.textContent).not.toContain('[S:');
  });

  test('does not parse emphasis inside citation ids', () => {
    const { container } = answer('**Source [S:sec-*id*]**', [
      { sectionId: 'sec-*id*', valid: true, chunkIds: [] },
    ]);
    expect(container.querySelector('strong button')?.textContent).toBe('1');
    expect(container.querySelector('em')).toBeNull();
  });

  test('preserves spaced asterisks, escaped punctuation, and non-list numerals', () => {
    const { container } = answer(
      '2 * 3 and \\*literal\\* and \\*\\*literal\\*\\*\n1.no list',
    );
    expect(container.textContent).toBe(
      '2 * 3 and *literal* and **literal**1.no list',
    );
    expect(container.querySelector('em, strong, ol, ul')).toBeNull();
  });
});

describe('whitespace before removed citation markers', () => {
  test('streaming strips the space before punctuation that follows a marker', () => {
    expect(stripMarkers('the deadline [S:sec-4].')).toBe('the deadline.');
    expect(stripMarkers('a [S:a] and b [S:b], c')).toBe('a  and b, c');
  });

  test('final rendering has no space before the superscript when punctuation follows', () => {
    const { container } = render(
      <AnswerText
        text="the deadline [S:sec-4]."
        citations={[
          {
            sectionId: 'sec-4',
            valid: true,
          } as unknown as Citation,
        ]}
        onOpenCitation={() => undefined}
      />,
    );
    expect(container.querySelector('p')?.textContent).toBe('the deadline1.');
    expect(screen.getByRole('button', { name: 'Source 1' })).toBeTruthy();
  });

  test('an invalid marker before punctuation also leaves no gap', () => {
    const { container } = render(
      <AnswerText
        text="the deadline [S:nope]."
        citations={[]}
        onOpenCitation={() => undefined}
      />,
    );
    expect(container.querySelector('p')?.textContent).toBe('the deadline.');
  });
});

describe('stripMarkers on hostile input', () => {
  test('drops only a trailing half-typed marker', () => {
    expect(stripMarkers('the deadline [S:sec')).toBe('the deadline');
    expect(stripMarkers('a [S:x] b [')).toBe('a  b');
    expect(stripMarkers('keep [this] text')).toBe('keep [this] text');
    expect(stripMarkers('[')).toBe('');
  });

  test('is linear on a long run of brackets', () => {
    const started = performance.now();
    stripMarkers(`${'['.repeat(200_000)}x y`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
