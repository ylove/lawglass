import { join } from 'node:path';
import { BillHistory, NormalizedDoc } from '../model/index.js';
import {
  configFileSystem,
  isMissingFile,
  readPrivateJson,
  storageError,
  writePrivateJson,
  type ConfigFileSystem,
} from '../config-files.js';

function historyPath(configDir: string, docId: string): string {
  if (!NormalizedDoc.shape.docId.safeParse(docId).success)
    throw storageError('Invalid document id. Use the full document hash.');
  return join(configDir, 'history', `${docId}.json`);
}

export async function writeHistory(
  configDir: string,
  docId: string,
  history: BillHistory,
  fs: ConfigFileSystem = configFileSystem,
): Promise<void> {
  const parsed = BillHistory.safeParse(history);
  if (!parsed.success) throw storageError('The bill history is invalid.');
  await writePrivateJson(historyPath(configDir, docId), parsed.data, fs);
}

export async function readHistory(
  configDir: string,
  docId: string,
  fs: ConfigFileSystem = configFileSystem,
): Promise<BillHistory | undefined> {
  const value = await readPrivateJson(historyPath(configDir, docId), fs);
  if (value === undefined) return undefined;
  const parsed = BillHistory.safeParse(value);
  if (!parsed.success)
    throw storageError('The cached bill history is invalid.');
  return parsed.data;
}

export async function deleteHistory(
  configDir: string,
  docId: string,
  fs: ConfigFileSystem = configFileSystem,
): Promise<void> {
  try {
    await fs.unlink(historyPath(configDir, docId));
  } catch (error) {
    if (!isMissingFile(error))
      throw storageError('The cached bill history could not be removed.');
  }
}
