import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../tests/contracts/scripted-provider.js';
import {
  describeWithFixture,
  fixturePath,
} from '../../tests/support/fixtures.js';
import {
  MAX_ITEMS_PER_GROUP,
  NOTHING_LEFT_TEXT,
  runDelegationsChip,
} from './chip-delegations.js';
import type { ChipDeps } from './chip-types.js';
import { chunkDocument } from './chunk/index.js';
import { getChip } from './chips.js';
import { enrichDocument } from './enrich/index.js';
import { sec } from './enrich/fixtures.js';
import { lazyProvider } from './llm/lazy-provider.js';
import {
  AppError,
  EMPTY_METADATA,
  type LlmProvider,
  type Section,
} from './model/index.js';
import { parseXml } from './parse/index.js';
import { findCitationIds } from './model/index.js';

const DOC = 'e'.repeat(64);
const chip = getChip('delegations');

const SECTIONS: Section[] = [
  sec(
    'sec-2',
    'Not later than 180 days after the date of enactment of this Act, the Secretary shall prescribe regulations to carry out this section.',
    { heading: 'Rules', page: undefined } as Partial<Section>,
  ),
  sec('sec-3', 'This Act shall take effect on the date of enactment.'),
];
const BASE_SECTIONS = SECTIONS.map((s) => ({ ...s }));

function deps(
  provider: LlmProvider,
  over: Partial<ChipDeps> & { sections?: Section[] } = {},
): ChipDeps {
  const { sections, ...rest } = over;
  return {
    backend: new MemoryBackend(),
    provider,
    doc: {
      metadata: EMPTY_METADATA,
      sections: sections ?? BASE_SECTIONS,
    },
    ...rest,
  };
}

const missingKey: LlmProvider = lazyProvider(() => {
  throw new AppError('MISSING_KEY');
});
const run = (d: ChipDeps, onToken?: (t: string) => void) =>
  runDelegationsChip(chip, DOC, d, { onToken });

