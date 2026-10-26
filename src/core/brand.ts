// Product identity shared by the CLI, configuration, indexes, and web UI.
import packageJson from '../../package.json' with { type: 'json' };

export const BRAND = {
  name: 'lawglass',
  displayName: 'Lawglass',
  // One line for the gate page and link previews; keep it in step with the hosted ingest hosts.
  description:
    'Plain-language answers about U.S. federal, Ohio, New York and New Jersey bills, with citations to section, page and line.',
  envPrefix: 'LAWGLASS',
  configDirName: '.lawglass',
  indexPrefix: 'lawglass-',
  version: packageJson.version,
  siteUrl: packageJson.homepage,
  repositoryUrl: packageJson.repository.url
    .replace(/^git\+/, '')
    .replace(/\.git$/, ''),
} as const;

export function envVar(suffix: string): string {
  return `${BRAND.envPrefix}_${suffix}`;
}
