import { BRAND } from '../../core/brand.js';

/** Shown instead of an error cascade when the browser cannot reach the local server at all. */
export function ServerDownCard({ onRetry }: { onRetry: () => void }) {
  return (
    <section aria-labelledby="server-down-title" className="card server-down">
      <h2 id="server-down-title">
        {BRAND.displayName}'s local server isn't running
      </h2>
      <p>
        Start it with <code>npx {BRAND.name} serve</code> (or{' '}
        <code>npx {BRAND.name} &lt;url&gt;</code>), then Retry.
      </p>
      <button type="button" className="btn primary" onClick={onRetry}>
        Retry
      </button>
    </section>
  );
}
