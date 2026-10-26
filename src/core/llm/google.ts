import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import {
  AppError,
  type LlmProvider,
  type LlmStreamEvent,
  type ObjectRequest,
  type ProviderConfig,
  type TextRequest,
  type LlmUsage,
  messageText,
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

function usageOf(result: GenerateContentResponse): LlmUsage {
  // Gemini caches repeated prefixes implicitly and reports the reused part.
  const cached = result.usageMetadata?.cachedContentTokenCount ?? 0;
  return {
    inputTokens: result.usageMetadata?.promptTokenCount ?? 0,
    outputTokens:
      (result.usageMetadata?.candidatesTokenCount ?? 0) +
      (result.usageMetadata?.thoughtsTokenCount ?? 0),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  };
}

export class GoogleProvider implements LlmProvider {
  readonly id = 'google' as const;
  readonly model: string;
  private readonly client: GoogleGenAI;

  constructor(
    private readonly config: ProviderConfig,
    deps: { fetch?: typeof fetch } = {},
  ) {
    this.model = config.model;
    this.client = new GoogleGenAI({
      apiKey: requireKey(config.apiKey),
      vertexai: false,
      httpOptions: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiVersion: 'v1beta',
        timeout: config.timeoutMs,
        fetch: deps.fetch,
        retryOptions: { attempts: 1 },
      },
    });
  }

  async *streamText(req: TextRequest): AsyncIterable<LlmStreamEvent> {
    try {
      const signal = requestSignal(req.signal, this.config.timeoutMs);
      const stream = await this.client.models.generateContentStream({
        model: this.model,
        contents: req.messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: messageText(m.content) }],
        })),
        config: {
          systemInstruction: req.system,
          maxOutputTokens: req.maxTokens,
          temperature: req.temperature,
          abortSignal: signal,
        },
      });
      let usage = ZERO_LLM_USAGE;
      let stopReason: string | null = null;
      for await (const result of stream) {
        signal.throwIfAborted();
        // Read text parts ourselves: the SDK's .text getter may warn about other parts.
        for (const part of result.candidates?.[0]?.content?.parts ?? []) {
          if (part.text && !part.thought)
            yield { type: 'text', text: part.text };
        }
        if (result.usageMetadata) usage = usageOf(result);
        stopReason = result.candidates?.[0]?.finishReason ?? stopReason;
      }
      signal.throwIfAborted();
      if (!stopReason) throw new AppError('PROVIDER_ERROR');
      yield { type: 'done', usage, stopReason };
    } catch (error) {
      throw providerFailure(error);
    }
  }

  async generateObject<T>(req: ObjectRequest<T>) {
    try {
      const signal = requestSignal(req.signal, this.config.timeoutMs);
      const result = await this.client.models.generateContent({
        model: this.model,
        contents: messageText(req.prompt),
        config: {
          systemInstruction: req.system,
          maxOutputTokens: req.maxTokens,
          abortSignal: signal,
          responseMimeType: 'application/json',
          responseJsonSchema: jsonSchema(req.schema),
        },
      });
      signal.throwIfAborted();
      const text = (result.candidates?.[0]?.content?.parts ?? [])
        .flatMap((p) => (p.text && !p.thought ? [p.text] : []))
        .join('');
      return {
        object: validateObject(req.schema, parseJson(text)),
        usage: usageOf(result),
      };
    } catch (error) {
      throw providerFailure(error);
    }
  }
}
