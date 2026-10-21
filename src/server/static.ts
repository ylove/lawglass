import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';

const TYPES: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function readIfFile(path: string): Promise<Buffer | undefined> {
  try {
    if (!(await stat(path)).isFile()) return undefined;
    return await readFile(path);
  } catch {
    return undefined;
  }
}

/**
 * Serves the built web UI on the same origin as /api. Unknown non-API GET paths fall back to
 * index.html so a reload on a client-side route still works. Not a general file server: it
 * refuses anything that resolves outside the root.
 */
export function staticAssets(webRoot: string): MiddlewareHandler {
  const root = resolve(webRoot);
  return async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    if (
      (method !== 'GET' && method !== 'HEAD') ||
      path === '/api' ||
      path.startsWith('/api/')
    )
      return next();

    const relative = normalize(path === '/' ? '/index.html' : path);
    const target = resolve(join(root, relative));
    const inside = target === root || target.startsWith(root + sep);
    let file = inside ? await readIfFile(target) : undefined;
    let ext = extname(target);
    // Only extension-less paths are client routes; a missing asset must stay a 404.
    if (!file && ext === '') {
      file = await readIfFile(join(root, 'index.html'));
      ext = '.html';
    }
    if (!file) return next();
    return c.body(new Uint8Array(file), 200, {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
  };
}
