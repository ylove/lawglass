import { expect, test } from 'vitest';
import { BRAND, envVar } from './brand.js';
import packageJson from '../../package.json' with { type: 'json' };

test('package name and sole CLI bin key match the configured brand', () => {
  expect(packageJson.name).toBe(BRAND.name);
  expect(Object.keys(packageJson.bin)).toEqual([BRAND.name]);
});

test('environment variables use the configured brand prefix', () => {
  expect(envVar('MAX_DOCS')).toBe(`${BRAND.envPrefix}_MAX_DOCS`);
  expect(envVar('LLM_PROVIDER')).toBe(`${BRAND.envPrefix}_LLM_PROVIDER`);
});

test('fetch identity uses package version and the repository’s HTTPS URL', () => {
  expect(BRAND.version).toBe(packageJson.version);
  expect(`${BRAND.repositoryUrl}.git`).toBe(
    packageJson.repository.url.replace(/^git\+/, ''),
  );
  expect(new URL(BRAND.repositoryUrl).protocol).toBe('https:');
  expect(new URL(BRAND.siteUrl).protocol).toBe('https:');
});
