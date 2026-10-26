/** The mock API's sample document, as the address-bar path that opens it. */
export const SAMPLE_PATH = `/doc/${'a'.repeat(64)}`;

// The tests/ project is compiled without the DOM lib, so describe just what is used here.
interface BrowserHistory {
  replaceState(data: unknown, unused: string, url: string): void;
}

/** Point the (shared) test window at a path before rendering the app. */
export function visit(path: string): void {
  (globalThis as unknown as { history: BrowserHistory }).history.replaceState(
    {},
    '',
    path,
  );
}
