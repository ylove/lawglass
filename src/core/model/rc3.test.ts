import { describe, expect, it } from 'vitest';
import {
  BillMetadata,
  ChipId,
  ChipStrategy,
  ClientConfig,
  DocDetail,
  ExternalRef,
  NormalizedDoc,
  ScenarioRequest,
  ScenarioResponse,
  ScanStatus,
} from './index.js';

const rc2Metadata = {
  title: 'A bill',
  billNumber: 'HB 1',
  jurisdiction: 'Ohio',
  session: '136',
  version: 'As Introduced',
  sponsors: ['Rep. A'],
  source: 'structured',
};
const rc2Doc = {
  docId: 'a'.repeat(64),
  sourceUrl: 'https://example.com/bill.pdf',
  format: 'pdf',
  fetchedAt: '2026-10-14T12:00:00.000Z',
  metadata: rc2Metadata,
  sections: [],
  definitions: [],
  externalRefs: [],
  warnings: [],
  pageCount: 2,
};
const rc2Summary = {
  docId: 'a'.repeat(64),
  label: 'x',
  sourceUrl: 'https://example.com/bill.pdf',
  format: 'pdf',
  title: null,
  billNumber: null,
  ingestedAt: '2026-10-14T12:00:00.000Z',
  lastUsedAt: '2026-10-14T12:00:00.000Z',
  backend: 'local',
};
const rc2Detail = {
  doc: rc2Summary,
  metadata: rc2Metadata,
  outline: [],
  externalRefs: [],
  warnings: [],
  hasLineNumbers: true,
};
const scan = {
  pages: [
    { page: 1, marks: 'read' },
    { page: 2, marks: 'uncertain' },
    { page: 3, marks: 'not-read' },
  ],
};
const scenario = {
  subject: 'Renters',
  profile: {
    name: 'Sam',
    label: 'A renter',
    assumptions: [{ key: 'rent', label: 'Rent', value: 900, unit: 'USD' }],
    illustrative: true,
  },
  frames: ['setup', 'rule', 'effect'].map((kind) => ({
    kind,
    avatar: 'worker',
    icon: 'job',
    caption: 'A caption.',
    citations: ['sec-1'],
  })),
};

describe('rc.2-shaped data still parses', () => {
  it('parses metadata, a normalized doc and a doc detail', () => {
    expect(BillMetadata.parse(rc2Metadata).docKind).toBeUndefined();
    const doc = NormalizedDoc.parse(rc2Doc);
    expect(doc.scan).toBeUndefined();
    const detail = DocDetail.parse(rc2Detail);
    expect(detail.scan).toBeUndefined();
    expect(detail.scenarioPersonas).toBeUndefined();
  });

  it('parses a config response without turnstileSiteKey', () => {
    const config = {
      productName: 'Product',
      publicMode: false,
      freeformEnabled: true,
      backend: 'local',
      provider: 'p',
      model: 'm',
      chips: [{ id: 'summary', label: 'Summary' }],
      scenariosEnabled: true,
    };
    expect(ClientConfig.parse(config).turnstileSiteKey).toBeUndefined();
    // scenariosEnabled is required in the response schema.
    const { scenariosEnabled: _omit, ...old } = config;
    expect(ClientConfig.safeParse(old).success).toBe(false);
  });
});

