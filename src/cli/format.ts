/** Plain-text rendering of pipeline results for the terminal. */
import { formatCitation } from '../core/pipeline/index.js';
import type { AskResult, IngestResult } from '../core/pipeline/index.js';
import type { NormalizedDoc } from '../core/model/index.js';
import type { RegistryEntry as RegistryEntryLike } from '../core/registry.js';

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
  for (const ref of doc.externalRefs) lines.push(`  - ${ref.citation}`);
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
  return `${lines.join('\n')}\n`;
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
  return `${lines.join('\n')}\n`;
}

export function formatList(entries: readonly RegistryEntryLike[]): string {
  if (entries.length === 0) return 'No documents ingested yet.\n';
  return `${entries
    .map((e) =>
      [
        e.label,
        e.docId.slice(0, 12),
        e.format,
        e.title ?? e.billNumber ?? '-',
        `last used ${e.lastUsedAt}`,
      ].join('  |  '),
    )
    .join('\n')}\n`;
}
