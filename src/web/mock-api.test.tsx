import { describe, expect, test } from 'vitest';
import {
  AskEvent,
  DocDetail,
  ScenarioResponse,
  SummaryResponse,
} from '../core/model/index.js';
import { createMockApi } from './mock-api.js';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

const api = () => createMockApi({ delayMs: 0 });

describe('mock API', () => {
  test('ingest streams stages in order and ends with done', async () => {
    const events = await collect(
      api().ingest({ url: 'https://e.gov/new.pdf' }),
    );
    const stages = events.flatMap((e) =>
      e.type === 'progress' ? [e.stage] : [],
    );
    expect(stages[0]).toBe('fetching');
    expect(stages.at(-1)).toBe('done');
    expect(new Set(stages)).toEqual(
      new Set([
        'fetching',
        'parsing',
        'enriching',
        'chunking',
        'embedding',
        'done',
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      stats: { reused: false },
    });
  });

  test('wrapper URLs return candidates and failing URLs return an error', async () => {
    const m = api();
    expect(
      (await collect(m.ingest({ url: 'https://e.gov/wrapper' }))).at(-1)?.type,
    ).toBe('candidates');
    expect(
      await collect(m.ingest({ url: 'https://e.gov/fail' })),
    ).toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  test('ingesting the same URL twice reports reuse; formats follow the extension', async () => {
    const m = api();
    await collect(m.ingest({ url: 'https://e.gov/a.xml' }));
    const second = await collect(m.ingest({ url: 'https://e.gov/a.xml' }));
    expect(second.at(-1)).toMatchObject({ stats: { reused: true } });
    const docs = await m.listDocs();
    const xml = docs.find((d) => d.sourceUrl.endsWith('a.xml'));
    expect(xml?.format).toBe('xml');
    expect((await m.getDoc(xml!.docId)).hasLineNumbers).toBe(false);
    const html = await collect(m.ingest({ url: 'https://e.gov/b.html' }));
    const txt = await collect(m.ingest({ url: 'https://e.gov/c.txt' }));
    expect(html.at(-1)).toMatchObject({ doc: { format: 'html' } });
    expect(txt.at(-1)).toMatchObject({ doc: { format: 'text' } });
  });

  test('sections carry page and line only for line-numbered formats', async () => {
    const m = api();
    const [sample] = await m.listDocs();
    const s = await m.getSection(sample!.docId, 'sec-4/b');
    expect(s.location).toMatchObject({ pageStart: 3, lineStart: 5 });
    expect(s.spans.map((x) => x.status)).toContain('deleted');
    await expect(m.getSection(sample!.docId, 'nope')).rejects.toThrow(
      'section',
    );
    await expect(m.getSection('missing', 'sec-1')).rejects.toThrow(
      'not been loaded',
    );
  });

  test('a chip answer streams tokens then a done event whose citations are valid', async () => {
    const m = api();
    const [sample] = await m.listDocs();
    const events = await collect(m.ask(sample!.docId, { chipId: 'penalties' }));
    expect(events[0]?.type).toBe('retrieval');
    expect(events.filter((e) => e.type === 'token').length).toBeGreaterThan(3);
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: 'done',
      answer: { citations: [{ sectionId: 'sec-6', valid: true }] },
    });
  });

  test('sponsors skips retrieval; off-topic questions decline; money warns', async () => {
    const m = api();
    const [sample] = await m.listDocs();
    const id = sample!.docId;
    expect((await collect(m.ask(id, { chipId: 'sponsors' })))[0]?.type).toBe(
      'token',
    );
    const declined = (
      await collect(m.ask(id, { question: 'What about the moon?' }))
    ).at(-1);
    expect(declined).toMatchObject({ answer: { declined: true } });
    const money = (await collect(m.ask(id, { chipId: 'money' }))).at(-1);
    expect(money).toMatchObject({
      answer: { warnings: ['INVALID_CITATIONS_REMOVED'] },
    });
  });

  test('delegations skips retrieval and cites only sections of the sample', async () => {
    const m = api();
    const [sample] = await m.listDocs();
    const events = await collect(
      m.ask(sample!.docId, { chipId: 'delegations' }),
    );
    expect(events[0]?.type).toBe('token');
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: 'done',
      answer: { warnings: [], invalidCitations: [] },
    });
    const text = events.flatMap((e) => (e.type === 'token' ? [e.text] : []));
    expect(text.join('')).toContain('**Decided later by**');
  });

  test('who-affected emits a sample scenario after done; other chips and public mode do not', async () => {
    const m = api();
    const [sample] = await m.listDocs();
    const id = sample!.docId;
    const events = await collect(m.ask(id, { chipId: 'who-affected' }));
    expect(events.slice(-2).map((e) => e.type)).toEqual(['done', 'scenario']);
    const done = events.at(-2);
    const scenario = events.at(-1);
    expect(done).toMatchObject({ type: 'done' });
    expect(done?.type === 'done' && done.answer.scenario).toBeUndefined();
    expect(
      scenario?.type === 'scenario' && AskEvent.safeParse(scenario).success,
    ).toBe(true);
    const penalties = await collect(m.ask(id, { chipId: 'penalties' }));
    expect(penalties.map((e) => e.type)).not.toContain('scenario');
    const pub = createMockApi({ delayMs: 0, publicMode: true });
    const pubEvents = await collect(pub.ask(id, { chipId: 'who-affected' }));
    expect(pubEvents.map((e) => e.type)).not.toContain('scenario');
  });

  test('public mode rejects freeform questions; unknown docs fail; remove works', async () => {
    const pub = createMockApi({ delayMs: 0, publicMode: true });
    const [sample] = await pub.listDocs();
    expect(await collect(pub.ask(sample!.docId, { question: 'hi' }))).toEqual([
      expect.objectContaining({ type: 'error' }),
    ]);
    await pub.removeDoc(sample!.docId);
    expect(await pub.listDocs()).toEqual([]);
    await expect(pub.getDoc(sample!.docId)).rejects.toThrow('not been loaded');
  });

  test('aborting stops the stream', async () => {
    const m = createMockApi({ delayMs: 5 });
    const controller = new AbortController();
    const it = m.ingest({ url: 'https://e.gov/x.pdf' }, controller.signal);
    await it[Symbol.asyncIterator]().next();
    controller.abort();
    await expect(collect(it)).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('the sample document carries history, sponsor profiles and a preview, all schema-valid', async () => {
    const m = api();
    const [sample] = await m.listDocs();
    const detail = DocDetail.parse(await m.getDoc(sample!.docId));
    // Federal-shaped: versions oldest first, actions, and an amendment named by the record.
    expect(detail.history?.versions.map((v) => v.code)).toEqual(['ih', 'rh']);
    expect(detail.history?.actions.length).toBeGreaterThan(1);
    expect(detail.history?.amendments[0]).toMatchObject({ status: 'adopted' });
    const links = detail.metadata.sponsorProfiles?.flatMap((p) => p.links);
    expect(links).toContainEqual(
      expect.objectContaining({ kind: 'official', verified: true }),
    );
    expect(links).toContainEqual(
      expect.objectContaining({ kind: 'search', verified: false }),
    );
    expect(detail.preview).toMatchObject({ kind: 'purpose' });
    // Each call hands out a copy, so a UI that mutates it cannot corrupt the next one.
    expect(await m.getDoc(sample!.docId)).not.toBe(detail);
  });

  test('other documents get a title preview and no history', async () => {
    const m = api();
    await collect(m.ingest({ url: 'https://e.gov/new.pdf' }));
    const other = (await m.listDocs()).find((d) =>
      d.sourceUrl.endsWith('new.pdf'),
    );
    const detail = DocDetail.parse(await m.getDoc(other!.docId));
    expect(detail.history).toBeUndefined();
    expect(detail.preview?.kind).toBe('title');
  });

  test('the summary is pending once, then cached with a scenario', async () => {
    const m = api();
    const [sample] = await m.listDocs();
    expect(SummaryResponse.parse(await m.getSummary(sample!.docId))).toEqual({
      status: 'pending',
    });
    const cached = SummaryResponse.parse(await m.getSummary(sample!.docId));
    expect(cached.status).toBe('cached');
    expect(cached.answer?.scenario?.frames.length).toBeGreaterThanOrEqual(3);
    expect((await m.getSummary(sample!.docId)).status).toBe('cached');
    await expect(m.getSummary('missing')).rejects.toThrow('not been loaded');
  });

  test('a public server serves the warmed sample summary and disables the rest', async () => {
    const pub = createMockApi({ delayMs: 0, publicMode: true });
    const [sample] = await pub.listDocs();
    expect((await pub.getSummary(sample!.docId)).status).toBe('cached');
    await collect(pub.ingest({ url: 'https://e.gov/new.pdf' }));
    const other = (await pub.listDocs()).find((d) =>
      d.sourceUrl.endsWith('new.pdf'),
    );
    expect(await pub.getSummary(other!.docId)).toEqual({ status: 'disabled' });
  });

  test('scenario: ok for a plain subject, refused when judging, none for the empty case, disabled when public', async () => {
    const m = api();
    const sample = (await m.listDocs())[0]!;
    const ok = await m.getScenario(sample.docId, { subject: 'a renter' });
    expect(ok.status).toBe('ok');
    expect(
      ScenarioResponse.parse(ok).scenario?.frames.length,
    ).toBeGreaterThanOrEqual(3);
    await expect(
      m.getScenario(sample.docId, { subject: 'unfair burden' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      m.getScenario(sample.docId, { subject: '<b>x</b>' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      await m.getScenario(sample.docId, { subject: 'nobody at all' }),
    ).toEqual({
      status: 'none',
    });
    await expect(
      m.getScenario('z'.repeat(64), { subject: 'a renter' }),
    ).rejects.toThrow();
    const pub = createMockApi({ delayMs: 0, publicMode: true });
    expect(
      await pub.getScenario(sample.docId, { subject: 'a renter' }),
    ).toEqual({
      status: 'disabled',
    });
  });

  test('the sample document offers scenario personas', async () => {
    const m = api();
    const sample = (await m.listDocs())[0]!;
    const detail = DocDetail.parse(await m.getDoc(sample.docId));
    expect(detail.scenarioPersonas?.length).toBeGreaterThanOrEqual(3);
  });
});
