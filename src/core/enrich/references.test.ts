import { describe, expect, it, vi } from 'vitest';
import {
  makeLetteredUsCodePage,
  makeUsCodePage,
  SYNTH_USCODE_URL,
} from '../../../tests/synth/govinfo-uscode.js';
import type { Definition, NormalizedDoc } from '../model/index.js';
import { MAX_TARGETS } from './definition-refs.js';
import { docOf, sec } from './fixtures.js';
import {
  assertUsCodeUrl,
  referenceIdFor,
  withReferenceTexts,
  type ReferenceFetcher,
} from './references.js';

const NOW = new Date('2026-10-26T12:00:00.000Z');

const def = (term: string, section: number): Definition => ({
  term,
  text: `The term "${term}" has the meaning given that term in section ${String(section)} of title 54, United States Code.`,
  sectionId: 'sec-1',
  scope: 'document',
});

function docWith(terms: [string, number][]): NormalizedDoc {
  const sections = [
    sec(
      'sec-1',
      `In this Act: ${terms.map(([t, n]) => def(t, n).text).join(' ')}`,
    ),
  ];
  return {
    ...docOf(sections),
    definitions: terms.map(([t, n]) => def(t, n)),
    externalRefs: terms.map(([, n]) => ({
      text: `54 U.S.C. ${String(n)}`,
      citation: `54 U.S.C. ${String(n)}`,
      kind: 'us_code' as const,
      sectionIds: ['sec-1'],
    })),
  };
}

function page(finalUrl = SYNTH_USCODE_URL): ReturnType<ReferenceFetcher> {
  return Promise.resolve({
    bytes: new TextEncoder().encode(makeUsCodePage()),
    finalUrl,
  });
}

