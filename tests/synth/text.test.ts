import { describe, expect, it } from 'vitest';
import { Section, walkSections } from '../../src/core/model/index.js';
import { makeSectionedText } from './text.js';

describe('sectioned text reader round-trip', () => {
  it('detects every spec section pattern, in order, without matching ordinary body text', () => {
    const { bytes, groundTruth } = makeSectionedText();
    const lines = new TextDecoder().decode(bytes).split('\n');
    // Test-only section recognizers; keep independent of the sample's expected facts.
    const topLevel =
      /^(?:Section|SECTION|Sec\.|SEC\.|§)\s+(\d+(?:\.\d+)*)(?:\.(?=\s))?\s+(.+)$/;
    const child = /^(\([a-zA-Z0-9]+\))\s+(.+)$/;
    const detected = lines.flatMap((line) => {
      const match = topLevel.exec(line) ?? child.exec(line);
      return match ? [{ num: match[1], text: match[2] }] : [];
    });
    const expected = [...walkSections(groundTruth.sections)];
    expect(detected.map((section) => section.num)).toEqual(
      expected.map((section) => section.num),
    );
    expected.forEach((section, index) => {
      Section.parse(section);
      expect(detected[index]!.text).toBe(
        section.heading ?? section.spans[0]!.text,
      );
      for (const span of section.spans)
        expect(lines.some((line) => line.includes(span.text))).toBe(true);
      expect(section).not.toHaveProperty('lineStart');
    });
    expect(detected).toHaveLength(8);
    expect(groundTruth.deletedStrings).toEqual([]);
    expect(groundTruth.insertedStrings).toEqual([]);
  });
});
