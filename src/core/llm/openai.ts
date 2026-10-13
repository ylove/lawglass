import OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import {
  AppError,
  type LlmProvider,
  type LlmStreamEvent,
  type ObjectRequest,
  type ProviderConfig,
  type TextRequest,
} from '../model/index.js';
import {
  jsonSchema,
  parseJson,
  providerFailure,
  requestSignal,
  requireKey,
  validateObject,
  ZERO_LLM_USAGE,
} from './shared.js';

function localEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const url = new URL(baseURL);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/** Only feature rejection may downgrade formatting; never retry auth/rate-limit/network failures. */
function rejectsFormat(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError)) return false;
  const status: unknown = error.status;
  if (typeof status !== 'number' || ![400, 404, 422].includes(status))
    return false;
  return (
    error.param === 'response_format' ||
    /response_format|json_schema|json_object/.test(error.message)
  );
}

export class OpenAIProvider implements LlmProvider {
  readonly id = 'openai' as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(
    private readonly config: ProviderConfig,
    deps: { fetch?: typeof fetch } = {},
  ) {
    this.model = config.model;
    this.client = new OpenAI({
      // Keyless loopback servers (Ollama/LM Studio) still need a non-secret SDK placeholder.
      apiKey:
        localEndpoint(config.baseURL) && !config.apiKey?.trim()
          ? 'local'
          : requireKey(config.apiKey),
      baseURL: config.baseURL ?? 'https://api.openai.com/v1',
      organization: null,
      project: null,
      maxRetries: 0,
      timeout: config.timeoutMs,
      logLevel: 'off',
      fetch: deps.fetch,
    });
  }

  private tokenLimit(maxTokens: number) {
    // Current OpenAI reasoning models require max_completion_tokens; compatible servers
    // and older OpenAI models still use max_tokens. Do not guess a vendor's capabilities.
    return !this.config.baseURL && /^(gpt-[5-9]|o[1-9])/.test(this.model)
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens };
  }

  async *streamText(req: TextRequest): AsyncIterable<LlmStreamEvent> {
    let stream:
      Awaited<ReturnType<OpenAI['chat']['completions']['create']>> | undefined;
    try {
      const signal = requestSignal(req.signal, this.config.timeoutMs);
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [{ role: 'system', content: req.system }, ...req.messages],
          ...this.tokenLimit(req.maxTokens),
          temperature: req.temperature,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal },
      );
      stream = response;
      let usage = ZERO_LLM_USAGE;
      let stopReason: string | null = null;
      for await (const chunk of response) {
        signal.throwIfAborted();
        const choice = chunk.choices[0];
        if (choice?.delta.content)
          yield { type: 'text', text: choice.delta.content };
        if (choice?.finish_reason) stopReason = choice.finish_reason;
        if (chunk.usage)
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
      }
      signal.throwIfAborted();
      if (!stopReason) throw new AppError('PROVIDER_ERROR');
      yield { type: 'done', usage, stopReason };
    } catch (error) {
      throw providerFailure(error);
    } finally {
      if (stream && 'controller' in stream) stream.controller.abort();
    }
  }

  async generateObject<T>(req: ObjectRequest<T>) {
    try {
      const signal = requestSignal(req.signal, this.config.timeoutMs);
      const schema = jsonSchema(req.schema);
      const formats: ChatCompletionCreateParamsNonStreaming['response_format'][] =
        [
          {
            type: 'json_schema',
            json_schema: { name: req.schemaName, strict: true, schema },
          },
          { type: 'json_object' },
          undefined,
        ];
      for (const [index, response_format] of formats.entries()) {
        try {
          const result = await this.client.chat.completions.create(
            {
              model: this.model,
              ...this.tokenLimit(req.maxTokens),
              response_format,
              messages: [
                {
                  role: 'system',
                  content: `${req.system}\nReturn only JSON matching this schema: ${JSON.stringify(schema)}`,
                },
                { role: 'user', content: req.prompt },
              ],
            },
            { signal },
          );
          signal.throwIfAborted();
          const choice = result.choices[0];
          if (choice?.message.refusal || choice?.finish_reason === 'length')
            throw new AppError('PROVIDER_BAD_OUTPUT');
          return {
            object: validateObject(
              req.schema,
              parseJson(choice?.message.content ?? ''),
            ),
            usage: {
              inputTokens: result.usage?.prompt_tokens ?? 0,
              outputTokens: result.usage?.completion_tokens ?? 0,
            },
          };
        } catch (error) {
          if (index === formats.length - 1 || !rejectsFormat(error))
            throw error;
        }
      }
      throw new AppError('PROVIDER_BAD_OUTPUT');
    } catch (error) {
      throw providerFailure(error);
    }
  }
}
