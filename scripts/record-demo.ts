/**
 * Records the README demo GIF from a running local server (development tool, not shipped).
 *
 * Real recording (server running with a real LLM provider, document ingested, summary pre-warmed):
 *
 *   npx tsx scripts/record-demo.ts --url http://127.0.0.1:4317 --doc "s202" \
 *     --chip "Who does it affect?" --out docs/demo.gif --width 720 --max-seconds 240
 *
 * Dry run (no server or model needed): serves a development-mode build of the web UI
 * (built into a temp dir on the fly) with the scripted mock UI (`?mock=1`). Production builds
 * deliberately exclude the mock. Write somewhere other than docs/demo.gif:
 *
 *   npx tsx scripts/record-demo.ts --dry-run --out /tmp/demo-dry/demo.gif
 *
 * The story: masthead and sponsor byline, "In brief" summary, optional scenario strip, optional
 * "How did it get here?" card, then one chip answer and its Source 1 in the drawer. The scenario
 * strip and history card are skipped when a bill has none. Needs Chromium from Playwright
 * (`npx playwright install chromium`) and ffmpeg on PATH.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { chromium, type Locator, type Page } from '@playwright/test';

const run = promisify(execFile);
const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:4317' },
    doc: { type: 'string' },
    chip: { type: 'string' },
    out: { type: 'string', default: 'docs/demo.gif' },
    width: { type: 'string', default: '720' },
    'max-seconds': { type: 'string', default: '90' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const dryRun = values['dry-run'];
const doc =
  values.doc ?? (dryRun ? 'Clean Water Infrastructure Act' : undefined);
if (!doc) throw new Error('Pass --doc <label of an ingested document>.');
const chip =
  values.chip ?? (dryRun ? 'What does it change?' : 'Who does it affect?');
const maxSeconds = Number(values['max-seconds']);
if (!Number.isFinite(maxSeconds) || maxSeconds <= 0)
  throw new Error('--max-seconds must be a positive number.');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/** Static server for a dev-mode web build (the mock only exists when DEV is true). */
async function serveBuiltUi(): Promise<{ server: Server; url: string }> {
  const root = await mkdtemp(join(tmpdir(), 'demo-ui-'));
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
    { stdio: 'ignore', env: { ...process.env, NODE_ENV: 'development' } },
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
  return { server, url: `http://127.0.0.1:${String(address.port)}/?mock=1` };
}

/**
 * Scrolls the page with small mouse-wheel steps until the element's top sits near the top of the
 * viewport (or the page can scroll no further). Small steps read as smooth motion on video.
 */
async function scrollTo(page: Page, target: Locator): Promise<void> {
  await page.mouse.move(640, 400);
  for (let i = 0; i < 200; i++) {
    const box = await target.boundingBox();
    if (!box) return;
    const delta = box.y - 110;
    if (Math.abs(delta) < 8) return;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), 36);
    const before = await page.evaluate<number>('window.scrollY');
    await page.mouse.wheel(0, step);
    await page.waitForTimeout(24);
    if ((await page.evaluate<number>('window.scrollY')) === before) return;
  }
}

const mockUi = dryRun ? await serveBuiltUi() : null;
const startUrl = mockUi?.url ?? values.url;
const videoDir = await mkdtemp(join(tmpdir(), 'demo-video-'));
const browser = await chromium.launch();
// Guard against a hung server or model: closing the browser makes the pending step throw.
const guard = setTimeout(() => {
  console.error(`Exceeded --max-seconds (${String(maxSeconds)}); aborting.`);
  void browser.close();
}, maxSeconds * 1000);
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  // Pauses are for the viewer: each step stays on screen long enough to read.
  const pause = (ms: number) => page.waitForTimeout(ms);

  await page.goto(startUrl);
  await pause(1000);
  const sidebar = page.getByRole('navigation', { name: 'Loaded documents' });
  // The entry's accessible name is the label followed by the bill number; anchor on the label so
  // the "Remove <label>" button never matches.
  const escaped = doc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await sidebar
    .getByRole('button', { name: new RegExp(`^${escaped}`) })
    .click();

  // 1. Masthead: bill title and sponsor byline. Wait for the title heading, then hold.
  await page.getByRole('heading', { level: 2 }).first().waitFor();
  await pause(2000);

  // 2. "In brief". The summary may still be writing; its footer note appears once it is cached.
  const brief = page.getByRole('region', { name: 'In brief' });
  await brief.waitFor();
  await scrollTo(page, brief);
  await brief
    .getByText("Written from the bill's own text.")
    .waitFor({ timeout: 180_000 })
    .catch(() => {
      // Dry runs and bills without a cached summary still show the preview; carry on.
      if (!dryRun)
        console.warn('Summary never reported as written; continuing.');
    });
  await pause(3000);

  // 3. Optional scenario strip, then the optional history card in the aside.
  const scenario = page.getByRole('region', { name: /example/i }).first();
  if (await scenario.isVisible().catch(() => false)) {
    await scrollTo(page, scenario);
    await pause(3000);
  }
  const history = page.getByRole('region', { name: 'How did it get here?' });
  if (await history.isVisible().catch(() => false)) {
    await scrollTo(page, history);
    await pause(2000);
  }

  // 4. A chip, its streamed answer, and Source 1 in the drawer.
  const chipButton = page.getByRole('button', { name: chip, exact: true });
  await scrollTo(page, chipButton);
  await pause(800);
  await chipButton.click();
  const answer = page.getByRole('region', { name: 'Answer', exact: true });
  await answer.waitFor();
  await scrollTo(page, answer);
  // The answer streams; it is complete once its first citation button renders.
  const source1 = answer
    .getByRole('button', { name: 'Source 1', exact: true })
    .first();
  await source1.waitFor({ timeout: 180_000 });
  await pause(3000);
  await source1.click();
  const drawer = page.getByRole('dialog', { name: 'Source text' });
  await drawer.waitFor();
  await pause(4000);
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await pause(1000);
  await context.close(); // flushes the video file
} finally {
  clearTimeout(guard);
  await browser.close();
  mockUi?.server.close();
}

const [video] = (await readdir(videoDir)).filter((f) => f.endsWith('.webm'));
if (!video) throw new Error('Playwright did not write a video.');
const out = resolve(values.out);
await mkdir(dirname(out), { recursive: true });
// Two-pass palette keeps text crisp at a small file size. 6 fps, 64 colours and rectangle diffs
// (only the changed region is stored per frame) keep a ~30 s story near 4 MB at 720 px; the UI
// is mostly static between scrolls, so the low frame rate costs little.
await run('ffmpeg', [
  '-y',
  '-i',
  join(videoDir, video),
  '-vf',
  `fps=6,scale=${values.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  '-loop',
  '0',
  out,
]);
await rm(videoDir, { recursive: true, force: true });
console.log(`Wrote ${out}`);
