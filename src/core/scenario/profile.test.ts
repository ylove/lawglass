import { describe, expect, it } from 'vitest';
import { exampleScenario } from '../../../tests/synth/scenario.js';
import {
  composeSetupFrames,
  setupCaption,
  validProfileLabel,
  validAssumptionUnit,
} from './profile.js';

describe('code-composed example profiles', () => {
  it.each([
    'Example employee',
    "Example worker's household",
    'Example self-employed worker',
    "Example part-time worker's household a b c d",
    'Example a b c d e f g',
    `Example ${'a'.repeat(52)}`,
  ])('accepts a bounded descriptive label: %s', (label) => {
    expect(validProfileLabel(label)).toBe(true);
  });
  it.each([
    '',
    'Example 52',
    'Example: employee',
    'Example a b c d e f g h',
    `Example ${'a'.repeat(53)}`,
    'Example exempts households',
    'Example office establishes taxes',
  ])('rejects claim text and invalid labels: %s', (label) => {
    expect(validProfileLabel(label)).toBe(false);
  });
  it('renders money, decimals and non-money assumptions in a deterministic template', () => {
    const profile = exampleScenario().profile;
    profile.assumptions = [
      { key: 'income', label: 'annual income', value: 52000, unit: 'USD' },
      { key: 'time', label: 'filing period', value: 2.5, unit: 'days' },
    ];
    expect(setupCaption(profile)).toBe(
      'This is Alex. Example employee. Example: annual income $52,000. Example: filing period 2.5 days.',
    );
    profile.assumptions = [];
    expect(setupCaption(profile)).toBe('This is Alex. Example employee.');
  });
  it('replaces every model setup and its figures without changing input or other frames', () => {
    const scenario = exampleScenario();
    scenario.frames[0]!.caption = 'The office abolishes all tax.';
    scenario.frames[0]!.figures = [{ source: 'bill', value: 7, unit: 'USD' }];
    const original = structuredClone(scenario);
    const composed = composeSetupFrames(scenario);
    expect(composed.frames[0]!.caption).toBe(setupCaption(scenario.profile));
    expect(composed.frames[0]!.figures).toEqual([
      { source: 'assumption', value: 50000, unit: 'USD' },
    ]);
    expect(composed.frames.slice(1)).toEqual(original.frames.slice(1));
    expect(scenario).toEqual(original);
  });
});

it('accepts known unit aliases while rejecting claim-bearing units', () => {
  for (const unit of [
    'USD',
    '$',
    'dollars',
    '%',
    'percent',
    'days',
    'years',
    'bedrooms',
    'count',
  ])
    expect(validAssumptionUnit(unit)).toBe(true);
  for (const unit of ['abolishes all tax', 'ban', '', 'unknown'])
    expect(validAssumptionUnit(unit)).toBe(false);
});
