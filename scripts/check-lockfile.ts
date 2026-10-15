import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

/**
 * Supply-chain check for package-lock.json: every installed package must come from the public npm
 * registry over HTTPS and carry an integrity hash. This blocks a lockfile edited (or a dependency
 * PR) to point at a git URL, tarball host or plain-HTTP mirror, and a missing hash that would let
 * npm accept altered bytes.
 */
const REGISTRY_PREFIX = 'https://registry.npmjs.org/';

const Lockfile = z.object({
  lockfileVersion: z.number().int().min(2),
  packages: z.record(
    z.string(),
    z.object({
      resolved: z.string().optional(),
      integrity: z.string().optional(),
      link: z.boolean().optional(),
    }),
  ),
});

export function findLockfileViolations(raw: string): string[] {
  const parsed = Lockfile.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return [
      'package-lock.json is not a lockfileVersion 2+ file with a "packages" map',
    ];
  }
  const violations: string[] = [];
  for (const [path, entry] of Object.entries(parsed.data.packages)) {
    // "" is the root project; entries outside node_modules are workspace sources; links point
    // at those. None of them are downloaded from a registry.
    if (path === '' || entry.link || !path.includes('node_modules/')) continue;
    const name = path.slice(
      path.lastIndexOf('node_modules/') + 'node_modules/'.length,
    );
    if (!entry.resolved?.startsWith(REGISTRY_PREFIX)) {
      violations.push(
        `${name}: resolved must start with ${REGISTRY_PREFIX} (got ${entry.resolved ?? 'nothing'})`,
      );
    }
    if (!entry.integrity) violations.push(`${name}: missing integrity hash`);
  }
  return violations;
}

// import.meta.main needs Node 22.18+; engines allows 22.13, where it would silently do nothing.
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const violations = findLockfileViolations(
    readFileSync(process.argv[2] ?? 'package-lock.json', 'utf8'),
  );
  if (violations.length) {
    console.error(
      `Lockfile check failed:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
    process.exit(1);
  }
  console.log(
    'Lockfile check passed: all packages resolve to the npm registry with integrity.',
  );
}
