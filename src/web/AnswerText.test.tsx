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
      expect(bold?.textContent).toBe('Section 2');
      expect(container.textContent).not.toContain('*');
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
