import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { describeProviderContract } from '../../../tests/contracts/provider.contract.js';
import { fakeCli, objectTranscript } from '../../../tests/llm/cli.js';
import { asset, drain, textRequest } from '../../../tests/llm/http.js';
import { objectRequest } from '../../../tests/llm/provider-tests.js';
import { envVar } from '../brand.js';
import { ClaudeCliProvider } from './claude-cli.js';

const config = { provider: 'claude-cli', model: 'claude-sonnet-5-5' } as const;
describeProviderContract(
  'claude-cli recorded subprocess',
  () =>
    new ClaudeCliProvider(config, {
      spawn: fakeCli({
        transcript: (_prompt, systemPrompt) =>
          systemPrompt.includes('Return only JSON')
            ? objectTranscript()
            : asset('claude-cli.jsonl'),
      }).spawn,
    }),
);
describe('Claude CLI isolation and lifecycle', () => {
  it('joins message parts into one string on stdin', async () => {
    const fake = fakeCli();
    const provider = new ClaudeCliProvider(config, fake);
    await drain(provider, {
      ...textRequest,
      messages: [
        {
          role: 'user',
          content: [
            { text: 'The bill. ', cache: true },
            { text: 'The question.' },
          ],
        },
      ],
    });
    expect(JSON.parse(fake.calls[0]!.prompt)).toEqual({
      messages: [{ role: 'user', content: 'The bill. The question.' }],
    });
  });

  it('replays the recorded transcript with a real system prompt, stdin conversation and isolated cwd', async () => {
    const fake = fakeCli();
    const provider = new ClaudeCliProvider(
      { ...config, apiKey: 'ignored-provider-key' },
      fake,
    );
    const events = await drain(provider, {
      ...textRequest,
      messages: [
        { role: 'user', content: 'untrusted bill text' },
        { role: 'assistant', content: 'Prior' },
      ],
    });
    expect(events).toEqual([
      { type: 'text', text: 'Hello.' },
      {
        type: 'done',
        usage: {
          inputTokens: 2003,
          outputTokens: 6,
          cacheReadTokens: 535,
          cacheWriteTokens: 1466,
        },
        stopReason: 'end_turn',
      },
    ]);
    const call = fake.calls[0]!;
    expect(call.command).toBe('claude');
    const systemPromptFile = join(
      String(call.options.cwd),
      'system-prompt.txt',
    );
    expect(call.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--max-turns',
      '1',
      '--model',
      config.model,
      '--system-prompt-file',
      systemPromptFile,
      '--safe-mode',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-session-persistence',
    ]);
    expect(call.args.join(' ')).not.toMatch(
      /bypass|dangerously|untrusted bill text|ignored-provider-key/,
    );
    expect(JSON.parse(call.prompt)).toEqual({
      messages: [
        { role: 'user', content: 'untrusted bill text' },
        { role: 'assistant', content: 'Prior' },
      ],
    });
    expect(call.systemPrompt).toBe(textRequest.system);
    expect(call.systemPromptMode).toBe(0o600);
    expect(call.cwdFiles).toEqual(['system-prompt.txt']);
    expect(call.options.shell).toBe(false);
    expect(existsSync(systemPromptFile)).toBe(false);
    expect(existsSync(String(call.options.cwd))).toBe(false);
  });
  it('writes long system prompts only to the temporary file', async () => {
    const system = 'Follow these legislation instructions.\n'.repeat(10_000);
    const fake = fakeCli();
    await drain(new ClaudeCliProvider(config, fake), {
      ...textRequest,
      system,
    });
    const call = fake.calls[0]!;
    expect(call.systemPrompt).toBe(system);
    expect(call.args.join(' ')).not.toContain(
      'Follow these legislation instructions',
    );
    expect(call.prompt).toBe(
      JSON.stringify({ messages: textRequest.messages }),
    );
    expect(existsSync(String(call.options.cwd))).toBe(false);
  });
  it('allows only basic process settings and Claude/Anthropic configuration in the child env', async () => {
    const permitted = {
      PATH: '/test/bin',
      HOME: '/test/home',
      USER: 'test',
      LOGNAME: 'test',
      SHELL: '/bin/sh',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      LC_MESSAGES: 'C',
      TERM: 'xterm',
      CLAUDE_CONFIG_DIR: '/test/claude',
      CLAUDE_CODE_OAUTH_TOKEN: 'test-cli-token',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    };
    const excluded = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'GOOGLE_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GEMINI_API_KEY',
      'PINECONE_API_KEY',
      envVar('OPENAI_API_KEY'),
      envVar('PROVIDER'),
      'NODE_OPTIONS',
      'UNRELATED_SECRET',
    ];
    try {
      for (const [name, value] of Object.entries(permitted))
        vi.stubEnv(name, value);
      for (const name of excluded)
        vi.stubEnv(name, 'test-other-provider-secret');
      const fake = fakeCli();
      await drain(new ClaudeCliProvider(config, fake));
      const env = fake.calls[0]!.options.env!;
      expect(env).toMatchObject(permitted);
      for (const name of excluded) expect(env).not.toHaveProperty(name);
      expect(
        Object.keys(env).every(
          (name) =>
            Object.hasOwn(permitted, name) ||
            name.startsWith('LC_') ||
            name.startsWith('CLAUDE_') ||
            name.startsWith('ANTHROPIC_'),
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    ['unset', undefined, false],
    ['0', '0', false],
    ['true', 'true', false],
    ['1', '1', true],
  ])(
    'forwards Anthropic API credentials only when %s opts in (%s -> %s)',
    async (_label, optIn, forwarded) => {
      try {
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-CANARY-env');
        vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'CANARY-auth-token');
        vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.anthropic.com');
        vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'login-token');
        vi.stubEnv(envVar('CLAUDE_CLI_USE_API_KEY'), optIn ?? '');
        const fake = fakeCli();
        await drain(new ClaudeCliProvider(config, fake));
        const env = fake.calls[0]!.options.env!;
        expect(env.ANTHROPIC_API_KEY).toBe(
          forwarded ? 'sk-ant-CANARY-env' : undefined,
        );
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe(
          forwarded ? 'CANARY-auth-token' : undefined,
        );
        // Login-based configuration always survives, so the subscription is billed.
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('login-token');
        expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
  it.each([
    '--dangerously-skip-permissions',
    '-p',
    '',
    ' sonnet',
    'sonnet --tools Bash',
    'a'.repeat(101),
    '.hidden',
    'model\nx',
    'model;rm',
  ])('rejects model %j before any process is spawned', (model) => {
    const fake = fakeCli();
    expect(() => new ClaudeCliProvider({ ...config, model }, fake)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(fake.calls).toHaveLength(0);
  });
  it.each([
    'sonnet',
    'claude-sonnet-5-5',
    'a'.repeat(100),
    'x.y_z:1-2'.replace('_', '.'),
  ])('accepts model %j', (model) => {
    expect(new ClaudeCliProvider({ ...config, model }, fakeCli()).model).toBe(
      model,
    );
  });
  it('validates structured output', async () => {
    const fake = fakeCli({ transcript: objectTranscript() });
    expect(
      (await new ClaudeCliProvider(config, fake).generateObject(objectRequest))
        .object,
    ).toEqual({ billNumber: null, sponsors: null });
    expect(fake.calls[0]!.systemPrompt).toContain(
      'Return only JSON matching this schema:',
    );
    expect(fake.calls[0]!.systemPrompt).toContain('billNumber');
    expect(JSON.parse(fake.calls[0]!.prompt)).toEqual({
      messages: [{ role: 'user', content: objectRequest.prompt }],
    });
    await expect(
      new ClaudeCliProvider(config, fakeCli()).generateObject(objectRequest),
    ).rejects.toMatchObject({ code: 'PROVIDER_BAD_OUTPUT' });
  });
  it.each([
    { transcript: 'bad json\n', code: 'PROVIDER_BAD_OUTPUT' },
    { transcript: '{"type":1}\n', code: 'PROVIDER_BAD_OUTPUT' },
    { transcript: '', code: 'PROVIDER_ERROR' },
    {
      transcript:
        '{"type":"result","subtype":"error","is_error":true,"result":"private request body"}\n',
      code: 'PROVIDER_ERROR',
    },
    {
      transcript:
        '{"type":"result","subtype":"success"}\n{"type":"result","subtype":"success"}\n',
      code: 'PROVIDER_BAD_OUTPUT',
    },
  ])(
    'rejects malformed or unsuccessful transcripts ($code)',
    async ({ transcript, code }) => {
      const fake = fakeCli({ transcript });
      const error: unknown = await drain(
        new ClaudeCliProvider(config, fake),
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code });
      expect(inspect(error)).not.toContain('private request body');
      expect(existsSync(String(fake.calls[0]!.options.cwd))).toBe(false);
    },
  );
  it('handles missing usage and a final result without deltas', async () => {
    const fake = fakeCli({
      transcript:
        '\n{"type":"system"}\n{"type":"result","subtype":"success","result":"Final only"}',
    });
    expect(await drain(new ClaudeCliProvider(config, fake))).toEqual([
      { type: 'text', text: 'Final only' },
      {
        type: 'done',
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);
  });
  it.each([{ error: true }, { code: 2 }, { stdinError: true }])(
    'sanitizes spawn, stdin and exit failures',
    async (options) => {
      await expect(
        drain(new ClaudeCliProvider(config, fakeCli(options))),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', cause: undefined });
    },
  );
  it('sanitizes synchronous spawn failures and removes the temp dir', async () => {
    let cwd = '';
    await expect(
      drain(
        new ClaudeCliProvider(config, {
          spawn: (_command, _args, options) => {
            cwd = String(options.cwd);
            throw new Error('private request body');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', cause: undefined });
    expect(existsSync(cwd)).toBe(false);
  });
  it('kills timed out children and removes their cwd', async () => {
    const fake = fakeCli({ stall: true });
    const timeout = new AbortController();
    let notifySpawn: () => void;
    const spawned = new Promise<void>((resolve) => {
      notifySpawn = resolve;
    });
    // Node's AbortSignal.timeout uses internal timers that vi.useFakeTimers does not replace.
    const timeoutSignal = vi.fn((timeoutMs: number) => {
      setTimeout(() => {
        timeout.abort(new DOMException('Timed out', 'TimeoutError'));
      }, timeoutMs);
      return timeout.signal;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = drain(
      new ClaudeCliProvider(
        { ...config, timeoutMs: 30 },
        {
          timeoutSignal,
          spawn: (...args) => {
            const child = fake.spawn(...args);
            notifySpawn();
            return child;
          },
        },
      ),
    );
    // Attach the rejection assertion before firing the timer to avoid an unhandled rejection.
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    try {
      // Let filesystem setup finish before advancing time; no real deadline races the I/O.
      await spawned;
      expect(timeoutSignal).toHaveBeenCalledExactlyOnceWith(30);
      const child = fake.children[0]!;
      const cwd = String(fake.calls[0]!.options.cwd);
      expect(existsSync(cwd)).toBe(true);
      await vi.advanceTimersByTimeAsync(29);
      expect(child.kills).toEqual([]);
      expect(timeout.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(child.kills).toEqual(['SIGKILL']);
      expect(child.signalCode).toBe('SIGKILL');
      expect(existsSync(cwd)).toBe(false);
    } finally {
      timeout.abort();
      await pending.catch(() => undefined);
      vi.useRealTimers();
    }
  });
  it('kills an aborted child and aborts before spawning when already cancelled', async () => {
    const fake = fakeCli({ stall: true });
    const ac = new AbortController();
    const pending = drain(new ClaudeCliProvider(config, fake), {
      ...textRequest,
      signal: ac.signal,
    });
    await vi.waitFor(() => {
      expect(fake.calls).toHaveLength(1);
    });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(fake.children[0]!.kills).toContain('SIGKILL');
    const pre = fakeCli();
    await expect(
      drain(new ClaudeCliProvider(config, pre), {
        ...textRequest,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(pre.calls).toHaveLength(0);
  });
  it('cleans up when the consumer stops after a text event', async () => {
    const transcript =
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}}\n';
    const fake = fakeCli({ transcript });
    const iterator = new ClaudeCliProvider(config, fake)
      .streamText(textRequest)
      [Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(existsSync(String(fake.calls[0]!.options.cwd))).toBe(false);
  });
  it('blocks real CLI execution in CI but allows injected replay', () => {
    vi.stubEnv('CI', 'true');
    try {
      expect(() => new ClaudeCliProvider(config)).toThrow(
        expect.objectContaining({ code: 'PROVIDER_ERROR' }),
      );
      expect(new ClaudeCliProvider(config, fakeCli()).id).toBe('claude-cli');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