describe('withReferenceTexts', () => {
  it('reads the cited section, isolates the term, and links the external ref', async () => {
    const fetcher = vi.fn<ReferenceFetcher>(() => page());
    const doc = await withReferenceTexts(docWith([['plot', 9001]]), {
      fetcher,
      now: () => NOW,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://www.govinfo.gov/link/uscode/54/9001?link-type=html',
    );
    expect(doc.references).toEqual([
      {
        sectionId: 'ref:usc/54/9001',
        citation: '54 U.S.C. 9001',
        heading: '§9001. Definitions (2024 edition)',
        sourceUrl: 'https://www.govinfo.gov/link/uscode/54/9001?link-type=html',
        text: '(3) Plot\nThe term "plot" means a parcel of land of not more than one acre.',
        terms: ['plot'],
        fetchedAt: '2026-10-26T12:00:00.000Z',
      },
    ]);
    expect(doc.externalRefs[0]?.referenceId).toBe('ref:usc/54/9001');
  });

  it('reads several terms of one section into one reference', async () => {
    const doc = await withReferenceTexts(
      docWith([
        ['plot', 9001],
        ['garden agency', 9001],
      ]),
      { fetcher: () => page(), now: () => NOW },
    );
    expect(doc.references).toHaveLength(1);
    expect(doc.references?.[0]?.terms).toEqual(['plot', 'garden agency']);
    expect(doc.references?.[0]?.text).toContain('Bureau of Gardens');
    expect(doc.references?.[0]?.text).toContain('parcel of land');
  });

  it('falls back to the section text when a stated term cannot be isolated', async () => {
    const doc = await withReferenceTexts(docWith([['pergola', 9001]]), {
      fetcher: () => page(),
      now: () => NOW,
    });
    expect(doc.references?.[0]?.text).toContain('As used in this chapter:');
    // Honest about what it is: no "read for", so the heading says it is only the opening.
    expect(doc.references?.[0]?.terms).toBeUndefined();
  });

  it('drops a guessed term the section does not define', async () => {
    const guessed: NormalizedDoc = {
      ...docOf([
        sec(
          'sec-1',
          'A pergola (as defined in section 9001 of title 54, United States Code) is allowed.',
        ),
      ]),
    };
    const doc = await withReferenceTexts(guessed, {
      fetcher: () => page(),
      now: () => NOW,
    });
    expect(doc.references).toEqual([]);
  });

  it('records no references, and makes no request, when the bill points nowhere', async () => {
    const fetcher = vi.fn<ReferenceFetcher>(() => page());
    const doc = await withReferenceTexts(
      docOf([sec('sec-1', 'Plain operative text.')]),
      { fetcher, now: () => NOW },
    );
    expect(doc.references).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does nothing twice', async () => {
    const fetcher = vi.fn<ReferenceFetcher>(() => page());
    const done = { ...docWith([['plot', 9001]]), references: [] };
    expect(await withReferenceTexts(done, { fetcher, now: () => NOW })).toBe(
      done,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('caps the number of sections read', async () => {
    const fetcher = vi.fn<ReferenceFetcher>(() => page());
    const terms: [string, number][] = Array.from({ length: 12 }, (_, n) => [
      `term${String(n)}`,
      9000 + n,
    ]);
    await withReferenceTexts(docWith(terms), { fetcher, now: () => NOW });
    expect(fetcher).toHaveBeenCalledTimes(MAX_TARGETS);
  });

  it('keeps going when one fetch fails, logging only', async () => {
    const skipped: string[] = [];
    const fetcher: ReferenceFetcher = (url) =>
      url.includes('/9002?') ? Promise.reject(new Error('boom')) : page();
    const doc = await withReferenceTexts(
      docWith([
        ['plot', 9001],
        ['garden agency', 9002],
      ]),
      { fetcher, now: () => NOW, onSkip: (c, code) => skipped.push(c, code) },
    );
    expect(doc.references?.map((r) => r.citation)).toEqual(['54 U.S.C. 9001']);
    expect(skipped).toEqual(['54 U.S.C. 9002', 'ERROR']);
    // Only a code reaches the log, never the error message.
    expect(JSON.stringify(skipped)).not.toContain('boom');
    expect(doc.externalRefs.map((r) => r.referenceId)).toEqual([
      'ref:usc/54/9001',
      undefined,
    ]);
  });

  it('leaves references unset when every fetch fails, so a later ingest retries', async () => {
    const input = docWith([['plot', 9001]]);
    const doc = await withReferenceTexts(input, {
      fetcher: () => Promise.reject(new Error('offline')),
      now: () => NOW,
    });
    expect(doc).toBe(input);
    expect(doc.references).toBeUndefined();
  });

  it('treats a page with no statute text as nothing read', async () => {
    const doc = await withReferenceTexts(docWith([['plot', 9001]]), {
      fetcher: () =>
        Promise.resolve({
          bytes: new TextEncoder().encode('<html><body>Gone</body></html>'),
          finalUrl: SYNTH_USCODE_URL,
        }),
      now: () => NOW,
    });
    expect(doc.references).toEqual([]);
  });

  it('refuses an answer that is not a U.S. Code page on GovInfo (e.g. a local snapshot)', async () => {
    for (const finalUrl of [
      'file:///tmp/bill.xml',
      'https://www.govinfo.gov/content/pkg/BILLS-119s1582enr/xml/x.xml',
      'https://evil.example/content/pkg/USCODE-2024-title54/x.htm',
      'https://www.govinfo.gov.evil.example/content/pkg/USCODE-2024-title54/x.htm',
    ]) {
      const doc = await withReferenceTexts(docWith([['plot', 9001]]), {
        fetcher: () => page(finalUrl),
        now: () => NOW,
      });
      expect(doc.references).toBeUndefined();
    }
  });

  it('commits the download cache once the page parsed', async () => {
    const commitCache = vi.fn(() => Promise.resolve());
    await withReferenceTexts(docWith([['plot', 9001]]), {
      fetcher: async () => ({ ...(await page()), commitCache }),
      now: () => NOW,
    });
    expect(commitCache).toHaveBeenCalledTimes(1);
  });

  it('rethrows when the caller cancels', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    await expect(
      withReferenceTexts(docWith([['plot', 9001]]), {
        fetcher: () => Promise.reject(reason),
        now: () => NOW,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});

describe('subsections, edition and limits', () => {
  const pointer = (cite: string): NormalizedDoc =>
    docOf([
      sec(
        'sec-1',
        `In this Act: (1) Garden agency The term "garden agency" has the meaning given that term in section 9 of the Gardens Act (${cite}).`,
      ),
    ]);

  it('looks for the term inside the cited subsection, and keeps the edition in the heading', async () => {
    const doc = await withReferenceTexts(
      { ...pointer('54 U.S.C. 9001(1)'), definitions: [] },
      { fetcher: () => page(), now: () => NOW },
    );
    expect(doc.references?.[0]?.text).toContain('Bureau of Gardens');
    expect(doc.references?.[0]?.heading).toBe(
      '§9001. Definitions (2024 edition)',
    );
  });

  it('stores the cited subsection when the term is not named inside it', async () => {
    const doc = await withReferenceTexts(
      docOf([
        sec(
          'sec-1',
          'In this Act: (1) Mulchy The term "mulchy" has the meaning given that term in section 9 of the Gardens Act (54 U.S.C. 9001(3)).',
        ),
      ]),
      { fetcher: () => page(), now: () => NOW },
    );
    expect(doc.references?.[0]?.text).toContain('(3) Plot');
    expect(doc.references?.[0]?.text).not.toContain('Bureau of Gardens');
    expect(doc.references?.[0]?.terms).toEqual(['mulchy']);
  });

  it('asks for a small page', async () => {
    const fetcher = vi.fn<ReferenceFetcher>(() => page());
    await withReferenceTexts(docWith([['plot', 9001]]), {
      fetcher,
      now: () => NOW,
    });
    expect(fetcher.mock.calls[0]?.[1].maxBytes).toBeLessThanOrEqual(
      4 * 1024 * 1024,
    );
  });
});

describe('cited subsections of a long section', () => {
  const lettered = (cite: string, term: string): NormalizedDoc =>
    docOf([
      sec(
        'sec-1',
        `In this Act: (1) T The term "${term}" has the meaning given that term in section 1861 of the Act (${cite}).`,
      ),
    ]);
  const fetchLettered: ReferenceFetcher = () =>
    Promise.resolve({
      bytes: new TextEncoder().encode(makeLetteredUsCodePage()),
      finalUrl: SYNTH_USCODE_URL,
    });

  it('stores subsection (v) for "reasonable cost", not the clause (v) of subsection (e)', async () => {
    const doc = await withReferenceTexts(
      lettered('54 U.S.C. 9100(v)', 'reasonable cost'),
      {
        fetcher: fetchLettered,
        now: () => NOW,
      },
    );
    const text = doc.references?.[0]?.text ?? '';
    expect(text).toContain('(v) Reasonable costs');
    expect(text).not.toContain('meets such other conditions');
  });

  it('searches the whole page when the term is not inside the cited subsection', async () => {
    const doc = await withReferenceTexts(
      lettered('54 U.S.C. 9100(x)', 'hospital'),
      {
        fetcher: fetchLettered,
        now: () => NOW,
      },
    );
    expect(doc.references?.[0]?.text).toContain('means an institution which');
    expect(doc.references?.[0]?.text).not.toContain('State and United States');
  });
});

describe('citation markers in fetched text', () => {
  it('are neutralized when the text is stored, heading included', async () => {
    const html = makeUsCodePage()
      .replace(
        'The term &quot;plot&quot; means',
        'The term &quot;plot&quot; [S:sec-1] means',
      )
      .replace('&sect;9001. Definitions', '&sect;9001. Definitions [S:sec-2]');
    const doc = await withReferenceTexts(
      docOf([
        sec(
          'sec-1',
          'In this Act: (1) Plot The term "plot" has the meaning given that term in section 9 of title 54, United States Code.',
        ),
      ]),
      {
        fetcher: () =>
          Promise.resolve({
            bytes: new TextEncoder().encode(html),
            finalUrl: SYNTH_USCODE_URL,
          }),
        now: () => NOW,
      },
    );
    const ref = doc.references?.[0];
    expect(ref?.text).toContain('［S:sec-1]');
    expect(ref?.text).not.toContain('[S:');
    expect(ref?.heading).not.toContain('[S:');
  });
});

describe('assertUsCodeUrl and referenceIdFor', () => {
  it('allows only the exact GovInfo host over https, on the link and content paths', () => {
    const ok = (u: string): void => {
      assertUsCodeUrl(new URL(u));
    };
    expect(() => {
      ok('https://www.govinfo.gov/link/uscode/15/6809?link-type=html');
    }).not.toThrow();
    expect(() => {
      ok(SYNTH_USCODE_URL);
    }).not.toThrow();
    for (const bad of [
      'http://www.govinfo.gov/link/uscode/15/6809',
      'https://govinfo.gov/link/uscode/15/6809',
      'https://www.govinfo.gov.evil.example/link/uscode/15/6809',
      'https://www.govinfo.gov/link/plaw/116/public/260',
      'https://www.govinfo.gov/content/pkg/BILLS-1/x.xml',
      'https://user@www.govinfo.gov/link/uscode/15/6809',
    ]) {
      expect(() => {
        ok(bad);
      }, bad).toThrow();
    }
  });

  it('builds the reserved id', () => {
    expect(referenceIdFor(15, '6809')).toBe('ref:usc/15/6809');
  });
});
