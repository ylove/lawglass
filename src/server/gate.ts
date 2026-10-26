import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import { BRAND } from '../core/brand.js';
import { staticAssets } from './static.js';

const DESCRIPTION = BRAND.description;

const ASSETS = new Set([
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/og-image.png',
  '/robots.txt',
  '/gate.css',
]);

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ] ?? char,
  );
}

/** Deployment metadata must never come from the request's untrusted Host header. */
export function publicOrigin(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (/^https?:$/.test(url.protocol)) return url.origin;
  } catch {
    /* Omit optional metadata for an invalid deployment setting. */
  }
  return undefined;
}

export async function gatePage(
  configuredOrigin?: string,
  webRoot?: string,
): Promise<string> {
  const title = escapeHtml(BRAND.displayName);
  const origin = publicOrigin(configuredOrigin);
  // Branding assets can arrive separately; omit missing images rather than show broken ones.
  const available = new Set(
    await Promise.all(
      [...ASSETS].map(async (path) => {
        const exists =
          webRoot &&
          (await stat(join(webRoot, path)).then(
            (file) => file.isFile(),
            () => false,
          ));
        return exists ? path : undefined;
      }),
    ),
  );
  const image = origin && available.has('/og-image.png');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${escapeHtml(DESCRIPTION)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
${image ? `<meta property="og:image" content="${escapeHtml(origin + '/og-image.png')}">` : ''}
${origin ? `<meta property="og:url" content="${escapeHtml(origin + '/')}">` : ''}
${available.has('/favicon.svg') ? '<link rel="icon" href="/favicon.svg" type="image/svg+xml">' : ''}
${available.has('/apple-touch-icon.png') ? '<link rel="apple-touch-icon" href="/apple-touch-icon.png">' : ''}
${available.has('/gate.css') ? '<link rel="stylesheet" href="/gate.css">' : ''}</head>
<body><main>${available.has('/favicon.svg') ? '<img src="/favicon.svg" alt="" width="64" height="64">' : ''}
<h1>${title}</h1><p>${escapeHtml(DESCRIPTION)}</p>
<p>This is a private preview. If you were sent an invite link, open it to continue.</p>
<a href="${escapeHtml(BRAND.repositoryUrl)}">View on GitHub</a></main></body></html>`;
}

/** Only these exact files can bypass authentication; never fall back to the SPA. */
export function gateAssets(webRoot?: string): MiddlewareHandler {
  const assets = webRoot ? staticAssets(webRoot) : undefined;
  return async (c, next) => {
    if (!ASSETS.has(c.req.path)) return next();
    if (!assets) return c.notFound();
    const response = await assets(c, () => Promise.resolve());
    return response ?? c.notFound();
  };
}
