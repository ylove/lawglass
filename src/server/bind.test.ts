import { describe, expect, test } from 'vitest';
import { isLoopbackHost, validateBindHost } from './bind.js';

describe('bind host', () => {
  test('defaults to IPv4 and pins localhost to it', () => {
    expect(validateBindHost()).toBe('127.0.0.1');
    expect(validateBindHost('LOCALHOST')).toBe('127.0.0.1');
  });
  test.each(['127.0.0.2', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1'])(
    'accepts loopback %s without opting in',
    (host) => {
      expect(validateBindHost(host)).toBe(host);
    },
  );
  test.each([
    '0.0.0.0',
    '::',
    '192.168.1.1',
    '10.0.0.1',
    '8.8.8.8',
    '::ffff:10.0.0.1',
  ])('requires explicit public mode for %s', (host) => {
    expect(() => validateBindHost(host)).toThrow(/Non-loopback/);
    expect(validateBindHost(host, true)).toBe(host);
  });
  test.each([
    '',
    'evil.example',
    'localhost.evil',
    '127.1',
    '[::1]',
    '::1%lo0',
    'http://127.0.0.1',
    '127.0.0.1:4317',
  ])('rejects invalid host %s even in public mode', (host) => {
    for (const publicMode of [false, true])
      expect(() => validateBindHost(host, publicMode)).toThrow(/Invalid bind/);
  });
});

describe('Host header', () => {
  test.each([
    'localhost',
    'LOCALHOST:4317',
    '127.0.0.2',
    '127.255.255.255:80',
    '[::1]',
    '[0:0:0:0:0:0:0:1]:4317',
    '[::ffff:127.0.0.1]:80',
    '[::ffff:7f00:2]',
  ])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });
  test.each([
    '',
    'evil.example',
    'localhost.evil',
    'localhost@evil.example',
    '127.0.0.1.evil',
    '127.1',
    '::1',
    '[::1%lo0]',
    '[localhost]',
    '[127.0.0.1]',
    '[::2]',
    '[::ffff:10.0.0.1]',
    '10.0.0.1',
    '127.0.0.1:abc',
    '[::1]:80/path',
  ])('rejects %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});
