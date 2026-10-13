import { Window, type Element } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import {
  BillMetadata,
  Definition,
  ExternalRef,
  Section,
  walkSections,
  type Span,
} from '../../src/core/model/index.js';
import { makeCongressionalBillXml, makeUslmXml } from './xml.js';

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

// A small DOM reader checks basic section facts; production normalization ships in #15.
function readCongressionalSection(element: Element, level: number): Section {
  const children = Array.from(element.children);
  const text = children
    .filter(
      (child) => child.tagName === 'text' || child.tagName === 'quoted-block',
    )
    .map((child) => normalize(child.textContent))
    .join(' ');
  return {
    id: element.id,
    num: children
      .find((child) => child.tagName === 'enum')!
      .textContent.replace(/\.$/, ''),
    heading: children.find((child) => child.tagName === 'header')!.textContent,
    level,
    spans: text ? [{ text, status: 'unchanged' }] : [],
    children: children
      .filter((child) => ['subsection', 'paragraph'].includes(child.tagName))
      .map((child) => readCongressionalSection(child, level + 1)),
  };
}

describe('congressional XML reader round-trip', () => {
  it('reads structured metadata, nested sections, definitions, quotations and references', async () => {
    const { bytes, groundTruth } = makeCongressionalBillXml();
    const window = new Window();
    try {
      const doc = new window.DOMParser().parseFromString(
        new TextDecoder().decode(bytes),
        'application/xml',
      );
      const form = doc.querySelector('form')!;
      const metadata = {
        title: form.querySelector('official-title')!.textContent,
        billNumber: form.querySelector('legis-num')!.textContent,
        jurisdiction: form
          .querySelector('current-chamber')!
          .textContent.includes('UNITED STATES')
          ? 'United States'
          : null,
        session: `${form.querySelector('congress')!.textContent}, ${form.querySelector('session')!.textContent}`,
        version: doc.documentElement.getAttribute('bill-stage'),
        sponsors: Array.from(form.querySelectorAll('sponsor,cosponsor')).map(
          (element) => element.textContent,
        ),
        source: 'structured',
      };
      expect(BillMetadata.parse(metadata)).toEqual(groundTruth.metadata);
      const sections = Array.from(
        doc.querySelector('legis-body')!.children,
      ).map((element) => readCongressionalSection(element, 1));
      expect(sections).toEqual(groundTruth.sections);
      sections.forEach((section) => Section.parse(section));
      for (const section of walkSections(sections))
        expect(section).not.toHaveProperty('lineStart');
      const term = doc.querySelector('term')!;
      const definition = groundTruth.definitions[0]!;
      Definition.parse(definition);
      expect(term.textContent).toBe(definition.term);
      expect(term.parentElement!.textContent).toBe(definition.text);
      expect(term.closest('paragraph')!.id).toBe(definition.sectionId);
      expect(doc.querySelector('quoted-block')!.textContent).toBe(
        groundTruth.quotedText,
      );
      const external = doc.querySelector('external-xref')!;
      ExternalRef.parse(groundTruth.externalRefs[0]);
      expect(external.getAttribute('legal-doc')).toBe('usc');
      expect(external.getAttribute('parsable-cite')).toBe('usc/15/632');
      expect(external.textContent).toBe(groundTruth.externalRefs[0]!.citation);
      expect(external.closest('section')!.id).toBe(
        groundTruth.externalRefs[0]!.sectionIds[0],
      );
      const internal = doc.querySelector('internal-xref')!;
      expect({
        text: internal.textContent,
        target: internal.getAttribute('idref'),
      }).toEqual(groundTruth.internalRefs[0]);
      expect(
        doc.getElementById(internal.getAttribute('idref')!),
      ).not.toBeNull();
    } finally {
      await window.happyDOM.close();
    }
  });
});

describe('USLM XML reader round-trip', () => {
  it('preserves namespace, section numbers and insertion/deletion spans', async () => {
    const { bytes, groundTruth } = makeUslmXml();
    const window = new Window();
    try {
      const doc = new window.DOMParser().parseFromString(
        new TextDecoder().decode(bytes),
        'application/xml',
      );
      expect(doc.documentElement.namespaceURI).toBe(groundTruth.namespace);
      const sections = Array.from(
        doc.getElementsByTagNameNS(groundTruth.namespace, 'section'),
      );
      expect(sections.map((section) => section.id)).toEqual(
        groundTruth.sections.map((section) => section.id),
      );
      sections.forEach((element, index) => {
        const expected = groundTruth.sections[index]!;
        Section.parse(expected);
        expect(element.querySelector('num')!.getAttribute('value')).toBe(
          expected.num,
        );
        expect(element.querySelector('heading')!.textContent).toBe(
          expected.heading,
        );
        const spans: Span[] = Array.from(
          element.querySelector('p')!.childNodes,
        ).map((node) => ({
          text: node.textContent,
          status:
            node.nodeName === 'del'
              ? 'deleted'
              : node.nodeName === 'ins'
                ? 'inserted'
                : 'unchanged',
        }));
        expect(spans).toEqual(expected.spans);
        expect(expected).not.toHaveProperty('lineStart');
      });
      expect(
        Array.from(doc.querySelectorAll('del')).map(
          (element) => element.textContent,
        ),
      ).toEqual(groundTruth.deletedStrings);
      expect(
        Array.from(doc.querySelectorAll('ins')).map(
          (element) => element.textContent,
        ),
      ).toEqual(groundTruth.insertedStrings);
    } finally {
      await window.happyDOM.close();
    }
  });
});
