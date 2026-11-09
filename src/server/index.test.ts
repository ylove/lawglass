import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

test('the source server entry exports the hosting API without printing, listening or connecting', async () => {
  // A fresh process catches module-load effects hidden by vitest's shared import cache. Network
  // and listen calls fail immediately, and the timeout also catches a server keeping Node alive.
  const source = new URL('./index.ts', import.meta.url).href;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import net from 'node:net';
      import http from 'node:http';
      import https from 'node:https';
      import { syncBuiltinESMExports } from 'node:module';
      const forbidden = () => { throw new Error('Import attempted network or server startup'); };
      net.Server.prototype.listen = forbidden;
      net.Socket.prototype.connect = forbidden;
      http.request = http.get = https.request = https.get = forbidden;
      globalThis.fetch = forbidden;
      syncBuiltinESMExports();
      const server = await import(${JSON.stringify(source)});
      for (const name of ['createApp', 'createRuntime', 'securityHeaders', 'contentSecurityPolicy', 'landingPage', 'quickstartHtml']) {
        assert.equal(typeof server[name], 'function', name);
      }
    `,
    ],
    { timeout: 40_000 },
  );
  expect(stdout).toBe('');
  expect(stderr).toBe('');
}, 45_000);
