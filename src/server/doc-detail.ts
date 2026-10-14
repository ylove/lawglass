/**
 * Builds `DocDetail` (the document screen's payload) from the registry document plus its
 * sidecar history. Kept apart from the Hono routes so it is testable without HTTP.
 */
import type { CliRuntime } from '../cli/runtime.js';
import {
  readHistory,
  readOfficialTitle,
} from '../core/history/history-store.js';
import {
  type BillHistory,
  type DocDetail,
  type DocSummary,
  type NormalizedDoc,
  type OutlineItem,
  type Section,
} from '../core/model/index.js';
import { compact, documentPreview } from '../core/preview.js';

/** Real CRS summaries run to 88k-208k characters; the screen only needs the opening. */
export const OFFICIAL_SUMMARY_MAX_LENGTH = 4000;

/**
 * Cut the official summary on a word boundary and point to the full text. The text is
 * untrusted; it is only ever shortened, never interpreted.
 */
export function truncateHistory(history: BillHistory): BillHistory {
  const summary = history.officialSummary;
  if (
    !summary ||
    Array.from(summary.text).length <= OFFICIAL_SUMMARY_MAX_LENGTH
  )
    return history;
  // Count code points, not UTF-16 units, so an emoji is never cut in half.
  const prefix = Array.from(summary.text)
    .slice(0, OFFICIAL_SUMMARY_MAX_LENGTH)
    .join('');
  const boundary = prefix.lastIndexOf(' ');
  const cut = (
    boundary > prefix.length / 2 ? prefix.slice(0, boundary) : prefix
  ).trimEnd();
  return {
    ...history,
    officialSummary: {
      ...summary,
      text: `${cut}… Full official summary at ${summary.url}`,
    },
  };
}

export function outlineOf(sections: readonly Section[]): OutlineItem[] {
  return sections.flatMap((s) => [
    {
      id: s.id,
      level: s.level,
      ...(s.num === undefined ? {} : { num: s.num }),
      ...(s.heading === undefined ? {} : { heading: s.heading }),
    },
    ...outlineOf(s.children),
  ]);
}

function hasLineNumbers(sections: readonly Section[]): boolean {
  return sections.some(
    (s) =>
      s.spans.some((span) => span.line !== undefined) ||
      hasLineNumbers(s.children),
  );
}

/**
 * Suggested subjects for a targeted scenario, picked by keyword from the bill's own words. The
 * list is deterministic and fixed: nothing here comes from a model, and every entry passes
 * `checkScenarioSubject`. Order is by relevance rules below, capped at five.
 */
export const PERSONA_RULES: readonly {
  match: RegExp;
  personas: readonly string[];
}[] = [
  {
    match: /\b(?:elections?|voters?|voting|ballots?|council|candidates?)\b/i,
    personas: [
      'a voter in a council district',
      'someone running for city council',
    ],
  },
  {
    match: /\b(?:tenants?|renters?|landlords?|leases?|rent)\b/i,
    personas: ['a renter', 'a landlord'],
  },
  {
    match: /\b(?:tax|taxes|taxation|levy|levies|assessments?)\b/i,
    personas: ['a taxpayer'],
  },
  {
    match: /\b(?:homeowners?|mortgages?|property)\b/i,
    personas: ['a homeowner'],
  },
  {
    match: /\b(?:employees?|workers?|wages?|employers?|labor)\b/i,
    personas: ['a worker', 'a small business owner'],
  },
  {
    match: /\b(?:students?|schools?|tuition)\b/i,
    personas: ['a student', 'a parent'],
  },
  {
    match: /\b(?:pensions?|retire\w*|public employees?)\b/i,
    personas: ['a public employee', 'a retiree'],
  },
  { match: /\b(?:drivers?|vehicles?|licenses?)\b/i, personas: ['a driver'] },
];
const MAX_PERSONAS = 5;

function sectionWords(sections: readonly Section[]): string[] {
  return sections.flatMap((s) => [
    s.heading ?? '',
    ...s.spans.filter((span) => span.status !== 'deleted').map((x) => x.text),
    ...sectionWords(s.children),
  ]);
}

/** Empty when no keyword matches; the screen then offers no suggestions. */
export function scenarioPersonasFor(doc: NormalizedDoc): string[] {
  const text = [doc.metadata.title ?? '', ...sectionWords(doc.sections)].join(
    '\n',
  );
  const found: string[] = [];
  for (const rule of PERSONA_RULES)
    if (rule.match.test(text))
      for (const persona of rule.personas)
        if (!found.includes(persona)) found.push(persona);
  return found.slice(0, MAX_PERSONAS);
}

export async function buildDocDetail(
  runtime: Pick<CliRuntime, 'registry'>,
  summary: DocSummary,
  doc: NormalizedDoc,
): Promise<DocDetail> {
  const { configDir } = runtime.registry;
  // A missing or corrupt sidecar is the same as no history: the screen says so, nothing fails.
  const history = await readHistory(configDir, doc.docId).catch(
    () => undefined,
  );
  // parseXml keeps only the short title; the record's official title states the purpose.
  const officialTitle = history
    ? await readOfficialTitle(configDir, doc.docId).catch(() => undefined)
    : undefined;
  const preview: DocDetail['preview'] = officialTitle
    ? { kind: 'purpose', text: compact(officialTitle) }
    : documentPreview(doc);
  const personas = scenarioPersonasFor(doc);
  return {
    doc: summary,
    metadata: doc.metadata,
    outline: outlineOf(doc.sections),
    externalRefs: doc.externalRefs,
    warnings: doc.warnings,
    hasLineNumbers: hasLineNumbers(doc.sections),
    ...(doc.scan ? { scan: doc.scan } : {}),
    ...(history ? { history: truncateHistory(history) } : {}),
    ...(preview ? { preview } : {}),
    ...(personas.length ? { scenarioPersonas: personas } : {}),
  };
}
