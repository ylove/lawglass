import { Hono } from 'hono';
import { expect, test } from 'vitest';
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
