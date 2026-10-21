import { expect, test } from 'vitest';
import { endpointIdentity } from './endpoint.js';

test('names the default endpoint of every provider explicitly', () => {
  expect(endpointIdentity('anthropic')).toBe('https://api.anthropic.com:443');
  expect(endpointIdentity('openai')).toBe('https://api.openai.com:443');
  expect(endpointIdentity('google')).toBe(
    'https://generativelanguage.googleapis.com:443',
  );
  expect(endpointIdentity('claude-cli')).toBe('claude-cli:local');
  expect(endpointIdentity('mock')).toBe('mock:local');
});

test('an OpenAI-compatible base URL is reduced to scheme, host and port', () => {
  expect(endpointIdentity('openai', 'http://localhost:11434/v1')).toBe(
    'http://localhost:11434',
  );
  expect(
    endpointIdentity('openai', 'https://proxy.example.com/openai/v1'),
  ).toBe('https://proxy.example.com:443');
  expect(endpointIdentity('openai', 'http://gateway.local')).toBe(
    'http://gateway.local:80',
  );
  expect(endpointIdentity('openai', 'http://[::1]:8080/v1')).toBe(
    'http://[::1]:8080',
  );
});

test('equivalent spellings share one identity', () => {
  const canonical = endpointIdentity('openai', 'https://API.Example.com/v1');
  expect(endpointIdentity('openai', 'https://api.example.com:443/other')).toBe(
    canonical,
  );
  expect(endpointIdentity('openai', ' https://api.example.com ')).toBe(
    canonical,
  );
});

test('different endpoints, ports and schemes do not collide', () => {
  const identities = new Set([
    endpointIdentity('openai'),
    endpointIdentity('openai', 'https://api.example.com'),
    endpointIdentity('openai', 'https://api.example.com:8443'),
    endpointIdentity('openai', 'http://api.example.com'),
    endpointIdentity('openai', 'http://localhost:1234'),
  ]);
  expect(identities.size).toBe(5);
});

test('never carries credentials, path, query or fragment', () => {
  const identity = endpointIdentity(
    'openai',
    'https://user:s3cret-token@proxy.example.com/v1/secret-path?key=sk-123#frag',
  );
  expect(identity).toBe('https://proxy.example.com:443');
  for (const secret of ['user', 's3cret', 'secret-path', 'sk-123', 'frag'])
    expect(identity).not.toContain(secret);
});

test('only the OpenAI provider honors a base URL', () => {
  expect(endpointIdentity('anthropic', 'https://evil.example.com')).toBe(
    'https://api.anthropic.com:443',
  );
});

test('a blank base URL means the default', () => {
  expect(endpointIdentity('openai', '  ')).toBe('https://api.openai.com:443');
});

test('an unparseable base URL is an error rather than a shared identity', () => {
  expect(() => endpointIdentity('openai', 'not a url')).toThrow();
});
