/** Per-question answer mode through `ask` (issue #429). */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { envVar } from '../brand.js';
import { forgetDocument } from '../answer/context.js';
import {
  EMPTY_METADATA,
  makeChunkId,
  type Chunk,
  type NormalizedDoc,
  type Section,
  type TextRequest,
} from '../model/index.js';
import { Registry } from '../registry.js';
import { ask } from './ask.js';

const DOC = 'c'.repeat(64);
let dir: string;
let backend: MemoryBackend;
let registry: Registry;
let provider: ScriptedProvider;
const requests = (): TextRequest[] =>
  provider.calls.filter((c): c is TextRequest => 'messages' in c);

beforeEach(async () => {
  vi.stubEnv(envVar('WHOLE_BILL_MAX_TOKENS'), '100000');
  dir = await mkdtemp(join(tmpdir(), 'ask-modes-'));
  registry = new Registry(dir);
  backend = new MemoryBackend();
  const sections: Section[] = Array.from({ length: 4 }, (_, i) => ({
    id: `sec-${String(i + 1)}`,
    num: String(i + 1),
    level: 1,
    heading: `Part ${String(i + 1)}`,
    spans: [
      { text: `Part ${String(i + 1)} sets a rule.`, status: 'unchanged' },
    ],
    children: [],
  }));
  const doc: NormalizedDoc = {
    docId: DOC,
    sourceUrl: 'https://example.gov/bill.xml',
    format: 'xml',
    fetchedAt: '2026-10-26T00:00:00.000Z',
    metadata: { ...EMPTY_METADATA, title: 'Rules' },
    sections,
    definitions: [],
    externalRefs: [],
    warnings: [],
  };
  const chunks = sections.map((s): Chunk => ({
    id: makeChunkId(DOC, s.id, 0),
    docId: DOC,
    sectionId: s.id,
    breadcrumb: s.heading!,
    text: s.spans[0]!.text,
    embedText: s.spans[0]!.text,
    chunkType: 'operative',
    amendmentStatus: 'unchanged',
    definedTermsUsed: [],
    refs: [],
    tokenCount: 10,
  }));
  provider = new ScriptedProvider({ reply: 'Part 1 sets a rule [S:sec-1].' });
  await backend.upsertChunks(DOC, chunks);
  await registry.add(doc, { label: 'rules', backend: 'local' });
});
afterEach(async () => {
  forgetDocument(backend, DOC);
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const deps = () => ({ backend, registry, provider });

describe('ask mode', () => {
  it('auto reads the whole bill when it fits, as before, at the old cap', async () => {
    const r = await ask(DOC, { question: 'What rule?' }, deps());
    expect(r.mode).toBe('whole');
    expect(r.answer.context).toBe('whole');
    expect(requests()[0]).toMatchObject({
      maxTokens: 16_000,
      effort: 'medium',
    });
  });

  it('no mode is the same as auto', async () => {
    const a = await ask(DOC, { question: 'What rule?' }, deps());
    const b = await ask(DOC, { question: 'What rule?', mode: 'auto' }, deps());
    expect(b.mode).toBe(a.mode);
    const [first, second] = requests();
    expect(second).toMatchObject({
      system: first?.system,
      messages: first?.messages,
      maxTokens: first?.maxTokens,
      effort: first?.effort,
    });
  });

  it('whole reads the whole bill when it fits', async () => {
    const r = await ask(DOC, { question: 'What rule?', mode: 'whole' }, deps());
    expect(r.mode).toBe('whole');
    expect(r.answer.context).toBe('whole');
  });

  it('whole on a bill too long for the budget is answered from excerpts, and says so', async () => {
    const r = await ask(
      DOC,
      { question: 'What rule?', mode: 'whole' },
      { ...deps(), wholeBillMaxTokens: 1 },
    );
    expect(r.mode).not.toBe('whole');
    expect(r.answer.context).toBe('excerpts');
  });

  it('focused retrieves excerpts even when the bill fits, at the focused cap and without effort', async () => {
    const r = await ask(
      DOC,
      { question: 'What rule?', mode: 'focused' },
      deps(),
    );
    expect(r.mode).not.toBe('whole');
    expect(r.answer.context).toBe('excerpts');
    expect(requests()[0]).toMatchObject({ maxTokens: 8192 });
    expect(requests()[0]?.effort).toBeUndefined();
  });

  it('focused does not scan the whole bill', async () => {
    const getChunks = vi.spyOn(backend, 'getChunks');
    await ask(DOC, { question: 'What rule?', mode: 'focused' }, deps());
    expect(getChunks).not.toHaveBeenCalled();
  });

  it('host caps apply per mode, and a lowered focused cap lowers effort', async () => {
    const answerLimits = { wholeMaxTokens: 12_000, focusedMaxTokens: 4096 };
    await ask(
      DOC,
      { question: 'q', mode: 'whole' },
      { ...deps(), answerLimits },
    );
    await ask(
      DOC,
      { question: 'q', mode: 'focused' },
      { ...deps(), answerLimits },
    );
    expect(requests()[0]).toMatchObject({
      maxTokens: 12_000,
      effort: 'medium',
    });
    expect(requests()[1]).toMatchObject({ maxTokens: 4096, effort: 'low' });
  });

  it('a mode on a chip is ignored: the chip keeps its own strategy', async () => {
    const r = await ask(DOC, { chipId: 'summary' }, deps());
    expect(r.mode).toBe('whole');
  });
});
