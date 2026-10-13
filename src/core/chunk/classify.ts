import type { ChunkType } from '../model/index.js';

/** Ordered heuristics: specific provisions take precedence over general boilerplate. */
export function classifyChunk(text: string, heading = ''): ChunkType {
  const context = `${heading}\n${text}`;
  if (
    /\bdefinitions?\b/i.test(heading) ||
    /\bas used in this (?:section|act)\b|["“][^"”]+["”]\s+(?:means|includes)\b|\bthe term\s+.+?\s+means\b/i.test(
      text,
    )
  )
    return 'definition';
  if (
    /\b(?:fines?|fined|penalt(?:y|ies)|violations?|guilty of|imprisonment)\b/i.test(
      context,
    )
  )
    return 'penalty';
  if (/\b(?:takes? effect|effective date|operative)\b/i.test(context))
    return 'effective_date';
  if (
    /\b(?:appropriat(?:ed|ion|ions)|there is authorized|funds?)\b|\$/i.test(
      context,
    )
  )
    return 'appropriation';
  if (/\b(?:findings|the Congress finds|purposes?)\b/i.test(context))
    return 'findings';
  if (
    text.trim().split(/\s+/).length < 12 &&
    /\b(?:short title|may be cited|be it enacted|enacting clause)\b/i.test(
      context,
    )
  )
    return 'other';
  return 'operative';
}
