/**
 * Captures the screenshots used on the public landing page into src/web/public/site/
 * (development tool, not shipped). Needs Chromium from Playwright.
 *
 * Mock data (no server, no model; builds a development bundle and serves it with ?mock=1):
 *
 *   npm run site:shots -- --mock
 *
 * A real bill from a running local server (start it with `node dist/cli.js <bill-url>`; pass the
 * link it prints, including ?k=..., as --url, and the document id as --doc):
 *
 *   npm run site:shots -- --url "http://127.0.0.1:4317/?k=..." --doc <docId>
 *
 * Images are JPEG (Playwright cannot write WebP and sharp is not a direct dependency), taken at
 * 2x density in the light theme, and must stay small because the landing page loads them all.
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Locator, type Page } from '@playwright/test';

const { values } = parseArgs({
  options: {
    mock: { type: 'boolean', default: false },
    url: { type: 'string' },
    doc: { type: 'string' },
    out: { type: 'string', default: 'src/web/public/site' },
    'locate-text': {
      type: 'string',
      default:
        'The bill requires every water system to replace its lead pipes within ten years.',
    },
  },
});
if (!values.mock && !(values.url && values.doc))
  throw new Error(
    'Pass --mock, or --url <origin> together with --doc <docId>.',
  );

const MAX_BYTES = 200 * 1024;
/**
 * A real bill's In brief or section-by-section card can run to several screens. The landing
 * page shows only the top of each, so a tall card is cut, at the end of the last list item or
 * brief that fits, to about this many CSS pixels.
 */
const MAX_HEIGHT = 900;
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/** Static server for a development-mode web build (the mock only exists when DEV is true). */
async function serveMockUi(): Promise<{
  server: Server;
  url: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'site-shots-ui-'));
  execFileSync(
    'npx',
    [
      'vite',
      'build',
      '--mode',
      'development',
      '--outDir',
      root,
      '--emptyOutDir',
    ],
    // NODE_ENV must be development too, or vite defaults it to production and strips the mock.
    { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' } },
  );
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    readFile(file).then(
      (buf) => {
        res.writeHead(200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        });
        res.end(buf);
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Static server did not bind a port.');
  return {
    server,
    root,
    url: `http://127.0.0.1:${String(address.port)}/?mock=1`,
  };
}

/** Waits for a card and fails with the name of the card, not a bare selector timeout. */
async function need(
  page: Page,
  name: string,
  selector: string,
): Promise<Locator> {
  const card = page.locator(selector).first();
  try {
    await card.waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    throw new Error(`The ${name} (${selector}) never appeared on the page.`);
  }
  return card;
}

/** Page coordinates of the card, cut at an item boundary when it is taller than MAX_HEIGHT. */
async function cropFor(
  card: Locator,
): Promise<
  { x: number; y: number; width: number; height: number } | undefined
> {
  const box = await card.boundingBox();
  if (!box || box.height <= MAX_HEIGHT) return undefined;
  // The scripts project has no DOM types; this is all of the element API the callback touches.
  interface Measured {
    getBoundingClientRect(): { top: number; bottom: number };
  }
  const items = await card.locator('li, article').evaluateAll((nodes) =>
    nodes.map((node) => {
      const { top, bottom } = (
        node as unknown as Measured
      ).getBoundingClientRect();
      return { top, bottom };
    }),
  );
  // End after the last item that fits, with a little space below it but none of the next item.
  const fits = items.filter((r) => r.bottom - box.y <= MAX_HEIGHT);
  if (fits.length === 0)
    return {
      x: box.x,
      y: box.y + (await scrollTop(card)),
      width: box.width,
      height: MAX_HEIGHT,
    };
  const end = Math.max(...fits.map((r) => r.bottom));
  const nextTop = Math.min(
    ...items.map((r) => r.top).filter((top) => top >= end),
    end + 16,
  );
  const height = nextTop - box.y;
  return {
    x: box.x,
    y: box.y + (await scrollTop(card)),
    width: box.width,
    height,
  };
}

/** How far the page is scrolled: a clip is in page coordinates, a bounding box in the viewport's. */
function scrollTop(card: Locator): Promise<number> {
  return card
    .page()
    .evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY);
}

