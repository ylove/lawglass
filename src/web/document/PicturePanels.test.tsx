import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { PictureEntry } from '../../core/model/index.js';
import { PicturePanels } from './PicturePanels.js';

afterEach(cleanup);

const entry = (panels: PictureEntry['panels']): PictureEntry => ({
  item: 0,
  text: 'text',
  panels,
});

describe('PicturePanels', () => {
  test('draws sides, link, carry, note and stamp, all hidden from assistive technology', () => {
    const { container } = render(
      <PicturePanels
        entry={entry([
          {
            left: { glyphs: ['bank'], label: 'Bank' },
            link: 'to',
            carry: 'coins',
            note: 'monthly',
            right: { glyphs: ['person', 'people'], label: 'Holders' },
            stamp: { glyph: 'seal', label: 'Federal' },
          },
          { left: { glyphs: ['document'] }, link: 'none' },
        ])}
      />,
    );
    const root = container.firstElementChild!;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelectorAll('.pp-panel')).toHaveLength(2);
    expect(root.textContent).toContain('Bank');
    expect(root.textContent).toContain('Holders');
    expect(root.textContent).toContain('monthly');
    expect(root.textContent).toContain('Federal');
    // `none` draws no link at all.
    expect(root.querySelectorAll('.pp-link')).toHaveLength(1);
    expect(root.querySelectorAll('svg').length).toBeGreaterThan(5);
  });

  test('labels are plain text, never markup', () => {
    const { container } = render(
      <PicturePanels
        entry={entry([
          {
            left: { glyphs: ['person'], label: '<b>Bold</b>' },
            link: 'none',
          },
        ])}
      />,
    );
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>Bold</b>');
  });

  test('a blocked link carries a barred-circle mark, not just a colour', () => {
    const { container } = render(
      <PicturePanels
        entry={entry([
          {
            left: { glyphs: ['business'] },
            link: 'blocked',
            right: { glyphs: ['person'] },
          },
        ])}
      />,
    );
    expect(
      container.querySelector('.pp-link[data-link="blocked"] .pp-ban'),
    ).toBeTruthy();
  });

  test('equals and both use their own marks', () => {
    const { container } = render(
      <PicturePanels
        entry={entry([
          {
            left: { glyphs: ['coins'] },
            link: 'equals',
            right: { glyphs: ['money'] },
          },
          {
            left: { glyphs: ['coins'] },
            link: 'both',
            right: { glyphs: ['money'] },
          },
        ])}
      />,
    );
    expect(container.querySelector('[data-link="equals"] .pp-ban')).toBeNull();
    expect(container.querySelectorAll('.pp-arrow-icon')).toHaveLength(2);
  });
});
