import { walkSections, type Section } from '../model/index.js';
import { trimEndWhile } from '../trim.js';

/** Lookup tables over the section tree, shared by definition scoping and reference resolution. */
export interface SectionIndex {
  byId: ReadonlyMap<string, Section>;
  parentOf: ReadonlyMap<string, Section | undefined>;
  /** Normalized section number ("3", "5747.01") to section id. First occurrence wins. */
  bySectionNum: ReadonlyMap<string, string>;
}

/** "Sec. 3." / "§ 3" / "Section 3" all become "3". Subdivision labels like "(b)" return undefined. */
export function normalizeSectionNum(num: string): string | undefined {
  const cleaned = trimEndWhile(
    num.trim().replace(/^(?:sec(?:tion)?\.?|§+)\s*/i, ''),
    (c) => c === '.' || /\s/.test(c),
  ).toLowerCase();
  return cleaned && !cleaned.startsWith('(') ? cleaned : undefined;
}

/** "(b)" / "(2)" / "b." become "b" / "2". Case is kept: Ohio's (A) and (a) are different levels. */
export function normalizeDesignator(label: string): string {
  return label.replace(/[^A-Za-z0-9]/g, '');
}

export function buildSectionIndex(sections: readonly Section[]): SectionIndex {
  const byId = new Map<string, Section>();
  const parentOf = new Map<string, Section | undefined>();
  const bySectionNum = new Map<string, string>();
  const visit = (
    list: readonly Section[],
    parent: Section | undefined,
  ): void => {
    for (const section of list) {
      byId.set(section.id, section);
      parentOf.set(section.id, parent);
      visit(section.children, section);
    }
  };
  visit(sections, undefined);
  for (const section of walkSections(sections)) {
    const key =
      section.num === undefined ? undefined : normalizeSectionNum(section.num);
    if (key !== undefined && !bySectionNum.has(key))
      bySectionNum.set(key, section.id);
  }
  return { byId, parentOf, bySectionNum };
}

/** Root-first chain ending at `id`. Empty when the id is unknown. */
export function ancestry(index: SectionIndex, id: string): Section[] {
  const chain: Section[] = [];
  for (
    let node = index.byId.get(id);
    node !== undefined;
    node = index.parentOf.get(node.id)
  )
    chain.unshift(node);
  return chain;
}

/**
 * The numbered "section" containing `id`: climbs out of subdivisions such as "(b)" so that
 * "this section" means the same thing whether the parser nests subsections or not.
 */
export function enclosingSection(
  index: SectionIndex,
  id: string,
): Section | undefined {
  const chain = ancestry(index, id);
  const numbered = chain.findLast(
    (section) =>
      section.num !== undefined && !section.num.trim().startsWith('('),
  );
  return numbered ?? chain[0];
}
