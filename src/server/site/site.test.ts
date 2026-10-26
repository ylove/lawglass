import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BRAND } from '../../core/brand.js';
import { gatePage, quickstartHtml } from '../gate.js';
import { PUBLIC_ASSETS } from './assets.js';
import { HOSTED_CTA, LINKEDIN, NODEJS } from './layout.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'site-pages-'));
  for (const path of PUBLIC_ASSETS) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), path);
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const hosts = (html: string): string[] =>
  [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) =>
    (m[1] ?? '').replaceAll('&amp;', '&'),
  );

describe('landing page', () => {
  test('carries the headline, title and description', async () => {
    const html = await gatePage('https://preview.example', root);
    expect(html).toContain('<h1>Know what a bill really says.</h1>');
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain(
      `<title>${BRAND.displayName}: know what a bill really says</title>`,
    );
    expect(html).toContain(`name="description" content="${BRAND.description}"`);
    expect(html).toContain('content="noindex"');
    expect(html).toContain('id="how"');
    expect(html).toContain('id="hosted"');
  });

  test('links only to the approved external destinations, each opening safely', async () => {
    const html = await gatePage(undefined, root);
    expect(new Set(hosts(html))).toEqual(
      new Set([HOSTED_CTA, LINKEDIN, BRAND.repositoryUrl]),
    );
    for (const tag of html.match(/<a [^>]*href="https?:[^>]*>/g) ?? [])
      expect(tag).toContain('rel="noopener noreferrer"');
  });

  test('is script-free and style-attribute-free, so the private CSP holds', async () => {
    const html = await gatePage(undefined, root);
    expect(html).not.toMatch(/<script|<style|\sstyle=|\son[a-z]+=/i);
  });

  test('every image has alt text and a same-origin allowlisted source', async () => {
    const html = await gatePage(undefined, root);
    const images = html.match(/<img [^>]*>/g) ?? [];
    expect(images.length).toBeGreaterThanOrEqual(4);
    for (const tag of images) {
      expect(tag).toMatch(/alt="[^"]+"/);
      const src = /src="([^"]+)"/.exec(tag)?.[1] ?? '';
      expect(PUBLIC_ASSETS.has(src)).toBe(true);
    }
  });

  test('omits screenshots that are not deployed instead of showing broken images', async () => {
    const html = await gatePage(undefined, join(root, 'missing'));
    expect(html).not.toContain('<img');
    expect(html).toContain('<h1>Know what a bill really says.</h1>');
  });
});

describe('quickstart page', () => {
  test('lists the verified commands and the approved links', async () => {
    const html = await quickstartHtml(undefined, root);
    expect(html).toContain(
      `<h1>Run ${BRAND.displayName} on your computer</h1>`,
    );
    expect(html).toContain('<title>Run');
    for (const command of [
      `git clone ${BRAND.repositoryUrl}`,
      'npm ci',
      'npm run build',
      'node dist/cli.js init',
      'node dist/cli.js https://www.congress.gov/bill/119th-congress/senate-bill/1582',
      'node dist/cli.js mcp',
    ])
      expect(html).toContain(command);
    expect(html).toContain('content="noindex"');
    expect(new Set(hosts(html))).toEqual(
      new Set([NODEJS, LINKEDIN, BRAND.repositoryUrl, HOSTED_CTA]),
    );
    expect(html).not.toMatch(/<script|<style|\sstyle=/i);
  });
});
