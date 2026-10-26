import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  breakdownProvider,
  listedIds,
} from '../../../tests/support/breakdown-provider.js';
import { MockProvider } from '../llm/mock.js';
import { AppError, messageText, type LlmTextPart } from '../model/index.js';
import { envVar } from '../brand.js';
import { trustMarkers } from '../answer/markers.js';
import { fleschKincaidGrade, stripCitations } from '../answer/readability.js';
import {
  PLAIN_LANGUAGE_INSTRUCTION,
  REGENERATION_VERSION,
} from '../answer/regenerate.js';
import { promptVersion, WHOLE_SYSTEM_PROMPT } from '../answer/prompt.js';
import { UNIT_RULES_VERSION } from './units.js';
import {
  BREAKDOWN_INSTRUCTION,
  BREAKDOWN_PROMPT_VERSION,
  breakdownPromptVersion,
  EXCERPT_BATCH_SIZE,
  generateBreakdown,
  MAX_BRIEF_CHARS,
  WHOLE_BATCH_SIZE,
  type BreakdownInput,
  type BriefRegenerationEvent,
} from './generate.js';
import { chunkHit, DOC_ID, fakeBackend, sec } from './test-support.js';

afterEach(() => vi.unstubAllEnvs());

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
  it('includes the ceiling and the regeneration rule', () => {
    const expected = (ceiling: number, regeneration: string) =>
      promptVersion(
        BREAKDOWN_INSTRUCTION,
        WHOLE_SYSTEM_PROMPT,
        JSON.stringify({
          whole: WHOLE_BATCH_SIZE,
          excerpt: EXCERPT_BATCH_SIZE,
          max: MAX_BRIEF_CHARS,
          units: UNIT_RULES_VERSION,
          ceiling,
          regeneration,
        }),
      );
    expect(breakdownPromptVersion(8)).toBe(expected(8, REGENERATION_VERSION));
    expect(breakdownPromptVersion(8)).not.toBe(expected(8, 'old-rule'));
    expect(breakdownPromptVersion(8)).not.toBe(breakdownPromptVersion(9));
  });
});

const HARD =
  'The Administrator shall promulgate regulations establishing eligibility requirements for participating municipalities, which must demonstrate substantial compliance with applicable environmental standards for ten years [S:sec-1].';
const EASY = 'Towns must follow the rules for ten years [S:sec-1].';

function rewriteProvider(second: string) {
  const provider = breakdownProvider(new MockProvider());
  provider.behavior = (req) => ({
    briefs: listedIds(req.prompt).map((id) => ({
      id,
      text:
        id !== 'sec-1'
          ? `Towns get help [S:${id}].`
          : messageText(req.prompt).includes('6th-grade reader')
            ? second
            : HARD,
      example: 'available',
    })),
  });
  return provider;
}

