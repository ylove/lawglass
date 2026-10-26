/**
 * Draw the pictures for a list of items (#344): one structured call per batch of items to the
 * small "extract" model, then the deterministic checks in `validate.ts`. Items run in batches
 * one after another, so a long breakdown never fans out into parallel calls.
 */
import {
  AppError,
  type LlmProvider,
  type LlmUsage,
  type PictureEntry,
} from '../model/index.js';
import { validateObject } from '../llm/shared.js';
import {
  ITEMS_PER_CALL,
  PICTURE_SYSTEM_PROMPT,
  PictureSet,
  picturePrompt,
  type PictureItem,
} from './prompt.js';
import { validatePictures, type PictureValidation } from './validate.js';

/** Output budget per call: a panel is a few dozen tokens, at most three per item. */
const MAX_TOKENS = 3000;

export interface DrawnPictures {
  entries: PictureEntry[];
  dropped: PictureValidation['dropped'];
  usage: LlmUsage;
}

export async function drawPictures(input: {
  provider: LlmProvider;
  items: readonly PictureItem[];
  signal?: AbortSignal | undefined;
}): Promise<DrawnPictures> {
  const entries: PictureEntry[] = [];
  const dropped: PictureValidation['dropped'] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  for (let i = 0; i < input.items.length; i += ITEMS_PER_CALL) {
    input.signal?.throwIfAborted();
    const batch = input.items.slice(i, i + ITEMS_PER_CALL);
    // A malformed reply is retried once; a batch that stays malformed simply gets no pictures.
    // Anything else (a budget, an abort, an outage) stops the run.
    let reply: PictureSet | undefined;
    for (let attempt = 0; attempt < 2 && !reply; attempt++) {
      try {
        const result = await input.provider.generateObject({
          system: PICTURE_SYSTEM_PROMPT,
          prompt: picturePrompt(batch),
          schema: PictureSet,
          schemaName: 'pictures',
          maxTokens: MAX_TOKENS,
          signal: input.signal,
        });
        usage.inputTokens += result.usage.inputTokens;
        usage.outputTokens += result.usage.outputTokens;
        reply = validateObject(PictureSet, result.object);
      } catch (error) {
        if (!(
          error instanceof AppError && error.code === 'PROVIDER_BAD_OUTPUT'
        ))
          throw error;
      }
    }
    if (!reply) continue;
    const checked = validatePictures(reply, batch);
    entries.push(...checked.entries);
    dropped.push(...checked.dropped);
  }
  return { entries, dropped, usage };
}
