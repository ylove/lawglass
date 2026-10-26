import { describe, expect, it } from 'vitest';
import {
  breakdownProvider,
  listedIds,
} from '../../../tests/support/breakdown-provider.js';
import { MockProvider } from '../llm/mock.js';
import { AppError, type LlmTextPart } from '../model/index.js';
import {
  BREAKDOWN_INSTRUCTION,
  BREAKDOWN_PROMPT_VERSION,
  EXCERPT_BATCH_SIZE,
  generateBreakdown,
  MAX_BRIEF_CHARS,
  WHOLE_BATCH_SIZE,
  type BreakdownInput,
} from './generate.js';
import { chunkHit, DOC_ID, fakeBackend, sec } from './test-support.js';

const metadata = {
  title: 'Community Gardens Act',
  billNumber: 'HB 1',
  jurisdiction: null,
  session: null,
  version: null,
  sponsors: null,
  source: 'structured' as const,
};

function bill(count: number) {
  const sections = Array.from({ length: count }, (_, i) =>
    sec(
      `sec-${String(i + 1)}`,
      `Topic ${String(i + 1)}`,
      `Rule ${String(i + 1)}.`,
    ),
  );
  const hits = sections.map((s) => chunkHit(s.id, `Rule of ${s.id}.`));
  return { sections, hits };
}

function input(
  provider: BreakdownInput['provider'],
  count: number,
  mode: 'whole' | 'excerpts' = 'whole',
): BreakdownInput {
  const { sections, hits } = bill(count);
  return {
    provider,
    docId: DOC_ID,
    backend: fakeBackend(hits),
    doc: { metadata, sections, externalRefs: [], references: [] },
    context: { mode, hits: mode === 'whole' ? hits : [] },
    units: sections,
  };
}

const parts = (prompt: unknown): readonly LlmTextPart[] => {
  expect(Array.isArray(prompt)).toBe(true);
  return prompt as LlmTextPart[];
};

