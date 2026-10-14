import { afterEach, expect, test, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })));
vi.mock('node:child_process', () => ({ spawn }));

afterEach(() => {
  vi.restoreAllMocks();
  spawn.mockClear();
});

test.each([
  ['darwin', 'open'],
  ['linux', 'xdg-open'],
  ['win32', 'cmd'],
])('openBrowser uses the right command on %s', async (platform, command) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(
    platform as NodeJS.Platform,
  );
  const { openBrowser } = await import('./serve.js');
  await openBrowser('http://localhost:4317');
  expect(spawn).toHaveBeenCalledWith(
    command,
    expect.arrayContaining(['http://localhost:4317']),
    expect.objectContaining({ stdio: 'ignore', detached: true }),
  );
});
