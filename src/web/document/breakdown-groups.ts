import type { OutlineItem, SectionBrief } from '../../core/model/index.js';

/** A bill with more briefs than this is grouped by its top-level container and filterable. */
export const GROUPING_THRESHOLD = 30;

export interface BriefGroup {
  /** The container's section id, or `other` for parts the outline does not place. */
  id: string;
  label: string;
  briefs: readonly SectionBrief[];
}

function labelOf(item: OutlineItem): string {
  return [item.num, item.heading].filter(Boolean).join(' ') || item.id;
}

/**
 * Groups briefs by the top-level container (division, title or subtitle) their part sits under,
 * using the document outline (preorder, with each item's depth in `level`). Returns `undefined`
 * when the bill has no containers to group by, or all its briefs fall under one, so the caller
 * shows a plain list.
 */
export function groupBriefs(
  briefs: readonly SectionBrief[],
  outline: readonly OutlineItem[] | undefined,
): BriefGroup[] | undefined {
  if (!outline?.length) return undefined;
  // Walk the preorder list with a stack of open ancestors: the first one is the top-level
  // container. An item with nothing nested under it is a section, not a container.
  const rootOf = new Map<string, OutlineItem>();
  const stack: OutlineItem[] = [];
  outline.forEach((item) => {
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= item.level)
      stack.pop();
    const root = stack[0];
    if (root) rootOf.set(item.id, root);
    stack.push(item);
  });

  const groups = new Map<string, { label: string; briefs: SectionBrief[] }>();
  const other: SectionBrief[] = [];
  const byId = new Map(outline.map((item) => [item.id, item]));
  for (const brief of briefs) {
    const item = byId.get(brief.sectionId);
    const root = rootOf.get(brief.sectionId);
    if (!item || !root) {
      other.push(brief);
      continue;
    }
    const group = groups.get(root.id) ?? { label: labelOf(root), briefs: [] };
    group.briefs.push(brief);
    groups.set(root.id, group);
  }
  const result: BriefGroup[] = [...groups].map(([id, g]) => ({ id, ...g }));
  if (other.length > 0)
    result.push({ id: 'other', label: 'Other parts', briefs: other });
  return result.length >= 2 ? result : undefined;
}

/** What a reader can search: the part's number, heading and text, without citation markers. */
function searchable(brief: SectionBrief): string {
  return [brief.num, brief.heading, brief.text.replace(/\[S:[^\]]*\]/g, '')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Briefs whose number, heading or text contains every word typed (any order, any case). */
export function filterBriefs(
  briefs: readonly SectionBrief[],
  query: string,
): readonly SectionBrief[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return briefs;
  return briefs.filter((brief) => {
    const text = searchable(brief);
    return words.every((word) => text.includes(word));
  });
}
