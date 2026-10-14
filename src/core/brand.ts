// Product identity shared by the CLI, configuration, indexes, and web UI.
import packageJson from '../../package.json' with { type: 'json' };

export const BRAND = {
  name: 'legislation-summary',
  displayName: 'Legislation Summary',
  envPrefix: 'LEGSUM',
  configDirName: '.legislation-summary',
  indexPrefix: 'legsum-',
  version: packageJson.version,
  repositoryUrl: packageJson.repository.url
    .replace(/^git\+/, '')
    .replace(/\.git$/, ''),
} as const;

export function envVar(suffix: string): string {
  return `${BRAND.envPrefix}_${suffix}`;
}
