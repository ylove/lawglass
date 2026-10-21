/**
 * Linear-time trimming. `value.replace(/x+$/, '')` is quadratic on a long run of `x` that is not
 * at the end (the engine retries from every start in the run), so untrusted text is trimmed by
 * walking in from the edge instead. This is what the `regexp/no-super-linear-move` lint asks for.
 */

export function trimEndWhile(
  value: string,
  drop: (char: string) => boolean,
): string {
  let end = value.length;
  while (end > 0 && drop(value.charAt(end - 1))) end--;
  return value.slice(0, end);
}

export function trimStartWhile(
  value: string,
  drop: (char: string) => boolean,
): string {
  let start = 0;
  while (start < value.length && drop(value.charAt(start))) start++;
  return value.slice(start);
}

export function trimEdgesWhile(
  value: string,
  drop: (char: string) => boolean,
): string {
  return trimStartWhile(trimEndWhile(value, drop), drop);
}
