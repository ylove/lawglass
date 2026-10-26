import {
  AppError,
  addUsage,
  type LlmProvider,
  type LocateResponse,
  type RetrievalBackend,
} from '../model/index.js';
import type { Registry } from '../registry.js';
import { cleanQuestion } from '../pipeline/question.js';
import { sharedLimits, type Limits } from '../pipeline/limits.js';
import { retrieve } from '../retrieve/index.js';
import { findDefinitionsToInject } from '../retrieve/definitions.js';
import { Selection, SELECTION_PROMPT, selectionPrompt } from './prompt.js';
import { verifySelection } from './verify.js';

export function cleanSentence(raw: string): string {
  const text = cleanQuestion(raw);
  if (text.length < 3)
    throw new AppError(
      'INVALID_INPUT',
      'Enter a sentence of 3 to 500 characters.',
    );
  return text;
}

export interface LocateDeps {
  backend: RetrievalBackend;
  provider: LlmProvider;
  registry: Registry;
  limits?: Limits | undefined;
  signal?: AbortSignal | undefined;
}

export async function locate(
  docId: string,
  raw: string,
  deps: LocateDeps,
): Promise<LocateResponse> {
  const text = cleanSentence(raw);
  const doc = await deps.registry.getDocument(docId);
  const limits = deps.limits ?? sharedLimits();
  const release = await limits.acquire('ask', deps.signal);
  try {
    if (!(await deps.backend.hasDocument(docId)))
      throw new AppError('DOC_NOT_FOUND');
    await deps.backend.ensureReady(deps.signal);
    const retrieved = await retrieve(deps.backend, {
      docId,
      query: text,
      mode: 'hybrid_rerank',
      topK: 8,
      includeDeleted: true,
      injectDefinitions: false,
      signal: deps.signal,
    });
    const definitions = await findDefinitionsToInject({
      backend: deps.backend,
      docId,
      hits: retrieved.hits,
      includeDeleted: true,
      signal: deps.signal,
    });
    const generated = await limits.meter(deps.provider).generateObject({
      system: SELECTION_PROMPT,
      prompt: selectionPrompt(text, retrieved.hits, definitions.definitions),
      schema: Selection,
      schemaName: 'locate',
      maxTokens: 1800,
      signal: deps.signal,
    });
    const parsed = Selection.safeParse(generated.object);
    if (!parsed.success) throw new AppError('PROVIDER_BAD_OUTPUT');
    const usage = addUsage(retrieved.usage, definitions.usage);
    await deps.registry.touch(docId, {
      embedTokens: usage.embedTokens,
      rerankUnits: usage.rerankUnits,
      llmInputTokens: generated.usage.inputTokens,
      llmOutputTokens: generated.usage.outputTokens,
    });
    return {
      ...verifySelection(parsed.data, doc, retrieved.hits),
      provider: deps.provider.id,
      model: deps.provider.model,
    };
  } finally {
    release();
  }
}
