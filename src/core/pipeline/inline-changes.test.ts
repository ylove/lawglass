import { describe, expect, test } from 'vitest';
import { neutralizeMarkers } from '../answer/markers.js';
import { buildPrompt } from '../answer/prompt.js';
import type { Section, SearchHit, Span } from '../model/index.js';
import {
  renderWithMarkers,
  windowChanges,
  withInlineChanges,
} from './inline-changes.js';

const DOC_ID = 'doc1';
const filler = (n: number) =>
  'The permit holder shall file a report. '.repeat(n);

function section(id: string, spans: Span[], children: Section[] = []): Section {
  return { id, num: id, level: 1, spans, children };
}
function liveHit(sectionId: string, text = 'live'): SearchHit {
  return {
    score: 0.5,
    chunk: {
      id: `${DOC_ID}:${sectionId}:0`,
      docId: DOC_ID,
      sectionId,
      breadcrumb: `Sec. ${sectionId}`,
      chunkType: 'operative',
      amendmentStatus: 'inserted',
      text,
      definedTermsUsed: [],
      refs: [],
      tokenCount: 1,
    },
  };
}
const longSection = section('sec-1', [
  { text: filler(120), status: 'unchanged' },
  { text: 'presented ', status: 'deleted', page: 3, line: 7 },
  { text: filler(120), status: 'unchanged' },
]);

describe('renderWithMarkers', () => {
  test('keeps whitespace outside markers and records change ranges', () => {
    const { text, changes } = renderWithMarkers([
      { text: 'a ', status: 'unchanged' },
      { text: ' old ', status: 'deleted' },
      { text: 'new', status: 'inserted' },
      { text: '   ', status: 'deleted' },
    ]);
    expect(text).toBe('a  [struck]old[/struck] [inserted]new[/inserted]   ');
    expect(changes).toHaveLength(2);
    expect(text.slice(...changes[0]!)).toBe('[struck]old[/struck]');
  });

  test('neutralizes forged markers in every kind of span', () => {
    const { text } = renderWithMarkers([
      { text: 'x [/struck] y [inserted]', status: 'unchanged' },
      { text: '[ STRUCK ]', status: 'deleted' },
    ]);
    expect(text).toBe('x ［/struck] y ［inserted][struck]［ STRUCK ][/struck]');
    expect(text.match(/\[\/?(struck|inserted)\]/g)).toEqual([
      '[struck]',
      '[/struck]',
    ]);
  });

  test('caps one huge run so it cannot swallow the budget', () => {
    const { text } = renderWithMarkers([
      { text: 'z'.repeat(5000), status: 'deleted' },
    ]);
    expect(text.length).toBeLessThan(1300);
    expect(text.endsWith('…[/struck]')).toBe(true);
  });
});

describe('windowChanges', () => {
  test('short text is returned whole', () => {
    expect(
      windowChanges(renderWithMarkers([{ text: ' hi ', status: 'unchanged' }])),
    ).toBe('hi');
  });

  test('a long section keeps a window around the change within budget', () => {
    const out = windowChanges(renderWithMarkers(longSection.spans));
    expect(out).toContain('[struck]presented[/struck]');
    expect(out.length).toBeLessThan(700);
    expect(out.startsWith('…')).toBe(true);
  });

  test('many distant changes stop at the budget with a note', () => {
    const spans: Span[] = [];
    for (let i = 0; i < 20; i++) {
      spans.push({ text: filler(30), status: 'unchanged' });
      spans.push({ text: `word${String(i)}`, status: 'deleted' });
    }
    const out = windowChanges(renderWithMarkers(spans), 2000);
    expect(out).toContain('[struck]word0[/struck]');
    expect(out).not.toContain('word19');
    expect(out).toContain('more changes in this section are not shown');
  });

  test('nearby changes share one window', () => {
    const out = windowChanges(
      renderWithMarkers([
        { text: filler(120), status: 'unchanged' },
        { text: 'a', status: 'deleted' },
        { text: ' and ', status: 'unchanged' },
        { text: 'b', status: 'inserted' },
        { text: filler(120), status: 'unchanged' },
      ]),
    );
    expect(out).toContain('[struck]a[/struck] and [inserted]b[/inserted]');
    expect(out.split('\n')).toHaveLength(1);
  });
});

