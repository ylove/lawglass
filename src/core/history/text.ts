/**
 * Text sanitizing shared by the history adapters. Everything here is linear in the input
 * length: no backtracking regexes over untrusted text, and callers cap length first.
 *
 * Output is plain text. By default bare `<` and `>` are dropped so markup can never survive;
 * `keepOperators` removes only genuine tags and keeps comparison operators. Consumers must
 * still render it as text, never as HTML.
 */

// Zero-width (U+200B-200F), bidi embedding/override (U+202A-202E), bidi isolate
// (U+2066-2069) and the byte order mark (U+FEFF). They can spoof or hide text in a UI.
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export const MAX_TEXT = 2_000;
export const MAX_NAME = 200;

/** Remove zero-width and bidi control characters. */
export function stripInvisible(value: string): string {
  return value.replace(INVISIBLE, '');
}

/** One pass: `<...>` becomes a space. An unterminated tag drops the rest; a bare `>` is dropped. */
function stripAllAngles(value: string): string {
  let out = '';
  let inTag = false;
  for (const char of value) {
    if (inTag) {
      if (char === '>') inTag = false;
    } else if (char === '<') {
      inTag = true;
      out += ' ';
    } else if (char !== '>') out += char;
  }
  return out;
}

const isLetter = (c: string | undefined): boolean =>
  c !== undefined && /^[A-Za-z]$/.test(c);

/**
 * One linear pass: a genuine tag (`<b>`, `</b>`, `<a href="x">`, `<!--c-->`, `<?x?>`) becomes a
 * space. A `<` or `>` that is not part of a tag stays, because bill text really says
 * "income < $50,000 and age > 65"; an unmatched `<` never swallows what follows it.
 */
function stripTags(value: string): string {
  let out = '';
  let at = 0;
  // Index of the next `<` or `>` at or after `at`, cached so the scan never repeats work.
  let angle = -2;
  const nextAngle = (from: number): number => {
    if (angle !== -1 && angle < from) {
      angle = from;
      while (
        angle < value.length &&
        value[angle] !== '<' &&
        value[angle] !== '>'
      )
        angle++;
      if (angle >= value.length) angle = -1;
    }
    return angle;
  };
  while (at < value.length) {
    const lt = value.indexOf('<', at);
    if (lt < 0) return out + value.slice(at);
    out += value.slice(at, lt);
    const first = value[lt + 1];
    const startsTag =
      isLetter(first) ||
      first === '!' ||
      first === '?' ||
      (first === '/' && isLetter(value[lt + 2]));
    const close = startsTag ? nextAngle(lt + 1) : -1;
    if (close >= 0 && value[close] === '>') {
      out += ' ';
      at = close + 1;
    } else {
      out += '<';
      at = lt + 1;
    }
  }
  return out;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
function decodeEntities(value: string): string {
  return value.replace(
    /&(#[0-9]{1,6}|#x[0-9a-f]{1,5}|[a-z]{2,6});/gi,
    (m, e) => {
      const name = String(e);
      if (name.startsWith('#')) {
        const hex = name[1] === 'x' || name[1] === 'X';
        const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[name.toLowerCase()] ?? m;
    },
  );
}

/**
 * Strip markup, entities, control and invisible characters, collapse whitespace and cap
 * the length (with an ellipsis). Entities are decoded between two tag passes so an
 * encoded tag cannot survive.
 */
export function sanitizeText(
  value: string,
  max: number = MAX_TEXT,
  options: { keepOperators?: boolean } = {},
): string {
  const strip = options.keepOperators ? stripTags : stripAllAngles;
  // Bound the work before any pass; a 1 MB field costs the same as a 40 KB one.
  const bounded = value.slice(0, max * 20);
  const stripped = strip(decodeEntities(strip(stripInvisible(bounded))))
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > max
    ? `${stripped.slice(0, max).trimEnd()}…`
    : stripped;
}
