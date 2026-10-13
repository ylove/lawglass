import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { afterAll } from 'vitest';
import './setup.fetch.js';

function assertLoopback(host: string): void {
  if (!/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(host)) {
    throw new Error(`Network access is blocked in unit tests (${host})`);
  }
}

function assertHttpDestination(args: unknown[]): void {
  const [input, options] = args;
  const url = typeof input === 'string' ? new URL(input) : input;
  // In the URL + options overload, explicit options override the URL host.
  const overrides = options && typeof options === 'object' ? options : input;
  if (overrides && typeof overrides === 'object') {
    if ('socketPath' in overrides && overrides.socketPath) return;
    if ('hostname' in overrides && typeof overrides.hostname === 'string') {
      assertLoopback(overrides.hostname);
      return;
    }
    if ('host' in overrides && typeof overrides.host === 'string') {
      assertLoopback(overrides.host);
      return;
    }
  }
  assertLoopback(url instanceof URL ? url.hostname : 'localhost');
}

function assertSocketDestination(args: unknown[]): void {
  const [input, host] = args;
  if (typeof input === 'object' && input !== null) {
    if ('path' in input && input.path) return; // Local Unix socket.
    assertLoopback(
      'host' in input && typeof input.host === 'string'
        ? input.host
        : 'localhost',
    );
  } else if (typeof input === 'number') {
    assertLoopback(typeof host === 'string' ? host : 'localhost');
  }
  // A string in the first position is a local Unix socket path.
}

const httpRequest = http.request;
const httpGet = http.get;
const httpsRequest = https.request;
const httpsGet = https.get;
const netConnect = net.connect;
const netCreateConnection = net.createConnection;

// Direct wrappers survive vi.restoreAllMocks(). The tuple assertions only help
// Reflect.apply type overloaded builtins; every original argument is forwarded.
http.request = (...args: unknown[]) => {
  assertHttpDestination(args);
  return Reflect.apply(
    httpRequest,
    http,
    args as Parameters<typeof httpRequest>,
  );
};
http.get = (...args: unknown[]) => {
  assertHttpDestination(args);
  return Reflect.apply(httpGet, http, args as Parameters<typeof httpGet>);
};
https.request = (...args: unknown[]) => {
  assertHttpDestination(args);
  return Reflect.apply(
    httpsRequest,
    https,
    args as Parameters<typeof httpsRequest>,
  );
};
https.get = (...args: unknown[]) => {
  assertHttpDestination(args);
  return Reflect.apply(httpsGet, https, args as Parameters<typeof httpsGet>);
};
net.connect = (...args: unknown[]) => {
  assertSocketDestination(args);
  return Reflect.apply(netConnect, net, args as Parameters<typeof netConnect>);
};
net.createConnection = (...args: unknown[]) => {
  assertSocketDestination(args);
  return Reflect.apply(
    netCreateConnection,
    net,
    args as Parameters<typeof netCreateConnection>,
  );
};

// CJS builtin mutations alone do not update ESM named imports. Synchronizing
// their live bindings makes import { request } as safe as import http.
syncBuiltinESMExports();

afterAll(() => {
  http.request = httpRequest;
  http.get = httpGet;
  https.request = httpsRequest;
  https.get = httpsGet;
  net.connect = netConnect;
  net.createConnection = netCreateConnection;
  syncBuiltinESMExports();
});
