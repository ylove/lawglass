import { describe, expect, it } from 'vitest';
import { findLockfileViolations } from './check-lockfile.js';

const lock = (packages: Record<string, object>) =>
  JSON.stringify({ lockfileVersion: 3, packages });
const good = {
  resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
  integrity: 'sha512-abc',
};

describe('findLockfileViolations', () => {
  it('passes registry packages with integrity, ignoring root, workspaces and links', () => {
    expect(
      findLockfileViolations(
        lock({
          '': { name: 'x' },
          'node_modules/a': good,
          'node_modules/a/node_modules/@s/b': good,
          'packages/ws': {},
          'node_modules/ws': { resolved: 'packages/ws', link: true },
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    ['git', 'git+ssh://git@github.com/x/y.git#abc'],
    ['http', 'http://registry.npmjs.org/a/-/a-1.0.0.tgz'],
    ['other host', 'https://registry.evil.example/a/-/a-1.0.0.tgz'],
    ['lookalike', 'https://registry.npmjs.org.evil.example/a.tgz'],
  ])('rejects a %s resolved URL', (_label, resolved) => {
    const out = findLockfileViolations(
      lock({ 'node_modules/a': { ...good, resolved } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('a: resolved must start with');
  });

  it('rejects a missing resolved and a missing integrity', () => {
    const out = findLockfileViolations(
      lock({
        'node_modules/a': { integrity: 'sha512-x' },
        'node_modules/@s/b': { resolved: good.resolved },
      }),
    );
    expect(out).toEqual([
      expect.stringContaining('a: resolved must start with'),
      '@s/b: missing integrity hash',
    ]);
  });

  it('rejects files that are not a v2+ lockfile', () => {
    expect(findLockfileViolations('{}')).toHaveLength(1);
    expect(
      findLockfileViolations(
        JSON.stringify({ lockfileVersion: 1, packages: {} }),
      ),
    ).toHaveLength(1);
  });
});
