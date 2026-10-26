import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SummaryResponse } from '../src/core/model/index.js';
import { makeCongressionalBillXml } from '../tests/synth/index.js';
import { test, expect } from './packed-app.fixture.js';

// A second synthetic document: unlike the PDF it names a sponsor and a cosponsor, and like every
// local file it has no official record (no history, no verified profile links).
const LABEL = 'Synthetic garden bill';
const SECOND_LABEL = 'Second garden bill';
// The sidebar appends the bill number to the label, so match the start of the name.
const LABEL_PATTERN = new RegExp(`^${LABEL}`);
const SECOND_PATTERN = new RegExp(`^${SECOND_LABEL}`);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ packedApp }) => {
  const dir = await mkdtemp(join(tmpdir(), 'rc2-e2e-'));
  try {
    const path = join(dir, 'garden.xml');
    await writeFile(path, makeCongressionalBillXml().bytes);
    await packedApp.cli('ingest', path, '--name', LABEL);
    // A trailing comment changes the content hash, so this registers as a separate document.
    await writeFile(
      path,
      Buffer.concat([
        makeCongressionalBillXml().bytes,
        Buffer.from('<!-- 2 -->'),
      ]),
    );
    await packedApp.cli('ingest', path, '--name', SECOND_LABEL);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.afterAll(async ({ packedApp }) => {
  // The other spec expects an empty library at its end.
  for (const label of [LABEL, SECOND_LABEL])
    await packedApp.cli('remove', label).catch(() => undefined);
});

async function openDocument(page: import('@playwright/test').Page) {
  await page.goto('/');
  // The homepage lists the documents; opening one moves to /doc/<id>.
  await page
    .getByRole('region', { name: 'Your documents' })
    .getByRole('link', { name: LABEL_PATTERN })
    .click();
  await expect(page).toHaveURL(/\/doc\/[a-f0-9]{64}$/);
}

test('summary on arrival: preview, then summary, then cached on reload', async ({
  page,
}) => {
  // Hold the first answer back briefly so the preview phase is observable, not a race. The
  // request still reaches the real server, which starts the one generation.
  let held = false;
  await page.route('**/summary', async (route) => {
    const response = await route.fetch();
    if (!held) {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.fulfill({ response });
  });
  await openDocument(page);
  const panel = page.getByRole('region', { name: 'In brief' });
  // The instant preview comes from the document itself, before any model call.
  await expect(panel.locator('.summary-preview')).toHaveText(/\S/);
  await expect(panel).toContainText('Writing a plain-language summary');
  await expect(panel).toContainText('Written from the bill');
  await expect(panel).not.toContainText('Writing a plain-language summary');
  const summaryText = await panel.locator('.summary-text').innerText();
  expect(summaryText.length).toBeGreaterThan(0);

  await page.unroute('**/summary');

  // On reload the server must answer from its cache on the very first look. A `pending` first
  // answer would mean a second generation was started.
  const statuses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/summary')) {
      void response.json().then((body: unknown) => {
        statuses.push(SummaryResponse.parse(body).status);
      });
    }
  });
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Loaded documents' })
    .getByRole('button', { name: LABEL_PATTERN })
    .click();
  const again = page.getByRole('region', { name: 'In brief' });
  await expect(again).toContainText('Written from the bill');
  await expect(again.locator('.summary-text')).toHaveText(summaryText);
  expect(statuses.length).toBeGreaterThan(0);
  expect(statuses.every((status) => status === 'cached')).toBe(true);
});

test('no example strip or badge when the mock provider yields no valid scenario', async ({
  page,
}) => {
  // The mock cannot produce a grounded scenario, so the validator drops it. The strip's own
  // rendering is covered by ScenarioStrip's unit tests.
  await openDocument(page);
  await expect(page.getByRole('region', { name: 'In brief' })).toContainText(
    'Written from the bill',
  );
  await expect(page.locator('.scenario')).toHaveCount(0);
  await expect(page.getByText('Example · invented person')).toHaveCount(0);
});

test('history: honest "unavailable" card and chip answer for a local document', async ({
  page,
}) => {
  await openDocument(page);
  const card = page.getByRole('region', { name: 'How did it get here?' });
  await expect(card).toContainText(
    'The official history is not available for this document.',
  );
  await page
    .getByRole('button', { name: 'How did it get here?', exact: true })
    .click();
  const answer = page.getByRole('region', { name: 'Answer', exact: true });
  await expect(answer).toContainText(/history isn't available/i);
});

test('sponsors: unverified search links that open safely in a new tab', async ({
  page,
}) => {
  await openDocument(page);
  const link = page.locator('dd a.sponsor').first();
  await expect(link).toContainText('Rowan Example');
  await expect(link).toContainText('search');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  // Never followed: the href is only read.
  const href = (await link.getAttribute('href')) ?? '';
  expect(href).toMatch(/^https:\/\//);
});

test('server-down card appears when the server stops, and Retry recovers', async ({
  page,
  packedApp,
}) => {
  // A server of its own, so the shared one keeps serving the other tests.
  const first = await packedApp.serve();
  const port = Number(new URL(first.url).port);
  await page.goto(first.url);
  // Arrive on the homepage, open one document; the other is clicked once the server is gone.
  await page
    .getByRole('region', { name: 'Your documents' })
    .getByRole('link', { name: LABEL_PATTERN })
    .click();
  const sidebar = page.getByRole('navigation', { name: 'Loaded documents' });
  await expect(
    sidebar.getByRole('button', { name: LABEL_PATTERN }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole('button', { name: SECOND_PATTERN }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'In brief' })).toBeVisible();
  const other = SECOND_LABEL;

  await first.stop();
  await sidebar.getByRole('button', { name: new RegExp(`^${other}`) }).click();
  const card = page.getByRole('region', { name: /can't reach its server/ });
  await expect(card).toBeVisible();

  // Same port, so the open page's relative requests reach the restarted server.
  const second = await packedApp.serve(port);
  expect(new URL(second.url).origin).toBe(new URL(first.url).origin);
  expect(second.url).not.toBe(first.url);
  // Each launch rotates the token, so re-open its link before the old page retries.
  await page.context().request.get(second.url);
  await card.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'In brief' })).toBeVisible();
});
