import type { DocDetail } from '../../core/model/index.js';

const FORMAT_LABEL: Record<DocDetail['doc']['format'], string> = {
  pdf: 'PDF',
  xml: 'XML',
  html: 'Web page',
  text: 'Plain text',
};

/** "The document": where it was read from and what that means for citations. */
export function FactsCard({ detail }: { detail: DocDetail }) {
  let host: string | null = null;
  try {
    host = new URL(detail.doc.sourceUrl).hostname;
  } catch {
    host = null;
  }
  return (
    <section aria-labelledby="facts-title" className="card facts">
      <h3 id="facts-title">The document</h3>
      <dl>
        {host && (
          <>
            <dt>Read from</dt>
            <dd>{host}</dd>
          </>
        )}
        <dt>Format</dt>
        <dd>{FORMAT_LABEL[detail.doc.format]}</dd>
        <dt>Sections</dt>
        <dd>{detail.outline.length}</dd>
        <dt>Line numbers</dt>
        <dd>{detail.hasLineNumbers ? 'Yes' : 'No, sections only'}</dd>
      </dl>
    </section>
  );
}
