import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getCookie, setCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { BRAND, envVar } from '../core/brand.js';
import { AppError } from '../core/model/index.js';
import { gatePage, gateAssets } from './gate.js';

/**
 * Cookies are scoped by host, not port, so two local servers on one machine would overwrite
 * each other's session (#228); the port in the name keeps them apart. A hosted private preview
 * runs one instance per host and keeps the original name, so invited readers who already opened
 * their link stay signed in across this change.
 */
export function sessionCookieName(port: number, privateMode = false): string {
  return privateMode
    ? `${BRAND.name}_session`
    : `${BRAND.name}_session_${String(port)}`;
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Reject other lengths before the constant-time comparison (which requires equal lengths). */
export function matchesSessionToken(
  value: string | undefined,
  token: string,
): boolean {
  if (value === undefined) return false;
  const candidate = Buffer.from(value);
  const expected = Buffer.from(token);
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

export function readAccessKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[envVar('ACCESS_KEY')];
  if (!key || key.length < 32) {
    const message = `Private mode requires ${envVar('ACCESS_KEY')} with at least 32 characters.`;
    throw new AppError('INVALID_INPUT', message, { userMessage: message });
  }
  return key;
}

export function privateCookieValue(accessKey: string): string {
  return createHmac('sha256', accessKey)
    .update(`${BRAND.name}-session-v1`)
    .digest('base64url');
}

export interface SessionOptions {
  /** A callback supplies the actual bound port when the server starts with port 0. */
  port: number | (() => number);
  privateMode?: boolean;
  webRoot?: string;
  publicOrigin?: string;
}

export function localSession(
  token: string,
  options: SessionOptions,
): MiddlewareHandler {
  const privateMode = options.privateMode ?? false;
  const cookieValue = privateMode ? privateCookieValue(token) : token;
  const assets = gateAssets(options.webRoot);
  return async (c, next) => {
    // Tokens must not reach asset referrers or shared caches, including on the exchange redirect.
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    const url = new URL(c.req.url);
    const port =
      typeof options.port === 'function' ? options.port() : options.port;
    const cookieName = sessionCookieName(port, privateMode);
    if (matchesSessionToken(url.searchParams.get('k') ?? undefined, token)) {
      setCookie(c, cookieName, cookieValue, {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
        ...(privateMode ? { secure: true, maxAge: 30 * 24 * 60 * 60 } : {}),
      });
      url.searchParams.delete('k');
      // A relative redirect preserves HTTPS at the TLS proxy. A double slash would be
      // a network-path redirect, so collapse leading slashes on private exchanges.
      return c.redirect(
        privateMode
          ? url.pathname.replace(/^\/+/, '/') + url.search
          : url.toString(),
        302,
      );
    }
    if (!matchesSessionToken(getCookie(c, cookieName), cookieValue)) {
      if (c.req.path.startsWith('/api/'))
        return c.json(
          {
            error: {
              code: 'UNAUTHORIZED',
              message: privateMode
                ? 'This is a private preview. Open your invite link.'
                : 'Open the link printed in your terminal.',
            },
          },
          401,
        );
      if (privateMode) {
        const asset = await assets(c, () => Promise.resolve());
        if (asset) return asset;
        if (c.req.method === 'GET' || c.req.method === 'HEAD')
          return c.html(await gatePage(options.publicOrigin, options.webRoot));
        return c.body(null, 401);
      }
      return c.html(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Local session required</title><p>Open the link printed in your terminal.</p></html>',
      );
    }
    await next();
    // Static asset middleware sets its own caching header. Keep local responses private.
    c.header('Cache-Control', 'no-store');
  };
}
