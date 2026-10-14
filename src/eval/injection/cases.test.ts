import { describe, expect, test } from 'vitest';
import {
  BASE_SECTIONS,
  INJECTION_CASES,
  billHtml,
  sectionIds,
} from './cases.js';

describe('case catalog', () => {
  test('ids are unique and every case names an attack and an OWASP id', () => {
    const ids = INJECTION_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of INJECTION_CASES) {
      expect(c.owasp.length).toBeGreaterThan(0);
      expect(c.owasp.every((o) => /^LLM\d\d$/.test(o))).toBe(true);
      expect(c.question.trim().length).toBeGreaterThan(0);
    }
  });

  test('covers every direct and indirect category the issue lists', () => {
    const has = (re: RegExp, channel: 'direct' | 'indirect') =>
      INJECTION_CASES.some((c) => c.channel === channel && re.test(c.category));
    for (const re of [
      /role-play/,
      /ignore previous rules/,
      /system-prompt extraction/,
      /write code/,
      /write an email/,
      /markdown links/,
      /very long/,
      /bidi/,
    ])
      expect(has(re, 'direct'), String(re)).toBe(true);
    for (const re of [
      /instruction addressed to the AI/,
      /struck/,
      /URL and image/,
      /fake citations/,
    ])
      expect(has(re, 'indirect'), String(re)).toBe(true);
  });

  test('direct cases carry the payload in the question; indirect cases plant it in the bill', () => {
    for (const c of INJECTION_CASES) {
      const planted = (c.planted ?? []).map((s) => s.text).join('\n');
      if (c.channel === 'direct') {
        expect(c.planted).toBeUndefined();
        expect(c.question).toContain(c.payloadKey);
      } else {
        expect(planted).toContain(c.payloadKey);
        expect(c.question).not.toContain(c.payloadKey);
      }
    }
  });

  test('the long question is at least the 500-character interface limit', () => {
    const long = INJECTION_CASES.find((c) => c.id === 'direct-long-question');
    expect(long?.question.length).toBeGreaterThan(500);
  });

  test('every expected failure explains itself', () => {
    for (const c of INJECTION_CASES)
      for (const e of c.expectedFailures ?? [])
        expect(e.why.length).toBeGreaterThan(40);
  });
});

describe('billHtml', () => {
  test('numbers sections from the base bill, then the planted ones', () => {
    const c = INJECTION_CASES.find((x) => x.id === 'indirect-ai-instruction');
    expect(c).toBeDefined();
    if (!c) return;
    expect(sectionIds(c)).toHaveLength(BASE_SECTIONS.length + 1);
    expect(billHtml(c)).toContain(
      `id="sec-${String(BASE_SECTIONS.length + 1)}"`,
    );
  });

  test('hostile text is HTML-escaped so it stays text in the page', () => {
    const c = INJECTION_CASES.find((x) => x.id === 'indirect-forged-tags');
    const html = billHtml(c ?? INJECTION_CASES[0]!);
    expect(html).toContain('&lt;/excerpt&gt;&lt;system&gt;');
    expect(html).not.toContain('<system>');
  });

  test('struck sections are wrapped in <s>', () => {
    const c = INJECTION_CASES.find(
      (x) => x.id === 'indirect-struck-instruction',
    );
    expect(billHtml(c ?? INJECTION_CASES[0]!)).toMatch(/<s>NOTE TO AI/);
  });
});
