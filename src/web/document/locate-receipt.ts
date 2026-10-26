import { BRAND } from '../../core/brand.js';
import type { DocDetail, LocateMatch } from '../../core/model/index.js';
import { LABEL_TEXT } from './locate-label-text.js';
import { stripMarkers } from '../AnswerText.js';

/** The receipt preserves removal status and limits even when pasted into plain text. */
export function buildReceipt(
  match: LocateMatch,
  detail: DocDetail,
): { plain: string; markdown: string } {
  const quote = match.quote
    .map((s) => (s.status === 'deleted' ? `[removed: ${s.text}]` : s.text))
    .join('');
  const bill =
    detail.doc.billNumber ??
    detail.metadata.billNumber ??
    detail.doc.title ??
    detail.metadata.title ??
    detail.doc.label;
  const version =
    detail.history?.versions.find((v) => v.url === detail.doc.sourceUrl) ??
    detail.history?.versions.find((v) => v.label === detail.metadata.version);
  const versionText =
    version?.label ?? detail.metadata.version ?? 'Version not stated';
  const date = version?.date ? ` (${version.date})` : '';
  const { pageStart, pageEnd, lineStart, lineEnd } = match.location;
  const page =
    pageStart === undefined
      ? ''
      : `, page ${String(pageStart)}${pageEnd !== undefined && pageEnd !== pageStart ? `–${String(pageEnd)}` : ''}`;
  const lines =
    lineStart === undefined
      ? ''
      : `, lines ${String(lineStart)}${lineEnd !== undefined && lineEnd !== lineStart ? `–${String(lineEnd)}` : ''}`;
  const explanation = stripMarkers(match.explanation)
    .replace(/(?<!\s)\s+([.,;!?])/g, '$1')
    .trim();
  const sentence = (text: string): string =>
    /[.!?]$/.test(text) ? text : `${text}.`;
  const conditions = match.conditions
    ? ` Conditions: ${sentence(stripMarkers(match.conditions).trim())}`
    : '';
  const amends = match.amends ? ` Changes ${match.amends}.` : '';
  const status = ` Status: ${LABEL_TEXT[match.label]}.`;
  const beforeSource = `"${quote}" — ${bill}, ${match.breadcrumb}${page}${lines}, ${versionText}${date}.${status} ${sentence(explanation)}${conditions}${amends}`;
  const footer = `Found with ${BRAND.displayName}; not legal advice.`;
  // Escaping keeps source text from becoming Markdown instructions or forged links.
  const escaped = beforeSource.replace(/[\\`*_{}[\]<>#!|]/g, '\\$&');
  const url = detail.doc.sourceUrl;
  return {
    plain: `${beforeSource} Source: ${url}. ${footer}`,
    markdown: `${escaped} Source: [Official source](<${url.replaceAll('<', '%3C').replaceAll('>', '%3E')}>). ${footer}`,
  };
}

export async function copyReceipt(
  receipt: ReturnType<typeof buildReceipt>,
): Promise<void> {
  const clipboard = navigator.clipboard as Partial<Clipboard> | undefined;
  if (
    typeof clipboard?.write === 'function' &&
    typeof ClipboardItem !== 'undefined'
  ) {
    try {
      await clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([receipt.plain], { type: 'text/plain' }),
          'text/markdown': new Blob([receipt.markdown], {
            type: 'text/markdown',
          }),
        }),
      ]);
      return;
    } catch {
      /* Some browsers expose write but reject text/markdown. */
    }
  }
  if (!clipboard?.writeText) throw new Error('Clipboard unavailable.');
  await clipboard.writeText(receipt.plain);
}
