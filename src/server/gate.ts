import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context, MiddlewareHandler } from 'hono';
import { staticAssets } from './static.js';
import { PUBLIC_ASSETS } from './site/assets.js';
import { landingPage } from './site/landing.js';
import { quickstartPage } from './site/quickstart.js';
import type { PageContext } from './site/layout.js';

export interface SiteOptions {
  /** Replaces the shared-key gate page. External auth hosts serve their own landing pages. */
  landing?: (ctx: Context) => string | Promise<string>;
  /** Public in every mode, before authentication. Must contain no reader data. */
  quickstart?: (ctx: Context) => string | Promise<string>;
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

async function pageContext(
  configuredOrigin?: string,
  webRoot?: string,
): Promise<PageContext> {
  // Assets can arrive separately (screenshots are regenerated per release); omit missing
  // images and the stylesheet link rather than show broken ones.
  const found = await Promise.all(
    [...PUBLIC_ASSETS].map(async (path) => {
      const exists =
        webRoot &&
        (await stat(join(webRoot, path)).then(
          (file) => file.isFile(),
          () => false,
        ));
      return exists ? path : undefined;
    }),
  );
  return {
    origin: publicOrigin(configuredOrigin),
    available: new Set(found.filter((path) => path !== undefined)),
  };
}

/** The public marketing page that signed-out visitors see in place of the app. */
export async function gatePage(
  configuredOrigin?: string,
  webRoot?: string,
): Promise<string> {
  return landingPage(await pageContext(configuredOrigin, webRoot));
}

/** The run-it-yourself guide; public for everyone, signed in or not. */
export async function quickstartHtml(
  configuredOrigin?: string,
  webRoot?: string,
): Promise<string> {
  return quickstartPage(await pageContext(configuredOrigin, webRoot));
}

/** Only these exact files can bypass authentication; never fall back to the SPA. */
export function gateAssets(webRoot?: string): MiddlewareHandler {
  const assets = webRoot ? staticAssets(webRoot) : undefined;
  return async (c, next) => {
    if (!PUBLIC_ASSETS.has(c.req.path)) return next();
    if (!assets) return c.notFound();
    const response = await assets(c, () => Promise.resolve());
    return response ?? c.notFound();
  };
}