async function shoot(card: Locator, file: string): Promise<void> {
  await card.scrollIntoViewIfNeeded();
  await card.page().waitForTimeout(400);
  const clip = await cropFor(card);
  // Quality steps down until the file fits the budget.
  for (const quality of [82, 74, 66, 58]) {
    if (clip)
      await card.page().screenshot({
        path: file,
        type: 'jpeg',
        quality,
        clip,
        fullPage: true,
      });
    else await card.screenshot({ path: file, type: 'jpeg', quality });
    const { size } = await stat(file);
    if (size <= MAX_BYTES) {
      console.log(
        `Wrote ${file} (${String(Math.round(size / 1024))} KB, q${String(quality)})`,
      );
      return;
    }
  }
  throw new Error(
    `${file} is still over ${String(MAX_BYTES / 1024)} KB at the lowest quality.`,
  );
}

const mock = values.mock ? await serveMockUi() : undefined;
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 1400 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    console.warn(`Page error: ${error.message}`);
  });
  const start = mock?.url ?? values.url ?? '';
  await page.goto(start);
  if (mock) {
    // The home screen lists the demo document as a link (the sidebar only shows on a document).
    await page
      .getByRole('link', { name: /^Clean Water Infrastructure Act/ })
      .first()
      .click();
  } else {
    // The first visit exchanges the ?k= key for a cookie; then go straight to the document.
    await page.goto(`${new URL(start).origin}/doc/${values.doc ?? ''}`);
  }

  // Each card is captured only once it holds finished content, not a loading state.
  const summary = await need(page, 'In brief card', 'section.card.summary');
  await summary
    .getByText("Written from the bill's own text.")
    .waitFor({ timeout: 120_000 })
    .catch(() => {
      console.warn(
        'In brief never reported as written; capturing what is there.',
      );
    });
  await shoot(summary, join(out, 'in-brief.jpg'));

  const breakdown = await need(
    page,
    'section-by-section card',
    'section.card.breakdown',
  );
  // Per-section briefs load one by one; wait for the loading line to go before capturing.
  await breakdown
    .getByText(/Reading the rest of the sections/)
    .waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => {
      console.warn('Section briefs still loading; capturing what is there.');
    });
  await shoot(breakdown, join(out, 'sections.jpg'));

  const locate = await need(
    page,
    'Find where it says that card',
    'section.locate-card',
  );
  await locate
    .getByLabel(/Paste a sentence/)
    .first()
    .fill(values['locate-text']);
  await locate.getByRole('button', { name: 'Find passage' }).click();
  try {
    await locate
      .getByRole('button', { name: /Copy receipt/ })
      .first()
      .waitFor({ timeout: 120_000 });
  } catch {
    throw new Error('Find passage never produced a passage with a receipt.');
  }
  await shoot(locate, join(out, 'find.jpg'));

  const history = await need(page, 'history card', 'section.card.history');
  await shoot(history, join(out, 'history.jpg'));

  // Chip answers stream; an answer is finished once its first citation button renders.
  for (const [chip, file] of [
    ['What does it change?', 'changes.jpg'],
    ['Who decides later?', 'decides.jpg'],
  ] as const) {
    const button = page.getByRole('button', { name: chip, exact: true });
    try {
      await button.click({ timeout: 20_000 });
    } catch {
      throw new Error(`The "${chip}" chip was not found on the page.`);
    }
    const answer = page.getByRole('region', { name: 'Answer', exact: true });
    try {
      await answer
        .getByRole('button', { name: 'Source 1', exact: true })
        .first()
        .waitFor({ timeout: 180_000 });
    } catch {
      throw new Error(`The answer to "${chip}" never showed a citation.`);
    }
    await shoot(answer, join(out, file));
  }
} catch (error) {
  // A picture of the page at the moment of failure saves guessing which selector drifted.
  const pages = browser.contexts().flatMap((c) => c.pages());
  await pages[0]?.screenshot({
    path: join(tmpdir(), 'site-shots-failure.png'),
  });
  console.error(
    `Saved ${join(tmpdir(), 'site-shots-failure.png')} for debugging.`,
  );
  throw error;
} finally {
  await browser.close();
  if (mock) {
    mock.server.close();
    await rm(mock.root, { recursive: true, force: true });
  }
}
