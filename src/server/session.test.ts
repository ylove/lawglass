import { timingSafeEqual, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createSessionToken,
  localSession,
  matchesSessionToken,
  SESSION_COOKIE,
} from './session.js';

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return {
    ...original,
    timingSafeEqual: vi.fn(original.timingSafeEqual),
    randomBytes: vi.fn(original.randomBytes),
  };
});
beforeEach(() => {
  vi.clearAllMocks();
});

const token = 'a'.repeat(43);
const app = () => {
  const a = new Hono();
  a.use('*', localSession(token));
  a.get('/api/health', (c) => c.json({ ok: true }));
  a.get('*', (c) =>
    c.html('<title>Application</title>', 200, {
      'cache-control': 'public, max-age=3600',
    }),
  );
  return a;
};

describe('session token', () => {
  test('uses 32 random bytes, encoded as base64url, afresh on each call', () => {
    const first = createSessionToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first, 'base64url')).toHaveLength(32);
    expect(createSessionToken()).not.toBe(first);
    expect(randomBytes).toHaveBeenCalledWith(32);
  });
  test('uses timingSafeEqual for both matching and wrong tokens of the same byte length', () => {
    expect(matchesSessionToken(token, token)).toBe(true);
    expect(matchesSessionToken('b'.repeat(43), token)).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    expect(timingSafeEqual).toHaveBeenCalledWith(
      Buffer.from(token),
      Buffer.from(token),
    );
  });
  test.each([undefined, '', 'short', 'a'.repeat(44), 'é'.repeat(43)])(
    'rejects other byte lengths safely: %s',
    (value) => {
      expect(matchesSessionToken(value, token)).toBe(false);
      expect(timingSafeEqual).not.toHaveBeenCalled();
    },
  );
});

describe('local session gate', () => {
  test('exchanges the token for a strict HttpOnly cookie and strips every k parameter', async () => {
    const a = app();
    const response = await a.request(
      `http://127.0.0.1/document?x=1&k=${token}&k=wrong`,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'http://127.0.0.1/document?x=1',
    );
    expect(response.headers.get('set-cookie')).toBe(
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain(token);
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    const health = await a.request('/api/health', { headers: { cookie } });
    expect(health.status).toBe(200);
    const asset = await a.request('/assets/app.js', { headers: { cookie } });
    expect(await asset.text()).toContain('Application');
    expect(asset.headers.get('cache-control')).toBe('no-store');
  });
  test.each([
    undefined,
    `${SESSION_COOKIE}=wrong`,
    `${SESSION_COOKIE}=${'b'.repeat(43)}`,
    `${SESSION_COOKIE}=%`,
    'unrelated=valid',
  ])('missing or wrong cookie gets 401 JSON: %s', async (cookie) => {
    const response = await app().request('/api/health', {
      headers: cookie ? { cookie } : {},
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Open the link printed in your terminal.',
      },
    });
  });
  test.each(['/', '/assets/app.js', '/document?x=1', '/?k=wrong'])(
    'untrusted pages and assets show a static launch instruction: %s',
    async (path) => {
      const response = await app().request(path);
      expect(response.headers.get('set-cookie')).toBeNull();
      const html = await response.text();
      expect(html).toContain('Open the link printed in your terminal.');
      expect(html).not.toContain(token);
      expect(html).not.toContain('<script');
    },
  );
  test('a wrong query token cannot create a session or override a valid cookie', async () => {
    const a = app();
    const response = await a.request('/api/health?k=wrong');
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(
      (
        await a.request('/api/health?k=wrong', {
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        })
      ).status,
    ).toBe(200);
  });
  test('a cookie from another launch is refused', async () => {
    const a = new Hono();
    a.use('*', localSession('b'.repeat(43)));
    a.get('/api/health', (c) => c.json({ ok: true }));
    expect(
      (
        await a.request('/api/health', {
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        })
      ).status,
    ).toBe(401);
  });
});

describe('private session', () => {
  const privateApp = () => {
    const a = new Hono();
    a.use('*', localSession(token, { privateMode: true }));
    a.get('/api/health', (c) => c.json({ ok: true }));
    a.get('*', (c) => c.html('<title>Application</title>'));
    return a;
  };
  test('derives a stable HMAC cookie, keeps HTTPS through relative redirects, rotates with the key', async () => {
    const { privateCookieValue } = await import('./session.js');
    const { createHmac } = await import('node:crypto');
    const { BRAND } = await import('../core/brand.js');
    const expected = createHmac('sha256', token)
      .update(`${BRAND.name}-session-v1`)
      .digest('base64url');
    expect(privateCookieValue(token)).toBe(expected);
    expect(privateCookieValue('other')).not.toBe(expected);
    const a = privateApp();
    const response = await a.request(
      `http://preview.example/doc?x=1&k=${token}&q=a%26b`,
    );
    expect(response.headers.get('location')).toBe('/doc?x=1&q=a%26b');
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain(`${SESSION_COOKIE}=${expected}`);
    for (const attribute of [
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      'Secure',
      'Max-Age=2592000',
    ])
      expect(cookie).toContain(attribute);
    expect(cookie).not.toContain(token);
    expect(
      (await a.request('/api/health', { headers: { cookie } })).status,
    ).toBe(200);
    expect(
      (
        await a.request('/api/health', {
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        })
      ).status,
    ).toBe(401);
    const slashes = await a.request(
      `http://preview.example//evil.example/?k=${token}`,
    );
    expect(slashes.headers.get('location')).toBe('/evil.example/');
  });
  test('unauthenticated APIs get the invite message; pages get the branded gate', async () => {
    const a = privateApp();
    const denied = await a.request('/api/health?k=wrong');
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'This is a private preview. Open your invite link.',
      },
    });
    const page = await a.request('/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('This is a private preview.');
    expect((await a.request('/', { method: 'POST' })).status).toBe(401);
  });
  test('requires a key of at least 32 characters without echoing its value', async () => {
    const { readAccessKey } = await import('./session.js');
    const { envVar } = await import('../core/brand.js');
    for (const key of [undefined, '', 'too-short-secret']) {
      expect(() => readAccessKey({ [envVar('ACCESS_KEY')]: key })).toThrow(
        expect.objectContaining({
          code: 'INVALID_INPUT',
          userMessage: expect.stringContaining(
            'at least 32 characters',
          ) as string,
        }),
      );
    }
    expect(readAccessKey({ [envVar('ACCESS_KEY')]: 'x'.repeat(32) })).toBe(
      'x'.repeat(32),
    );
  });
});
