import { BRAND } from '../../core/brand.js';

/** Shown instead of an error cascade when the browser cannot reach the server at all (hosted or local). */
export function ServerDownCard({ onRetry }: { onRetry: () => void }) {
  return (
    <section aria-labelledby="server-down-title" className="card server-down">
      <h2 id="server-down-title">
        {BRAND.displayName} can't reach its server right now
      </h2>
      <p>
        If this is a hosted preview, wait a moment and reload. If you run{' '}
        {BRAND.displayName} yourself, start it with{' '}
        <code>npx {BRAND.name} serve</code>, then Retry.
      </p>
      <button type="button" className="btn primary" onClick={onRetry}>
        Retry
      </button>
    </section>
  );
}
