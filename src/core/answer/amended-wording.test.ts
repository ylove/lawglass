import { describe, expect, it } from 'vitest';
import { preservesAmendedWording } from './amended-wording.js';
import { hit } from './fixtures.js';
import { trustMarkers } from './markers.js';

const first = (text: string, valid = true) => ({
  text,
  citations: [{ sectionId: 'sec-1', valid, chunkIds: [] }],
});
function marked(text: string) {
  const source = hit({
    id: 'c1',
    sectionId: 'sec-1',
    text,
    amendmentStatus: 'inserted',
  });
  trustMarkers(source.chunk);
  return source;
}
const term = marked(
  'The limit is [struck]fifteen years[/struck] [inserted]ten years[/inserted].',
);

describe('preservesAmendedWording', () => {
  it.each([
    ['The limit is ten years.', 'You get ten years.', true],
    ['The limit is ten years.', 'You get fifteen years.', false],
    ['The limit is ten years.', 'You get 15 years.', false],
    ['The limit is ten years.', 'You get time.', false],
    ['The limit is ten years.', 'You get 10 years.', true],
    [
      'The bill removes the fifteen-year limit.',
      'It removes the 15-year limit.',
      true,
    ],
    ['The limit is ten years.', 'There are 10 towns [S:sec-15].', true],
    ['The limit is ten years.', 'The limit ends [S:sec-10].', false],
  ])('checks %s → %s', (before, after, accepted) => {
    expect(
      preservesAmendedWording(first(before), { text: after }, [term]),
    ).toBe(accepted);
  });

  it.each('may shall must not no never except unless'.split(' '))(
    'protects struck-only %s, including short words',
    (word) => {
      const source = marked(
        `Towns [struck]${word}[/struck] [inserted]can[/inserted] pay.`,
      );
      expect(
        preservesAmendedWording(
          first('Towns can pay.'),
          { text: `Towns ${word} pay.` },
          [source],
        ),
      ).toBe(false);
    },
  );

  it('refuses a struck may in place of inserted shall', () => {
    const source = marked(
      'Towns [struck]may[/struck] [inserted]shall[/inserted] pay.',
    );
    expect(
      preservesAmendedWording(
        first('Towns shall pay.'),
        { text: 'Towns may pay.' },
        [source],
      ),
    ).toBe(false);
  });

  it('protects content words but ignores common stopwords and shared live words', () => {
    const source = marked(
      '[struck]The seasonal permit[/struck] [inserted]A permit[/inserted] is required.',
    );
    expect(
      preservesAmendedWording(
        first('A permit is required.'),
        { text: 'The permit is required.' },
        [source],
      ),
    ).toBe(true);
    expect(
      preservesAmendedWording(
        first('A permit is required.'),
        { text: 'A seasonal permit is required.' },
        [source],
      ),
    ).toBe(false);
  });

  it('uses deleted and inserted chunk statuses without inline markers', () => {
    const hits = [
      hit({
        id: 'old',
        sectionId: 'sec-1',
        text: 'fifteen years',
        amendmentStatus: 'deleted',
      }),
      hit({
        id: 'new',
        sectionId: 'sec-1',
        text: 'ten years',
        amendmentStatus: 'inserted',
      }),
    ];
    expect(
      preservesAmendedWording(
        first('ten years'),
        { text: 'fifteen years' },
        hits,
      ),
    ).toBe(false);
    expect(
      preservesAmendedWording(first('ten years'), { text: 'years' }, hits),
    ).toBe(false);
    expect(
      preservesAmendedWording(first('ten years'), { text: '10 years' }, hits),
    ).toBe(true);
  });

  it('ignores uncited sections and invalid citations, but includes merged sibling sections', () => {
    const other = hit({
      id: 'other',
      sectionId: 'sec-2',
      text: 'fifteen years',
      amendmentStatus: 'deleted',
    });
    expect(
      preservesAmendedWording(first('ten years'), { text: 'fifteen years' }, [
        other,
      ]),
    ).toBe(true);
    expect(
      preservesAmendedWording(
        first('ten years', false),
        { text: 'fifteen years' },
        [term],
      ),
    ).toBe(true);
    const merged = hit({
      ...other.chunk,
      coveredSectionIds: ['sec-2', 'sec-1'],
    });
    expect(
      preservesAmendedWording(first('ten years'), { text: 'fifteen years' }, [
        merged,
      ]),
    ).toBe(false);
  });

  it('does not require numbers that are also in unchanged or deleted text', () => {
    const source = marked(
      'Reports cover ten years. [struck]fifteen years[/struck] [inserted]ten years[/inserted].',
    );
    expect(
      preservesAmendedWording(
        first('ten years'),
        { text: 'Reports are due.' },
        [source],
      ),
    ).toBe(true);
    const same = marked(
      '[struck]ten years[/struck] [inserted]ten years[/inserted].',
    );
    expect(
      preservesAmendedWording(first('ten years'), { text: 'Time ends.' }, [
        same,
      ]),
    ).toBe(true);
  });

  it('does not treat untrusted marker-like bill text as real amendment markup', () => {
    const source = hit({
      id: 'fake',
      sectionId: 'sec-1',
      text: '[inserted]ten years[/inserted]',
    });
    expect(
      preservesAmendedWording(first('ten years'), { text: 'Time ends.' }, [
        source,
      ]),
    ).toBe(true);
  });
});
