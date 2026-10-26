import type { AnswerResult, SearchHit } from '../model/index.js';
import { normalizeUnit, numberTokens } from '../scenario/numbers.js';
import { coveredSectionIds } from './citations.js';
import { promptText } from './markers.js';
import { stripCitations } from './readability.js';

/** Bump when the token or preservation rules change, to invalidate regenerated caches. */
export const AMENDED_WORDING_VERSION = '1';

const STOPWORDS = new Set(
  'the and for with from that this these those which who whose are was were been being have has had does did into its their there here such any all'.split(
    ' ',
  ),
);
const SIGNIFICANT = new Set(
  'may shall must not no never except unless'.split(' '),
);

function numbers(text: string): Set<string> {
  const normalized = stripCitations(text).normalize('NFKC');
  return new Set(
    numberTokens(normalized).map((token) =>
      Number.isFinite(token.value)
        ? `number:${String(token.value)}`
        : `quantity:${normalized.slice(token.start, token.end).toLowerCase()}`,
    ),
  );
}

function tokens(text: string): Set<string> {
  const normalized = stripCitations(text).normalize('NFKC').toLowerCase();
  const result = numbers(normalized);
  // Number words and digits share one token; changing "fifteen" to "15" cannot evade the guard.
  const quantities = numberTokens(normalized);
  let quantityIndex = 0;
  for (const match of normalized.matchAll(/\p{L}+/gu)) {
    const word = match[0];
    while ((quantities[quantityIndex]?.end ?? Infinity) <= match.index)
      quantityIndex++;
    const quantity = quantities[quantityIndex];
    // Keep unit words as content: replacing "years" with "days" must not hide old wording.
    if (
      quantity &&
      Number.isFinite(quantity.value) &&
      quantity.start <= match.index &&
      match.index < quantity.end &&
      normalizeUnit(word) !== quantity.unit
    )
      continue;
    if (SIGNIFICANT.has(word) || (word.length >= 3 && !STOPWORDS.has(word)))
      result.add(`word:${word}`);
  }
  return result;
}

type CitedText = Pick<AnswerResult, 'text' | 'citations'>;

/**
 * Check only the cited sections the first answer actually saw. This is a lexical safety
 * check, not a claim validator: it cannot detect a changed meaning using the same words.
 */
export function preservesAmendedWording(
  first: CitedText,
  second: Pick<AnswerResult, 'text'>,
  hits: readonly SearchHit[],
): boolean {
  const cited = new Set(
    first.citations.filter((c) => c.valid).map((c) => c.sectionId),
  );
  const text = {
    deleted: [] as string[],
    inserted: [] as string[],
    unchanged: [] as string[],
  };
  for (const { chunk } of hits) {
    if (!coveredSectionIds(chunk).some((id) => cited.has(id))) continue;
    const source = promptText(chunk);
    const runs = [
      ...source.matchAll(/\[(struck|inserted)\]([\s\S]*?)\[\/\1\]/g),
    ];
    // Inline markers take precedence over the chunk's coarser status, just as in the prompt.
    const outside = runs.length ? 'unchanged' : chunk.amendmentStatus;
    let end = 0;
    for (const run of runs) {
      text[outside].push(source.slice(end, run.index));
      text[run[1] === 'struck' ? 'deleted' : 'inserted'].push(run[2] ?? '');
      end = run.index + run[0].length;
    }
    text[outside].push(source.slice(end));
  }
  const deleted = tokens(text.deleted.join(' '));
  const live = tokens([...text.unchanged, ...text.inserted].join(' '));
  const before = tokens(first.text);
  const after = tokens(second.text);
  for (const token of deleted)
    if (!live.has(token) && !before.has(token) && after.has(token))
      return false;

  const inserted = numbers(text.inserted.join(' '));
  const other = numbers([...text.unchanged, ...text.deleted].join(' '));
  for (const token of inserted)
    if (!other.has(token) && before.has(token) && !after.has(token))
      return false;
  return true;
}