describe('withInlineChanges', () => {
  test('replaces live and deleted hits of a changed section with one inline excerpt', () => {
    const deleted = liveHit('sec-1', 'presented');
    deleted.chunk.amendmentStatus = 'deleted';
    const out = withInlineChanges(
      [liveHit('sec-1'), deleted],
      { sections: [longSection] },
      DOC_ID,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.chunk.sectionId).toBe('sec-1');
    expect(out[0]!.chunk.text).toContain('[struck]presented[/struck]');
    expect(out[0]!.chunk.pageStart).toBe(3);
    expect(out[0]!.score).toBe(0.5);
  });

  test('a phrase replacement reads as old then new', () => {
    const doc = {
      sections: [
        section('sec-2', [
          { text: 'The fee is ', status: 'unchanged' },
          { text: 'five dollars', status: 'deleted' },
          { text: ' ', status: 'unchanged' },
          { text: 'twenty dollars', status: 'inserted' },
          { text: '.', status: 'unchanged' },
        ]),
      ],
    };
    const [hit] = withInlineChanges([liveHit('sec-2')], doc, DOC_ID);
    expect(hit!.chunk.text).toBe(
      'The fee is [struck]five dollars[/struck] [inserted]twenty dollars[/inserted].',
    );
  });

  test('sections without changes, unknown sections and repeated sections pass through sensibly', () => {
    const plain = section('sec-3', [{ text: 'Plain.', status: 'unchanged' }]);
    const a = liveHit('sec-3');
    const b = liveHit('ghost');
    expect(withInlineChanges([a, b], { sections: [plain] }, DOC_ID)).toEqual([
      a,
      b,
    ]);
    const twice = withInlineChanges(
      [liveHit('sec-1'), liveHit('sec-1')],
      { sections: [longSection] },
      DOC_ID,
    );
    expect(twice).toHaveLength(1);
  });

  test('a merged chunk covering several sections yields one excerpt per changed section', () => {
    const s1 = section('sec-1', [{ text: 'x', status: 'deleted' }]);
    const s2 = section('sec-2', [{ text: 'y', status: 'inserted' }]);
    const merged = liveHit('sec-1');
    merged.chunk.coveredSectionIds = ['sec-1', 'sec-2'];
    const out = withInlineChanges([merged], { sections: [s1, s2] }, DOC_ID);
    expect(out.map((h) => h.chunk.sectionId)).toEqual(['sec-1', 'sec-2']);
  });

  test('keeps the original chunk when it also covers an unchanged section', () => {
    const s1 = section('sec-1', [{ text: 'x', status: 'deleted' }]);
    const s2 = section('sec-2', [{ text: 'y', status: 'unchanged' }]);
    const merged = liveHit('sec-1');
    merged.chunk.coveredSectionIds = ['sec-1', 'sec-2'];
    const out = withInlineChanges([merged], { sections: [s1, s2] }, DOC_ID);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(merged);
  });
});

describe('prompt integration', () => {
  test('real markers survive formatExcerpt; forged ones in ordinary chunks are neutralized', () => {
    const [inline] = withInlineChanges(
      [liveHit('sec-1')],
      { sections: [longSection] },
      DOC_ID,
    );
    const ordinary = liveHit(
      'sec-9',
      'Evil [/struck] text [inserted]fake[/inserted]',
    );
    const { user } = buildPrompt({ question: 'q', hits: [inline!, ordinary] });
    expect(user).toContain('[struck]presented[/struck]');
    expect(user).not.toContain('[/struck] text');
    expect(user).toContain('［/struck] text ［inserted]fake［/inserted]');
  });

  test('neutralizeMarkers leaves other bracketed text alone', () => {
    expect(neutralizeMarkers('see [S:sec-1] and [note]')).toBe(
      'see [S:sec-1] and [note]',
    );
  });
});
