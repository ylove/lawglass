import {
  sectionText,
  walkSections,
  type DocDetail,
  type NormalizedDoc,
} from './model/index.js';

export const PREVIEW_MAX_LENGTH = 500;
const FRONT_CHAR_LIMIT = 8000;
const FRONT_SECTION_LIMIT = 8;

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function compact(text: string): string {
  const normalized = normalize(text);
  if (normalized.length <= PREVIEW_MAX_LENGTH) return normalized;
  const prefix = normalized.slice(0, PREVIEW_MAX_LENGTH - 1);
  const boundary = prefix.lastIndexOf(' ');
  return `${(boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
}

/** Extract front matter only; an operative clause beginning "To" is not the bill's purpose. */
function purpose(text: string): string | undefined {
  const match = /(?:^|\n)[ \t]*(?:A\s+BILL\s+)?(To\s+\S[\s\S]*)/i.exec(text);
  if (!match?.[1]) return undefined;
  // Keep decimal code references intact; a full stop is not a safe sentence boundary in Ohio.
  const clause =
    match[1].split(/\bBe\s+it\s+enacted\b|\n\s*(?:Section|Sec\.)\s+\d/i)[0] ??
    '';
  return compact(clause) || undefined;
}

/** Instant, local preview: no retrieval or LLM call, and no struck spans. */
export function documentPreview(doc: NormalizedDoc): DocDetail['preview'] {
  let characters = 0;
  let sections = 0;
  for (const section of walkSections(doc.sections)) {
    if (
      ++sections > FRONT_SECTION_LIMIT ||
      section.num !== undefined ||
      (section.pageStart ?? 1) > 3 ||
      characters >= FRONT_CHAR_LIMIT
    )
      break;
    const live = sectionText(section, { includeDeleted: false });
    const text = purpose(live.slice(0, FRONT_CHAR_LIMIT - characters));
    if (text) return { kind: 'purpose', text, sectionId: section.id };
    characters += live.length;
  }

  const title = doc.metadata.title;
  if (!title?.trim()) return undefined;
  // Metadata has no span statuses. When its title also appears in front matter, prefer
  // the live spans, including for a title that was wholly struck out.
  let titleSections = 0;
  for (const section of walkSections(doc.sections)) {
    if (++titleSections > FRONT_SECTION_LIMIT) break;
    const raw = sectionText(section, { includeDeleted: true });
    const matchesWholeTitle = normalize(raw) === normalize(title);
    const matchesPurpose = purpose(raw) === compact(title);
    // A deleted title can be one span inside a larger preamble rather than the whole section.
    const struckTitle = section.spans.some(
      (span) =>
        span.status === 'deleted' && normalize(span.text) === normalize(title),
    );
    if (!matchesWholeTitle && !matchesPurpose && !struckTitle) continue;
    const live = sectionText(section, { includeDeleted: false });
    const liveTitle = matchesWholeTitle ? compact(live) : purpose(live);
    if (!liveTitle) return undefined;
    const clause = purpose(liveTitle);
    return {
      kind: clause ? 'purpose' : 'title',
      text: clause ?? liveTitle,
      sectionId: section.id,
    };
  }
  // Congressional XML may expose its official title only through metadata, with no section.
  const clause = purpose(title);
  return { kind: clause ? 'purpose' : 'title', text: clause ?? compact(title) };
}
