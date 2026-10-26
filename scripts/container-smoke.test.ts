import { describe, expect, test } from 'vitest';
import { sessionCookieName } from '../src/server/session.js';
import { sessionCookie, sseEvents } from './container-smoke.js';

describe('sessionCookie', () => {
  test('returns the name=value pair of the session cookie', () => {
    expect(
      sessionCookie(
        `${sessionCookieName(8080)}=abc123; Path=/; HttpOnly; Secure; SameSite=Strict`,
      ),
    ).toBe(`${sessionCookieName(8080)}=abc123`);
  });

  test('ignores other cookies and a missing header', () => {
    expect(sessionCookie('other=1; Path=/')).toBeUndefined();
    expect(sessionCookie(null)).toBeUndefined();
  });
});

describe('sseEvents', () => {
  test('parses every data line and skips comments and blank lines', () => {
    const body =
      ': heartbeat\n\ndata: {"type":"progress"}\n\ndata: {"type":"done"}\n\n';
    expect(sseEvents(body)).toEqual([{ type: 'progress' }, { type: 'done' }]);
  });

  test('returns nothing for a stream with no events', () => {
    expect(sseEvents(': heartbeat\n\n')).toEqual([]);
  });
});
