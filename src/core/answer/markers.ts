/**
 * The inline change markers `[struck]…[/struck]` and `[inserted]…[/inserted]`.
 *
 * Only our own code may write them. A bill is untrusted text: if it could contain a literal
 * `[/struck]`, it could close a real struck run early and make removed wording look like
 * current law (or the reverse). So every document string is neutralized before it is placed
 * next to real markers, and a chunk whose text already carries real markers is registered
 * here so `formatExcerpt` does not neutralize them a second time.
 */
import type { StoredChunk } from '../model/index.js';

/** Any spelling of a marker tag: case and inner spaces are forgiven so near-misses are caught too. */
const MARKER_LIKE = /\[(\s*(?:\/\s*)?(?:struck|inserted)\s*)\]/gi;

/**
 * Make marker-like text in a document inert by swapping its opening bracket for a full-width
 * one (`［struck]`). The words stay readable to a person; the model no longer sees a marker.
 */
export function neutralizeMarkers(text: string): string {
  return text.replace(MARKER_LIKE, '［$1]');
}

/** Wrap a run in real markers. The run must already be neutralized. */
export function struck(text: string): string {
  return `[struck]${text}[/struck]`;
}
export function inserted(text: string): string {
  return `[inserted]${text}[/inserted]`;
}

/** Chunks built by `inline-changes.ts`, whose text holds real markers around neutralized text. */
const withRealMarkers = new WeakSet<object>();

export function trustMarkers<T extends StoredChunk>(chunk: T): T {
  withRealMarkers.add(chunk);
  return chunk;
}

/** Chunk text ready for the prompt: forged markers are neutralized unless we wrote them. */
export function promptText(chunk: StoredChunk): string {
  return withRealMarkers.has(chunk)
    ? chunk.text
    : neutralizeMarkers(chunk.text);
}
