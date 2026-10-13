import { existsSync } from 'node:fs';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { describeProviderContract } from '../../../tests/contracts/provider.contract.js';
import { fakeCli, objectTranscript } from '../../../tests/llm/cli.js';
import { asset, drain, textRequest } from '../../../tests/llm/http.js';
import { objectRequest } from '../../../tests/llm/provider-tests.js';
import { ClaudeCliProvider } from './claude-cli.js';

const config = { provider: 'claude-cli', model: 'claude-sonnet-5-5' } as const;
describeProviderContract(
  'claude-cli recorded subprocess',
  () =>
    new ClaudeCliProvider(config, {
      spawn: fakeCli({
        transcript: (prompt) =>
          prompt.includes('Return only JSON')
            ? objectTranscript()
            : asset('claude-cli.jsonl'),
      }).spawn,
    }),
);
describe('Claude CLI isolation and lifecycle', () => {
  it('sends the full conversation via stdin with no tools, isolated cwd and explicit model', async () => {
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
        usage: { inputTokens: 2003, outputTokens: 6 },
        stopReason: 'end_turn',
      },
    ]);
    const call = fake.calls[0]!;
    expect(call.command).toBe('claude');
    for (const [flag, value] of [
      ['--tools', ''],
      ['--mcp-config', '{"mcpServers":{}}'],
      ['--max-turns', '1'],
      ['--model', config.model],
      ['--setting-sources', ''],
    ]) {
      expect(call.args[call.args.indexOf(flag!) + 1]).toBe(value);
    }
    expect(call.args).toEqual(
      expect.arrayContaining([
        '--strict-mcp-config',
        '--safe-mode',
        '--disable-slash-commands',
        '--no-session-persistence',
      ]),
    );
    expect(call.args.join(' ')).not.toMatch(
      /bypass|dangerously|untrusted bill text|ignored-provider-key/,
    );
    expect(JSON.parse(call.prompt)).toMatchObject({
      messages: [
        { role: 'user', content: 'untrusted bill text' },
        { role: 'assistant', content: 'Prior' },
      ],
    });
    expect(call.emptyCwd).toBe(true);
    expect(call.options.shell).toBe(false);
    expect(existsSync(String(call.options.cwd))).toBe(false);
  });
  it('validates structured output', async () => {
    expect(
      (
        await new ClaudeCliProvider(
          config,
          fakeCli({ transcript: objectTranscript() }),
        ).generateObject(objectRequest)
      ).object,
    ).toEqual({ billNumber: null, sponsors: null });
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
    await expect(
      drain(new ClaudeCliProvider({ ...config, timeoutMs: 30 }, fake)),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(fake.children[0]!.kills).toContain('SIGKILL');
    expect(existsSync(String(fake.calls[0]!.options.cwd))).toBe(false);
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
