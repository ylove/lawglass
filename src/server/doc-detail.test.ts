import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { makeBillStatusXml } from '../../tests/synth/billstatus.js';
import {
  makeCongressionalBillXml,
  makeSectionedText,
} from '../../tests/synth/index.js';
import { writeHistory } from '../core/history/history-store.js';
import { parseGovinfoBillStatus } from '../core/history/govinfo-billstatus.js';
import { resolveGovinfo } from '../core/history/resolve.js';
import {
  DocDetail,
  IngestEvent,
  type BillHistory,
} from '../core/model/index.js';
import { readSseEvents } from '../web/sse.js';
import { createApp } from './app.js';
import { OFFICIAL_SUMMARY_MAX_LENGTH, truncateHistory } from './doc-detail.js';

let env: PipelineEnv;
beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve('https://example.gov/a.txt', makeSectionedText(), 'text/plain');
  env.serve('https://example.gov/b.xml', makeCongressionalBillXml());
});
afterEach(async () => {
  await env.cleanup();
});

const app = () => createApp(env.runtime, { localOnly: false });

async function ingestDoc(url: string): Promise<string> {
  const res = await app().request('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  for await (const e of readSseEvents(res, IngestEvent))
    if (e.type === 'done') return e.doc.docId;
  throw new Error('ingest did not finish');
}

async function detail(docId: string): Promise<DocDetail> {
  const res = await app().request(`/api/docs/${docId}`);
  expect(res.status).toBe(200);
  return DocDetail.parse(await res.json());
}

const history = (text?: string): BillHistory => ({
  ...(text === undefined
    ? {}
    : {
        officialSummary: {
          text,
          source: 'Congressional Research Service',
          url: 'https://www.govinfo.gov/bulkdata/BILLSTATUS/118/hr/BILLSTATUS-118hr9001.xml',
        },
      }),
  versions: [],
  actions: [],
  amendments: [],
  sources: [],
});

describe('truncateHistory', () => {
  test('leaves a short summary and an absent one alone', () => {
    const short = history('Short.');
    expect(truncateHistory(short)).toBe(short);
    const none = history();
    expect(truncateHistory(none)).toBe(none);
  });

  test('cuts a huge summary on a word boundary and points to the full text', () => {
    const huge = history('word '.repeat(40_000));
    const text = truncateHistory(huge).officialSummary?.text ?? '';
    expect(text.length).toBeLessThan(OFFICIAL_SUMMARY_MAX_LENGTH + 200);
    expect(text).toContain(
      '… Full official summary at https://www.govinfo.gov/',
    );
    expect(text.startsWith('word word')).toBe(true);
    expect(text).not.toMatch(/wor…/);
    // The stored record is never changed, only the copy sent to the screen.
    expect(huge.officialSummary?.text).toHaveLength(200_000);
  });

  test('cuts mid-word when there is no usable space', () => {
    const text =
      truncateHistory(history('x'.repeat(10_000))).officialSummary?.text ?? '';
    expect(text.startsWith('x'.repeat(OFFICIAL_SUMMARY_MAX_LENGTH))).toBe(true);
  });
});

describe('GET /api/docs/:docId detail', () => {
  test('has a preview and no history for a document without an official record', async () => {
    const d = await detail(await ingestDoc('https://example.gov/b.xml'));
    expect(d.history).toBeUndefined();
    expect(d.preview).toBeDefined();
  });

  test('includes the sidecar history, with a huge official summary truncated', async () => {
    const docId = await ingestDoc('https://example.gov/a.txt');
    await writeHistory(
      env.registry.configDir,
      docId,
      history('y '.repeat(100_000)),
    );
    const d = await detail(docId);
    expect(d.history?.officialSummary?.text.length).toBeLessThan(4300);
    expect(d.history?.officialSummary?.text).toContain(
      'Full official summary at',
    );
  });

  test('a corrupt history sidecar is the same as none', async () => {
    const docId = await ingestDoc('https://example.gov/a.txt');
    await writeHistory(env.registry.configDir, docId, history('ok'));
    await writeFile(
      join(env.registry.configDir, 'history', `${docId}.json`),
      '{not json',
      { mode: 0o600 },
    );
    expect((await detail(docId)).history).toBeUndefined();
  });

  test('prefers the official title from the record as a purpose preview', async () => {
    const docId = await ingestDoc('https://example.gov/b.xml');
    const before = await detail(docId);
    const plan = resolveGovinfo(
      new URL('https://www.congress.gov/bill/118th-congress/house-bill/9001'),
    )!;
    const record = parseGovinfoBillStatus(
      makeBillStatusXml(),
      plan,
      '2026-10-14T00:00:00.000Z',
    );
    await writeHistory(
      env.registry.configDir,
      docId,
      record.history,
      undefined,
      record.officialTitle,
    );
    const after = await detail(docId);
    expect(after.preview).toEqual({
      kind: 'purpose',
      text: 'To create example grants for community gardens, and for other purposes.',
    });
    expect(after.preview).not.toEqual(before.preview);
    expect(after.history?.versions.length).toBeGreaterThan(0);
  });

  test('a history without an official title keeps the document preview', async () => {
    const docId = await ingestDoc('https://example.gov/b.xml');
    const before = await detail(docId);
    await writeHistory(env.registry.configDir, docId, history('ok'));
    expect((await detail(docId)).preview).toEqual(before.preview);
  });

  test('sponsor profiles in metadata pass through', async () => {
    const docId = await ingestDoc('https://example.gov/a.txt');
    const doc = await env.registry.getDocument(docId);
    await env.registry.updateDocument({
      ...doc,
      metadata: {
        ...doc.metadata,
        sponsorProfiles: [
          {
            name: 'Rep. Example',
            role: 'sponsor',
            bioguideId: 'X000001',
            links: [
              {
                kind: 'official',
                url: 'https://example.house.gov/',
                label: 'Official website',
                verified: true,
              },
            ],
          },
        ],
      },
    });
    expect(
      (await detail(docId)).metadata.sponsorProfiles?.[0]?.links[0],
    ).toMatchObject({ kind: 'official', verified: true });
  });
});
