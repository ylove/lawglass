import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  makeCongressionalBillXml,
  makeScannedPreset,
} from '../tests/synth/index.js';
import { test, expect } from './packed-app.fixture.js';

// The v1.1 and v1.2 reading flows, driven against the mock provider (src/core/llm/mock-objects.ts
// gives it briefs, pictures, passages and examples). Both documents are synthetic.
const GARDEN = 'Reader flows garden bill';
const SCAN = 'Scanned charter amendment';
const GARDEN_PATTERN = new RegExp(`^${GARDEN}`);
const SCAN_PATTERN = new RegExp(`^${SCAN}`);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ packedApp }) => {
  const dir = await mkdtemp(join(tmpdir(), 'reader-flows-e2e-'));
  try {
    // A trailing comment gives the bill its own content hash, so it never collides with the
    // garden bill the other spec registers.
    const bill = join(dir, 'garden.xml');
    await writeFile(
      bill,
      Buffer.concat([
        makeCongressionalBillXml().bytes,
        Buffer.from('<!-- reader flows -->'),
      ]),
    );
    await packedApp.cli('ingest', bill, '--name', GARDEN);
    const scan = join(dir, 'charter.pdf');
    await writeFile(scan, (await makeScannedPreset('clean')).bytes);
    await packedApp.cli('ingest', scan, '--name', SCAN);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.afterAll(async ({ packedApp }) => {
  // The other specs expect an empty library.
  for (const label of [GARDEN, SCAN])
    await packedApp.cli('remove', label).catch(() => undefined);
});

async function openDocument(page: Page, name: RegExp) {
  await page.goto('/');
  await page
    .getByRole('region', { name: 'Your documents' })
    .getByRole('link', { name })
    .click();
  await expect(page).toHaveURL(/\/doc\/[a-f0-9]{64}$/);
}

test('summary bullets with a picture become picture cards; the rest stay bullets', async ({
  page,
}) => {
  await openDocument(page, GARDEN_PATTERN);
  const panel = page.getByRole('region', { name: 'In brief' });
  const drawn = panel.locator('li.picture-item');
  await expect(drawn).toHaveCount(1);
  // The art is decoration; the bullet's own words are the figure's caption, as real text.
  await expect(drawn.locator('figure .picture-panels')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
  await expect(drawn.locator('figcaption')).toContainText(
    'The term garden group means a nonprofit that maintains a shared garden',
  );
  await expect(drawn.locator('.picture-panels')).toHaveText('');
  // The lead-in has nothing to draw, so it stays a plain bullet.
  const plain = panel.locator('ul > li:not(.picture-item)');
  await expect(plain).toHaveCount(1);
  await expect(plain).toContainText('In this Act');
  await expect(plain.locator('.picture-panels')).toHaveCount(0);
});

test('section by section: briefs load, with a picture card and the text as caption', async ({
  page,
}) => {
  await openDocument(page, GARDEN_PATTERN);
  const panel = page.getByRole('region', { name: 'Section by section' });
  const brief = panel.locator('article.brief-card');
  await expect(brief).toHaveCount(1);
  await expect(brief.locator('.brief-num')).toHaveText('Section 2');
  await expect(brief.locator('.brief-heading')).toHaveText('Grants');
  const text = brief.locator('.brief-text');
  await expect(text).toContainText('This part covers Section 2, Grants.');
  // The picture arrives after the briefs, hidden from assistive technology and wordless.
  const picture = brief.locator('.brief-picture .picture-panels');
  await expect(picture).toHaveAttribute('aria-hidden', 'true');
  await expect(picture).toHaveText('');
  await expect(text.locator('[aria-hidden="true"]')).toHaveCount(0);
});

test('"Show an example" on a part of the bill draws the example', async ({
  page,
}) => {
  await openDocument(page, GARDEN_PATTERN);
  const brief = page
    .getByRole('region', { name: 'Section by section' })
    .locator('article.brief-card');
  await brief.getByRole('button', { name: /^Show an example/ }).click();
  const example = brief.locator('.scenario-nested');
  await expect(
    example.getByRole('heading', { name: /^What it could mean for \w+/ }),
  ).toBeVisible();
  await expect(example.getByText('Example · invented person')).toBeVisible();
  await expect(example.locator('.scenario-frame')).toHaveCount(3);
  await expect(example).toContainText('reads the rule for this part');
  // It can be hidden and shown again.
  await brief.getByRole('button', { name: /^Hide example/ }).click();
  await expect(example).toHaveCount(0);
});

test('"Find where it says that": a sentence in the bill, and one that is not', async ({
  page,
}) => {
  await openDocument(page, GARDEN_PATTERN);
  const card = page.getByRole('region', { name: 'Find where it says that' });
  const box = card.getByLabel(/Paste a sentence/);
  await box.fill('Award notices shall state the planting season.');
  await card.getByRole('button', { name: 'Find passage' }).click();
  const match = card.locator('article.locate-match');
  await expect(match.locator('blockquote')).toHaveText(
    'Award notices shall state the planting season.',
  );
  await expect(match).toContainText('In this bill');
  await expect(
    match.getByRole('button', { name: /^Sec\. 2 Grants/ }),
  ).toBeVisible();

  await box.fill('The mayor shall confiscate every garden.');
  await card.getByRole('button', { name: 'Find passage' }).click();
  await expect(
    card.getByText("We couldn't find these words in this version of the bill."),
  ).toBeVisible();
  await expect(card.locator('article.locate-match')).toHaveCount(0);
});

test('"Who decides later?" answers from the bill, with sources', async ({
  page,
}) => {
  await openDocument(page, GARDEN_PATTERN);
  await page
    .getByRole('button', { name: 'Who decides later?', exact: true })
    .click();
  const answer = page.getByRole('region', { name: 'Answer', exact: true });
  await expect(answer).toContainText('Takes effect when');
  await expect(answer).toContainText('ninety days after enactment');
  await answer
    .getByRole('button', { name: /^Source 1/ })
    .first()
    .click();
  await expect(page.getByRole('dialog', { name: 'Source text' })).toContainText(
    'Grants',
  );
});

test('a scanned charter amendment shows the scan badge and says marks were not read', async ({
  page,
}) => {
  await openDocument(page, SCAN_PATTERN);
  const badge = page.getByRole('region', { name: 'Scanned document' });
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('This file is a scan');
  await expect(badge.locator('.scan-page')).toHaveText(
    'Page 1: marks not read',
  );
  // Reading struck words out of the page image is not built yet (the parser marks every scanned
  // page "not-read"), so the app must say so instead of showing struck words as removed.
  await expect(badge.locator('.scan-warning')).toContainText(
    'struck and inserted words were not read',
  );
});
