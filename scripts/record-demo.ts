/**
 * Records the README demo GIF from a running local server (development tool, not shipped).
 *
 *   npx tsx scripts/record-demo.ts --url http://127.0.0.1:4317 --doc "HB 62" --out docs/demo.gif
 *
 * The server must already have the document ingested and a real LLM provider configured: the
 * demo shows a real answer, never the mock provider. Needs Chromium from Playwright
 * (`npx playwright install chromium`) and ffmpeg on PATH.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { chromium } from '@playwright/test';

const run = promisify(execFile);
const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:4317' },
    doc: { type: 'string' },
    chip: { type: 'string', default: 'What does it change?' },
    out: { type: 'string', default: 'docs/demo.gif' },
    width: { type: 'string', default: '960' },
  },
});
if (!values.doc) throw new Error('Pass --doc <label of an ingested document>.');

const videoDir = await mkdtemp(join(tmpdir(), 'demo-video-'));
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  // Pauses are for the viewer: each step stays on screen long enough to read.
  const pause = (ms: number) => page.waitForTimeout(ms);

  await page.goto(values.url);
  await pause(1200);
  const sidebar = page.getByRole('navigation', { name: 'Loaded documents' });
  // The entry's accessible name is the label followed by the bill number; anchor on the label so
  // the "Remove <label>" button never matches.
  const escaped = values.doc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await sidebar
    .getByRole('button', { name: new RegExp(`^${escaped}`) })
    .click();
  await pause(1500);

  await page.getByRole('button', { name: values.chip, exact: true }).click();
  const answer = page.getByRole('region', { name: 'Answer', exact: true });
  // Bring the answer up while it streams; it renders below the chips, past the fold.
  await answer.waitFor();
  await answer.scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 360);
  // The answer streams; it is complete once its first citation button renders.
  await answer
    .getByRole('button', { name: 'Source 1', exact: true })
    .first()
    .waitFor({ timeout: 180_000 });
  await pause(3500);

  await answer
    .getByRole('button', { name: 'Source 1', exact: true })
    .first()
    .click();
  const drawer = page.getByRole('dialog', { name: 'Source text' });
  await drawer.waitFor();
  await pause(5000);
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await pause(1000);
  await context.close(); // flushes the video file
} finally {
  await browser.close();
}

const [video] = (await readdir(videoDir)).filter((f) => f.endsWith('.webm'));
if (!video) throw new Error('Playwright did not write a video.');
const out = resolve(values.out);
// Two-pass palette keeps text crisp at a small file size.
await run('ffmpeg', [
  '-y',
  '-i',
  join(videoDir, video),
  '-vf',
  `fps=10,scale=${values.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
  '-loop',
  '0',
  out,
]);
await rm(videoDir, { recursive: true, force: true });
console.log(`Wrote ${out}`);