describe('brief reading-level regeneration', () => {
  it.each(['whole', 'excerpts'] as const)(
    'rewrites only high-grade units once with the same context in %s mode',
    async (mode) => {
      const provider = rewriteProvider(EASY);
      const events: BriefRegenerationEvent[] = [];
      const out = await generateBreakdown({
        ...input(provider, 2, mode),
        log: (e) => events.push(e),
      });
      expect(fleschKincaidGrade(stripCitations(HARD))).toBeGreaterThan(8);
      expect(out.briefs[0]?.text).toBe(EASY);
      expect(out.briefs[0]?.readingGrade).toBeLessThan(8);
      expect(provider.breakdownCalls).toBe(2);
      expect(out.usage).toEqual({ inputTokens: 22, outputTokens: 26 });
      expect(events).toEqual([
        { event: 'brief_regeneration', rewritten: 1, refused: 0 },
      ]);
      const [first, second] = provider.requests;
      expect(second?.system).toBe(first?.system);
      expect(listedIds(first!.prompt)).toEqual(['sec-1', 'sec-2']);
      expect(listedIds(second!.prompt)).toEqual(['sec-1']);
      // Whole-bill prompts XML-escape the task text; excerpt prompts do not.
      const escaped = PLAIN_LANGUAGE_INSTRUCTION.replaceAll('"', '&quot;');
      const sent = messageText(second!.prompt);
      expect(
        sent.includes(PLAIN_LANGUAGE_INSTRUCTION) || sent.includes(escaped),
      ).toBe(true);
      if (mode === 'whole')
        expect(parts(second!.prompt)[0]).toEqual(parts(first!.prompt)[0]);
      else
        expect(messageText(second!.prompt).split('</excerpts>')[0]).toBe(
          messageText(first!.prompt).split('</excerpts>')[0],
        );
    },
  );

  it.each([
    ['not simpler', HARD],
    ['no citation', 'Towns get help.'],
    ['another part only', 'Towns get help [S:sec-2].'],
    ['new warning', `${EASY} Towns get help [S:missing].`],
    ['too long', `${'Towns get help. '.repeat(90)} [S:sec-1]`],
    ['unmeasurable', '[S:sec-1]'],
  ])('keeps the original when the rewrite has %s', async (_, second) => {
    const provider = rewriteProvider(second);
    const events: BriefRegenerationEvent[] = [];
    const out = await generateBreakdown({
      ...input(provider, 2),
      log: (e) => events.push(e),
    });
    expect(provider.breakdownCalls).toBe(2);
    expect(out.briefs[0]?.text).toBe(HARD);
    expect(out.dropped).toBe(0);
    expect(events).toEqual([
      { event: 'brief_regeneration', rewritten: 0, refused: 1 },
    ]);
  });

  it.each([
    ['Towns must follow the rules for ten years [S:sec-1].', true],
    ['Towns must follow the rules for fifteen years [S:sec-1].', false],
    ['Towns must follow the rules [S:sec-1].', false],
  ])('applies the amendment guard per unit: %s', async (second, accepted) => {
    const provider = rewriteProvider(second);
    const args = input(provider, 2);
    const amended = chunkHit(
      'sec-1',
      'Towns get [struck]fifteen years[/struck] [inserted]ten years[/inserted].',
    );
    trustMarkers(amended.chunk);
    // Another unit's live wording must not hide a struck-only value in this one.
    args.context.hits = [
      amended,
      chunkHit('sec-2', 'Towns get fifteen years.'),
    ];
    const out = await generateBreakdown(args);
    expect(out.briefs[0]?.text).toBe(accepted ? second : HARD);
  });

  it('keeps every cited section and the original example choice', async () => {
    const provider = rewriteProvider(EASY);
    let call = 0;
    provider.behavior = () => ({
      briefs: [
        {
          id: 'sec-1',
          text: call++ === 0 ? `${HARD} Reports are due [S:sec-2].` : EASY,
          example: 'none',
        },
      ],
    });
    const out = await generateBreakdown(input(provider, 2));
    expect(out.briefs[0]?.text).toContain('[S:sec-2]');
    const accepted = rewriteProvider(EASY);
    call = 0;
    accepted.behavior = () => ({
      briefs: [
        {
          id: 'sec-1',
          text: call++ === 0 ? HARD : EASY,
          example: call === 1 ? 'none' : 'available',
        },
      ],
    });
    expect(
      (await generateBreakdown(input(accepted, 1))).briefs[0]?.example,
    ).toBe('none');
  });

  it('makes no extra call when briefs are within the ceiling or the ceiling is zero', async () => {
    const easy = breakdownProvider(new MockProvider());
    const events: BriefRegenerationEvent[] = [];
    await generateBreakdown({ ...input(easy, 2), log: (e) => events.push(e) });
    expect(easy.breakdownCalls).toBe(1);
    vi.stubEnv(envVar('READING_GRADE_MAX'), '0');
    const disabled = rewriteProvider(EASY);
    expect((await generateBreakdown(input(disabled, 1))).briefs[0]?.text).toBe(
      HARD,
    );
    expect(disabled.breakdownCalls).toBe(1);
    expect(events).toEqual([]);
  });

  it('does not retry a rewrite that is still above the ceiling', async () => {
    const second =
      'The department must establish eligibility rules for towns that want to participate [S:sec-1].';
    const provider = rewriteProvider(second);
    expect(fleschKincaidGrade(stripCitations(second))).toBeGreaterThan(8);
    expect((await generateBreakdown(input(provider, 1))).briefs[0]?.text).toBe(
      second,
    );
    expect(provider.breakdownCalls).toBe(2);
  });

  it.each(['malformed', 'error', 'missing'] as const)(
    'keeps originals on a %s rewrite without retrying',
    async (failure) => {
      const provider = rewriteProvider(EASY);
      let call = 0;
      provider.behavior = () => {
        if (call++ === 0)
          return { briefs: [{ id: 'sec-1', text: HARD, example: 'none' }] };
        if (failure === 'error') throw new AppError('PROVIDER_ERROR');
        return { briefs: failure === 'missing' ? [] : 'bad' };
      };
      const out = await generateBreakdown(input(provider, 1));
      expect(out.briefs[0]?.text).toBe(HARD);
      expect(provider.breakdownCalls).toBe(2);
    },
  );

  it('rethrows a caller abort during the rewrite', async () => {
    const provider = rewriteProvider(EASY);
    const controller = new AbortController();
    provider.gate = () => {
      if (provider.breakdownCalls === 2) {
        controller.abort();
        controller.signal.throwIfAborted();
      }
      return Promise.resolve();
    };
    await expect(
      generateBreakdown({ ...input(provider, 1), signal: controller.signal }),
    ).rejects.toThrow();
  });
});
