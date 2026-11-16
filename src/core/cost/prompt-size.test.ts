/**
 * The forecast sizes of each whole-bill prompt against the prompt the real pipeline sends.
 *
 * The documents here are indexed the way ingest indexes them (chunked, then enriched, so
 * definitions are split into chunks of their own) and run through the real `ask`, breakdown
 * and scenario code with a recording provider. What the provider receives is measured and
 * compared with `billFacts(...).wholePrompt`, so a change to a prompt, to chunking or to the
 * selection rules cannot leave the estimator behind.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { scenarioProvider } from '../../../tests/support/scenario-provider.js';
import { shapedBill } from '../../../tests/synth/bill-shape.js';
import { envVar } from '../brand.js';
import { documentContext, hitTokens } from '../answer/context.js';
import { referenceTokens } from '../answer/references.js';
import { chunkDocument } from '../chunk/index.js';
import { enrichDocument } from '../enrich/index.js';
import {
  EMPTY_METADATA,
  type NormalizedDoc,
  type ObjectRequest,
  type ReferenceText,
  type Section,
  type TextRequest,
} from '../model/index.js';
import { ask } from '../pipeline/ask.js';
import { getChip, runChip } from '../chips.js';
import { runBreakdown } from '../pipeline/breakdown.js';
import { runScenario } from '../pipeline/scenario.js';
import { Registry } from '../registry.js';
import { billFacts } from './facts.js';
import { NO_PROMPT, placeholderReferences } from './prompt-size.js';
import { MAX_TEXT_CHARS } from '../enrich/references.js';

const DOC = 'c'.repeat(64);

const reference: ReferenceText = {
  sectionId: 'ref:usc/15/6809',
  citation: '15 U.S.C. 6809',
  heading: '§6809. Definitions',
  sourceUrl: 'https://example.gov/usc/15/6809',
  text: 'The term "nonpublic personal information" means <anything> & more. '.repeat(
    20,
  ),
  terms: ['nonpublic personal information'],
  fetchedAt: '2026-01-01T00:00:00.000Z',
};

/** Many short definitions in one section, which enrichment splits into chunks of their own. */
function definitionsSection(count: number): Section {
  const terms = Array.from(
    { length: count },
    (_, i) =>
      `(${String(i + 1)}) The term "grant term ${String(i + 1)}" means a thing the program funds.`,
  );
  return {
    id: 'division-a/title-9/sec-definitions',
    num: '900',
    heading: 'Definitions',
    level: 3,
    spans: [{ text: `In this Act:\n${terms.join('\n')}`, status: 'unchanged' }],
    children: [],
  };
}

/** Definitions that borrow their meaning from the U.S. Code: the targets ingest will read. */
function borrowedDefinitions(): Section {
  return {
    id: 'division-a/title-9/sec-borrowed',
    num: '901',
    heading: 'Borrowed terms',
    level: 3,
    spans: [
      {
        text: 'In this Act:\n(1) The term "financial institution" has the meaning given that term in section 509 of the Gramm-Leach-Bliley Act (15 U.S.C. 6809).\n(2) The term "agency" has the same meaning as in section 551 of title 5, United States Code.',
        status: 'unchanged',
      },
    ],
    children: [],
  };
}

/** A section whose text is partly struck and partly inserted. */
function amendedSection(id: string, struckChars: number): Section {
  return {
    id,
    num: id.slice(-3),
    heading: 'Amended rule',
    level: 3,
    spans: [
      { text: 'Subsection (b) is amended by striking ', status: 'unchanged' },
      {
        text: 'old wording of the rule '.repeat(struckChars / 24),
        status: 'deleted',
      },
      { text: ' and inserting ', status: 'unchanged' },
      { text: 'new wording of the rule', status: 'inserted' },
      { text: '.', status: 'unchanged' },
    ],
    children: [],
  };
}

function bill(options: { struckChars?: number } = {}): NormalizedDoc {
  const sections = shapedBill({
    divisions: 1,
    titles: 2,
    sectionsPerTitle: 6,
    sectionChars: 300,
    headingChars: 24,
  });
  const title = sections[0]?.children[0];
  title?.children.push(
    definitionsSection(40),
    borrowedDefinitions(),
    amendedSection(
      'division-a/title-1/sec-amended-1',
      options.struckChars ?? 2400,
    ),
    amendedSection(
      'division-a/title-1/sec-amended-2',
      options.struckChars ?? 2400,
    ),
  );
  return {
    docId: DOC,
    sourceUrl: 'https://example.gov/bill.xml',
    format: 'xml',
    fetchedAt: '2026-10-26T00:00:00.000Z',
    metadata: {
      ...EMPTY_METADATA,
      title: 'Garden grants',
      billNumber: 'H.R. 1',
    },
    sections,
    definitions: [],
    externalRefs: [],
    references: [reference],
    warnings: [],
  };
}

