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
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
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

/** Deliberately narrow: no inline code, extra attributes, URL entities or remote URLs. */
export function validateHead(tags: readonly string[] = []): void {
  const path = String.raw`\/(?!\/)[A-Za-z0-9_./?=#~-]+`;
  const script = new RegExp(`^<script type="module" src="${path}"></script>$`);
  const link = new RegExp(
    `^<link rel="(?:stylesheet|preload|modulepreload)" href="${path}"\\s*/?>$`,
  );
  if (
    !Array.isArray(tags) ||
    tags.some(
      (tag) =>
        typeof tag !== 'string' || (!script.test(tag) && !link.test(tag)),
    )
  )
    throw new Error(
      'Invalid head tag: use a same-origin module script or stylesheet/preload/modulepreload link.',
    );
}

/**
 * Serves the built web UI on the same origin as /api. Unknown non-API GET paths fall back to
 * index.html so a reload on a client-side route still works. Not a general file server: it
 * refuses anything that resolves outside the root.
 */
export function staticAssets(
  webRoot: string,
  head: readonly string[] = [],
): MiddlewareHandler {
  validateHead(head);
  const tags = [...head];
  const root = resolve(webRoot);
  // Share one transformed index across /, /index.html and every SPA fallback.
  let index: Promise<Buffer | undefined> | undefined;
  const readIndex = (): Promise<Buffer | undefined> => {
    if (tags.length === 0) return readIfFile(join(root, 'index.html'));
    index ??= readIfFile(join(root, 'index.html')).then((file) => {
      if (!file) return file;
      const html = file.toString('utf8');
      if (!html.includes('</head>'))
        throw new Error('SPA index.html has no closing head tag.');
      return Buffer.from(
        html.replace('</head>', `${tags.join('\n')}\n</head>`),
      );
    });
    return index;
  };
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
    let file = inside
      ? await (target === join(root, 'index.html')
          ? readIndex()
          : readIfFile(target))
      : undefined;
    let ext = extname(target);
    // Only extension-less paths are client routes; a missing asset must stay a 404.
    if (!file && ext === '') {
      file = await readIndex();
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