describe('delegations chip: list only', () => {
  it('lists grouped items with citations when there is no API key', async () => {
    const { answer, hits, mode } = await run(deps(missingKey));
    expect(answer.text).toBe(
      [
        '**Decided later by**',
        '- the Secretary — prescribe regulations to carry out this section (Not later than 180 days after the date of enactment of this Act) [S:sec-2]',
        '',
        '**Takes effect when**',
        '- on the date of enactment [S:sec-3]',
      ].join('\n'),
    );
    expect(answer.citations.map((c) => [c.sectionId, c.valid])).toEqual([
      ['sec-2', true],
      ['sec-3', true],
    ]);
    expect(answer.provider).toBe('none');
    expect(answer.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(hits).toEqual([]);
    expect(mode).toBe('none');
  });

  it('never leaves a synthetic chunk id on a citation', async () => {
    const { answer } = await run(deps(missingKey));
    for (const c of answer.citations)
      for (const id of c.chunkIds) expect(id).not.toContain(':~');
  });

  it('streams the final text as one piece', async () => {
    const pieces: string[] = [];
    const { answer } = await run(deps(missingKey), (t) => pieces.push(t));
    expect(pieces).toEqual([answer.text]);
  });

  it('rethrows a provider error other than MISSING_KEY', async () => {
    const broken = lazyProvider(() => {
      throw new AppError('PROVIDER_ERROR');
    });
    await expect(run(deps(broken))).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });
});

describe('delegations chip: lede plus list', () => {
  it('puts the model lede before the list and validates both together', async () => {
    const provider = new ScriptedProvider({
      reply:
        'The Secretary will write the rules later [S:sec-2]. The bill starts when it is enacted [S:sec-3].',
    });
    const { answer } = await run(deps(provider));
    expect(
      answer.text.startsWith('The Secretary will write the rules later'),
    ).toBe(true);
    expect(answer.text).toContain('\n\n**Decided later by**');
    // Numbered by first appearance: the lede cites sec-2, then sec-3.
    expect(findCitationIds(answer.text).slice(0, 2)).toEqual([
      'sec-2',
      'sec-3',
    ]);
    expect(answer.provider).toBe('mock');
    expect(answer.usage.outputTokens).toBeGreaterThan(0);
  });

  it('shows the model only the extracted quotes, tagged by group', async () => {
    const provider = new ScriptedProvider({
      reply: 'Rules come later [S:sec-2].',
    });
    await run(deps(provider));
    const call = provider.calls[0] as unknown as {
      messages: { content: string }[];
    };
    const prompt = call.messages[0]?.content ?? '';
    expect(prompt).toContain('(decided later)');
    expect(prompt).toContain('shall prescribe regulations');
    expect(prompt).toContain('(takes effect when)');
  });

  it('strips a lede citation that is not in the list', async () => {
    const provider = new ScriptedProvider({
      reply: 'Rules come later [S:sec-2] and money too [S:sec-99].',
    });
    const { answer } = await run(deps(provider));
    expect(answer.text).not.toContain('sec-99');
    expect(
      answer.text.startsWith('Rules come later [S:sec-2] and money too.'),
    ).toBe(true);
    expect(answer.citations.every((c) => c.valid)).toBe(true);
  });

  it('drops a lede that cites nothing in the list', async () => {
    const provider = new ScriptedProvider({
      reply: 'Rules come later [S:sec-99].',
    });
    const { answer } = await run(deps(provider));
    expect(answer.text.startsWith('**Decided later by**')).toBe(true);
    expect(answer.text).not.toContain('sec-99');
    // The call was still made, so its usage is reported.
    expect(answer.provider).toBe('mock');
  });

  it.each([
    ['uncited prose', 'The rules come later.'],
    ['a list', '- The rules come later [S:sec-2].'],
    ['the decline sentence', "This document doesn't address that question."],
    ['a runaway lede', 'Rules come later [S:sec-2]. '.repeat(40)],
  ])('drops a lede that is %s', async (_n, reply) => {
    const { answer } = await run(deps(new ScriptedProvider({ reply })));
    expect(answer.text.startsWith('**Decided later by**')).toBe(true);
  });

  it('keeps only the first paragraph of the lede', async () => {
    const provider = new ScriptedProvider({
      reply: 'Rules come later [S:sec-2].\n\nAlso, a second thought [S:sec-3].',
    });
    const { answer } = await run(deps(provider));
    expect(answer.text).not.toContain('second thought');
  });

  it('drops a truncated lede', async () => {
    const cutOff: LlmProvider = {
      id: 'mock',
      model: 'cut',
      // eslint-disable-next-line @typescript-eslint/require-await -- generator needs no await
      async *streamText() {
        yield { type: 'text', text: 'Rules come later [S:sec-2]' };
        yield {
          type: 'done',
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'max_tokens',
        };
      },
      generateObject: () => Promise.reject(new Error('unused')),
    };
    const { answer } = await run(deps(cutOff));
    expect(answer.text.startsWith('**Decided later by**')).toBe(true);
  });

  it('passes an abort through instead of hiding it', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runDelegationsChip(
        chip,
        DOC,
        deps(new ScriptedProvider({ reply: 'x [S:sec-2]' })),
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });
});

describe('delegations chip: public mode', () => {
  it('returns the list alone and never touches the provider', async () => {
    let touched = false;
    const spy = lazyProvider(() => {
      touched = true;
      return new ScriptedProvider({ reply: 'Lede [S:sec-2].' });
    });
    const { answer } = await run(deps(spy, { publicMode: true }));
    expect(touched).toBe(false);
    expect(answer.text.startsWith('**Decided later by**')).toBe(true);
    expect(answer.citations.length).toBeGreaterThan(0);
  });
});

describe('delegations chip: empty and capped', () => {
  it('says so, with no model call, when nothing is left for later', async () => {
    const provider = new ScriptedProvider({ reply: 'unused [S:a]' });
    const { answer } = await run(
      deps(provider, { sections: [sec('a', 'The sky is blue.')] }),
    );
    expect(answer.text).toBe(NOTHING_LEFT_TEXT);
    expect(answer.citations).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it('shows at most the cap per group and counts the rest', async () => {
    const many = Array.from({ length: MAX_ITEMS_PER_GROUP + 3 }, (_, i) =>
      sec(
        `r-${String(i)}`,
        `The Secretary shall promulgate regulations number ${String(i)}.`,
      ),
    );
    const { answer } = await run(deps(missingKey, { sections: many }));
    expect(answer.text.match(/^- The Secretary/gm)).toHaveLength(
      MAX_ITEMS_PER_GROUP,
    );
    expect(answer.text).toContain('- and 3 more');
    expect(answer.citations).toHaveLength(MAX_ITEMS_PER_GROUP);
  });

  it('escapes markdown and citation look-alikes in bill text', async () => {
    const { answer } = await run(
      deps(missingKey, {
        sections: [
          sec(
            'a',
            'The Secretary shall prescribe regulations for *bold* and [S:sec-99] things.',
          ),
        ],
      }),
    );
    expect(answer.text).toContain('\\*bold\\*');
    expect(answer.text).toContain('(S:sec-99]');
    expect(answer.invalidCitations).toEqual([]);
  });

  it('reports page and line for an item from a numbered source', async () => {
    const located: Section = {
      id: 'p',
      level: 1,
      spans: [
        {
          text: 'The Secretary shall prescribe regulations.',
          status: 'unchanged',
          page: 3,
          line: 7,
        },
      ],
      children: [],
      pageStart: 3,
      pageEnd: 3,
    };
    const { answer } = await run(deps(missingKey, { sections: [located] }));
    expect(answer.citations[0]?.location).toMatchObject({
      pageStart: 3,
      lineStart: 7,
    });
  });
});

describeWithFixture('us-s202-119-is', () => {
  it('lists the Administrator determinations and law dependencies in S. 202', async () => {
    const raw = parseXml(readFileSync(fixturePath('us-s202-119-is')!), {
      sourceUrl: 'https://example.test/bill.xml',
      fetchedAt: '2026-10-13T12:00:00.000Z',
    });
    const { doc } = enrichDocument(raw, chunkDocument(raw));
    const base = {
      backend: new MemoryBackend(),
      doc: {
        metadata: doc.metadata,
        sections: doc.sections,
        externalRefs: doc.externalRefs,
      },
    };
    const plainRun = await run({ ...base, provider: missingKey });
    expect(plainRun.answer.text).toMatch(/Administrator/);
    expect(plainRun.answer.text).toContain('**Depends on**');
    expect(plainRun.answer.invalidCitations).toEqual([]);

    const firstId = plainRun.answer.citations[0]?.sectionId ?? '';
    const withLede = await run({
      ...base,
      provider: new ScriptedProvider({
        reply: `The Administrator makes several later decisions, and the bill relies on existing law [S:${firstId}].`,
      }),
    });
    expect(withLede.answer.text).toContain(
      'The Administrator makes several later decisions',
    );
    expect(withLede.answer.text).toContain(plainRun.answer.text);
    process.stdout.write(
      `\n--- S. 202 sample ---\n${withLede.answer.text}\n---\n`,
    );
  });
});
