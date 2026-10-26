import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { providerFailure } from '../core/llm/shared.js';
import { AppError } from '../core/model/index.js';
import { createLogger } from './log.js';

test('logs route templates and safe fields, never request or error contents', async () => {
  const lines: string[] = [];
  const log = createLogger(
    (line) => {
      lines.push(line);
    },
    () => 100,
  );
  const app = new Hono();
  app.use('*', log.middleware);
  app.onError((_error, c) =>
    c.json({ error: { code: 'INTERNAL', message: 'Safe' } }, 500),
  );
  const secret = 'c'.repeat(40);
  app.get('/api/docs/:docId', () => {
    const error = new Error(secret);
    error.name = secret;
    throw error;
  });
  app.get('/app-error', () => {
    throw new AppError('INVALID_INPUT', secret);
  });
  app.get('/refusal', (c) =>
    c.json({ error: { code: 'UNAUTHORIZED', message: secret } }, 401),
  );
  app.get('/unusual', (c) =>
    c.json({ error: { code: 'bad-code', message: secret } }, 415),
  );
  app.get('/empty', (c) => c.body(null, 413));
  app.get('/no-code', (c) => c.json({ error: 'wrong' }, 403));
  app.get('/no-error', (c) => c.json({}, 429));
  app.get('/type', () => {
    throw new TypeError(secret);
  });
  app.get('/range', () => {
    throw new RangeError(secret);
  });
  app.get('/ok', (c) => c.text('ok'));
  for (const path of [
    `/api/docs/${secret}?k=${secret}`,
    '/app-error',
    '/refusal',
    '/unusual',
    '/empty',
    '/no-code',
    '/no-error',
    '/type',
    '/range',
    '/ok',
  ])
    await app.request(path, {
      headers: { cookie: secret, authorization: secret },
    });
  expect(lines.join('')).not.toContain(secret);
  expect(lines).toHaveLength(9);
  expect(JSON.parse(lines[0]!)).toEqual({
    t: new Date(100).toISOString(),
    level: 'error',
    event: 'internal_error',
    route: '/api/docs/:docId',
    method: 'GET',
    status: 500,
    code: 'INTERNAL',
    errorName: 'Error',
    ms: 0,
  });
  expect(lines[1]).toContain('INVALID_INPUT');
  expect(lines[2]).toContain('UNAUTHORIZED');
  expect(lines[7]).toContain('TypeError');
  expect(lines[8]).toContain('RangeError');
});

test('a skipped reference logs a citation and a code, and nothing else', () => {
  const lines: string[] = [];
  const log = createLogger(
    (line) => {
      lines.push(line);
    },
    () => 100,
  );
  log.referenceSkipped('12 U.S.C. 1813', 'FETCH_FAILED');
  log.referenceSkipped(
    'https://evil.example/?k=secret',
    'bad code with spaces',
  );
  const [first, second] = lines.map(
    (l) => JSON.parse(l) as Record<string, string>,
  );
  expect(first).toMatchObject({
    event: 'reference_skipped',
    citation: '12 U.S.C. 1813',
    code: 'FETCH_FAILED',
  });
  expect(second).toMatchObject({ citation: 'unknown', code: 'ERROR' });
  expect(lines.join('')).not.toContain('secret');
});

test('background answer events log a count or a code, never text', () => {
  const lines: string[] = [];
  const log = createLogger(
    (line) => {
      lines.push(line);
    },
    () => 0,
  );
  log.backgroundAnswerEvent({ event: 'excerpt_talk_reworded', count: 2 });
  log.backgroundAnswerEvent({
    event: 'regeneration_refused',
    reason: 'TIMEOUT',
  });
  const [reworded, refused] = lines.map(
    (l) => JSON.parse(l) as Record<string, unknown>,
  );
  expect(reworded).toMatchObject({ event: 'excerpt_talk_reworded', count: 2 });
  expect(refused).toMatchObject({
    event: 'regeneration_refused',
    code: 'TIMEOUT',
  });
});

test('a provider failure logs its HTTP status and nothing else from the cause (#341)', async () => {
  const lines: string[] = [];
  const log = createLogger(
    (line) => {
      lines.push(line);
    },
    () => 0,
  );
  const app = new Hono();
  app.use('*', log.middleware);
  app.onError((_error, c) =>
    c.json({ error: { code: 'PROVIDER_ERROR', message: 'Safe' } }, 502),
  );
  app.get('/api/docs/:docId/breakdown', () => {
    throw providerFailure(
      Object.assign(new Error('secret schema error'), { status: 400 }),
    );
  });
  await app.request('/api/docs/d/breakdown');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    event: 'refusal',
    code: 'PROVIDER_ERROR',
    providerStatus: 400,
  });
  expect(lines[0]).not.toContain('secret');
});
