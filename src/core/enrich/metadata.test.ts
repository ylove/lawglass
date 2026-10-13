import { describe, expect, it } from 'vitest';
import { AppError, EMPTY_METADATA, type BillMetadata } from '../model/index.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { extractMetadata, MAX_METADATA_CHARS } from './metadata.js';

const TEXT = `H.R. 1234
119th Congress, 1st Session
A BILL To improve things.
Introduced in House
Sponsored by Rep. John Smith and Sen. Ana Lopez`;

const NULLS = {
  title: null,
  billNumber: null,
  jurisdiction: null,
  session: null,
  version: null,
  sponsors: null,
};
const scripted = (o: Record<string, unknown>) =>
  new ScriptedProvider({
    objects: { bill_metadata: { ...NULLS, ...o } },
  });

describe('extractMetadata', () => {
  it('returns nulls when the model finds nothing', async () => {
    const r = await extractMetadata(
      { metadata: EMPTY_METADATA },
      { provider: scripted({}), text: TEXT },
    );
    expect(r.metadata).toEqual(EMPTY_METADATA);
    expect(r.warnings).toEqual([]);
  });

  it('keeps stated values and marks source extracted', async () => {
    const r = await extractMetadata(
      { metadata: EMPTY_METADATA },
      {
        provider: scripted({
          billNumber: 'HR 1234',
          session: '119th Congress, 1st Session',
          sponsors: ['Rep. John Smith', 'Ana Lopez'],
          version: ' Introduced in House ',
        }),
        text: TEXT,
      },
    );
    expect(r.metadata.billNumber).toBe('HR 1234');
    expect(r.metadata.sponsors).toEqual(['Rep. John Smith', 'Ana Lopez']);
    expect(r.metadata.version).toBe('Introduced in House');
    expect(r.metadata.source).toBe('extracted');
  });

  it('discards hallucinated bill number, session and sponsors with warnings', async () => {
    const r = await extractMetadata(
      { metadata: EMPTY_METADATA },
      {
        provider: scripted({
          billNumber: 'S. 999',
          session: '120th Congress',
          sponsors: ['Rep. Jane Doe', 'John Smith Jr.'],
        }),
        text: TEXT,
      },
    );
    expect(r.metadata.billNumber).toBeNull();
    expect(r.metadata.session).toBeNull();
    expect(r.metadata.sponsors).toEqual(['John Smith Jr.']);
    expect(r.warnings).toHaveLength(3);
    expect(r.metadata.source).toBe('extracted');
  });

  it('stays at source none when everything extracted is discarded', async () => {
    const r = await extractMetadata(
      { metadata: EMPTY_METADATA },
      {
        provider: scripted({ billNumber: 'S. 999', sponsors: ['Nobody'] }),
        text: TEXT,
      },
    );
    expect(r.metadata).toEqual(EMPTY_METADATA);
    expect(r.warnings).toHaveLength(2);
  });

  it('merges with structured fields and never overwrites them', async () => {
    const structured: BillMetadata = {
      ...EMPTY_METADATA,
      billNumber: 'H.R. 1234',
      title: 'Structured Title',
      source: 'structured',
    };
    const r = await extractMetadata(
      { metadata: structured },
      {
        provider: scripted({
          billNumber: 'H.R. 1234',
          title: 'Model Title',
          sponsors: ['Ana Lopez'],
        }),
        text: TEXT,
      },
    );
    expect(r.metadata.title).toBe('Structured Title');
    expect(r.metadata.sponsors).toEqual(['Ana Lopez']);
    expect(r.metadata.source).toBe('extracted');
  });

  it('keeps structured source and skips the model when nothing is null', async () => {
    const full: BillMetadata = {
      title: 't',
      billNumber: 'b',
      jurisdiction: 'j',
      session: 's',
      version: 'v',
      sponsors: ['x'],
      source: 'structured',
    };
    const provider = scripted({});
    const r = await extractMetadata(
      { metadata: full },
      { provider, text: TEXT },
    );
    expect(r.metadata).toBe(full);
    expect(provider.calls).toHaveLength(0);
  });

  it('keeps structured source when the model adds nothing', async () => {
    const structured: BillMetadata = {
      ...EMPTY_METADATA,
      title: 't',
      source: 'structured',
    };
    const r = await extractMetadata(
      { metadata: structured },
      { provider: scripted({}), text: TEXT },
    );
    expect(r.metadata.source).toBe('structured');
  });

  it('skips the model call for empty text', async () => {
    const provider = scripted({});
    const r = await extractMetadata(
      { metadata: EMPTY_METADATA },
      { provider, text: '   ' },
    );
    expect(provider.calls).toHaveLength(0);
    expect(r.metadata).toEqual(EMPTY_METADATA);
  });

  it('truncates the prompt to the character budget', async () => {
    const provider = scripted({});
    await extractMetadata(
      { metadata: EMPTY_METADATA },
      { provider, text: 'x'.repeat(MAX_METADATA_CHARS * 2) },
    );
    const req = provider.calls[0] as { prompt: string; system: string };
    expect(req.prompt.length).toBeLessThan(MAX_METADATA_CHARS + 100);
    expect(req.system).toMatch(/null/i);
  });

  it('turns bad model output into a warning', async () => {
    const r = await extractMetadata(
      { metadata: EMPTY_METADATA },
      { provider: new ScriptedProvider({}), text: TEXT },
    );
    expect(r.metadata).toEqual(EMPTY_METADATA);
    expect(r.warnings[0]).toMatch(/PROVIDER_BAD_OUTPUT/);
  });

  it('turns provider errors and unexpected throws into warnings', async () => {
    for (const err of [
      new AppError('PROVIDER_ERROR'),
      new Error('boom'),
    ] as const) {
      const provider = scripted({});
      provider.generateObject = () => Promise.reject(err);
      const r = await extractMetadata(
        { metadata: EMPTY_METADATA },
        { provider, text: TEXT },
      );
      expect(r.metadata).toEqual(EMPTY_METADATA);
      expect(r.warnings).toHaveLength(1);
    }
  });

  it('rethrows when the caller aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const provider = scripted({});
    provider.generateObject = () => Promise.reject(new Error('aborted'));
    await expect(
      extractMetadata(
        { metadata: EMPTY_METADATA },
        { provider, text: TEXT, signal: ctl.signal },
      ),
    ).rejects.toThrow();
  });

  it('ignores blank sponsor and field strings', async () => {
    const r = await extractMetadata(
      { metadata: EMPTY_METADATA },
      {
        provider: scripted({ title: '  ', sponsors: ['', '(D)'] }),
        text: TEXT,
      },
    );
    expect(r.metadata.title).toBeNull();
    expect(r.metadata.sponsors).toBeNull();
  });
});
