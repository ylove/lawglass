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
function readCongressionalSection(
  element: Element,
  level: number,
  parentId?: string,
): Section {
  const children = Array.from(element.children);
  const text = children
    .filter(
      (child) => child.tagName === 'text' || child.tagName === 'quoted-block',
    )
    .map((child) =>
      // Quoted law is marked with quotation marks, like the production parser does.
      child.tagName === 'quoted-block'
        ? `“${normalize(child.textContent)}”`
        : normalize(child.textContent),
    )
    .join(' ');
  const printed = children.find(
    (child) => child.tagName === 'enum',
  )!.textContent;
  // Ids come from enums, never from the XML ids (real files use opaque hex ids).
  const inner = printed.replace(/^\(|\)$|\.$/g, '');
  const id = parentId ? `${parentId}/${inner}` : `sec-${inner}`;
  return {
    id,
    num: printed.replace(/\.$/, ''),
    heading: children.find((child) => child.tagName === 'header')!.textContent,
    level,
    spans: text ? [{ text, status: 'unchanged' }] : [],
    children: children
      .filter((child) => ['subsection', 'paragraph'].includes(child.tagName))
      .map((child) => readCongressionalSection(child, level + 1, id)),
  };
}

describe('congressional XML reader round-trip', () => {
  it('reads structured metadata, nested sections, definitions, quotations and references', async () => {
    const { bytes, groundTruth } = makeCongressionalBillXml();
    const window = new Window();
    try {
      // happy-dom's XML parser falls back to HTML when a DOCTYPE is present; the real
      // parser (src/core/parse/xml.ts) tolerates it, so only this DOM reader strips it.
      const doc = new window.DOMParser().parseFromString(
        new TextDecoder().decode(bytes).replace(/<!DOCTYPE[^>]*>/, ''),
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
        sponsors: Array.from(form.querySelectorAll('sponsor')).map(
          (element) => element.textContent,
        ),
        source: 'structured',
      };
      expect(BillMetadata.parse(metadata)).toEqual(groundTruth.metadata);
      expect(doc.querySelector('dublinCore')).not.toBeNull();
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
      expect(term.closest('paragraph')!.getAttribute('id')).toMatch(
        /^id[0-9a-f]{32}$/,
      );
      expect(doc.querySelector('quoted-block')!.textContent).toBe(
        groundTruth.quotedText,
      );
      const external = doc.querySelector('external-xref')!;
      ExternalRef.parse(groundTruth.externalRefs[0]);
      expect(external.getAttribute('legal-doc')).toBe('usc');
      expect(external.getAttribute('parsable-cite')).toBe('usc/15/632');
      expect(external.textContent).toBe(groundTruth.externalRefs[0]!.citation);
      expect(external.closest('section')!.getAttribute('id')).toMatch(
        /^id[0-9a-f]{32}$/,
      );
      const internal = doc.querySelector('internal-xref')!;
      // idrefs are opaque hex ids; the ground-truth target is the enum-built section id.
      expect(internal.textContent).toBe(groundTruth.internalRefs[0]!.text);
      const target = doc.getElementById(internal.getAttribute('idref')!)!;
      expect(target.tagName).toBe('paragraph');
      expect(groundTruth.internalRefs[0]!.target).toBe('sec-1/a/1');
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
        // Own text only: the first <p> in <content>, or the <chapeau> (nested levels have their own).
        const own = Array.from(element.children).find((child) =>
          ['content', 'chapeau'].includes(child.tagName),
        )!;
        const block = own.tagName === 'content' ? own.querySelector('p')! : own;
        const spans: Span[] = Array.from(block.childNodes).map((node) => ({
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
