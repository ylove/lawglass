// Neutral reader events for a host page (ADR 0018, section 8). This repository only dispatches
// them on `window`; it never sends them anywhere. A payload carries a name and a few
// non-identifying fields: never bill text, a question, or the address of a bill someone chose.
import { BRAND } from '../core/brand.js';
import type { ApiClient } from './api.js';

export const EVENT_TYPE = `${BRAND.name}:event`;

export type ReaderEventName =
  | 'ingest_started'
  | 'ingest_done'
  | 'summary_viewed'
  | 'section_brief_open'
  | 'example_view'
  | 'question_asked'
  | 'find_where_it_says'
  | 'reference_open'
  | 'quote_shown'
  | 'quote_confirmed';

export type EventFields = Record<string, string | number | boolean>;
export interface ReaderEvent extends EventFields {
  name: ReaderEventName;
}

/**
 * What each event may carry. An allowlist, not a filter: a field that is not listed for the event
 * is dropped, and a listed field is kept only if its value is one of a fixed set, so no caller
 * can put a reader's words, a bill's text or an address into an event by mistake.
 */
const SIZES = ['small', 'medium', 'large'];
const FORMATS = ['xml', 'html', 'pdf', 'text'];
const CHIPS = [
  'summary',
  'what-changes',
  'who-affected',
  'penalties',
  'effective-date',
  'money',
  'definitions',
  'sponsors',
  'history',
  'delegations',
];

/** Buckets a free-text jurisdiction (from bill metadata) into a fixed label. */
function jurisdictionLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  if (/\bohio\b|^oh$/i.test(raw.trim())) return 'ohio';
  if (/new york/i.test(raw)) return 'new-york';
  if (/new jersey/i.test(raw)) return 'new-jersey';
  if (/united states|congress|federal|^u\.?s\.?$/i.test(raw)) return 'federal';
  return 'other';
}

const oneOf =
  (allowed: readonly string[]) =>
  (value: unknown): string | undefined =>
    typeof value === 'string' && allowed.includes(value) ? value : undefined;
const flag = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const FIELDS = {
  jurisdiction: jurisdictionLabel,
  chipId: oneOf(CHIPS),
  format: oneOf(FORMATS),
  size: oneOf(SIZES),
  reused: flag,
} as const;
type FieldName = keyof typeof FIELDS;

const ALLOWED: Record<ReaderEventName, readonly FieldName[]> = {
  ingest_started: [],
  ingest_done: ['format', 'size', 'reused'],
  summary_viewed: ['jurisdiction'],
  section_brief_open: ['jurisdiction'],
  example_view: ['jurisdiction'],
  question_asked: ['jurisdiction', 'chipId'],
  find_where_it_says: ['jurisdiction'],
  reference_open: ['jurisdiction'],
  quote_shown: [],
  quote_confirmed: [],
};

export function emitEvent(
  name: ReaderEventName,
  fields: Partial<Record<FieldName, unknown>> = {},
): void {
  const detail: ReaderEvent = { name };
  for (const field of ALLOWED[name]) {
    const value = FIELDS[field](fields[field]);
    if (value !== undefined) detail[field] = value;
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT_TYPE, { detail }));
  } catch {
    /* A host listener must never break the reader's page. */
  }
}

/** A coarse size, so a host can tell a short bill from a long one without a count. */
export function sizeBand(sections: number): string {
  if (sections < 20) return 'small';
  if (sections < 100) return 'medium';
  return 'large';
}

/**
 * Emits the events that follow from API calls. Wrapping the client keeps the components free of
 * tracking code and makes sure the same call always means the same event.
 */
export function withEvents(api: ApiClient): ApiClient {
  const jurisdictions = new Map<string, string | undefined>();
  const summarySeen = new Set<string>();
  const exampleSeen = new Set<string>();
  const where = (docId: string) => ({ jurisdiction: jurisdictions.get(docId) });
  return {
    ...api,
    async getDoc(docId) {
      const detail = await api.getDoc(docId);
      jurisdictions.set(docId, detail.metadata.jurisdiction ?? undefined);
      return detail;
    },
    async getSummary(docId) {
      const result = await api.getSummary(docId);
      if (result.status === 'cached' && !summarySeen.has(docId)) {
        summarySeen.add(docId);
        emitEvent('summary_viewed', where(docId));
      }
      return result;
    },
    async getSectionExample(docId, sectionId, signal) {
      const result = await api.getSectionExample(docId, sectionId, signal);
      const key = `${docId}\n${sectionId}`;
      if (result.status === 'ok' && !exampleSeen.has(key)) {
        exampleSeen.add(key);
        emitEvent('example_view', where(docId));
      }
      return result;
    },
    locate(docId, req, signal) {
      emitEvent('find_where_it_says', where(docId));
      return api.locate(docId, req, signal);
    },
    async *ingest(req, signal) {
      emitEvent('ingest_started');
      for await (const event of api.ingest(req, signal)) {
        if (event.type === 'done')
          emitEvent('ingest_done', {
            format: event.stats.format,
            size: sizeBand(event.stats.sectionCount),
            reused: event.stats.reused,
          });
        yield event;
      }
    },
    ask(docId, req, signal) {
      emitEvent('question_asked', {
        ...where(docId),
        // A chip is a fixed, public label; a typed question is never described.
        chipId: req.chipId,
      });
      return api.ask(docId, req, signal);
    },
  };
}