describe('generateBreakdown in whole-bill mode', () => {
  it('sends the whole bill as one cacheable part, then this batch’s task', async () => {
    const provider = breakdownProvider(new MockProvider());
    const { briefs } = await generateBreakdown(input(provider, 3));
    expect(provider.breakdownCalls).toBe(1);
    const request = provider.requests[0]!;
    const [prefix, task] = parts(request.prompt);
    expect(prefix?.cache).toBe(true);
    expect(prefix?.text).toContain('<bill>');
    for (const id of ['sec-1', 'sec-2', 'sec-3'])
      expect(prefix?.text).toContain(`section="${id}"`);
    expect(task?.cache).toBeFalsy();
    expect(task?.text).toContain(`<task>${BREAKDOWN_INSTRUCTION.slice(0, 40)}`);
    expect(listedIds(request.prompt)).toEqual(['sec-1', 'sec-2', 'sec-3']);
    expect(request.effort).toBe('medium');
    expect(briefs.map((b) => b.sectionId)).toEqual(['sec-1', 'sec-2', 'sec-3']);
  });

  it('shares one identical prefix and system prompt across batches, run one after another', async () => {
    const provider = breakdownProvider(new MockProvider());
    let active = 0;
    let peak = 0;
    provider.gate = async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
    };
    const seen: number[] = [];
    const out = await generateBreakdown({
      ...input(provider, WHOLE_BATCH_SIZE * 2 + 1),
      onProgress: (b) => seen.push(b.length),
    });
    expect(provider.breakdownCalls).toBe(3);
    expect(peak).toBe(1);
    const prefixes = new Set(
      provider.requests.map((r) => parts(r.prompt)[0]?.text),
    );
    expect(prefixes.size).toBe(1);
    expect(new Set(provider.requests.map((r) => r.system)).size).toBe(1);
    expect(seen).toEqual([10, 20, 21]);
    expect(out.briefs).toHaveLength(21);
    expect(out.usage).toEqual({ inputTokens: 33, outputTokens: 39 });
  });

  it('computes the reading grade itself and keeps the model’s example flag', async () => {
    const provider = breakdownProvider(new MockProvider());
    provider.noExample.add('sec-2');
    const { briefs } = await generateBreakdown(input(provider, 2));
    expect(briefs.map((b) => b.example)).toEqual(['available', 'none']);
    expect(briefs[0]?.readingGrade).toEqual(expect.any(Number));
    expect(briefs[0]?.num).toBe('1');
    expect(briefs[0]?.heading).toBe('Topic 1');
    expect(briefs[0]?.citations[0]).toMatchObject({
      sectionId: 'sec-1',
      valid: true,
    });
  });

  it('removes markers for sections that do not exist, and drops a brief left with none', async () => {
    const provider = breakdownProvider(new MockProvider());
    provider.behavior = () => ({
      briefs: [
        {
          id: 'sec-1',
          text: 'Real. [S:sec-1] Made up. [S:sec-99]',
          example: 'available',
        },
        {
          id: 'sec-2',
          text: 'Only a made-up source. [S:sec-99]',
          example: 'available',
        },
        { id: 'sec-3', text: 'No source at all.', example: 'available' },
      ],
    });
    const { briefs } = await generateBreakdown(input(provider, 3));
    expect(briefs).toHaveLength(1);
    expect(briefs[0]?.text).toBe('Real. [S:sec-1] Made up.');
    expect(briefs[0]?.citations.map((c) => c.sectionId)).toEqual(['sec-1']);
  });

  it('ignores ids it was not asked for, repeated ids and over-long briefs', async () => {
    const provider = breakdownProvider(new MockProvider());
    provider.behavior = () => ({
      briefs: [
        { id: 'sec-1', text: 'First. [S:sec-1]', example: 'none' },
        { id: 'sec-1', text: 'Again. [S:sec-1]', example: 'available' },
        { id: 'stray', text: 'Stray. [S:sec-1]', example: 'available' },
        {
          id: 'sec-2',
          text: `${'Long sentence. '.repeat(MAX_BRIEF_CHARS / 10)}[S:sec-2]`,
          example: 'available',
        },
      ],
    });
    const { briefs } = await generateBreakdown(input(provider, 2));
    expect(briefs.map((b) => [b.sectionId, b.text])).toEqual([
      ['sec-1', 'First. [S:sec-1]'],
    ]);
  });

  it('keeps the bill’s order whatever order the model answers in', async () => {
    const provider = breakdownProvider(new MockProvider());
    provider.behavior = () => ({
      briefs: ['sec-3', 'sec-1', 'sec-2'].map((id) => ({
        id,
        text: `Text. [S:${id}]`,
        example: 'available',
      })),
    });
    const { briefs } = await generateBreakdown(input(provider, 3));
    expect(briefs.map((b) => b.sectionId)).toEqual(['sec-1', 'sec-2', 'sec-3']);
  });

  it('retries a malformed batch once, then counts the parts it could not get', async () => {
    const provider = breakdownProvider(new MockProvider());
    const good = (req: { prompt: string | readonly LlmTextPart[] }) => ({
      briefs: listedIds(req.prompt).map((id) => ({
        id,
        text: `Ok. [S:${id}]`,
        example: 'available',
      })),
    });
    let call = 0;
    provider.behavior = (req) =>
      call++ === 0 ? { briefs: 'not an array' } : good(req);
    const recovered = await generateBreakdown(input(provider, 2));
    expect(recovered.briefs).toHaveLength(2);
    expect(recovered.dropped).toBe(0);
    expect(provider.breakdownCalls).toBe(2);

    // Malformed twice: the first batch's parts are lost, and counted, not silent.
    call = 0;
    provider.behavior = (req) => (call++ < 2 ? { briefs: 'no' } : good(req));
    const out = await generateBreakdown(input(provider, WHOLE_BATCH_SIZE + 2));
    expect(out.briefs.map((b) => b.sectionId)).toEqual(['sec-11', 'sec-12']);
    expect(out.dropped).toBe(WHOLE_BATCH_SIZE);
  });

  it('stops on any other failure', async () => {
    const provider = breakdownProvider(new MockProvider());
    provider.behavior = () => {
      throw new AppError('RATE_LIMITED');
    };
    await expect(generateBreakdown(input(provider, 2))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('drops a brief that cites only other parts, and counts it', async () => {
    const provider = breakdownProvider(new MockProvider());
    provider.behavior = () => ({
      briefs: [
        { id: 'sec-1', text: 'About two. [S:sec-2]', example: 'available' },
        { id: 'sec-2', text: 'About two. [S:sec-2]', example: 'available' },
      ],
    });
    const out = await generateBreakdown(input(provider, 2));
    expect(out.briefs.map((b) => b.sectionId)).toEqual(['sec-2']);
    expect(out.dropped).toBe(1);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateBreakdown({
        ...input(breakdownProvider(new MockProvider()), 2),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe('generateBreakdown in excerpt mode', () => {
  it('gives each part its own text, the definitions it uses and the section it refers to', async () => {
    const own = chunkHit('sec-1', 'Grants go to each eligible town.', {
      definedTermsUsed: ['eligible town'],
      refs: ['sec-2'],
    });
    const other = chunkHit('sec-2', 'Reports are due yearly.');
    const unrelated = chunkHit('sec-3', 'Unrelated penalty text.');
    const definition = chunkHit(
      'sec-9',
      '"Eligible town" means a town with a garden.',
      {
        chunkType: 'definition',
        definesTerm: 'eligible town',
      },
    );
    const sections = [
      sec('sec-1', 'Grants', 'x'),
      sec('sec-2', 'Reports', 'x'),
      sec('sec-3', 'Penalties', 'x'),
      sec('sec-9', 'Definitions', 'x'),
    ];
    const provider = breakdownProvider(new MockProvider());
    const backend = fakeBackend([own, other, unrelated, definition]);
    const out = await generateBreakdown({
      provider,
      docId: DOC_ID,
      backend,
      doc: { metadata, sections, externalRefs: [], references: [] },
      context: { mode: 'excerpts', hits: [] },
      units: [sections[0]!],
    });
    const request = provider.requests[0]!;
    expect(typeof request.prompt).toBe('string');
    const prompt = request.prompt as string;
    expect(prompt).toContain('<excerpts>');
    expect(prompt).toContain('Grants go to each eligible town.');
    expect(prompt).toContain('means a town with a garden');
    expect(prompt).toContain('Reports are due yearly.');
    expect(prompt).not.toContain('Unrelated penalty text.');
    expect(out.briefs).toHaveLength(1);
    expect(request.effort).toBeUndefined();
  });

  it('batches a few parts per call', async () => {
    const provider = breakdownProvider(new MockProvider());
    const out = await generateBreakdown(
      input(provider, EXCERPT_BATCH_SIZE + 1, 'excerpts'),
    );
    expect(provider.breakdownCalls).toBe(2);
    expect(out.briefs).toHaveLength(EXCERPT_BATCH_SIZE + 1);
  });
});

describe('BREAKDOWN_PROMPT_VERSION', () => {
  it('is a stable short hash', () => {
    expect(BREAKDOWN_PROMPT_VERSION).toMatch(/^[a-f0-9]{12}$/);
  });
});
