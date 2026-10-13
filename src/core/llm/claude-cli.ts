import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import {
  AppError,
  type LlmProvider,
  type LlmStreamEvent,
  type ObjectRequest,
  type ProviderConfig,
  type TextRequest,
} from '../model/index.js';
import {
  anthropicUsage,
  jsonSchema,
  parseJson,
  providerFailure,
  requestSignal,
  validateObject,
  ZERO_LLM_USAGE,
} from './shared.js';

export type CliSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;
const defaultSpawn: CliSpawn = (command, args, options) =>
  spawn(command, args, { ...options, stdio: 'pipe' });

/** Preserve CLI login/config and basic process settings without other providers' secrets. */
function cliEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'TERM',
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        allowed.has(name) ||
        name.startsWith('LC_') ||
        name.startsWith('CLAUDE_') ||
        name.startsWith('ANTHROPIC_'),
    ),
  );
}
const TranscriptEvent = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  event: z
    .object({
      type: z.string(),
      delta: z
        .object({ type: z.string().optional(), text: z.string().optional() })
        .optional(),
    })
    .optional(),
  usage: z
    .object({
      input_tokens: z.number().nonnegative().optional(),
      output_tokens: z.number().nonnegative().optional(),
      cache_read_input_tokens: z.number().nonnegative().optional(),
      cache_creation_input_tokens: z.number().nonnegative().optional(),
    })
    .optional(),
});

export class ClaudeCliProvider implements LlmProvider {
  readonly id = 'claude-cli' as const;
  readonly model: string;
  private readonly spawnChild: CliSpawn;

  constructor(
    private readonly config: ProviderConfig,
    deps: { spawn?: CliSpawn } = {},
  ) {
    this.model = config.model;
    this.spawnChild = deps.spawn ?? defaultSpawn;
    // Injected subprocesses are allowed for offline CI tests; real CLI execution never is.
    if (process.env.CI && !deps.spawn) throw new AppError('PROVIDER_ERROR');
  }

  async *streamText(req: TextRequest): AsyncIterable<LlmStreamEvent> {
    let cwd: string | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let closed: Promise<number | null> | undefined;
    let lines: ReturnType<typeof createInterface> | undefined;
    let signal: AbortSignal | undefined;
    let kill: (() => void) | undefined;
    try {
      signal = requestSignal(req.signal, this.config.timeoutMs);
      cwd = await mkdtemp(join(tmpdir(), 'llm-cli-'));
      const systemPromptFile = join(cwd, 'system-prompt.txt');
      await writeFile(systemPromptFile, req.system, {
        encoding: 'utf8',
        mode: 0o600,
      });
      signal.throwIfAborted();
      // Confirmed against local `claude --help` on 2026-10-13:
      // -p: non-interactive; stream-json + verbose: NDJSON events; partial: text deltas.
      // tools "": no built-in tools; strict + empty MCP: no inherited MCP servers.
      // max-turns 1: no agent loop; model: explicit caller choice.
      // safe-mode + empty setting-sources + disable-slash-commands: no user hooks,
      // plugins, project customizations or skills. No permission-bypass flag is used.
      // no-session-persistence: avoid writing prompts to saved conversations.
      // system-prompt-file replaces the CLI system prompt without argv length limits:
      // https://code.claude.com/docs/en/cli-reference (verified 2026-10-13).
      // Fresh cwd contains only our prompt file, isolating project files/settings.
      child = this.spawnChild(
        'claude',
        [
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
          this.model,
          '--system-prompt-file',
          systemPromptFile,
          '--safe-mode',
          '--setting-sources',
          '',
          '--disable-slash-commands',
          '--no-session-persistence',
        ],
        { cwd, shell: false, env: cliEnvironment() },
      );
      const running = child;
      const status = { failed: false };
      closed = new Promise((resolve) => {
        running.once('error', () => {
          status.failed = true;
          lines?.close();
        });
        running.once('close', (code) => {
          resolve(code);
        });
      });
      // Discard diagnostic bodies: they may repeat prompts or authentication errors.
      child.stderr.resume();
      child.stdin.on('error', () => {
        status.failed = true;
        running.kill('SIGKILL');
      });
      lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      kill = () => {
        running.kill('SIGKILL');
        lines?.close();
      };
      signal.addEventListener('abort', kill, { once: true });
      signal.throwIfAborted();
      child.stdin.end(JSON.stringify({ messages: req.messages }));
      let result: z.infer<typeof TranscriptEvent> | undefined;
      let emittedText = false;
      for await (const line of lines) {
        signal.throwIfAborted();
        if (!line.trim()) continue;
        const parsed = TranscriptEvent.safeParse(parseJson(line));
        if (!parsed.success) throw new AppError('PROVIDER_BAD_OUTPUT');
        const event = parsed.data;
        if (result) throw new AppError('PROVIDER_BAD_OUTPUT');
        if (event.type === 'result') {
          if (event.is_error || event.subtype !== 'success')
            throw new AppError('PROVIDER_ERROR');
          result = event;
        } else if (
          event.type === 'stream_event' &&
          event.event?.type === 'content_block_delta' &&
          event.event.delta?.type === 'text_delta' &&
          event.event.delta.text
        ) {
          emittedText = true;
          yield { type: 'text', text: event.event.delta.text };
        }
      }
      const code = await closed;
      signal.throwIfAborted();
      if (code !== 0 || status.failed || !result)
        throw new AppError('PROVIDER_ERROR');
      // Older CLI builds may omit partial messages; the final result remains usable.
      if (!emittedText && result.result)
        yield { type: 'text', text: result.result };
      yield {
        type: 'done',
        usage: result.usage ? anthropicUsage(result.usage) : ZERO_LLM_USAGE,
        stopReason: 'end_turn',
      };
    } catch (error) {
      throw providerFailure(error);
    } finally {
      if (kill) signal?.removeEventListener('abort', kill);
      lines?.close();
      if (child?.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      if (closed) await closed;
      if (cwd) await rm(cwd, { recursive: true, force: true });
    }
  }

  async generateObject<T>(req: ObjectRequest<T>) {
    const schema = jsonSchema(req.schema);
    let text = '';
    let usage = ZERO_LLM_USAGE;
    for await (const event of this.streamText({
      system: `${req.system}\nReturn only JSON matching this schema: ${JSON.stringify(schema)}`,
      messages: [{ role: 'user', content: req.prompt }],
      maxTokens: req.maxTokens,
      signal: req.signal,
    })) {
      if (event.type === 'text') text += event.text;
      else usage = event.usage;
    }
    return { object: validateObject(req.schema, parseJson(text)), usage };
  }
}
