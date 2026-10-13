// Local web UI shell; document screens arrive in later issues.
import { BRAND } from '../core/brand.js';

export function App() {
  return (
    <main>
      <h1>{BRAND.displayName}</h1>
      <footer>
        Not legal advice. Answers are generated only from the text of this
        document.
      </footer>
    </main>
  );
}
