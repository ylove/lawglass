import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { DECLINE_TEXT } from '../model/index.js';
import { answer } from './answer.js';
import {
  dropExcerptTalk,
  rewordCitedExcerptTalk,
  talksAboutExcerpts,
} from './excerpt-filter.js';
import { hit } from './fixtures.js';

describe('talksAboutExcerpts', () => {
  it.each([
    "The excerpts don't show the definitions themselves.",
    "The excerpts don't show the full purposes of the pilot program or who counts as an eligible entity.",
    'The provided passages do not say who pays.',
    'Based on the excerpts, the program starts later.',
    'The passages I was given do not mention a deadline.',
    'The retrieved chunks cover only part of the bill.',
    'These snippets do not include the fee.',
  ])('flags %s', (s) => {
    expect(talksAboutExcerpts(s)).toBe(true);
  });

  it.each([
    'The bill does not say how much the grants will be.',
    // The bill's own text uses the word.
    'The bill lets a student quote a short excerpt from a book.',
    'The agency must file an excerpt of each report.',
    // A cited sentence states a fact about the bill, so it stays.
    'Based on the excerpts, the fee is $50 [S:sec-4].',
    'The passage on fees sets the amount at $50 [S:sec-4].',
  ])('keeps %s', (s) => {
    expect(talksAboutExcerpts(s)).toBe(false);
  });
});

