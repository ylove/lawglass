/**
 * How many characters the whole-bill prompt really holds, measured by building it.
 *
 * Whole-bill mode sends every chunk as `<part id=".." section=".." heading="Division A > Title
 * II > Sec. 142 ..." status=".." page=".." lines="..">text</part>`. The tags, ids, breadcrumbs
 * and escaping are a large share of the prompt on a bill with many short sections, and a flat
 * factor on the bill's text cannot follow that: S. 1582 (684 sections) carries about 70,000
 * characters of markup on 125,000 of text, Ohio S.B. 113 (101 sections) about 6,000 on 25,000.
 *
 * So this runs the same chunker and the same `formatExcerpt`/`formatReference` the answer
 * pipeline runs, and counts the result. Nothing is guessed about the markup, and a change to
 * the prompt format moves the forecast with it.
 */
import { dropOverlap } from '../answer/context.js';
import { formatExcerpt, formatReference } from '../answer/prompt.js';
import { chunkDocument } from '../chunk/index.js';
import {
  EMPTY_METADATA,
  type NormalizedDoc,
  type ReferenceText,
  type Section,
} from '../model/index.js';

/** The chunker only validates and reads these; none of them reaches the prompt. */
function stubDocument(sections: readonly Section[]): NormalizedDoc {
  return {
    docId: '0'.repeat(64),
    sourceUrl: 'https://estimate.invalid/',
    format: 'text',
    fetchedAt: '2000-01-01T00:00:00.000Z',
    metadata: EMPTY_METADATA,
    sections: [...sections],
    definitions: [],
    externalRefs: [],
    warnings: [],
  };
}

/**
 * Characters of the `<part>` blocks (the bill, then any reference texts) in the whole-bill
 * prompt, with the newline between blocks. Excludes the system prompt and the task, which the
 * estimator's framing allowance covers. Overlap between a section's chunks is dropped, as the
 * pipeline drops it before prompting.
 */
export function wholePromptCharacters(
  sections: readonly Section[],
  references: readonly ReferenceText[] = [],
): number {
  const hits = dropOverlap(
    chunkDocument(stubDocument(sections)).map((chunk) => ({ chunk, score: 1 })),
  );
  let characters = 0;
  hits.forEach((hit, i) => {
    characters += formatExcerpt(hit, String(i + 1), 'part').length + 1;
  });
  references.forEach((reference, i) => {
    characters +=
      formatReference(reference, String(hits.length + i + 1), 'part').length +
      1;
  });
  return characters;
}
