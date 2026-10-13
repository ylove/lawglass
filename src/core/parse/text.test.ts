import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  EMPTY_METADATA,
  NormalizedDoc,
  sectionText,
  walkSections,
} from '../model/index.js';
import { detectSections, parseText } from './index.js';

const options = {
  sourceUrl: 'https://example.gov/bill.txt',
  fetchedAt: '2026-10-13T00:00:00.000Z',
};

describe('parseText', () => {
  it('returns a contract-valid document with deterministic identity and no invented metadata', () => {
    const input =
      'A bill\nSection 4. Grants\n(a) Eligibility\n(1) A town qualifies.';
    const doc = parseText(input, options);
    expect(NormalizedDoc.safeParse(doc).success).toBe(true);
    expect(doc).toMatchObject({
      docId: createHash('sha256').update(input).digest('hex'),
      ...options,
      format: 'text',
      metadata: EMPTY_METADATA,
      definitions: [],
      externalRefs: [],
      warnings: [],
    });
    expect(
      [...walkSections(doc.sections)].map((section) => section.id),
    ).toEqual(['preamble', 'sec-4', 'sec-4/a', 'sec-4/a/1']);
    expect(doc.sections).toEqual(
      detectSections(input.split('\n').map((text) => ({ text }))),
    );
    expect(parseText(input, options)).toEqual(doc);
    expect(doc).not.toHaveProperty('pageCount');
    for (const section of walkSections(doc.sections)) {
      expect(section).not.toHaveProperty('lineStart');
      for (const span of section.spans) {
        expect(span.status).toBe('unchanged');
        expect(span).not.toHaveProperty('line');
        expect(span).not.toHaveProperty('page');
      }
    }
  });

  it.each(['\n', '\r\n', '\r'])(
    'normalizes line endings %j while hashing the original bytes',
    (newline) => {
      const input = `Section 1.${newline}(a) Duty${newline}Continuation${newline}`;
      const bytes = Buffer.from(input);
      const doc = parseText(bytes, options);
      expect(doc.docId).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(doc).toEqual(parseText(input, options));
      expect(
        sectionText(doc.sections[0]!.children[0]!, { includeDeleted: false }),
      ).toBe('(a) Duty\nContinuation\n');
    },
  );

  it('parses inline markers and wrapped references together from CRLF input', () => {
    const input = [
      'SEC. 2. DEFINITIONS. (a) In General.— (1) foo',
      'This includes subsection (b).',
      'section 5747.02 of the Revised Code and',
      'Section 3 of H.B. 1 as enacted',
      '(b)(1) Another item',
      '§ 1395x-1',
      '(z) Last letter',
      '(aa) Next letter',
      '(bb) Next letter',
    ].join('\r\n');
    const doc = parseText(input, options);
    const nodes = [...walkSections(doc.sections)];
    expect(nodes.map((section) => section.id)).toEqual([
      'sec-2',
      'sec-2/a',
      'sec-2/a/1',
      'sec-2/b',
      'sec-2/b/1',
      'sec-1395x-1',
      'sec-1395x-1/z',
      'sec-1395x-1/aa',
      'sec-1395x-1/bb',
    ]);
    expect(doc.sections[0]?.heading).toBe('DEFINITIONS.');
    expect(
      sectionText(doc.sections[0]!.children[0]!.children[0]!, {
        includeDeleted: false,
      }),
    ).toBe(
      '(1) foo\nThis includes subsection (b).\nsection 5747.02 of the Revised Code and\nSection 3 of H.B. 1 as enacted\n',
    );
    expect(
      nodes
        .flatMap((section) => section.spans)
        .map((span) => span.text)
        .join(''),
    ).toBe(input.replaceAll('\r\n', '\n'));
    expect(doc.docId).toBe(createHash('sha256').update(input).digest('hex'));
    expect(NormalizedDoc.safeParse(doc).success).toBe(true);
  });

  it('decodes UTF-8 including BOM and Unicode text without changing the raw-byte identity', () => {
    const bytes = new Uint8Array(
      Buffer.from('\uFEFF§ 5747.01\nCafé — eligibility.'),
    );
    const doc = parseText(bytes, options);
    expect(doc.docId).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(doc.sections[0]?.id).toBe('sec-5747.01');
    expect(sectionText(doc.sections[0]!, { includeDeleted: false })).toBe(
      '§ 5747.01\nCafé — eligibility.',
    );
  });

  it('uses preamble for unstructured text and passes through custom heading patterns', () => {
    expect(
      parseText('An unstructured document.', options).sections[0]?.id,
    ).toBe('preamble');
    expect(
      parseText('Rule 10: Grants', {
        ...options,
        patterns: [{ kind: 'section', regex: /^Rule (\d+):/ }],
      }).sections[0]?.id,
    ).toBe('sec-10');
  });

  it('does not share mutable metadata or section state between calls', () => {
    const first = parseText('Section 1.', options);
    first.metadata.title = 'Changed';
    first.sections[0]!.spans[0]!.text = 'Changed';
    const second = parseText('Section 1.', options);
    expect(second.metadata.title).toBeNull();
    expect(second.sections[0]?.spans[0]?.text).toBe('Section 1.');
    expect(EMPTY_METADATA.title).toBeNull();
  });

  it.each(['', ' \t\r\n', new Uint8Array(), '\uFEFF'])(
    'rejects an empty document: %j',
    (input) => {
      expect(() => parseText(input, options)).toThrow(
        'The text document is empty.',
      );
    },
  );

  it('reports invalid UTF-8 as a parse error with a cause', () => {
    try {
      parseText(new Uint8Array([0xc3, 0x28]), options);
      expect.fail('Expected invalid UTF-8 to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: 'PARSE_FAILED',
        userMessage: 'The document could not be read.',
      });
      expect((error as AppError).cause).toBeInstanceOf(Error);
    }
  });

  it.each([
    { ...options, sourceUrl: 'not a URL' },
    { ...options, fetchedAt: 'not a timestamp' },
  ])('rejects invalid document context: %j', (context) => {
    expect(() => parseText('Section 1.', context)).toThrow(
      'Invalid text document source or fetch timestamp.',
    );
  });
});