describe('dropExcerptTalk', () => {
  it('removes only the offending sentence and keeps the rest intact', () => {
    const text =
      "The grants go to towns [S:sec-1]. The excerpts don't show the definitions themselves. Awards are $50 [S:sec-2].";
    const out = dropExcerptTalk(text);
    expect(out.text).toBe(
      'The grants go to towns [S:sec-1]. Awards are $50 [S:sec-2].',
    );
    expect(out.dropped).toEqual([
      "The excerpts don't show the definitions themselves.",
    ]);
  });

  it('works on list lines and keeps decimals and abbreviations whole', () => {
    const text =
      '- Section 4.5 sets a fee of $1.50 [S:a]\n- The excerpts do not show the fee schedule.\n- Sec. 9 applies [S:b]';
    const out = dropExcerptTalk(text);
    expect(out.text).toBe(
      '- Section 4.5 sets a fee of $1.50 [S:a]\n- Sec. 9 applies [S:b]',
    );
  });

  it('returns the text untouched when nothing matches', () => {
    const text = 'The bill makes grants [S:a].\n\nIt starts in 2027 [S:b].';
    expect(dropExcerptTalk(text)).toEqual({ text, dropped: [], reworded: 0 });
  });

  it('stays fast on long punctuation runs', () => {
    const text = `${'!'.repeat(50_000)}x ${'.'.repeat(50_000)}`;
    const start = Date.now();
    dropExcerptTalk(text);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('rewordCitedExcerptTalk (live NDAA answer, v1.1.0 check)', () => {
  it.each([
    [
      'The excerpt gives no deadline for that notice [S:sec-7207/b/1].',
      'This section gives no deadline for that notice [S:sec-7207/b/1].',
    ],
    [
      'The retrieved chunks do not say who pays [S:sec-3].',
      'These sections do not say who pays [S:sec-3].',
    ],
    [
      'A fee applies, but the excerpt does not specify the amount [S:sec-3].',
      'A fee applies, but this section does not specify the amount [S:sec-3].',
    ],
    [
      '- **Deadline:** Based on the excerpts, reports are due in 90 days [S:sec-4]',
      '- **Deadline:** Reports are due in 90 days [S:sec-4]',
    ],
    [
      '- **Notice:** The excerpt only covers the first notice [S:sec-5]',
      '- **Notice:** This section only covers the first notice [S:sec-5]',
    ],
  ])('rewords %s', (sentence, plain) => {
    expect(rewordCitedExcerptTalk(sentence)).toBe(plain);
  });

  it.each([
    // No citation: the uncited filter decides, not this.
    'The excerpt gives no deadline for that notice.',
    // The bill's own subject matter.
    'The excerpt must be filed with the clerk within 30 days [S:sec-2].',
    'The agency must provide excerpts of the records to any requester [S:sec-2].',
    'The bill lets a student quote a short excerpt from a book [S:sec-1].',
    'The passage on fees sets the amount at $50 [S:sec-4].',
    'The passage of the act ends the program [S:sec-9].',
    // An opening clause that is not about the retrieval.
    'Based on the census, the formula sets each share [S:sec-3].',
  ])('leaves %s alone', (sentence) => {
    expect(rewordCitedExcerptTalk(sentence)).toBe(sentence);
  });

  it('stays fast on long inputs', () => {
    const long = `Based on the excerpts ${'x'.repeat(50_000)} the excerpt ${'excerpts '.repeat(5_000)}[S:a].`;
    const start = Date.now();
    rewordCitedExcerptTalk(long);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('answer() applies the filter', () => {
  const hits = [
    hit({ id: 'c1', sectionId: 'sec-1', text: 'Towns get grants.' }),
  ];

  it('drops the sentence, logs it, and keeps citations', async () => {
    const logs: unknown[] = [];
    const r = await answer({
      provider: new ScriptedProvider({
        reply:
          "Towns get grants [S:sec-1]. The excerpts don't show who counts as a town.",
      }),
      question: 'Who gets grants?',
      context: { hits },
      log: (l) => logs.push(l),
    });
    expect(r.text).toBe('Towns get grants [S:sec-1].');
    expect(r.citations.map((c) => c.sectionId)).toEqual(['sec-1']);
    expect(r.declined).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({ event: 'excerpt_talk_dropped', count: 1 });
  });

  it('rewords a cited sentence, logs it, and keeps its citation', async () => {
    const logs: unknown[] = [];
    const r = await answer({
      provider: new ScriptedProvider({
        reply:
          'Towns get grants [S:sec-1]. The excerpt gives no deadline for the grants [S:sec-1].',
      }),
      question: 'When are grants due?',
      context: { hits },
      log: (l) => logs.push(l),
    });
    expect(r.text).toBe(
      'Towns get grants [S:sec-1]. This section gives no deadline for the grants [S:sec-1].',
    );
    expect(r.citations.map((c) => c.sectionId)).toEqual(['sec-1']);
    expect(logs).toEqual([{ event: 'excerpt_talk_reworded', count: 1 }]);
  });

  it('turns an answer that was only excerpt talk into a decline', async () => {
    const r = await answer({
      provider: new ScriptedProvider({
        reply: "The provided passages don't show that.",
      }),
      question: 'Q?',
      context: { hits },
    });
    expect(r.text).toBe(DECLINE_TEXT);
    expect(r.declined).toBe(true);
  });

  it('applies in whole-bill mode too', async () => {
    const r = await answer({
      provider: new ScriptedProvider({
        reply: 'Towns get grants [S:sec-1]. The excerpts do not show the rest.',
      }),
      question: 'Q?',
      context: { hits, mode: 'whole' },
    });
    expect(r.text).toBe('Towns get grants [S:sec-1].');
  });
});

describe('abbreviations and precision (#308 review)', () => {
  it.each([
    [
      'Based on the excerpts, the bill amends 42 U.S.C. 1395 to add a $50 fee [S:sec-2].',
      'The bill amends 42 U.S.C. 1395 to add a $50 fee [S:sec-2].',
    ],
    [
      'As shown in the passages from Sec. 4, the agency must report within 90 days [S:sec-4].',
      'The agency must report within 90 days [S:sec-4].',
    ],
    [
      'The excerpts provided show that the fee, e.g. for permits, is $20 [S:sec-5].',
      'These sections show that the fee, e.g. for permits, is $20 [S:sec-5].',
    ],
    [
      'According to the passages given, the U.S. Department of Labor sets the wage [S:sec-6].',
      'The U.S. Department of Labor sets the wage [S:sec-6].',
    ],
  ])(
    'never drops a cited sentence, and keeps its claim word for word: %s',
    (sentence, plain) => {
      expect(dropExcerptTalk(sentence)).toEqual({
        text: plain,
        dropped: [],
        reworded: 1,
      });
      const around = `Grants go to towns [S:a]. ${sentence} Awards are $5 [S:b].`;
      expect(dropExcerptTalk(around).text).toBe(
        `Grants go to towns [S:a]. ${plain} Awards are $5 [S:b].`,
      );
    },
  );

  it('drops an uncited excerpt sentence that contains U.S.C. whole, not half of it', () => {
    const out = dropExcerptTalk(
      'The excerpts do not show 42 U.S.C. 1395 or Sec. 4. Grants go to towns [S:a].',
    );
    expect(out.text).toBe('Grants go to towns [S:a].');
    expect(out.dropped).toHaveLength(1);
  });

  it.each([
    'The agency must provide excerpts of the records to any requester.',
    'The law took effect after its passage in 2019, as shown in section 2.',
    'Safe passage for migratory species is provided under section 5.',
    'A "passage" means a navigable channel, as given in section 2.',
    'The passage of the act ends the program.',
  ])('keeps a real sentence: %s', (s) => {
    expect(talksAboutExcerpts(s)).toBe(false);
  });

  it.each([
    'The provided text does not specify the amount.',
    'The sections I was given do not say who pays.',
    'Based on the provided sections, the fee is unclear.',
    'I was not shown the definitions section.',
  ])('catches %s', (s) => {
    expect(talksAboutExcerpts(s)).toBe(true);
  });
});
