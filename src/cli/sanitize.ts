/**
 * Document text is untrusted: a candidate link or heading can carry terminal escape sequences
 * (colors, OSC 8 hyperlinks, title changes). Everything derived from a document is cleaned
 * before it is printed.
 */
const ESCAPE_SEQUENCES = new RegExp(
  [
    // OSC: ESC ] ... terminated by BEL or ESC \
    String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?`,
    // CSI: ESC [ params intermediates final
    String.raw`\u001b\[[0-?]*[ -/]*[@-~]?`,
    // Other two-character escapes
    String.raw`\u001b[@-Z\\-_]`,
  ].join('|'),
  'g',
);
// C0 and C1 controls except tab and newline.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function safeText(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, '').replace(CONTROLS, '');
}