let dir: string;
let backend: MemoryBackend;
let registry: Registry;
let provider: ScriptedProvider;

/** Index a document the way ingest does, and register it. Returns the enriched document. */
async function index(source: NormalizedDoc): Promise<NormalizedDoc> {
  const enriched = enrichDocument(source, chunkDocument(source));
  await backend.upsertChunks(source.docId, enriched.chunks);
  await registry.add(enriched.doc, { label: 'bill', backend: 'local' });
  return enriched.doc;
}

/** The cached first block of a whole-mode request: the bill, then any references. */
function billBlockOf(request: TextRequest | ObjectRequest<unknown>): string {
  const content =
    'messages' in request ? request.messages[0]?.content : request.prompt;
  if (content === undefined || typeof content === 'string')
    throw new Error('Expected a prompt in parts.');
  return content[0]?.text ?? '';
}
const textRequests = (): TextRequest[] =>
  provider.calls.filter((c): c is TextRequest => 'messages' in c);

beforeEach(async () => {
  vi.stubEnv(envVar('WHOLE_BILL_MAX_TOKENS'), '100000');
  dir = await mkdtemp(join(tmpdir(), 'prompt-size-'));
  registry = new Registry(dir);
  backend = new MemoryBackend();
  provider = new ScriptedProvider({
    reply: 'The grants fund gardens [S:division-a].',
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('whole-bill prompt sizes match what the pipeline sends', () => {
  it('has definitions the enrichment splits, which raw chunks would miss', () => {
    const source = bill();
    const raw = chunkDocument(source);
    expect(enrichDocument(source, raw).chunks.length).toBeGreaterThan(
      raw.length + 20,
    );
  });

  it('summary and plain questions: live parts plus every reference', async () => {
    const indexed = await index(bill());
    const facts = billFacts(indexed.sections, { document: indexed });
    expect(facts.mode).toBe('whole');
    const result = await ask(
      DOC,
      { question: 'Who can apply?' },
      { backend, registry, provider },
    );
    expect(result.answer.context).toBe('whole');
    expect(billBlockOf(textRequests()[0]!).length).toBe(
      facts.wholePrompt.summary,
    );
    expect(facts.wholePrompt.summary).toBeGreaterThan(
      facts.wholePrompt.breakdown,
    );
  });

  it('the summary chip sends the same bill block', async () => {
    const indexed = await index(bill());
    const facts = billFacts(indexed.sections, { document: indexed });
    const run = await runChip(getChip('summary'), DOC, {
      backend,
      provider,
      doc: indexed,
    });
    expect(run.answer.context).toBe('whole');
    expect(billBlockOf(textRequests()[0]!).length).toBe(
      facts.wholePrompt.summary,
    );
  });

  it('a question about changes: struck text and inline markers, whichever prompt is larger', async () => {
    const indexed = await index(bill());
    const facts = billFacts(indexed.sections, { document: indexed });
    await ask(
      DOC,
      { question: 'What was removed from the rule?' },
      { backend, registry, provider },
    );
    const sent = billBlockOf(textRequests()[0]!);
    expect(sent).toContain('[struck]');
    expect(sent.length).toBe(facts.wholePrompt.question);
    expect(facts.wholePrompt.question).toBeGreaterThan(
      facts.wholePrompt.summary,
    );
  });

  it('breakdown batches: live parts, no references', async () => {
    const indexed = await index(bill());
    const facts = billFacts(indexed.sections, { document: indexed });
    await runBreakdown(DOC, {
      backend,
      registry,
      provider: scenarioProvider(provider),
      endpoint: 'mock:local',
    });
    const call = provider.calls.find(
      (c): c is ObjectRequest<unknown> =>
        'schemaName' in c && c.schemaName === 'section_briefs',
    );
    if (!call) throw new Error('No breakdown call was made.');
    const sent = billBlockOf(call);
    expect(sent).not.toContain('<references>');
    expect(sent.length).toBe(facts.wholePrompt.breakdown);
  });

  it('summary scenario: live parts as excerpts, no references', async () => {
    const indexed = await index(bill());
    const facts = billFacts(indexed.sections, { document: indexed });
    const scenarios = scenarioProvider(provider);
    await runScenario(DOC, 'a gardener', {
      backend,
      registry,
      provider: scenarios,
    });
    const prompt = scenarios.prompts[0] ?? '';
    const body = /<excerpts>\n([\s\S]*)\n<\/excerpts>/.exec(prompt)?.[1] ?? '';
    expect(prompt).not.toContain('<references>');
    expect(body.length).toBe(facts.wholePrompt.scenario);
  });
});

describe('what each feature leaves out', () => {
  it('struck text never reaches the summary, breakdown or scenario, so it does not price them', () => {
    const plain = billFacts(bill({ struckChars: 240 }).sections, {
      document: bill({ struckChars: 240 }),
    });
    const struck = billFacts(bill({ struckChars: 24_000 }).sections, {
      document: bill({ struckChars: 24_000 }),
    });
    expect(struck.wholePrompt.summary).toBe(plain.wholePrompt.summary);
    expect(struck.wholePrompt.breakdown).toBe(plain.wholePrompt.breakdown);
    expect(struck.wholePrompt.scenario).toBe(plain.wholePrompt.scenario);
    // Only a question about changes reads it.
    expect(struck.wholePrompt.question).toBeGreaterThan(
      plain.wholePrompt.question,
    );
  });
});

describe('the whole-versus-excerpts decision is the runtime decision', () => {
  /** Short words make characters / 4 undercount tokens (the chunker counts 1.3 per word). */
  function shortWords(chars: number): NormalizedDoc {
    const word = 'a ab ac ad ae af ag ah ai aj ';
    const sections: Section[] = Array.from({ length: 20 }, (_, i) => ({
      id: `sec-${String(i + 1)}`,
      num: String(i + 1),
      heading: 'Gardens',
      level: 1,
      spans: [
        {
          text: word.repeat(Math.floor(chars / 20 / word.length)),
          status: 'unchanged',
        },
      ],
      children: [],
    }));
    return { ...bill(), sections, references: undefined };
  }

  it.each([60_000, 90_000, 120_000, 140_000])(
    'agrees with documentContext for a %i-token budget',
    async (budget) => {
      const source = shortWords(280_000);
      const indexed = await index(source);
      const facts = billFacts(indexed.sections, {
        document: indexed,
        wholeBillMaxTokens: budget,
      });
      const actual = await documentContext(backend, DOC, indexed.sections, {
        budget,
        reservedTokens: referenceTokens(indexed.references),
      });
      expect(facts.mode).toBe(actual.mode);
      expect(facts.wholePrompt.summary > 0).toBe(actual.mode === 'whole');
    },
  );
  it('reserves reference tokens, as documentContext does', async () => {
    const source = bill();
    const indexed = await index(source);
    const plain = billFacts(indexed.sections, {
      document: { ...indexed, references: undefined },
    });
    expect(plain.mode).toBe('whole');
    const reserved = referenceTokens(indexed.references);
    // A budget the bill fits but bill plus references does not.
    const tokens = (
      await documentContext(backend, DOC, indexed.sections, { budget: 100_000 })
    ).hits.reduce((n, h) => n + h.chunk.tokenCount, 0);
    const budget = tokens + Math.floor(reserved / 2);
    const facts = billFacts(indexed.sections, {
      document: indexed,
      wholeBillMaxTokens: budget,
    });
    const actual = await documentContext(backend, DOC, indexed.sections, {
      budget,
      reservedTokens: reserved,
    });
    expect(actual.mode).toBe('excerpts');
    expect(facts.mode).toBe('excerpts');
  });
});

describe('sizing an indexed document', () => {
  it('is not refused by a chunk limit set lower after the document was indexed', async () => {
    const indexed = await index(bill());
    vi.stubEnv(envVar('MAX_CHUNKS'), '1');
    expect(() =>
      billFacts(indexed.sections, { document: indexed }),
    ).not.toThrow();
    expect(
      billFacts(indexed.sections, { document: indexed }).wholePrompt.summary,
    ).toBeGreaterThan(0);
  });
  it('sizes nothing for a bill the runtime reads in excerpts', () => {
    const facts = billFacts(bill().sections, { wholeBillMaxTokens: 0 });
    expect(facts.mode).toBe('excerpts');
    expect(facts.wholePrompt).toEqual(NO_PROMPT);
  });
  it('sizes the breakdown on its own when references crowd the summary out of whole mode', async () => {
    const indexed = await index(bill());
    const all = await documentContext(backend, DOC, indexed.sections, {
      budget: 100_000,
    });
    const tokens = all.hits.reduce((n, h) => n + h.chunk.tokenCount, 0);
    const facts = billFacts(indexed.sections, {
      document: indexed,
      wholeBillMaxTokens: tokens + 1,
    });
    expect(facts.mode).toBe('excerpts');
    expect(facts.wholePrompt.summary).toBe(0);
    expect(facts.wholePrompt.breakdown).toBeGreaterThan(0);
  });
});

describe('sizing at quote time, before ingest has read the references', () => {
  /** What the ingest will read at most: every target's text at its longest. */
  const fullSize = (count: number): ReferenceText[] =>
    Array.from({ length: count }, (_, i) => ({
      ...reference,
      sectionId: `ref:usc/15/${String(6809 + i)}`,
      citation: `15 U.S.C. ${String(6809 + i)}`,
      terms: ['financial institution'],
      text: 'The term "state" means each State. '
        .repeat(Math.ceil(MAX_TEXT_CHARS / 30))
        .slice(0, MAX_TEXT_CHARS),
    }));

  it('finds the borrowed definitions without any network', async () => {
    const indexed = await index(bill());
    const targets = placeholderReferences(
      indexed.sections,
      indexed.definitions,
    );
    expect(targets.map((t) => t.citation).sort()).toEqual([
      '15 U.S.C. 6809',
      '5 U.S.C. 551',
    ]);
  });

  it('is at least the indexed sizing for the same bill', async () => {
    const indexed = await index(bill());
    const quoted = billFacts(indexed.sections, {
      document: { ...indexed, references: undefined },
      preIngest: true,
    });
    // The ingest read both targets, each at the longest a text can be.
    const read = billFacts(indexed.sections, {
      document: { ...indexed, references: fullSize(2) },
    });
    // The high-bound blocks cover the longest the ingest can read.
    expect(quoted.wholePrompt.summaryHigh).toBeGreaterThanOrEqual(
      read.wholePrompt.summary,
    );
    expect(quoted.wholePrompt.questionHigh).toBeGreaterThanOrEqual(
      read.wholePrompt.question,
    );
    // The low bound counts no placeholder: a failed read leaves the bill alone.
    const bare = billFacts(indexed.sections, {
      document: { ...indexed, references: [] },
    });
    expect(quoted.wholePrompt.summary).toBe(bare.wholePrompt.summary);
    expect(quoted.wholePrompt.question).toBe(bare.wholePrompt.question);
    expect(quoted.wholePrompt.summaryHigh).toBeGreaterThan(
      bare.wholePrompt.summary + 2 * MAX_TEXT_CHARS,
    );
    for (const key of ['breakdown', 'scenario'] as const)
      expect(quoted.wholePrompt[key]).toBe(read.wholePrompt[key]);
  });

  it('chooses the mode as the runtime does with no references, not with the placeholders', async () => {
    const indexed = await index(bill());
    const all = await documentContext(backend, DOC, indexed.sections, {
      budget: 100_000,
    });
    const tokens = all.hits.reduce((n, h) => n + h.chunk.tokenCount, 0);
    // The bill fits with room for less than the eight placeholders would reserve.
    const budget = tokens + 100;
    const noRefs = { ...indexed, references: undefined };
    const quoted = billFacts(indexed.sections, {
      document: noRefs,
      preIngest: true,
      wholeBillMaxTokens: budget,
    });
    const runtime = await documentContext(backend, DOC, indexed.sections, {
      budget,
      reservedTokens: 0,
    });
    expect(runtime.mode).toBe('whole');
    expect(quoted.mode).toBe('whole');
    // The blocks that carry references are still sized at their longest.
    const indexedSizing = billFacts(indexed.sections, {
      document: noRefs,
      wholeBillMaxTokens: budget,
    });
    expect(quoted.wholePrompt.summaryHigh).toBeGreaterThan(
      indexedSizing.wholePrompt.summary,
    );
  });

  it('gives an indexed document with no references no placeholders', async () => {
    const indexed = await index(bill());
    const none = billFacts(indexed.sections, {
      document: { ...indexed, references: undefined },
    });
    const empty = billFacts(indexed.sections, {
      document: { ...indexed, references: [] },
    });
    expect(none.wholePrompt).toEqual(empty.wholePrompt);
  });

  it('refuses a bill the ingest would refuse, with the ingest limits', async () => {
    const indexed = await index(bill());
    expect(() =>
      billFacts(indexed.sections, {
        document: indexed,
        limits: { maxChunks: 3 },
      }),
    ).toThrow(/chunk limit/);
  });
});

describe('the same order and overlap trimming as the runtime', () => {
  /** Long parent text with small children and a large child between them. */
  function nested(): NormalizedDoc {
    const word = 'the grantee shall report each award to the secretary. ';
    const leaf = (id: string, chars: number): Section => ({
      id,
      num: id.slice(-2),
      heading: 'Rule',
      level: 3,
      spans: [
        {
          text: word.repeat(Math.ceil(chars / word.length)),
          status: 'unchanged',
        },
      ],
      children: [],
    });
    const parent: Section = {
      id: 'sec-p',
      num: '1',
      heading: 'Parent',
      level: 1,
      spans: [{ text: word.repeat(120), status: 'unchanged' }],
      children: [
        leaf('sec-p/a1', 90),
        leaf('sec-p/a2', 90),
        leaf('sec-p/big', 6000),
        leaf('sec-p/b1', 90),
        leaf('sec-p/b2', 90),
      ],
    };
    return { ...bill(), sections: [parent], references: undefined };
  }

  it('flips between whole and excerpts at the same budget as documentContext', async () => {
    const source = nested();
    const indexed = await index(source);
    const scan = await documentContext(backend, DOC, indexed.sections, {
      budget: 100_000,
    });
    const tokens = hitTokens(scan.hits);
    for (const budget of [tokens - 1, tokens, tokens + 1]) {
      const facts = billFacts(indexed.sections, {
        document: indexed,
        wholeBillMaxTokens: budget,
      });
      const runtime = await documentContext(backend, DOC, indexed.sections, {
        budget,
      });
      expect(facts.mode).toBe(runtime.mode);
    }
  });
});

describe('a change question that cannot read the whole bill', () => {
  it('is sized from the excerpts the runtime retrieves, struck text included', async () => {
    const source = bill({ struckChars: 24_000 });
    const indexed = await index(source);
    const scan = await documentContext(backend, DOC, indexed.sections, {
      budget: 100_000,
    });
    // Room for the live bill, not for its struck text as well.
    const budget = hitTokens(scan.hits) + 1500;
    const facts = billFacts(indexed.sections, {
      document: indexed,
      wholeBillMaxTokens: budget,
    });
    expect(facts.mode).toBe('whole');
    expect(facts.wholePrompt.changeExcerpts).toBeGreaterThan(0);
    const result = await ask(
      DOC,
      { question: 'What was removed: the old wording of the rule?' },
      { backend, registry, provider, wholeBillMaxTokens: budget },
    );
    expect(result.answer.context).toBe('excerpts');
    const content = textRequests()[0]?.messages[0]?.content;
    const sent = typeof content === 'string' ? content : '';
    expect(sent).toContain('[struck]');
    // The question and its tags add a little to what the forecast counts.
    expect(sent.length - 200).toBeLessThanOrEqual(
      facts.wholePrompt.changeExcerpts,
    );
  });
});

describe('limits and deadlines', () => {
  it('checks the ingest chunk limit even when the forecast is excerpts', async () => {
    const indexed = await index(bill());
    expect(() =>
      billFacts(indexed.sections, {
        document: indexed,
        wholeBillMaxTokens: 0,
        limits: { maxChunks: 3 },
      }),
    ).toThrow(/chunk limit/);
  });
  it('stops at its deadline and on an aborted signal, across every stage', async () => {
    const indexed = await index(bill());
    expect(() =>
      billFacts(indexed.sections, {
        document: indexed,
        limits: { timeoutMs: 1 },
      }),
    ).toThrow(/time budget/);
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      billFacts(indexed.sections, {
        document: indexed,
        limits: { signal: controller.signal },
      }),
    ).toThrow(/aborted/);
  });
});
