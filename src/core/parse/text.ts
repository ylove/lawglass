import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ParseBudget, type ParseControl } from './limits.js';
import { AppError, EMPTY_METADATA, NormalizedDoc } from '../model/index.js';
import { detectSections, type SectionDetectionOptions } from './sections.js';

export interface TextParseOptions
  extends SectionDetectionOptions, ParseControl {
  sourceUrl: string;
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
  const lines = text.split(/\r\n|\r|\n/).map((text) => ({ text }));
  const doc = NormalizedDoc.parse({
    docId: createHash('sha256').update(bytes).digest('hex'),
    sourceUrl: options.sourceUrl,
    fetchedAt: options.fetchedAt,
    format: 'text',
    metadata: { ...EMPTY_METADATA },
    sections: detectSections(lines, options),
    definitions: [],
    externalRefs: [],
    warnings: [],
  });
  budget.check();
  return doc;
}
