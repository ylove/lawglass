// Product identity shared by the CLI, configuration, indexes, and web UI.
export const BRAND = {
  name: 'legislation-summary',
  displayName: 'Legislation Summary',
  envPrefix: 'LEGSUM',
  configDirName: '.legislation-summary',
  indexPrefix: 'legsum-',
} as const;

export function envVar(suffix: string): string {
  return `${BRAND.envPrefix}_${suffix}`;
}
