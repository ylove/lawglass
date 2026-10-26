/**
 * How answer text is split into paragraphs and lists. One parser for the web (which renders the
 * blocks) and the server (which draws a picture per list item, #343), so both number the items
 * the same way and a picture is attached to the item it was drawn from. Pure, no Node imports.
 */

const LIST_ITEM = /^\s*(?:[-*]|(\d+)\.)\s+(?=\S)/;

export interface AnswerBlock {
  kind: 'p' | 'ul' | 'ol';
  /** Paragraph lines, or list items without their bullet or number. */
  lines: string[];
  /** The first number of an ordered list. */
  start: number;
  /** The source line the block starts on; stable across renders, used as a React key. */
  key: number;
}

/** Paragraphs are separated by blank lines; consecutive item lines of one kind form a list. */
export function answerBlocks(text: string): AnswerBlock[] {
  const result: AnswerBlock[] = [];
  let block: AnswerBlock | undefined;
  for (const [index, line] of text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .entries()) {
    if (!line.trim()) {
      block = undefined;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    const kind = item ? (item[1] === undefined ? 'ul' : 'ol') : 'p';
    if (block?.kind !== kind) {
      block = { kind, lines: [], start: Number(item?.[1] ?? 1), key: index };
      result.push(block);
    }
    block.lines.push(item ? line.slice(item[0].length) : line);
  }
  return result;
}

export interface ListItem {
  /** Position among all list items of the text, in reading order, counting from 0. */
  index: number;
  /** The item's text without its bullet, exactly as written (citation markers included). */
  text: string;
}

/** Every list item of the text, numbered across all of its lists. */
export function listItems(text: string): ListItem[] {
  return answerBlocks(text)
    .filter((block) => block.kind !== 'p')
    .flatMap((block) => block.lines)
    .map((line, index) => ({ index, text: line }));
}
