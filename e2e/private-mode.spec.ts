import { BRAND, envVar } from '../src/core/brand.js';
import { test, expect } from './packed-app.fixture.js';

const ACCESS_KEY = 'e'.repeat(40);

// The inherited CSP guard checks both the gate and the app. Skip the local session exchange:
// this test must begin with a fresh, unauthenticated browser.
test.use({
  localSession: async ({}, use) => {
    await use(undefined);
  },
});

test('private preview gate, invite exchange and hosted ingest policy', async ({
  page,
  context,
  packedApp,
}) => {
  const server = await packedApp.serve(0, {
    privateMode: true,
    env: {
      [envVar('ACCESS_KEY')]: ACCESS_KEY,
      [envVar('ALLOW_MOCK')]: '1',
      [envVar('PUBLIC_ORIGIN')]: 'https://preview.example',
    },
  });
  // Chromium treats localhost as a secure-cookie exception on plain HTTP.
  const origin = new URL(server.url);
  origin.hostname = 'localhost';
  try {
    const gate = await page.goto(origin.origin);
    expect(gate?.status()).toBe(200);
    await expect(
      page.getByRole('heading', { name: BRAND.displayName }),
    ).toBeVisible();
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      BRAND.displayName,
    );
    await expect(page.locator('#root')).toHaveCount(0);
    await expect(page.locator('script')).toHaveCount(0);
    // A document address is gated like everything else: it gets the gate page, not the app.
    const gatedDoc = await page.goto(`${origin.origin}/doc/${'a'.repeat(64)}`);
    expect(gatedDoc?.status()).toBe(200);
    await expect(page.locator('#root')).toHaveCount(0);
    const denied = await context.request.get(`${origin.origin}/api/docs`);
    expect(denied.status()).toBe(401);
    expect(await denied.json()).toMatchObject({
      error: { code: 'UNAUTHORIZED' },
    });

    const redirect = page.waitForResponse(
      (response) =>
        response.status() === 302 &&
        new URL(response.url()).searchParams.has('k'),
    );
    await page.goto(`${origin.origin}/?k=${ACCESS_KEY}`);
    const exchange = await redirect;
    expect(exchange.headers().location).toBe('/');
    expect(page.url()).toBe(`${origin.origin}/`);
    const session = (await context.cookies(origin.origin)).find(
      (cookie) => cookie.name === `${BRAND.name}_session`,
    );
    expect(session).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    });
    expect(session?.value).not.toBe(ACCESS_KEY);
    await page.goto(origin.origin);
    await expect(page.locator('#root')).not.toBeEmpty();
    const config = await context.request.get(`${origin.origin}/api/config`);
    expect(await config.json()).toMatchObject({
      publicMode: false,
      freeformEnabled: true,
      scenariosEnabled: true,
    });
    // Visitors land on the homepage with the example line, never inside a document.
    await expect(
      page.getByText('Understand any bill, line by line.'),
    ).toBeVisible();
    await expect(page).toHaveURL(`${origin.origin}/`);
    const reader = (await context.cookies(origin.origin)).find(
      (cookie) => cookie.name === `${BRAND.name}_reader`,
    );
    expect(reader).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    });
    // /doc/<id> reloads and the logo are covered by legislation.spec.ts; a production build
    // never enables ?mock=1, so this spec has no document to open.
    await page.goto(origin.origin);
    await page
      .getByRole('textbox', { name: /url|address|link/i })
      .fill('https://pub.njleg.gov/bill.pdf');
    await page
      .getByRole('button', { name: 'Read this bill', exact: true })
      .click();
    await expect(
      page.getByText(/Other states are on the roadmap\./),
    ).toBeVisible();
  } finally {
    await server.stop();
  }
});