describe('new fields round-trip', () => {
  it('ChipId and ChipStrategy accept the new values', () => {
    expect(ChipId.parse('delegations')).toBe('delegations');
    expect(ChipStrategy.parse('extract')).toBe('extract');
    expect(ChipId.safeParse('nope').success).toBe(false);
  });

  it('BillMetadata docKind and amends', () => {
    const m = {
      ...rc2Metadata,
      docKind: 'charter_amendment',
      amends: { name: 'City Charter', jurisdiction: 'Dayton', sections: ['4'] },
    };
    expect(BillMetadata.parse(m)).toEqual(m);
    expect(
      BillMetadata.parse({
        ...rc2Metadata,
        amends: { name: 'Code', sections: [] },
      }).amends,
    ).toEqual({ name: 'Code', sections: [] });
  });

  it('rejects an unknown docKind and an amends without sections', () => {
    expect(
      BillMetadata.safeParse({ ...rc2Metadata, docKind: 'memo' }).success,
    ).toBe(false);
    expect(
      BillMetadata.safeParse({ ...rc2Metadata, amends: { name: 'x' } }).success,
    ).toBe(false);
  });

  it('ExternalRef category, with kind unchanged', () => {
    const ref = {
      text: 'Article IV of the Charter',
      citation: 'Charter art. IV',
      kind: 'other',
      category: 'charter',
      sectionIds: ['sec-1'],
    };
    expect(ExternalRef.parse(ref)).toEqual(ref);
    expect(ExternalRef.safeParse({ ...ref, category: 'x' }).success).toBe(
      false,
    );
    expect(ExternalRef.safeParse({ ...ref, kind: 'charter' }).success).toBe(
      false,
    );
  });

  it('scan on NormalizedDoc and DocDetail', () => {
    expect(NormalizedDoc.parse({ ...rc2Doc, scan }).scan).toEqual(scan);
    expect(
      DocDetail.parse({
        ...rc2Detail,
        scan,
        scenarioPersonas: ['A renter', 'A landlord'],
      }),
    ).toMatchObject({ scan, scenarioPersonas: ['A renter', 'A landlord'] });
    expect(
      ScanStatus.safeParse({ pages: [{ page: 0, marks: 'read' }] }).success,
    ).toBe(false);
    expect(
      ScanStatus.safeParse({ pages: [{ page: 1, marks: 'maybe' }] }).success,
    ).toBe(false);
  });

  it('ClientConfig turnstileSiteKey', () => {
    const c = ClientConfig.parse({
      productName: 'L',
      publicMode: true,
      freeformEnabled: false,
      backend: 'local',
      provider: 'p',
      model: 'm',
      chips: [],
      scenariosEnabled: false,
      turnstileSiteKey: '0x4AAA',
    });
    expect(c.turnstileSiteKey).toBe('0x4AAA');
  });
});

describe('ScenarioRequest / ScenarioResponse', () => {
  it('trims the subject and enforces 1-80 characters', () => {
    expect(ScenarioRequest.parse({ subject: '  Renters  ' }).subject).toBe(
      'Renters',
    );
    expect(ScenarioRequest.safeParse({ subject: '   ' }).success).toBe(false);
    expect(ScenarioRequest.safeParse({}).success).toBe(false);
    expect(ScenarioRequest.safeParse({ subject: 'x'.repeat(80) }).success).toBe(
      true,
    );
    expect(ScenarioRequest.safeParse({ subject: 'x'.repeat(81) }).success).toBe(
      false,
    );
  });

  it('accepts each status, with a scenario only when given', () => {
    expect(ScenarioResponse.parse({ status: 'none' }).scenario).toBeUndefined();
    expect(ScenarioResponse.parse({ status: 'disabled' }).status).toBe(
      'disabled',
    );
    expect(ScenarioResponse.parse({ status: 'ok', scenario }).scenario).toEqual(
      scenario,
    );
    expect(ScenarioResponse.safeParse({ status: 'later' }).success).toBe(false);
    expect(
      ScenarioResponse.safeParse({ status: 'ok', scenario: { subject: 'x' } })
        .success,
    ).toBe(false);
  });
});

describe('an rc.2-style reader ignores the new optional fields', () => {
  // An rc.2 binary parses with the rc.2 shape; zod objects strip unknown keys.
  it('strips unknown keys on the non-strict schemas', () => {
    const doc = NormalizedDoc.parse({
      ...rc2Doc,
      scan,
      metadata: { ...rc2Metadata, docKind: 'bill', future: 1 },
    });
    expect(doc.metadata.docKind).toBe('bill');
    const stripped = NormalizedDoc.parse({ ...rc2Doc, somethingNew: true });
    expect('somethingNew' in stripped).toBe(false);
    const ref = ExternalRef.parse({
      text: 't',
      citation: 'c',
      kind: 'other',
      sectionIds: [],
      futureField: 1,
    });
    expect('futureField' in ref).toBe(false);
  });
});
