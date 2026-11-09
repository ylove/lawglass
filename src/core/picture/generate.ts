/**
 * Draw the pictures for a list of items (#344): one structured call per batch of items to the
 * small "extract" model, then the deterministic checks in `validate.ts`. Items run in batches
 * one after another, so a long breakdown never fans out into parallel calls.
 */
import { addLlmUsage } from '../cost/usage.js';
import {
  AppError,
  type LlmProvider,
  type LlmUsage,
  type PictureEntry,
  type PicturePanel,
  type StampId,
} from '../model/index.js';
import { validateObject } from '../llm/shared.js';
import {
  ITEMS_PER_CALL,
  PICTURE_SYSTEM_PROMPT,
  PictureSet,
  picturePrompt,
  type PictureItem,
} from './prompt.js';
import {
  validatePictures,
  type PictureDropReason,
  type PictureValidation,
} from './validate.js';

/** Output budget per call: a panel is a few dozen tokens, at most three per item. */
const MAX_TOKENS = 3000;

const DROP_FEEDBACK: Record<
  Exclude<PictureDropReason, 'stamp-unsupported'>,
  string
> = {
  'unknown-item': 'Use only the item numbers provided.',
  repeat: 'Return at most one picture for this item.',
  shape:
    'A link needs a right side; none has no right side, carry or note; equals has no carry.',
  'label-markup': 'Labels and notes must be plain text without markup.',
  'label-judgment': 'Labels and notes must not add a judgment.',
  'label-words':
    "Every label and note must use the item's own words, apart from small connecting words.",
  'label-number':
    'Every number in a label or note must be written exactly as in the item.',
  'label-negation':
    'A label or note must not add a negation that the item does not say.',
  'label-chars':
    'Labels and notes need plain Latin text with at least one letter or digit, without symbols or emoji.',
};

const STAMP_FEEDBACK: Record<StampId, string> = {
  warning: 'a penalty or risk',
  seal: 'approval, licensing or official oversight',
  no: 'a negation or prohibition',
  calendar: 'a time or deadline',
  clock: 'a time or deadline',
  check: 'permission, a duty or eligibility',
};

function dropFeedback(
  reason: PictureDropReason,
  panels: readonly PicturePanel[],
): string {
  if (reason !== 'stamp-unsupported') return DROP_FEEDBACK[reason];
  const stamps = new Set(
    panels.flatMap((panel) => (panel.stamp ? [panel.stamp.glyph] : [])),
  );
  return [...stamps]
    .map(
      (stamp) =>
        `The stamp '${stamp}' needs ${STAMP_FEEDBACK[stamp]} in the item's words.`,
    )
    .join(' ');
}

export interface DrawnPictures {
  entries: PictureEntry[];
  /** Final refusals, including a malformed or omitted retry's original reason. */
  dropped: PictureValidation['dropped'];
  retried: number;
  recovered: number;
  usage: LlmUsage;
}

export async function drawPictures(input: {
  provider: LlmProvider;
  items: readonly PictureItem[];
  signal?: AbortSignal | undefined;
  /** Per-response usage, including malformed replies, so callers retain it if a later call fails. */
  onUsage?: (usage: LlmUsage) => void;
}): Promise<DrawnPictures> {
  const entries: PictureEntry[] = [];
  const dropped: PictureValidation['dropped'] = [];
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let retried = 0;
  let recovered = 0;

  async function generate(
    prompt: string,
    attempts: number,
  ): Promise<PictureSet | undefined> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      input.signal?.throwIfAborted();
      try {
        const result = await input.provider.generateObject({
          system: PICTURE_SYSTEM_PROMPT,
          prompt,
          schema: PictureSet,
          schemaName: 'pictures',
          maxTokens: MAX_TOKENS,
          signal: input.signal,
        });
        Object.assign(usage, addLlmUsage(usage, result.usage));
        input.onUsage?.(result.usage);
        return validateObject(PictureSet, result.object);
      } catch (error) {
        if (!(
          error instanceof AppError && error.code === 'PROVIDER_BAD_OUTPUT'
        ))
          throw error;
      }
    }
    return undefined;
  }

  for (let i = 0; i < input.items.length; i += ITEMS_PER_CALL) {
    // The model and the checks see numbers local to the call (0..9), so the reply schema stays
    // small whatever the bill's length; results are mapped back to the item's own index.
    const original = input.items.slice(i, i + ITEMS_PER_CALL);
    const batch = original.map((item, k) => ({ ...item, index: k }));
    const batchEntries: PictureEntry[] = [];
    // Preserve the malformed-output retry; other failures stop the run.
    const reply = await generate(picturePrompt(batch), 2);
    if (!reply) continue;
    const checked = validatePictures(reply, batch);
    batchEntries.push(...checked.entries);
    const failures = new Map<number, PictureValidation['dropped'][number]>();
    for (const drop of checked.dropped)
      if (!failures.has(drop.item)) failures.set(drop.item, drop);
    for (const entry of checked.entries) failures.delete(entry.item);
    // Unknown numbers cannot be redrawn, and a repeated picture may already have a valid entry.
    const retryItems = batch.filter(
      (item) =>
        failures.has(item.index) &&
        !checked.entries.some((entry) => entry.item === item.index),
    );
    if (retryItems.length > 0) {
      const feedback = [...failures.values()]
        .filter((drop) => retryItems.some((item) => item.index === drop.item))
        .map((drop) => {
          const panels =
            reply.pictures.find((picture) => picture.item === drop.item)
              ?.panels ?? [];
          return `Item ${String(drop.item)}: ${dropFeedback(drop.reason, panels)}`;
        });
      retried += retryItems.length;
      // This is the one extra call for rejected items, even if its output is malformed.
      const redrawn = await generate(
        `${picturePrompt(retryItems)}\n\nRedraw only these items using the feedback below. Skip any item you cannot draw honestly.\n${feedback.join('\n')}`,
        1,
      );
      if (redrawn) {
        const rechecked = validatePictures(redrawn, retryItems);
        batchEntries.push(...rechecked.entries);
        recovered += rechecked.entries.length;
        const retryFailures = new Set<number>();
        for (const drop of rechecked.dropped) {
          // Extra items are not redraw candidates. Keep the first actual rejection, rather
          // than a later repeat, and never count a kept picture as dropped.
          if (!retryItems.some((item) => item.index === drop.item)) continue;
          if (retryFailures.has(drop.item)) continue;
          retryFailures.add(drop.item);
          if (drop.reason !== 'repeat') failures.set(drop.item, drop);
        }
        for (const entry of rechecked.entries) failures.delete(entry.item);
      }
    }
    entries.push(
      ...batchEntries.map((e) => ({
        ...e,
        item: original[e.item]?.index ?? e.item,
      })),
    );
    dropped.push(
      ...[...failures.values()].map((d) => ({
        ...d,
        item: original[d.item]?.index ?? d.item,
      })),
    );
  }
  entries.sort((a, b) => a.item - b.item);
  return { entries, dropped, retried, recovered, usage };
}
