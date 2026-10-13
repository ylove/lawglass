import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { Section, sectionText } from '../../src/core/model/index.js';
import { makeAmendmentHtml } from './html.js';

describe('amendment HTML reader round-trip', () => {
  it('extracts section facts, every amendment form, and strips page noise', async () => {
    const { bytes, groundTruth } = makeAmendmentHtml();
    const window = new Window();
    try {
      const doc = new window.DOMParser().parseFromString(
        new TextDecoder().decode(bytes),
        'text/html',
      );
      for (const noise of groundTruth.noiseStrings)
        expect(doc.body.textContent).toContain(noise);
      doc.querySelectorAll('nav,header,footer,script').forEach((element) => {
        element.remove();
      });
      for (const noise of groundTruth.noiseStrings)
        expect(doc.body.textContent).not.toContain(noise);
      const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
      expect(
        Array.from(doc.querySelectorAll('section')).map(
          (section) => section.id,
        ),
      ).toEqual(groundTruth.sections.map((section) => section.id));
      for (const section of groundTruth.sections) {
        Section.parse(section);
        const element = doc.getElementById(section.id)!;
        expect(element.querySelector('h2')!.textContent).toBe(
          `Section ${section.num!}. ${section.heading!}`,
        );
        const text = Array.from(element.querySelectorAll('p'))
          .map((p) => p.textContent)
          .join(' ');
        expect(normalize(text)).toBe(
          sectionText(section, { includeDeleted: true }),
        );
        expect(section).not.toHaveProperty('lineStart');
      }
      const deleted = Array.from(
        doc.querySelectorAll('s,strike,del,[style*="line-through"]'),
      );
      const inserted = Array.from(
        doc.querySelectorAll('u,ins,[style*="underline"]'),
      );
      expect(deleted.map((element) => element.textContent)).toEqual(
        groundTruth.deletedStrings,
      );
      expect(inserted.map((element) => element.textContent)).toEqual(
        groundTruth.insertedStrings,
      );
      for (const element of deleted) element.remove();
      for (const section of groundTruth.sections) {
        const text = Array.from(
          doc.getElementById(section.id)!.querySelectorAll('p'),
        )
          .map((p) => p.textContent)
          .join(' ');
        expect(normalize(text)).toBe(
          normalize(sectionText(section, { includeDeleted: false })),
        );
      }
    } finally {
      await window.happyDOM.close();
    }
  });
});
