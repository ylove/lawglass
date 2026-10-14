import { AskEvent, ERROR_CODES } from '../src/core/model/index.js';
import { SAMPLE_LABEL } from '../scripts/packed-app.js';
import { test, expect } from './packed-app.fixture.js';

test('packed UI: document, streamed chip, citation, blocked address, removal', async ({
  page,
  packedApp,
}) => {
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Loaded documents' });
  const document = sidebar.getByRole('button', {
    name: SAMPLE_LABEL,
    exact: true,
  });
  await expect(document).toBeVisible();
  await document.click();

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith('/ask') && response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'When does it take effect?', exact: true })
    .click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/event-stream');
  // Chrome does not reliably keep the body of a streamed, no-store response for DevTools, so
  // replay the same request through the page's request context (it shares the session cookie).
  const replay = await page.request.post(response.url(), {
    data: response.request().postDataJSON() as unknown,
    headers: { 'content-type': 'application/json' },
  });
  expect(replay.status()).toBe(200);
  const events = (await replay.text())
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => AskEvent.parse(JSON.parse(line.slice(5))));
  // Tokens stream first; the refs arrive once the answer is complete, just before `done`.
  const types = events.map((event) => event.type);
  expect(types.filter((type) => type === 'token').length).toBeGreaterThan(1);
  expect(types.slice(-2)).toEqual(['retrieval', 'done']);
  const answer = page.getByRole('region', { name: 'Answer', exact: true });
  await expect(answer).toContainText('Section 2');
  await answer.getByRole('button', { name: 'Source 1', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Source text' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Sec. 2');
  await expect(drawer).toContainText('Effective date');
  await expect(drawer).toContainText('Page 2, lines 4-5');
  await expect(drawer).toContainText(
    'This act takes effect ninety days after passage.',
  );
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();

  // The changes chip cites the amended section; the drawer preserves both kinds of markup.
  await page
    .getByRole('button', { name: 'What does it change?', exact: true })
    .click();
  await expect(answer).toContainText('Adjusted gross income');
  await answer
    .getByRole('button', { name: 'Source 1', exact: true })
    .first()
    .click();
  await expect(drawer).toContainText('Sec. 5747.01 Definitions. > (A) > (1)');
  await expect(drawer).toContainText('Page 1, lines 5-6');
  await expect(drawer.locator('.excerpt del')).toHaveText(
    /the obsolete credit/,
  );
  await expect(drawer.locator('.excerpt ins')).toHaveText(
    /the community garden credit/,
  );
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();

  await sidebar
    .getByRole('button', { name: 'Add a bill', exact: true })
    .click();
  await page.getByLabel('Web address of the bill').fill('http://127.0.0.1/x');
  await page
    .getByRole('button', { name: 'Read this bill', exact: true })
    .click();
  await expect(page.getByRole('alert')).toHaveText(ERROR_CODES.SSRF_BLOCKED);

  await sidebar
    .getByRole('button', { name: `Remove ${SAMPLE_LABEL}`, exact: true })
    .click();
  await sidebar
    .getByRole('button', { name: 'Yes, remove', exact: true })
    .click();
  await expect(sidebar).toContainText('Nothing loaded yet.');
  await expect(document).toHaveCount(0);
  await page.reload();
  await expect(sidebar).toContainText('Nothing loaded yet.');
  expect(await packedApp.cli('list')).toContain('No documents ingested yet.');
});
