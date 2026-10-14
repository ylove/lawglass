// Product identity shared by the CLI, configuration, indexes, and web UI.
import packageJson from '../../package.json' with { type: 'json' };

export const BRAND = {
  name: 'lawglass',
  displayName: 'Lawglass',
  envPrefix: 'LAWGLASS',
  configDirName: '.lawglass',
  indexPrefix: 'lawglass-',
  version: packageJson.version,
  repositoryUrl: packageJson.repository.url
    .replace(/^git\+/, '')
    .replace(/\.git$/, ''),
} as const;

export function envVar(suffix: string): string {
  return `${BRAND.envPrefix}_${suffix}`;
}
