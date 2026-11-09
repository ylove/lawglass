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

/** Short labels only. A longer or odd-looking string could be someone's text, so it is dropped. */
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/;

export function emitEvent(
  name: ReaderEventName,
  fields: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const detail: ReaderEvent = { name };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'name') continue;
    if (typeof value === 'number' && Number.isFinite(value))
      detail[key] = value;
    else if (typeof value === 'boolean') detail[key] = value;
    else if (typeof value === 'string' && SAFE_LABEL.test(value))
      detail[key] = value;
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
