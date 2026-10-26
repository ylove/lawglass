import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ParseBudget, type ParseControl } from './limits.js';
import { AppError, NormalizedDoc } from '../model/index.js';
import { applyChangeMarks } from './change-marks.js';
import { jurisdictionSections, newYorkMetadata } from './new-york.js';
import { detectSections, type SectionDetectionOptions } from './sections.js';

export interface TextParseOptions
  extends SectionDetectionOptions, ParseControl {
  sourceUrl: string;
  jurisdiction?: string;
  /** Supplied by the fetch step so parsing is deterministic. */
  fetchedAt: string;
}

const context = z.object({ sourceUrl: z.url(), fetchedAt: z.iso.datetime() });

/** UTF-8 plain text; hash original bytes before decoding or normalizing line endings. */
export function parseText(
  input: string | Uint8Array,
  options: TextParseOptions,
): NormalizedDoc {
  if (!context.safeParse(options).success) {
    throw new AppError(
      'INVALID_INPUT',
      'Invalid text document source or fetch timestamp.',
    );
  }
  const budget = new ParseBudget(options);
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new AppError(
      'PARSE_FAILED',
      'The text document is not valid UTF-8.',
      { cause },
    );
  }
  if (!text.trim())
    throw new AppError('PARSE_FAILED', 'The text document is empty.');
  // Iterate separators so the budget can stop splitting before all lines are allocated.
  // Checking by character offset also covers a very long line without separators.
  const lines: { text: string }[] = [];
  let start = 0;
  let checkpoint = 0;
  for (let at = 0; at < text.length; at++) {
    if (at >= checkpoint) {
      budget.check();
      checkpoint = at + 4096;
    }
    const char = text.charAt(at);
    if (char !== '\r' && char !== '\n') continue;
    lines.push({ text: text.slice(start, at) });
    if (char === '\r' && text[at + 1] === '\n') at++;
    start = at + 1;
  }
  lines.push({ text: text.slice(start) });
  budget.check();
  const marked = applyChangeMarks(lines, options);
  const doc = NormalizedDoc.parse({
    docId: createHash('sha256').update(bytes).digest('hex'),
    sourceUrl: options.sourceUrl,
    fetchedAt: options.fetchedAt,
    format: 'text',
    metadata: newYorkMetadata(text, options),
    sections: detectSections(marked.lines, jurisdictionSections(options)),
    definitions: [],
    externalRefs: [],
    warnings: marked.warnings,
  });
  budget.check();
  return doc;
}
