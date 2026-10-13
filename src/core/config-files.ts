// Shared private JSON storage. Open handles avoid a stat/read race on credential files.
import { constants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { AppError } from './model/index.js';

export type ConfigFileSystem = Pick<
  typeof nodeFs,
  'open' | 'mkdir' | 'chmod' | 'rename' | 'unlink' | 'access' | 'stat'
>;
export const configFileSystem: ConfigFileSystem = nodeFs;

export function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === 'ENOENT';
}

export function storageError(message: string): AppError {
  // Filesystem errors and JSON/schema failures can contain credentials. Do not retain a cause.
  return new AppError('INVALID_INPUT', message, { userMessage: message });
}

export async function readPrivateJson(
  path: string,
  fs: ConfigFileSystem,
  warn?: (message: string) => void,
): Promise<unknown> {
  let handle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw storageError('The local data file could not be opened.');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw storageError('The local data path must be a regular file.');
    if ((stat.mode & 0o077) !== 0) {
      const message = 'Refusing to read the local data file: group or world permissions are enabled. Set its mode to 0600.';
      if (!warn) throw storageError(message);
      warn(message);
      return undefined;
    }
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } catch {
    throw storageError('The local data file could not be read. Check its contents and permissions.');
  } finally {
    await handle.close();
  }
}

export async function writePrivateJson(
  path: string,
  data: unknown,
  fs: ConfigFileSystem,
): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.chmod(dirname(path), 0o700);
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, path);
  } catch {
    throw storageError('The local data file could not be saved.');
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}
