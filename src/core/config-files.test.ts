import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configFileSystem,
  ensurePrivateSubdirectory,
  readPrivateJson,
  writePrivateJson,
} from './config-files.js';

// Windows has no POSIX modes; the checks are skipped there by design.
const posix = process.platform === 'win32' ? describe.skip : describe;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'config-files-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const mode = async (path: string) => (await lstat(path)).mode & 0o777;

posix('config directory vetting (G18)', () => {
  async function dir(name: string, dirMode: number): Promise<string> {
    const path = join(root, name);
    await mkdir(path);
    await chmod(path, dirMode);
    await writeFile(join(path, 'config.json'), '{"port":1234}', {
      mode: 0o600,
    });
    return path;
  }

  it.each([0o770, 0o707, 0o777, 0o720])(
    'refuses to read from a directory with mode %o that others can write',
    async (dirMode) => {
      const path = await dir('writable', dirMode);
      await expect(
        readPrivateJson(join(path, 'config.json'), configFileSystem, vi.fn()),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        userMessage: expect.stringMatching(
          /writable by other users.*chmod 700/,
        ) as unknown,
      });
      // Refusal must not silently "fix" a directory it does not trust.
      expect(await mode(path)).toBe(dirMode);
    },
  );

  it('refuses to write into such a directory, and does not write the file', async () => {
    const path = await dir('writable', 0o777);
    await expect(
      writePrivateJson(join(path, 'new.json'), { a: 1 }, configFileSystem),
    ).rejects.toMatchObject({
      userMessage: expect.stringMatching(/chmod 700/) as unknown,
    });
    await expect(lstat(join(path, 'new.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a symlink that points at a group- or world-writable directory', async () => {
    const real = await dir('real', 0o770);
    const link = join(root, 'link');
    await symlink(real, link);
    await expect(
      readPrivateJson(join(link, 'config.json'), configFileSystem, vi.fn()),
    ).rejects.toMatchObject({
      userMessage: expect.stringMatching(/links to.*chmod 700/) as unknown,
    });
    await expect(
      writePrivateJson(join(link, 'x.json'), {}, configFileSystem),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('warns about a symlink to a private directory and leaves the target mode alone', async () => {
    const real = await dir('real', 0o700);
    const link = join(root, 'link');
    await symlink(real, link);
    const warn = vi.fn();
    await expect(
      readPrivateJson(join(link, 'config.json'), configFileSystem, warn),
    ).resolves.toEqual({ port: 1234 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/symbolic link/));
  });

  it.each([0o750, 0o755, 0o705])(
    'tightens a merely readable directory (mode %o) to 0700 and warns',
    async (dirMode) => {
      const path = await dir(`readable-${dirMode.toString(8)}`, dirMode);
      const warn = vi.fn();
      await expect(
        readPrivateJson(join(path, 'config.json'), configFileSystem, warn),
      ).resolves.toEqual({ port: 1234 });
      expect(await mode(path)).toBe(0o700);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/0700/));
    },
  );

  it('tightens on write, and creates a missing directory 0700', async () => {
    const loose = await dir('loose', 0o755);
    await writePrivateJson(join(loose, 'out.json'), { a: 1 }, configFileSystem);
    expect(await mode(loose)).toBe(0o700);
    const fresh = join(root, 'fresh', 'nested');
    await writePrivateJson(join(fresh, 'out.json'), { a: 1 }, configFileSystem);
    expect(await mode(fresh)).toBe(0o700);
  });

  it('warns without crashing when the directory cannot be tightened', async () => {
    const path = await dir('foreign', 0o755);
    const warn = vi.fn();
    const fs = {
      ...configFileSystem,
      chmod: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('x'), { code: 'EPERM' })),
    };
    await readPrivateJson(join(path, 'config.json'), fs, warn);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/Set its mode to 0700/),
    );
  });

  it('creates the model cache subdirectory 0700 and tightens an existing loose one', async () => {
    const models = join(root, 'cfg', 'models');
    await ensurePrivateSubdirectory(models);
    expect(await mode(models)).toBe(0o700);
    // A directory left behind by an older version or a permissive umask.
    await chmod(models, 0o755);
    await ensurePrivateSubdirectory(models);
    expect(await mode(models)).toBe(0o700);
  });

  it('does not chmod through a symlink, and warns when the target is loose', async () => {
    const target = join(root, 'target');
    await mkdir(target);
    await chmod(target, 0o755);
    const link = join(root, 'cfg-models');
    await symlink(target, link);
    const warn = vi.fn();
    await ensurePrivateSubdirectory(link, configFileSystem, warn);
    expect(await mode(target)).toBe(0o755);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/symbolic link/));
    // A private target needs no warning.
    await chmod(target, 0o700);
    warn.mockClear();
    await ensurePrivateSubdirectory(link, configFileSystem, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a failed chmod as a warning, not a crash', async () => {
    const models = join(root, 'cfg2', 'models');
    await mkdir(models, { recursive: true });
    await chmod(models, 0o755);
    const warn = vi.fn();
    const fs = {
      ...configFileSystem,
      chmod: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('x'), { code: 'EPERM' })),
    };
    await expect(
      ensurePrivateSubdirectory(models, fs, warn),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/0700/));
  });
});
