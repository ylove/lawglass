import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { envVar } from '../src/core/brand.js';
import {
  makeBillStatusXml,
  makeCongressionalBillXml,
} from '../tests/synth/index.js';
import { test, expect } from './packed-app.fixture.js';

// Issue #380: clicking "Open in Lawglass" on a referenced bill must give the same document and
// summary as pasting that bill's address. The packed server runs unmodified and every one of its
// address, DNS and certificate checks still runs. Only its network egress is faked, by a preload
// that is passed to the spawned server (never part of the shipped package): GovInfo's two host
// names resolve to a public-looking address, and TLS connections to them are carried to a local
// HTTPS stub that serves the synthetic bytes below, under a certificate the server is told to trust.
const REFERRING = 'Bill that cites another';
const REFERRED = 'https://www.congress.gov/bill/118th-congress/house-bill/9001';
const GOVINFO_HOSTS = ['www.govinfo.gov', 'govinfo.gov'];
const run = promisify(execFile);

const PRELOAD = `
import dnsPromises from 'node:dns/promises';
import tls from 'node:tls';
const hosts = new Set(${JSON.stringify(GOVINFO_HOSTS)});
const lookup = dnsPromises.lookup.bind(dnsPromises);
dnsPromises.lookup = async (host, options) =>
  hosts.has(host)
    ? options?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 }
    : lookup(host, options);
const connect = tls.connect;
tls.connect = (...args) => {
  const options = args[0];
  if (options && typeof options === 'object' && hosts.has(options.host))
    args[0] = { ...options, host: '127.0.0.1', port: Number(process.env.OPEN_REF_STUB_PORT), lookup: undefined };
  return connect.apply(tls, args);
};
`;

let dir = '';
let stub: Server | undefined;
let stubPort = 0;
const requested: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ packedApp }) => {
  dir = await mkdtemp(join(tmpdir(), 'open-reference-e2e-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  await run('openssl', [
    ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2'],
    ...['-subj', '/CN=www.govinfo.gov', '-keyout', key, '-out', cert],
    ...[
      '-addext',
      `subjectAltName=${GOVINFO_HOSTS.map((h) => `DNS:${h}`).join(',')}`,
    ],
  ]);
  await writeFile(join(dir, 'preload.mjs'), PRELOAD);

  // The referenced bill, as GovInfo would serve it. The trailing comment keeps its bytes (and
  // so its document id) apart from the bill that cites it.
  const referred = Buffer.concat([
    makeCongressionalBillXml().bytes,
    Buffer.from('<!-- referred bill -->'),
  ]);
  const files = new Map<string, Uint8Array>([
    [
      '/bulkdata/BILLSTATUS/118/hr/BILLSTATUS-118hr9001.xml',
      makeBillStatusXml(),
    ],
    ['/content/pkg/BILLS-118hr9001enr/xml/BILLS-118hr9001enr.xml', referred],
  ]);
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (req, res) => {
      const path = new URL(req.url ?? '/', 'https://stub').pathname;
      requested.push(path);
      const body = files.get(path);
      res.writeHead(body ? 200 : 404, { 'content-type': 'application/xml' });
      res.end(body);
    },
  );
  stub = server;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  stubPort = (server.address() as AddressInfo).port;

  // The bill that cites it, ingested from a file like any other local document.
  const citing = Buffer.from(
    new TextDecoder()
      .decode(makeCongressionalBillXml().bytes)
      .replace(
        '<text>In this Act:</text>',
        '<text>In this Act, as in H.R. 9001 of the 118th Congress:</text>',
      ),
  );
  const path = join(dir, 'citing.xml');
  await writeFile(path, citing);
  await packedApp.cli('ingest', path, '--name', REFERRING);
});

test.afterAll(async ({ packedApp }) => {
  await packedApp.cli('remove', REFERRING).catch(() => undefined);
  await new Promise<void>((resolve) => {
    if (stub)
      stub.close(() => {
        resolve();
      });
    else resolve();
  });
  await rm(dir, { recursive: true, force: true });
});

test('opening a referenced bill gives the same document and summary as pasting its address', async ({
  page,
  context,
  packedApp,
}) => {
  const server = await packedApp.serve(0, {
    env: {
      NODE_OPTIONS: `--import=${join(dir, 'preload.mjs')}`,
      NODE_EXTRA_CA_CERTS: join(dir, 'cert.pem'),
      OPEN_REF_STUB_PORT: String(stubPort),
      [envVar('MAX_CALLS_PER_MINUTE')]: '600',
    },
  });
  try {
    await context.request.get(server.url);
    const summary = async () => {
      const panel = page.getByRole('region', { name: 'In brief' });
      await expect(panel).toContainText('Written from the bill');
      return (await panel.locator('.summary-text').textContent()) ?? '';
    };
    const docId = () => /\/doc\/([a-f0-9]{64})$/.exec(page.url())?.[1] ?? '';

    // 1. From the citing bill: the reference offers to open the bill, and asks first.
    await page.goto(server.url);
    await page
      .getByRole('region', { name: 'Your documents' })
      .getByRole('link', { name: new RegExp(`^${REFERRING}`) })
      .click();
    const refs = page.getByRole('region', { name: 'Laws it refers to' });
    await refs
      .getByRole('link', { name: /^Open H\.R\. 9001 \(118th Congress\) in / })
      .click();
    await expect(page).toHaveURL(/\/\?url=/);
    await expect(page.getByLabel('Web address of the bill')).toHaveValue(
      REFERRED,
    );
    await page
      .getByRole('region', { name: 'Read this bill?' })
      .getByRole('button', { name: 'Read this bill' })
      .click();
    await expect(page).toHaveURL(/\/doc\/[a-f0-9]{64}$/);
    const clickedId = docId();
    const clickedSummary = await summary();
    expect(clickedSummary.length).toBeGreaterThan(0);

    // 2. Start over, then paste the very same address.
    await packedApp.cli('remove', clickedId.slice(0, 16));
    await page.goto(server.url);
    await page.getByLabel('Web address of the bill').fill(REFERRED);
    await page
      .getByRole('button', { name: 'Read this bill', exact: true })
      .click();
    await expect(page).toHaveURL(/\/doc\/[a-f0-9]{64}$/);
    expect(docId()).toBe(clickedId);
    expect(await summary()).toBe(clickedSummary);

    // The server really read the stub: the status record and the text it names.
    expect(requested).toContain(
      '/content/pkg/BILLS-118hr9001enr/xml/BILLS-118hr9001enr.xml',
    );
    await packedApp.cli('remove', clickedId.slice(0, 16));
  } finally {
    await server.stop();
  }
});
