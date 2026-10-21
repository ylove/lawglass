import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeSectionedText } from '../../tests/synth/index.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { createSessionTestApp } from '../../tests/support/session-app.js';
import { createApp, type AppOptions } from './app.js';
import {
  contentSecurityPolicy,
  PERMISSIONS_POLICY,
  TURNSTILE_ORIGIN,
} from './security-headers.js';

const LOCAL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

let env: PipelineEnv;
let root: string;
beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve('https://govinfo.gov/a.txt', makeSectionedText(), 'text/plain');
  root = await mkdtemp(join(tmpdir(), 'sec-web-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>x</title>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
});
afterEach(async () => {
  await env.cleanup();
  await rm(root, { recursive: true, force: true });
});

const modes = [
  { name: 'local', publicMode: false },
  { name: 'public', publicMode: true },
] as const;

function expectHardened(res: Response, publicMode: boolean): void {
  expect(res.headers.get('content-security-policy')).toBe(
    contentSecurityPolicy(publicMode),
  );
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  expect(res.headers.get('permissions-policy')).toBe(PERMISSIONS_POLICY);
  // Plain-http loopback: HSTS would pin the browser to https for localhost.
  expect(res.headers.get('strict-transport-security')).toBeNull();
}

describe.each(modes)('security headers ($name mode)', ({ publicMode }) => {
  const app = (options: AppOptions = {}): Hono =>
    createSessionTestApp(env.runtime, {
      publicMode,
      webRoot: root,
      ...options,
    });
  const post = (
    a: Hono,
    path: string,
    body: string,
    type = 'application/json',
  ) =>
    a.request(path, {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });

  test('HTML and static assets carry the full set', async () => {
    const a = app();
    for (const path of ['/', '/assets/app.js', '/some/client/route']) {
      const res = await a.request(path);
      expect(res.status).toBe(200);
      expectHardened(res, publicMode);
    }
  });

  test('JSON API responses are hardened and never cached', async () => {
    const res = await app().request('/api/docs');
    expect(res.status).toBe(200);
    expectHardened(res, publicMode);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('SSE responses are hardened and never cached, keeping their stream headers', async () => {
    const res = await post(
      app(),
      '/api/ingest',
      JSON.stringify({ url: 'https://govinfo.gov/a.txt' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expectHardened(res, publicMode);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await res.text();
  });

  test('error responses are hardened too', async () => {
    const a = app();
    const cases: [Response, number][] = [
      [await a.request('/api/nope'), 404],
      [await post(a, '/api/ingest', '{}', 'text/plain'), 415],
      [
        await post(
          a,
          '/api/ingest',
          JSON.stringify({ url: 'x'.repeat(20_000) }),
        ),
        413,
      ],
      [await post(a, '/api/ingest', '{}'), 400],
      [
        await a.request('/api/docs', {
          headers: { origin: 'https://evil.example' },
        }),
        403,
      ],
    ];
    for (const [res, status] of cases) {
      expect(res.status).toBe(status);
      expectHardened(res, publicMode);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('an unknown non-API path is hardened without forcing no-store', async () => {
    const res = await app({ webRoot: undefined }).request('/assets/missing.js');
    expect(res.status).toBe(404);
    expectHardened(res, publicMode);
  });
});

describe('CSP differences between modes', () => {
  test('local mode is exactly the strict policy', () => {
    expect(contentSecurityPolicy(false)).toBe(LOCAL_CSP);
  });

  test('public mode only adds Turnstile to script-src and frame-src', () => {
    const csp = contentSecurityPolicy(true);
    expect(csp).toContain(`script-src 'self' ${TURNSTILE_ORIGIN};`);
    expect(csp).toContain(`frame-src ${TURNSTILE_ORIGIN};`);
    expect(csp).not.toContain('unsafe-');
    expect(contentSecurityPolicy(false)).not.toContain(TURNSTILE_ORIGIN);
  });

  test('the local session page (no cookie) is covered and has no inline code', async () => {
    const res = await createApp(env.runtime, { sessionToken: 't' }).request(
      '/',
    );
    expect(res.headers.get('content-security-policy')).toBe(LOCAL_CSP);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).not.toMatch(/<script|<style|style=|onclick=/i);
  });

  test('permissions policy denies the sensitive features', () => {
    for (const feature of [
      'camera',
      'microphone',
      'geolocation',
      'payment',
      'usb',
    ])
      expect(PERMISSIONS_POLICY).toContain(`${feature}=()`);
  });
});

test('private mode sets HSTS and keeps the strict local CSP on gates, redirects and refusals', async () => {
  const accessKey = 'x'.repeat(32);
  const app = createApp(env.runtime, { privateMode: true, accessKey });
  for (const path of ['/', '/api/docs', `/?k=${accessKey}`]) {
    const response = await app.request(path);
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=31536000',
    );
    expect(response.headers.get('content-security-policy')).toBe(LOCAL_CSP);
  }
});
