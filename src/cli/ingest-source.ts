import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalFile } from '../core/fetch/local-file.js';
import { AppError } from '../core/model/index.js';
import type { Fetcher } from '../core/pipeline/index.js';

interface ExistingDocument {
  docId: string;
  label: string;
}

/** Keep local-file routing out of the runtime fetcher shared with the HTTP server. */
export async function prepareIngestSource(
  input: string,
  networkFetcher: Fetcher,
  entries: readonly ExistingDocument[],
): Promise<{ fetcher: Fetcher; label?: string }> {
  if (/^https?:/i.test(input)) return { fetcher: networkFetcher };
  if (
    !/^file:/i.test(input) &&
    /^[a-z][a-z\d+.-]*:/i.test(input) &&
    !(await stat(input).then(
      () => true,
      () => false,
    ))
  )
    throw new AppError('INVALID_INPUT');

  const snapshot = await readLocalFile(input);
  const known = entries.find((entry) => entry.docId === snapshot.docId);
  const base = basename(fileURLToPath(snapshot.finalUrl))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const taken = new Set(entries.map((entry) => entry.label));
  let label = known?.label ?? (base || snapshot.docId.slice(0, 12));
  if (!known && taken.has(label)) {
    let n = 1;
    do {
      const suffix = ` (${snapshot.docId.slice(0, 6)}${n === 1 ? '' : `-${String(n)}`})`;
      label = `${base.slice(0, 80 - suffix.length)}${suffix}`;
      n++;
    } while (taken.has(label));
  }
  return { fetcher: () => Promise.resolve(snapshot), label };
}
