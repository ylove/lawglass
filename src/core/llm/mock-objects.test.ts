import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockProvider } from './mock.js';

const provider = new MockProvider();
const ask = async (schemaName: string, prompt: string) =>
  (
    await provider.generateObject({
      system: 'x',
      prompt,
      schema: z.unknown(),
      schemaName,
      maxTokens: 100,
    })
  ).object;

describe('mock structured replies', () => {
  it('writes one cited brief per listed part', async () => {
    const reply = await ask(
      'section_briefs',
      'Write the brief for each:\n- id sec-2: Section 2, Grants\n- id sec-3: Definitions</question>',
    );
    expect(reply).toEqual({
      briefs: [
        {
          id: 'sec-2',
          text: 'This part covers Section 2, Grants. [S:sec-2]',
          example: 'available',
        },
        {
          id: 'sec-3',
          text: 'This part covers Definitions. [S:sec-3]',
          example: 'none',
        },
      ],
    });
  });

  it('draws every item except a lead-in', async () => {
    const reply = (await ask(
      'pictures',
      '<items>\n<item n="0">In this Act:</item>\n<item n="1">Groups get grants.</item>\n</items>',
    )) as { pictures: { item: number }[] };
    expect(reply.pictures.map((p) => p.item)).toEqual([1]);
  });

  it('quotes a sentence that is in a candidate, and reports one that is not', async () => {
    const prompt = (sentence: string) =>
      `<candidates>\n<excerpt id="1" section="sec-2">Award notices &amp; more shall state the season.</excerpt>\n</candidates>\n<sentence>${sentence}</sentence>`;
    expect(
      await ask('locate', prompt('notices &amp; more shall')),
    ).toMatchObject({
      matches: [{ passage: 1, quote: 'notices & more shall' }],
      notFound: false,
    });
    expect(await ask('locate', prompt('nothing like it'))).toEqual({
      matches: [],
      notFound: true,
    });
  });

  it('gives an example only for a focused part, and the empty object otherwise', async () => {
    const focused = (await ask(
      'scenario',
      '<persona>Casey</persona>\n<focus>Grants</focus>\n<excerpts>\n<excerpt id="1" section="sec-2">x</excerpt>\n</excerpts>',
    )) as { frames: { citations: string[] }[] };
    expect(focused.frames.at(-1)?.citations).toEqual(['sec-2']);
    expect(await ask('scenario', '<persona>Casey</persona>')).toBeUndefined();
  });
});
