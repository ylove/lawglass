/** Level labels in `cite`, and the New York / New Jersey missing-legend warning. */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { bracketText } from '../../tests/synth/brackets.js';
import { makeCongressionalBillXml } from '../../tests/synth/index.js';
import { makeMcpEnv, type McpEnv } from '../../tests/support/mcp-env.js';
import { CHANGE_MARKS_WARNING } from './queries.js';
import { TOOL_NAMES } from './server.js';

let m: McpEnv;
beforeEach(async () => {
  m = await makeMcpEnv({ server: { waitMs: 5_000 } });
});
afterEach(async () => {
  await m.close();
});

const bytes = (text: string): { bytes: Uint8Array } => ({
  bytes: new TextEncoder().encode(text),
});

async function ingest(
  url: string,
  sample: { bytes: Uint8Array },
  type: string,
  served = url,
): Promise<{ doc: string; ready: Record<string, unknown> }> {
  m.env.serve(served, sample, type);
  const { json, isError } = await m.call(TOOL_NAMES.ingest, { url });
  expect(isError).toBe(false);
  expect(json.status).toBe('ready');
  return { doc: (json.doc as { doc_id: string }).doc_id, ready: json };
}

/** Every section's get_section payload, in outline order. */
async function allSections(doc: string): Promise<Record<string, unknown>[]> {
  const outline = await m.call(TOOL_NAMES.outline, { doc });
  const handles = String(outline.json.outline)
    .replace(/<\/?bill_text_[0-9a-f]{16}>/g, '')
    .split('\n')
    .map((line) => /^\s*(\S+)/.exec(line)?.[1] ?? '')
    .filter(Boolean);
  const sections: Record<string, unknown>[] = [];
  for (const section of handles)
    sections.push((await m.call(TOOL_NAMES.getSection, { doc, section })).json);
  return sections;
}

async function allCites(doc: string): Promise<string[]> {
  return (await allSections(doc)).map((got) => String(got.cite));
}

const NY_URL = 'https://www.nyassembly.gov/leg/?bn=S04321&term=2025';
const NY_TEXT_URL = 'https://nyassembly.gov/leg/?bn=S04321&term=2025&Text=Y';
const NJ_URL = 'https://pub.njleg.gov/bills/2024/S1000/1000_I1.HTM';

test.each([
  ['New York', NY_URL, NY_TEXT_URL, bracketText],
  [
    'New Jersey',
    NJ_URL,
    NJ_URL,
    (legend: string) =>
      bracketText(legend).replace('STATE OF NEW YORK', 'STATE OF NEW JERSEY'),
  ],
])(
  '%s bill without its legend: bracketed text is unknown and the warning is shown',
  async (_name, url, served, make) => {
    const { doc, ready } = await ingest(
      url,
      bytes(make('(no legend printed)')),
      'text/plain',
      served,
    );
    expect(ready.change_marks_warning).toBe(CHANGE_MARKS_WARNING);

    const sections = await allSections(doc);
    // A bracketed deletion can run across sections (core's sec-99 is the tail of one), so with
    // no legend no section that reads "unchanged" can be trusted.
    expect(sections.length).toBeGreaterThan(2);
    for (const got of sections)
      expect(got).toMatchObject({
        status: 'unknown',
        change_marks_warning: CHANGE_MARKS_WARNING,
      });
    const tail = sections.find((got) =>
      String(got.current_text).includes('continues across the page'),
    );
    expect(tail?.status).toBe('unknown');

    const search = await m.call(TOOL_NAMES.search, {
      doc,
      query: 'notice replaced',
    });
    expect(search.json.change_marks_warning).toBe(CHANGE_MARKS_WARNING);
    const hits = search.json.hits as { status: string; current_text: string }[];
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.status).toBe('unknown');
  },
);

test('a bill whose legend is found carries no legend warning', async () => {
  const { doc, ready } = await ingest(
    NY_URL,
    bytes(bracketText()),
    'text/plain',
    NY_TEXT_URL,
  );
  expect(ready.change_marks_warning).toBeUndefined();
  const section = await m.call(TOOL_NAMES.getSection, {
    doc,
    section: 'sec-1/1',
  });
  expect(section.json.change_marks_warning).toBeUndefined();
  expect(section.json.status).not.toBe('unknown');
});

test('article, chapter and title numbers keep their level names in cite', async () => {
  const charter = [
    'City Charter',
    'Article 5 Powers',
    'Chapter 7 Budget',
    'Section 1. Fees.',
    'The fee is seven dollars.',
    'Title II Duties',
    'Section 2. Duties.',
    'The duty is light.',
  ].join('\n');
  const { doc } = await ingest(
    'https://example.gov/charter.txt',
    bytes(charter),
    'text/plain',
  );
  const all = (await allCites(doc)).join('\n');
  expect(all).toMatch(/Article 5 \[current text\]/);
  expect(all).toMatch(/Chapter 7 \[current text\]/);
  expect(all).not.toMatch(/Sec\. [57]\b/);
  expect(all).toMatch(/Sec\. 1\b/);
});

test('a part with no printed number is cited as unnumbered, never as a section number', async () => {
  const { doc } = await ingest(
    NY_URL,
    bytes(bracketText()),
    'text/plain',
    NY_TEXT_URL,
  );
  const cites = await allCites(doc);
  expect(cites.some((cite) => /unnumbered part s\d+/.test(cite))).toBe(true);
  for (const cite of cites) expect(cite).not.toMatch(/ section \d+/);
});

test('federal session and stage are kept so the bill number is unambiguous', async () => {
  const { doc } = await ingest(
    'https://example.gov/bill.xml',
    makeCongressionalBillXml(),
    'application/xml',
  );
  for (const cite of await allCites(doc))
    expect(cite).toContain(
      '(119th Congress, 1st Session, Introduced-in-Senate)',
    );
});

test('a federal Title and Chapter are cited by their own level names', async () => {
  const xml = new TextDecoder()
    .decode(makeCongressionalBillXml().bytes)
    .replace(
      '<legis-body>',
      '<legis-body><title id="t2"><enum>II</enum><header>Gardens</header><chapter id="c5"><enum>5</enum><header>Grants</header>',
    )
    .replace('</legis-body>', '</chapter></title></legis-body>');
  const { doc } = await ingest(
    'https://example.gov/titled.xml',
    bytes(xml),
    'application/xml',
  );
  const all = (await allCites(doc)).join('\n');
  expect(all).toMatch(/Title II \[current text\]/);
  expect(all).toMatch(/Chapter 5 \[current text\]/);
  expect(all).not.toMatch(/Sec\. (?:II|5)\b/);
});

test('a bracketed deletion spanning three subsections leaves none of them "unchanged" without the legend', async () => {
  const text = [
    'STATE OF NEW JERSEY',
    'S. 1000',
    '2024-2025 Regular Sessions',
    'AN ACT concerning fees.',
    'BE IT ENACTED by the Senate and General Assembly of the State of New Jersey:',
    '(no legend printed)',
    'Section 1. Fees.',
    '(a) The application fee is [five dollars; and',
    '(b) the renewal fee is two dollars; and',
    '(c) the late fee is one dollar] ten dollars.',
    '2. Effective date.',
  ].join('\n');
  const { doc } = await ingest(NJ_URL, bytes(text), 'text/plain');
  const sections = await allSections(doc);
  const b = sections.find((got) =>
    String(got.current_text).includes('renewal fee'),
  );
  expect(b).toMatchObject({ status: 'unknown' });
  for (const got of sections) expect(got.status).toBe('unknown');
});
