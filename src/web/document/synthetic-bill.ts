import type { OutlineItem, SectionBrief } from '../../core/model/index.js';

/** 3 titles of 40 sections each: 120 sections in all. */
export function syntheticBill(): {
  outline: OutlineItem[];
  briefs: SectionBrief[];
} {
  const outline: OutlineItem[] = [];
  const briefs: SectionBrief[] = [];
  for (let t = 1; t <= 3; t++) {
    outline.push({
      id: `title-${String(t)}`,
      num: `${String(t)}`,
      heading: `Title ${String(t)} ${['Farms', 'Schools', 'Roads'][t - 1] ?? ''}`,
      level: 1,
    });
    for (let s = 1; s <= 40; s++) {
      const n = (t - 1) * 40 + s;
      const id = `sec-${String(n)}`;
      outline.push({
        id,
        num: String(n),
        heading: `Rule ${String(n)}`,
        level: 2,
      });
      briefs.push({
        sectionId: id,
        num: String(n),
        heading: `Rule ${String(n)}`,
        text: `Part ${String(n)} ${t === 2 && s === 7 ? 'funds a bus garage' : 'sets a rule'}. [S:${id}]`,
        citations: [{ sectionId: id, valid: true, chunkIds: [] }],
        readingGrade: 6,
        example: 'available',
      });
    }
  }
  return { outline, briefs };
}
