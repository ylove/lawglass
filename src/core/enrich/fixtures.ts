import {
  EMPTY_METADATA,
  type NormalizedDoc,
  type Section,
} from '../model/index.js';

/** Test helpers shared by the enrich suites. */
export function sec(
  id: string,
  text: string,
  over: Partial<Section> = {},
): Section {
  return {
    id,
    level: 1,
    spans: text ? [{ text, status: 'unchanged' }] : [],
    children: [],
    ...over,
  };
}

export function docOf(sections: Section[]): NormalizedDoc {
  return {
    docId: 'd'.repeat(64),
    sourceUrl: 'https://example.gov/bill.xml',
    format: 'xml',
    fetchedAt: '2026-10-13T00:00:00.000Z',
    metadata: { ...EMPTY_METADATA },
    sections,
    definitions: [],
    externalRefs: [],
    warnings: [],
  };
}
