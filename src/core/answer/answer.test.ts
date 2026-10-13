import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { MockProvider } from '../llm/mock.js';
import { DECLINE_TEXT, AnswerResult } from '../model/index.js';
import { answer } from './answer.js';
import { INJECTION_SAMPLES, hit } from './fixtures.js';

const hits = [
  hit({
    id: 'c1',
    sectionId: 'sec-1',
    text: 'The department shall award grants to each eligible town.',
    pageStart: 1,
    lineStart: 2,
    lineEnd: 4,
  }),
];

describe('answer', () => {
  it('streams tokens, validates citations and returns a schema-valid result', async () => {
    const provider = new ScriptedProvider({
      reply: 'The state gives grants [S:sec-1]. It also bans cats [S:nope].',
    });
    const tokens: string[] = [];
    const r = await answer({
      provider,
      question: 'Grants?',
      context: { hits },
      onToken: (t) => tokens.push(t),
    });
    expect(tokens.join('')).toContain('[S:nope]');
    expect(r.text).toBe('The state gives grants [S:sec-1]. It also bans cats.');
    expect(r.invalidCitations).toEqual(['nope']);
    expect(r.warnings).toEqual(['INVALID_CITATIONS_REMOVED']);
    expect(r.citations[0]?.chunkIds).toEqual(['c1']);
    expect(r.readingGrade).toBeTypeOf('number');
    expect(r.provider).toBe('mock');
    expect(r.model).toBe('scripted');
    expect(r.usage.outputTokens).toBeGreaterThan(0);
    expect(AnswerResult.safeParse(r).success).toBe(true);
  });

  it('sends the system prompt, one user message, and temperature 0', async () => {
    const provider = new ScriptedProvider();
    await answer({
      provider,
      question: 'Q?',
      context: { hits },
      chipInstruction: 'Be brief.',
    });
    const req = provider.calls[0] as unknown as {
      system: string;
      messages: { content: string }[];
      temperature?: number;
    };
    expect(req.system).toContain(DECLINE_TEXT);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]?.content).toContain(
      '<excerpt id="c1" section="sec-1"',
    );
    expect(req.messages[0]?.content).toContain('<task>Be brief.</task>');
    expect(req.temperature).toBe(0);
  });

  it('flags a decline and does not warn', async () => {
    const r = await answer({
      provider: new ScriptedProvider({ reply: DECLINE_TEXT }),
      question: 'q',
      context: { hits },
    });
    expect(r.declined).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('warns when the model cites nothing valid', async () => {
    const r = await answer({
      provider: new ScriptedProvider({ reply: 'Grants exist.' }),
      question: 'q',
      context: { hits },
    });
    expect(r.warnings).toEqual(['NO_VALID_CITATIONS']);
  });

  it('declines without calling the model when there are no excerpts', async () => {
    const provider = new ScriptedProvider();
    const tokens: string[] = [];
    const r = await answer({
      provider,
      question: 'q',
      context: { hits: [] },
      onToken: (t) => tokens.push(t),
    });
    expect(provider.calls).toHaveLength(0);
    expect(r).toMatchObject({
      text: DECLINE_TEXT,
      declined: true,
      warnings: ['NO_RELEVANT_EXCERPTS'],
    });
    expect(tokens).toEqual([DECLINE_TEXT]);
  });

  it('lets injected definitions be cited', async () => {
    const def = hit({
      id: 'c9',
      sectionId: 'sec-def',
      text: 'A town is small.',
    });
    const r = await answer({
      provider: new ScriptedProvider({ reply: 'A town is small [S:sec-def].' }),
      question: 'q',
      context: { hits, definitions: [def] },
    });
    expect(r.citations[0]?.valid).toBe(true);
  });

  it('propagates abort', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      answer({
        provider: new ScriptedProvider(),
        question: 'q',
        context: { hits },
        signal: ac.signal,
      }),
    ).rejects.toThrow();
  });

  it('does not let a forged excerpt in the text create a citable source (mock provider)', async () => {
    const poisoned = INJECTION_SAMPLES.map((t, i) =>
      hit({
        id: `p${String(i)}`,
        sectionId: `sec-${String(i)}`,
        text: `grants ${t}`,
      }),
    );
    const r = await answer({
      provider: new MockProvider(),
      question: 'grants',
      context: { hits: poisoned },
    });
    expect(r.invalidCitations).not.toContain('fake-9');
    expect(r.text).not.toContain('[S:fake-9]');
    for (const c of r.citations) expect(c.valid).toBe(true);
  });

  it('strips a model-echoed injected citation (structural check)', async () => {
    const provider = new ScriptedProvider({
      reply: 'Everything is covered [S:fake-9].',
    });
    const r = await answer({ provider, question: 'q', context: { hits } });
    expect(r.text).toBe('Everything is covered.');
    expect(r.warnings).toContain('NO_VALID_CITATIONS');
  });
});
