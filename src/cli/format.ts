/** Plain-text rendering of pipeline results for the terminal. */
import type { AnswerLogEvent } from '../core/answer/log.js';
import { stripCitations } from '../core/answer/readability.js';
import { formatCitation } from '../core/pipeline/index.js';
import type { AskResult, IngestResult } from '../core/pipeline/index.js';
import { safeText } from './sanitize.js';
import type { NormalizedDoc } from '../core/model/index.js';
import type { RegistryEntry as RegistryEntryLike } from '../core/registry.js';

const MAX_LISTED_REFS = 10;

export function formatIngest(result: IngestResult): string {
  const { stats, normalized: doc, usage } = result;
  const lines: string[] = [];
  lines.push(
    stats.reused
      ? `Already ingested: ${result.doc.label} (reused, 0 tokens)`
      : `Ingested: ${result.doc.label}`,
  );
  lines.push(`Document id: ${result.doc.docId}`);
  lines.push(`Format: ${stats.format}`);

  const m = doc.metadata;
  const fields: [string, string | null][] = [
    ['Title', m.title],
    ['Bill number', m.billNumber],
    ['Jurisdiction', m.jurisdiction],
    ['Session', m.session],
    ['Version', m.version],
    ['Sponsors', m.sponsors?.join(', ') ?? null],
  ];
  for (const [name, value] of fields)
    if (value) lines.push(`${name}: ${value}`);

  lines.push(`Sections: ${String(stats.sectionCount)}`);
  const byType = Object.entries(stats.chunkCountsByType)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type} ${String(count)}`);
  const total = Object.values(stats.chunkCountsByType).reduce(
    (a, b) => a + b,
    0,
  );
  lines.push(
    `Chunks: ${String(total)}${byType.length ? ` (${byType.join(', ')})` : ''}`,
  );
  lines.push(
    `Amendment spans: ${String(stats.deletedSpanCount)} deleted, ${String(stats.insertedSpanCount)} inserted`,
  );
  lines.push(
    `Unresolved external references: ${String(doc.externalRefs.length)}`,
  );
  for (const ref of doc.externalRefs.slice(0, MAX_LISTED_REFS))
    lines.push(`  - ${ref.citation}`);
  if (doc.externalRefs.length > MAX_LISTED_REFS)
    lines.push(
      `  ... and ${String(doc.externalRefs.length - MAX_LISTED_REFS)} more`,
    );
  lines.push(
    stats.reused
      ? 'Embedding tokens: 0'
      : `Embedding tokens: ${String(stats.embedTokens)}`,
  );
  if (usage.llmInputTokens + usage.llmOutputTokens > 0)
    lines.push(
      `Metadata extraction tokens: ${String(usage.llmInputTokens)} in, ${String(usage.llmOutputTokens)} out`,
    );
  if (doc.warnings.length) {
    lines.push('Warnings:');
    for (const warning of doc.warnings) lines.push(`  - ${warning}`);
  }
  return safeText(`${lines.join('\n')}\n`);
}

const WARNING_TEXT: Record<string, string> = {
  NO_VALID_CITATIONS:
    'The answer has no valid citations; treat it with caution.',
  INVALID_CITATIONS_REMOVED:
    'Some citations pointed outside the retrieved text and were removed.',
  NO_RELEVANT_EXCERPTS: 'No relevant text was found in the document.',
  TRUNCATED: 'The answer may be cut off.',
};

/** Citations and warnings printed after the streamed answer text. */
export function formatAskFooter(
  result: AskResult,
  doc: Pick<NormalizedDoc, 'sections'>,
): string {
  const lines: string[] = [];
  const valid = result.answer.citations.filter((c) => c.valid);
  if (valid.length) {
    lines.push('', 'Citations:');
    for (const citation of valid)
      lines.push(
        `  ${formatCitation(citation, doc)}  [S:${citation.sectionId}]`,
      );
  }
  for (const warning of result.answer.warnings)
    lines.push(`Warning: ${WARNING_TEXT[warning] ?? warning}`);
  return safeText(`${lines.join('\n')}\n`);
}

export function formatList(entries: readonly RegistryEntryLike[]): string {
  if (entries.length === 0) return 'No documents ingested yet.\n';
  return safeText(
    `${entries
      .map((e) =>
        [
          e.label,
          e.docId.slice(0, 12),
          e.format,
          e.title ?? e.billNumber ?? '-',
          `last used ${e.lastUsedAt}`,
        ].join('  |  '),
      )
      .join('\n')}\n`,
  );
}

/** One stderr line for an answer-layer event: codes and counts only. */
export function formatAnswerLog(event: AnswerLogEvent): string {
  if (event.event === 'regeneration_refused')
    return `note: kept the original wording (regeneration refused: ${event.reason})`;
  return event.event === 'excerpt_talk_reworded'
    ? `note: reworded ${String(event.count)} cited sentence(s) that mentioned the excerpts`
    : `note: removed ${String(event.count)} sentence(s) about the excerpts`;
}

/**
 * Whether the final answer text says something other than what was streamed. Citation markers
 * and spacing are ignored: invalid markers are stripped from the final text, which is no reason
 * to print the answer twice. A final text that the streamed text already ends with (the decline
 * appended after a withheld recital) is the same too.
 */
export function finalTextDiffers(streamed: string, final: string): boolean {
  const plain = (t: string): string =>
    stripCitations(t).replace(/\s+/g, ' ').trim();
  const a = plain(streamed);
  const b = plain(final);
  return a !== b && !a.endsWith(b);
}
