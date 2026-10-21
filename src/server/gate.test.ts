import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { BRAND } from '../core/brand.js';
import { gateAssets, gatePage } from './gate.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gate-assets-'));
  for (const file of [
    'favicon.svg',
    'apple-touch-icon.png',
    'og-image.png',
    'robots.txt',
    'gate.css',
  ])
    await writeFile(join(root, file), file);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('gate is branded, static and has social metadata without inventing an origin', async () => {
  const html = await gatePage(undefined, root);
  expect(html).toContain(`<h1>${BRAND.displayName}</h1>`);
  expect(html).toContain(BRAND.repositoryUrl);
  expect(html).toContain('This is a private preview.');
  expect(html).toContain('content="noindex"');
  expect(html).toContain('property="og:title"');
  expect(html).toContain('property="og:description"');
  expect(html).toContain('name="twitter:card" content="summary"');
  expect(html).toContain('<link rel="stylesheet" href="/gate.css">');
  expect(html).toContain('<img src="/favicon.svg" alt=""');
  expect(html).not.toMatch(
    /<script|<style|style=|id="root"|property="og:(image|url)"/,
  );
});

test('uses only a configured http(s) origin and escapes HTML', async () => {
  const html = await gatePage(
    'https://preview.example/some/path?k=secret',
    root,
  );
  expect(html).toContain('name="twitter:card" content="summary_large_image"');
  expect(html).toContain(
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  );
  expect(html).toContain(
    'property="og:image" content="https://preview.example/og-image.png"',
  );
  expect(html).toContain(
    'property="og:url" content="https://preview.example/"',
  );
  expect(html).not.toContain('secret');
  for (const origin of ['invalid', 'javascript:alert(1)', 'file:///private'])
    expect(await gatePage(origin, root)).not.toContain('property="og:url"');
  // Identity fields are constants at runtime; this checks the escaping boundary itself.
  const original = BRAND.displayName;
  Object.assign(BRAND, { displayName: '<>&"\'' });
  try {
    expect(await gatePage()).toContain('&lt;&gt;&amp;&quot;&#39;');
  } finally {
    Object.assign(BRAND, { displayName: original });
  }
});

test('missing branding assets leave a readable gate and text-only social metadata', async () => {
  for (const file of ['favicon.svg', 'apple-touch-icon.png', 'og-image.png'])
    await rm(join(root, file));
  // A directory at an asset path must also count as absent.
  await mkdir(join(root, 'favicon.svg'));
  const html = await gatePage('https://preview.example', root);
  expect(html).toContain(`<h1>${BRAND.displayName}</h1>`);
  expect(html).toContain('This is a private preview.');
  expect(html).toContain('<link rel="stylesheet" href="/gate.css">');
  expect(html).toContain('name="twitter:card" content="summary"');
  expect(html).not.toMatch(/<img|rel="icon"|apple-touch-icon|og:image/);
  expect(await gatePage()).not.toMatch(/<img|<link|og:image/);
});

test('allowlisted assets return 404 without a configured web root', async () => {
  const app = new Hono();
  app.use('*', gateAssets());
  expect((await app.request('/favicon.svg')).status).toBe(404);
});

test('serves only existing allowlisted assets and never the SPA', async () => {
  try {
    await mkdir(join(root, 'assets'));
    for (const file of [
      'favicon.svg',
      'apple-touch-icon.png',
      'og-image.png',
      'robots.txt',
      'gate.css',
      'index.html',
      'assets/app.js',
    ])
      await writeFile(join(root, file), file);
    const app = new Hono();
    app.use('*', gateAssets(root));
    for (const file of [
      'favicon.svg',
      'apple-touch-icon.png',
      'og-image.png',
      'robots.txt',
      'gate.css',
    ]) {
      const response = await app.request(`/${file}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(file);
    }
    for (const file of [
      '',
      'index.html',
      'assets/app.js',
      'unknown',
      'gate.css/extra',
      '..%2fpackage.json',
      'gate.css/../index.html',
      'gate.css%2f..%2findex.html',
      'favicon.svg/extra',
      'favicon.svg.bak',
    ])
      expect((await app.request(`/${file}`)).status).toBe(404);
    await rm(join(root, 'favicon.svg'));
    expect((await app.request('/favicon.svg')).status).toBe(404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
