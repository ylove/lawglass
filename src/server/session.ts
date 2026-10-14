import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getCookie, setCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { BRAND } from '../core/brand.js';

export const SESSION_COOKIE = `${BRAND.name}_session`;

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

export function localSession(token: string): MiddlewareHandler {
  return async (c, next) => {
    // Tokens must not reach asset referrers or shared caches, including on the exchange redirect.
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    const url = new URL(c.req.url);
    if (matchesSessionToken(url.searchParams.get('k') ?? undefined, token)) {
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
      });
      url.searchParams.delete('k');
      return c.redirect(url.toString(), 302);
    }
    if (!matchesSessionToken(getCookie(c, SESSION_COOKIE), token)) {
      if (c.req.path.startsWith('/api/'))
        return c.json(
          {
            error: {
              code: 'UNAUTHORIZED',
              message: 'Open the link printed in your terminal.',
            },
          },
          401,
        );
      return c.html(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Local session required</title><p>Open the link printed in your terminal.</p></html>',
      );
    }
    await next();
    // Static asset middleware sets its own caching header. Keep local responses private.
    c.header('Cache-Control', 'no-store');
  };
}
