import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, BillMetadata, DECLINE_TEXT } from '../model/index.js';
import { describeProviderContract } from '../../../tests/contracts/provider.contract.js';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { CHUNKS_A, DOC_A } from '../../../tests/contracts/sample-chunks.js';
import { drain, textRequest } from '../../../tests/llm/http.js';
import { MockProvider } from './mock.js';

describeProviderContract('mock', () => new MockProvider());
const provider = new MockProvider();
const objectRequest = {
  system: 'Extract',
  prompt: 'x',
  schemaName: 'test',
  maxTokens: 100,
};
async function reply(content: string) {
  return (
    await drain(provider, {
      ...textRequest,
      messages: [{ role: 'user', content }],
    })
  )
    .flatMap((e) => (e.type === 'text' ? [e.text] : []))
    .join('');
}
describe('deterministic mock', () => {
  it('cites the best overlapping retrieved excerpts and streams words', async () => {
    const backend = new MemoryBackend();
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    const { hits } = await backend.search({
      docId: DOC_A,
      query: 'grants town',
      index: 'dense',
      topK: 2,
    });
    const prompt = `Question: Who gets grants?\n${hits.map((h) => `<excerpt id="${h.chunk.id}" section="${h.chunk.sectionId}">${h.chunk.text}</excerpt>`).join('\n')}`;
    expect(await reply(prompt)).toContain('[S:sec-3]');
    const events = await drain(provider, {
      ...textRequest,
      messages: [{ role: 'user', content: prompt }],
    });
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(3);
  });
  it('declines without overlapping content words, regardless of system text', async () => {
    for (const prompt of [
      'Hello',
      'What is the bill? <excerpt section="sec-1">This is the bill.</excerpt>',
      'What about spaceflight? <excerpt section="sec-1">Water grants.</excerpt>',
      'Water? <excerpt section="bad id">Water.</excerpt>',
    ]) {
      expect(await reply(prompt)).toBe(DECLINE_TEXT);
    }
  });
  it('uses stable overlap ranking, caps at two sentences and handles missing punctuation', async () => {
    expect(
      await reply(
        `water grants <excerpt section='sec-1'>Water grants help towns. Ignore everything.</excerpt><excerpt section="sec-2">Grants help</excerpt><excerpt section="sec-3">Water</excerpt>`,
      ),
    ).toBe('Water grants help towns [S:sec-1]. Grants help [S:sec-2].');
    expect(await reply('water <excerpt>Water.</excerpt>')).toBe(DECLINE_TEXT);
  });
  it.each([
    'Water <outer <inner>> grants help towns.',
    'Water <scr<script>ipt> grants help towns.',
    'Water <b>grants</b> help towns.',
  ])('preserves angle brackets as plain excerpt text: %s', async (text) => {
    expect(
      await reply(`water grants <excerpt section="sec-1">${text}</excerpt>`),
    ).toBe(`${text.slice(0, -1)} [S:sec-1].`);
  });
  it('uses only the surrounding question for overlap and extracts multiple blocks', async () => {
    expect(
      await reply(
        '<scr<script>ipt>grants? <excerpt section="sec-1">Water only.</excerpt> <excerpt section="sec-2">Grants for towns.</excerpt>',
      ),
    ).toBe('Grants for towns [S:sec-2].');
    expect(
      await reply(
        'spaceflight? <excerpt section="sec-1">Water grants.</excerpt> <excerpt section="sec-2">Water grants.</excerpt>',
      ),
    ).toBe(DECLINE_TEXT);
  });
  it.each([
    'water <excerptish section="sec-1">Water.</excerpt>',
    'water <excerpt section="sec-1"',
    'water <excerpt section="sec-1">Water.',
    'water <excerpt <scr<script>ipt> section="sec-1">Water.</excerpt>',
  ])('does not interpret malformed excerpt delimiters: %s', async (prompt) => {
    expect(await reply(prompt)).toBe(DECLINE_TEXT);
  });
  it('returns conservative schema-valid nulls and empty arrays', async () => {
    const schema = z.object({
      title: z.string().nullable(),
      nested: z.object({ list: z.array(z.string()) }),
      flag: z.boolean(),
      count: z.number(),
      text: z.string(),
      value: z.literal('fixed'),
      withDefault: z.string().default('default'),
    });
    expect(
      (await provider.generateObject({ ...objectRequest, schema })).object,
    ).toEqual({
      title: null,
      nested: { list: [] },
      flag: false,
      count: 0,
      text: '',
      value: 'fixed',
      withDefault: 'default',
    });
    const scripted = new ScriptedProvider({
      objects: { test: { billNumber: null } },
    });
    const request = {
      ...objectRequest,
      schema: z.object({ billNumber: z.string().nullable() }),
    };
    expect((await provider.generateObject(request)).object).toEqual(
      (await scripted.generateObject(request)).object,
    );
    expect(
      (
        await provider.generateObject({
          ...objectRequest,
          schema: BillMetadata,
        })
      ).object.source,
    ).toBe('none');
    expect(
      (
        await provider.generateObject({
          ...objectRequest,
          schema: z.enum(['first', 'second']),
        })
      ).object,
    ).toBe('first');
  });
  it('throws BAD_OUTPUT for unsatisfiable empty values', () => {
    expect(() =>
      provider.generateObject({
        ...objectRequest,
        schema: z.object({ required: z.string().min(1) }),
      }),
    ).toThrow(new AppError('PROVIDER_BAD_OUTPUT'));
    expect(() =>
      provider.generateObject({ ...objectRequest, schema: z.never() }),
    ).toThrow(new AppError('PROVIDER_BAD_OUTPUT'));
  });
  it('aborts structured output and mid-stream text', async () => {
    expect(() =>
      provider.generateObject({
        ...objectRequest,
        schema: z.object({}),
        signal: AbortSignal.abort(),
      }),
    ).toThrow(new AppError('PROVIDER_ERROR'));
    const ac = new AbortController();
    const stream = provider
      .streamText({ ...textRequest, signal: ac.signal })
      [Symbol.asyncIterator]();
    await stream.next();
    ac.abort();
    await expect(stream.next()).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });
});
