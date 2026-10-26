/**
 * Smoke test for the hosted preview image (Dockerfile, deploy/cloud-run/).
 *
 * Builds the image and runs it the way Cloud Run does: private mode, a mounted snapshot
 * directory, a SIGTERM to stop. Then it checks the invite gate, the key exchange, the
 * hosted ingest-host rule, a real ingest (which exercises the ONNX models baked into the
 * image), and that the document is still there after a stop and a fresh start.
 *
 * Needs Docker and network access (it ingests a real federal bill), so it is not part of
 * `npm run check`. Usage: npx tsx scripts/container-smoke.ts [--image <tag>] [--skip-build]
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BRAND, envVar } from '../src/core/brand.js';
import { sessionCookieName } from '../src/server/session.js';

const PORT = 18_080;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const SAMPLE_BILL =
  'https://www.congress.gov/bill/119th-congress/senate-bill/202';
const OUT_OF_SCOPE_BILL = 'https://pub.njleg.gov/Bills/2024/S0500/1_I1.HTM';

/** The `name=value` pair of the session cookie in a Set-Cookie header, or undefined. */
export function sessionCookie(setCookie: string | null): string | undefined {
  if (!setCookie) return undefined;
  const pair = setCookie.split(';')[0]?.trim();
  return pair?.startsWith(`${sessionCookieName(8080)}=`) ? pair : undefined;
}

/** The JSON payloads of every `data:` line in a server-sent event stream. */
export function sseEvents(body: string): unknown[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice('data:'.length).trim()) as unknown);
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('The container did not start listening in time.');
}

function startContainer(
  image: string,
  name: string,
  accessKey: string,
  snapshots: string,
): void {
  docker(
    'run',
    '--detach',
    '--name',
    name,
    '--publish',
    `127.0.0.1:${String(PORT)}:8080`,
    '--env',
    `${envVar('ACCESS_KEY')}=${accessKey}`,
    '--env',
    `${envVar('LLM_PROVIDER')}=mock`,
    '--env',
    `${envVar('ALLOW_MOCK')}=1`,
    '--env',
    `${envVar('BACKEND')}=local`,
    '--env',
    'SNAPSHOT_INTERVAL_SECONDS=3',
    '--env',
    'SNAPSHOT_QUIET_SECONDS=1',
    '--volume',
    `${snapshots}:/snapshots`,
    image,
  );
}

/** The raw response body: an event stream, or a JSON error when the request is refused early. */
async function ingest(cookie: string, url: string): Promise<string> {
  const response = await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ url }),
  });
  return response.text();
}

async function listedDocs(cookie: string): Promise<unknown[]> {
  const response = await fetch(`${BASE}/api/docs`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { docs?: unknown[] } | unknown[];
  return Array.isArray(body) ? body : (body.docs ?? []);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { image: { type: 'string' }, 'skip-build': { type: 'boolean' } },
  });
  const image = values.image ?? `${BRAND.name}-smoke:local`;
  if (!values['skip-build']) docker('build', '--tag', image, '.');

  const accessKey = randomBytes(30).toString('base64url');
  const snapshots = mkdtempSync(join(tmpdir(), 'container-smoke-'));
  // The container runs as uid 1000, which may not own this directory on the host.
  chmodSync(snapshots, 0o777);
  const name = `container-smoke-${randomBytes(4).toString('hex')}`;
  try {
    startContainer(image, name, accessKey, snapshots);
    await waitForServer();

    const gate = await fetch(`${BASE}/`);
    assert.equal(gate.status, 200);
    assert.match(
      await gate.text(),
      /private preview/i,
      'the gate page is shown without a session',
    );
    assert.equal(
      (await fetch(`${BASE}/api/docs`)).status,
      401,
      'the API needs a session',
    );

    const exchange = await fetch(`${BASE}/?k=${accessKey}`, {
      redirect: 'manual',
    });
    assert.equal(exchange.status, 302);
    assert.equal(
      exchange.headers.get('location')?.includes('k='),
      false,
      'the key is dropped',
    );
    const cookie = sessionCookie(exchange.headers.get('set-cookie'));
    assert.ok(cookie, 'the key exchange sets the session cookie');
    assert.match(exchange.headers.get('set-cookie') ?? '', /Secure/);
    assert.equal(
      cookie.includes(accessKey),
      false,
      'the cookie never holds the key itself',
    );

    const refused = await ingest(cookie, OUT_OF_SCOPE_BILL);
    assert.match(refused, /roadmap/, 'other states get the roadmap message');

    const events = sseEvents(await ingest(cookie, SAMPLE_BILL));
    assert.ok(
      events.some((event) => (event as { type?: string }).type === 'done'),
      `the sample bill ingests: ${JSON.stringify(events.at(-1))}`,
    );
    assert.equal((await listedDocs(cookie)).length, 1);

    // Cloud Run stops an instance with SIGTERM and allows 10 seconds.
    docker('stop', '--time', '10', name);
    assert.ok(
      existsSync(join(snapshots, 'state.tar.gz')),
      'state is saved on shutdown',
    );
    docker('rm', name);

    startContainer(image, name, accessKey, snapshots);
    await waitForServer();
    assert.equal(
      (await listedDocs(cookie)).length,
      1,
      'the document survives a restart',
    );
    console.log('Container smoke test passed.');
  } finally {
    try {
      docker('rm', '--force', name);
    } catch {
      /* already gone */
    }
    rmSync(snapshots, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
