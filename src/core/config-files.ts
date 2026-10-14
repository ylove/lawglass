// Shared private JSON storage. Open handles avoid a stat/read race on credential files.
import { constants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { AppError } from './model/index.js';

const warnedDirectories = new Set<string>();

const GROUP_OR_WORLD_WRITABLE = 0o022;
const GROUP_OR_WORLD_ACCESS = 0o077;

/**
 * Vet the directory that holds credentials. Never skipped for a directory that others can
 * write to: they could swap config.json for one that redirects keys. Throws in that case
 * (also when a symlink points at such a directory). Mere readability by others is tightened
 * to 0700 and reported once. Missing directories are left to the caller.
 */
async function ensurePrivateDirectory(
  directory: string,
  fs: ConfigFileSystem,
  warn: (message: string) => void,
  options: { tighten: boolean },
): Promise<void> {
  if (process.platform === 'win32') return;
  let link: boolean;
  let mode: number;
  try {
    const stat = await fs.lstat(directory);
    link = stat.isSymbolicLink();
    mode = link ? (await fs.stat(directory)).mode : stat.mode;
  } catch {
    return; // A missing directory is handled by the file open below.
  }
  if ((mode & GROUP_OR_WORLD_WRITABLE) !== 0)
    throw storageError(
      `Refusing to use the local data directory: ${link ? 'the directory it links to is' : 'it is'} writable by other users. Run chmod 700 on it.`,
    );
  if (link) {
    // chmod would follow the link and change a directory that is not ours.
    if (!warnedDirectories.has(directory)) {
      warnedDirectories.add(directory);
      warn('The local data directory is a symbolic link.');
    }
    return;
  }
  if ((mode & GROUP_OR_WORLD_ACCESS) === 0) return;
  let tightened = false;
  if (options.tighten) {
    try {
      await fs.chmod(directory, 0o700);
      tightened = true;
    } catch {
      // Not our directory: fall through to the warning.
    }
  }
  if (warnedDirectories.has(directory)) return;
  warnedDirectories.add(directory);
  warn(
    tightened
      ? 'The local data directory was accessible to other users. Its mode is now 0700.'
      : 'The local data directory is accessible to other users. Set its mode to 0700.',
  );
}

/** Create a private (0700) subdirectory of the config directory, such as the model cache. */
export async function ensurePrivateSubdirectory(
  directory: string,
  fs: ConfigFileSystem = configFileSystem,
): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
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
  await ensurePrivateDirectory(
    dirname(path),
    fs,
    warn ??
      ((message) => {
        console.warn(`Configuration warning: ${message}`);
      }),
    { tighten: true },
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
    await ensurePrivateDirectory(
      dirname(path),
      fs,
      (message) => {
        console.warn(`Configuration warning: ${message}`);
      },
      { tighten: true },
    );
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
  } catch (error) {
    // Our own refusal says how to fix the directory; anything else may hold secrets.
    if (error instanceof AppError) throw error;
    throw storageError('The local data file could not be saved.');
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}
