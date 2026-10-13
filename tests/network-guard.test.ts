import http, { get as httpGet, request as httpRequest } from 'node:http';
import https, { get as httpsGet, request as httpsRequest } from 'node:https';
import net, { connect, createConnection } from 'node:net';
import { expect, test, vi } from 'vitest';

test('native fetch refuses accidental outbound HTTP', async () => {
  await expect(fetch('https://example.com')).rejects.toMatchObject({
    cause: { code: 'UND_MOCK_ERR_MOCK_NOT_MATCHED' },
  });
});

test('builtin guards survive restoring test mocks', () => {
  vi.restoreAllMocks();
  for (const request of [http.get, httpGet]) {
    expect(() => request('http://example.com')).toThrow(
      'Network access is blocked in unit tests (example.com)',
    );
  }
});

test.each([
  ['http.get default', () => http.get('http://example.com')],
  ['http.get named', () => httpGet('http://example.com')],
  ['http.request default', () => http.request(new URL('http://example.com'))],
  ['http.request named', () => httpRequest({ hostname: 'example.com' })],
  ['https.get default', () => https.get('https://example.com')],
  ['https.get named', () => httpsGet('https://example.com')],
  ['https.request default', () => https.request({ host: 'example.com' })],
  ['https.request named', () => httpsRequest(new URL('https://example.com'))],
  ['net.connect default', () => net.connect(80, 'example.com')],
  ['net.connect named', () => connect({ port: 80, host: 'example.com' })],
  [
    'net.createConnection default',
    () => net.createConnection({ port: 80, host: 'example.com' }),
  ],
  ['net.createConnection named', () => createConnection(80, 'example.com')],
  [
    'HTTP URL options override',
    () => http.get('http://localhost', { hostname: 'example.com' }),
  ],
  [
    'HTTPS URL options override',
    () => https.get('https://localhost', { host: 'example.com' }),
  ],
])('%s blocks outbound access before connecting', (_name, request) => {
  expect(request).toThrow(
    'Network access is blocked in unit tests (example.com)',
  );
});

test('fetch, HTTP and TCP can reach a loopback server on an ephemeral port', async () => {
  const server = http.createServer((_request, response) =>
    response.end('local test server'),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected a TCP server address');
    const url = `http://127.0.0.1:${String(address.port)}`;

    expect(await (await fetch(url)).text()).toBe('local test server');

    for (const request of [http.get, httpGet, http.request, httpRequest]) {
      await new Promise<void>((resolve, reject) => {
        const client = request(url, (response) => {
          expect(response.statusCode).toBe(200);
          response.resume();
          response.once('end', resolve);
          response.once('error', reject);
        });
        client.once('error', reject);
        client.end();
      });
    }

    for (const connectSocket of [
      net.connect,
      connect,
      net.createConnection,
      createConnection,
    ]) {
      await new Promise<void>((resolve, reject) => {
        const socket = connectSocket({ port: address.port, host: '127.0.0.1' });
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
      });
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
