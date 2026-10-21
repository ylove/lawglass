import type { ChunkType } from '../model/index.js';

/** Ordered heuristics: specific provisions take precedence over general boilerplate. */
export function classifyChunk(text: string, heading = ''): ChunkType {
  // Headings participate in the same ordered rules as text: e.g. Penalties
  // takes precedence over effective-date or appropriation language below.
  const context = `${heading}\n${text}`;
  if (
    /\bdefinitions?\b/i.test(heading) ||
    /\bas used in this (?:section|act)\b|["“][^"“”]+["”]\s+(?:means|includes)\b|\bthe term\s.{0,100}?\smeans\b/i.test(
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
  if (
    /\b(?:takes? effect|shall (?:take|become) effective|effective (?:immediately|on|upon|beginning|as of|date)|operative (?:on|upon|date))\b/i.test(
      context,
    )
  )
    return 'effective_date';
  if (
    /\bappropriat(?:e|ed|ion|ions)\b/i.test(context) ||
    (/\bfrom the\s[^.!?\n]{0,200}\bfunds?\b/i.test(context) &&
      /\$\s*\d|\b\d[\d,.]*\s+(?:dollars?|thousand|million|billion)\b/i.test(
        context,
      ))
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
