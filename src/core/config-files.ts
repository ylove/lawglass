// Shared private JSON storage. Open handles avoid a stat/read race on credential files.
import { constants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { AppError } from './model/index.js';

const warnedDirectories = new Set<string>();

/** Warn (once per directory) if the directory is a symlink or open to group/world. Never throws. */
async function checkDirectory(
  directory: string,
  fs: ConfigFileSystem,
  warn: (message: string) => void,
): Promise<void> {
  if (process.platform === 'win32' || warnedDirectories.has(directory)) return;
  let problem: string | undefined;
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink())
      problem = 'The local data directory is a symbolic link.';
    else if ((stat.mode & 0o077) !== 0)
      problem =
        'The local data directory is accessible to other users. Set its mode to 0700.';
  } catch {
    return; // A missing directory is handled by the file open below.
  }
  if (!problem) return;
  warnedDirectories.add(directory);
  warn(problem);
}

const IGNORABLE_SYNC_ERRORS = new Set([
  'EPERM',
  'EINVAL',
  'EISDIR',
  'ENOTSUP',
  'EACCES',
]);

/** Make the rename durable. Some platforms cannot fsync a directory, so those errors are ignored. */
async function syncDirectory(
  directory: string,
  fs: ConfigFileSystem,
): Promise<void> {
  try {
    const handle = await fs.open(directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : '';
    if (!IGNORABLE_SYNC_ERRORS.has(code)) throw error;
  }
}

export type ConfigFileSystem = Pick<
  typeof nodeFs,
  'open' | 'mkdir' | 'chmod' | 'rename' | 'unlink' | 'access' | 'stat' | 'lstat'
>;
export const configFileSystem: ConfigFileSystem = nodeFs;

export function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
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
  await checkDirectory(
    dirname(path),
    fs,
    warn ??
      ((message) => {
        console.warn(`Configuration warning: ${message}`);
      }),
  );
  let handle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw storageError('The local data file could not be opened.');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw storageError('The local data path must be a regular file.');
    if ((stat.mode & 0o077) !== 0) {
      const message =
        'Refusing to read the local data file: group or world permissions are enabled. Run chmod 600 on it.';
      if (!warn) throw storageError(message);
      warn(message);
      return undefined;
    }
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } catch (error) {
    // Our own messages are safe to show; anything else (I/O, JSON) may contain file contents.
    if (error instanceof AppError) throw error;
    throw storageError(
      'The local data file could not be read. Check its contents and permissions.',
    );
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
    await syncDirectory(dirname(path), fs);
  } catch {
    throw storageError('The local data file could not be saved.');
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}
