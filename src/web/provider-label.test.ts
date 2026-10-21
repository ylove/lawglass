import { expect, test } from 'vitest';
import { dataNote } from './provider-label.js';

test.each([
  ['anthropic', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['google', 'Google'],
  ['claude-cli', 'Claude through your local Claude Code'],
])('names the provider for %s', (id, who) => {
  expect(dataNote(id)).toBe(
    `Bill text and your questions are sent to ${who} to write answers.`,
  );
});

test('says nothing for mock or unknown providers', () => {
  expect(dataNote('mock')).toBeNull();
  expect(dataNote('something-else')).toBeNull();
});
