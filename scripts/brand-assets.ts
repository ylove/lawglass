/**
 * Renders the brand PNGs (apple-touch-icon.png, og-image.png) into src/web/public/ with
 * Playwright's Chromium. Run `npm run brand:assets` after changing the mark or the copy, and
 * commit the PNGs. No network: the font is loaded from node_modules over file://.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { BRAND } from '../src/core/brand.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'src/web/public');
const fontDir = join(root, 'node_modules/@fontsource/instrument-sans/files');

export const OG_COPY = {
  tagline: 'Understand any bill, line by line.',
  detail: 'Plain-language answers with citations to section, page and line.',
  footer: 'U.S. federal and Ohio legislation',
} as const;

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function fontFaceCss(weights: readonly number[], dir: string): string {
  return weights
    .map((w) => {
      const url = pathToFileURL(
        join(dir, `instrument-sans-latin-${String(w)}-normal.woff2`),
      ).href;
      return `@font-face{font-family:'Instrument Sans';font-weight:${String(w)};src:url('${url}') format('woff2');}`;
    })
    .join('\n');
}

export function ogHtml(markSvg: string, fontCss: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontCss}
*{box-sizing:border-box}
body{margin:0;width:1200px;height:630px;background:#0f3b6e;color:#fff;font-family:'Instrument Sans',sans-serif;
  display:flex;align-items:center;padding:0 90px;gap:70px;position:relative}
.mark{width:240px;height:240px;flex:none}
.mark svg{width:100%;height:100%}
.name{font-size:120px;font-weight:600;letter-spacing:-0.02em;line-height:1}
.tag{font-size:46px;font-weight:500;margin-top:26px;letter-spacing:-0.01em}
.detail{font-size:26px;font-weight:400;margin-top:18px;color:#c9d8ec;max-width:760px;line-height:1.35}
.foot{position:absolute;left:90px;bottom:50px;font-size:24px;color:#a9c1e0;font-weight:500}
</style></head><body>
<div class="mark">${markSvg}</div>
<div><div class="name">${escapeHtml(BRAND.displayName)}</div>
<div class="tag">${escapeHtml(OG_COPY.tagline)}</div>
<div class="detail">${escapeHtml(OG_COPY.detail)}</div></div>
<div class="foot">${escapeHtml(OG_COPY.footer)}</div>
</body></html>`;
}

export function iconHtml(markSvg: string): string {
  // The tile fills the whole canvas; iOS applies its own rounded mask to touch icons.
  return `<!doctype html><html><body style="margin:0;background:#0f3b6e;width:180px;height:180px">
<div style="width:180px;height:180px">${markSvg.replace('<svg ', '<svg width="180" height="180" ')}</div></body></html>`;
}

/** Chromium blocks file:// fonts on about:blank pages, so render from a real file:// page. */
async function render(
  browser: Browser,
  html: string,
  size: { width: number; height: number },
  out: string,
  tmp: string,
): Promise<void> {
  const file = join(tmp, 'page.html');
  writeFileSync(file, html);
  const page = await browser.newPage({ viewport: size });
  await page.goto(pathToFileURL(file).href);
  // Evaluated in the page as a string: this project's tsconfig has no DOM types.
  await page.evaluate('document.fonts.ready.then(() => true)');
  writeFileSync(join(publicDir, out), await page.screenshot());
  await page.close();
}

async function main(): Promise<void> {
  const markSvg = readFileSync(join(publicDir, 'favicon.svg'), 'utf8');
  const tmp = mkdtempSync(join(tmpdir(), 'brand-assets-'));
  const browser = await chromium.launch();
  try {
    const og = ogHtml(markSvg, fontFaceCss([400, 500, 600], fontDir));
    await render(
      browser,
      og,
      { width: 1200, height: 630 },
      'og-image.png',
      tmp,
    );
    await render(
      browser,
      iconHtml(markSvg),
      { width: 180, height: 180 },
      'apple-touch-icon.png',
      tmp,
    );
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
