/**
 * Question chips (spec §3.3): the eight one-click questions, each with its own explicit
 * retrieval strategy. This file is the showcase of "retrieval is a per-question decision":
 *
 *   sparse-heavy   effective-date, penalties   exact words ("shall take effect", "fine") matter
 *                                              more than meaning, so BM25 gets more vote
 *   filtered       what-changes, money,        the chunk classifier (core/enrich) lets us skip
 *                  definitions                 text that cannot answer the question
 *   reranked       who-affected                the question is vague, so a cross-encoder
 *                                              re-orders the candidates
 *   structural     summary                     no query at all: walk the outline instead
 *   no model       sponsors                    the answer is a metadata field, so no retrieval
 *                                              and no LLM call
 *
 * The shape is the frozen `ChipDefinition` contract. The executor that runs a chip lives in
 * ./chip-runner.ts (re-exported here), so this file stays plain, readable configuration.
 */
import { ChipDefinition, type ChipId } from './model/index.js';

export { runChip } from './chip-runner.js';
export type {
  ChipDeps,
  ChipDoc,
  ChipRun,
  RunChipOptions,
} from './chip-runner.js';

/** Validate against the contract and freeze deeply, so a chip can never be mutated at runtime. */
function defineChip(chip: ChipDefinition): ChipDefinition {
  const parsed = ChipDefinition.parse(chip);
  const freezeDeep = <T>(value: T): T => {
    if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(freezeDeep);
      Object.freeze(value);
    }
    return value;
  };
  return freezeDeep(parsed);
}

/**
 * Summarize this bill.
 * No queries: the executor reads the outline (top-level sections) and takes the first chunk of
 * each, which is where a section states its purpose. Long bills are summarized in capped
 * batches and then combined (map-reduce); see `MAX_SECTIONS_PER_MAP_CALL` in chip-runner.ts.
 */
const summary = defineChip({
  id: 'summary',
  label: 'Summarize this bill',
  strategy: 'outline',
  queries: [],
  answerInstruction:
    'Summarize the whole bill in a short paragraph, then a short list of its main parts, one line per part. Say what the bill does first. Keep struck-out text out of the summary except to say what the bill removes.',
});

/**
 * What does it change?
 * Only chunks marked inserted or deleted can describe a change. Listing `deleted` is also what
 * tells `retrieve` to keep struck text (it is dropped from every other chip's results so it is
 * never mistaken for current law).
 */
const whatChanges = defineChip({
  id: 'what-changes',
  label: 'What does it change?',
  strategy: 'retrieve',
  queries: [
    'text removed or struck from current law',
    'new text added to current law',
    'amend repeal strike insert substitute section',
  ],
  filter: { amendmentStatus: ['inserted', 'deleted'] },
  retrieval: { mode: 'hybrid_rerank', includeDeleted: true, topK: 10 },
  answerInstruction:
    'Group your answer by section. For each section, say what the bill removes (status="deleted") and what it adds (status="inserted"), keeping the two apart. Never describe removed text as something the bill requires.',
});

/**
 * Who does it affect?
 * A vague question with no distinctive keywords, so the best bet is hybrid candidates
 * re-ordered by the cross-encoder reranker.
 */
const whoAffected = defineChip({
  id: 'who-affected',
  label: 'Who does it affect?',
  strategy: 'retrieve',
  queries: [
    'who must comply, who is required, who is eligible, who is covered',
    'applies to persons, employers, residents, agencies, businesses',
  ],
  retrieval: { mode: 'hybrid_rerank', topK: 8 },
  answerInstruction:
    'List the groups of people, businesses or agencies the bill applies to, and what it asks of or gives to each group. Do not say whether the reader is personally covered.',
});

/**
 * Penalties and enforcement.
 * The wording is predictable ("fine", "violation", "civil penalty"), so the sparse (BM25) list
 * gets 75% of the vote in weighted RRF. Only penalty and operative chunks are searched.
 */
const penalties = defineChip({
  id: 'penalties',
  label: 'Penalties and enforcement',
  strategy: 'retrieve',
  queries: [
    'penalty fine violation',
    'enforce enforcement civil penalty misdemeanor imprisonment',
  ],
  filter: { chunkType: ['penalty', 'operative'] },
  retrieval: { mode: 'hybrid', sparseWeight: 0.75, topK: 8 },
  answerInstruction:
    'List the penalties and who enforces them. For each, say who can be penalized, for what, and the amount or punishment, using the numbers exactly as written. If the excerpts show no penalties, say so.',
});

/**
 * When does it take effect?
 * Dates and phrases like "takes effect" are literal strings, so sparse search gets 85% of the
 * vote. No chunk-type filter: the date is often a clause inside an ordinary section.
 */
const effectiveDate = defineChip({
  id: 'effective-date',
  label: 'When does it take effect?',
  strategy: 'retrieve',
  queries: ['effective date takes effect operative'],
  retrieval: { mode: 'hybrid', sparseWeight: 0.85, topK: 6 },
  answerInstruction:
    'Give the date or event on which the bill, or each part of it, takes effect. If different parts start on different dates, list each one. Copy dates exactly as written.',
});

/**
 * Taxes, fees, and spending.
 * Hybrid search over appropriation and operative chunks, which is where amounts are stated.
 */
const money = defineChip({
  id: 'money',
  label: 'Taxes, fees, and spending',
  strategy: 'retrieve',
  queries: [
    'tax rate fee charge payment',
    'appropriation funding spending dollars grant',
  ],
  filter: { chunkType: ['appropriation', 'operative'] },
  retrieval: { mode: 'hybrid', topK: 8 },
  answerInstruction:
    'List the taxes, fees and spending in the bill: what is charged or paid, by whom, and how much. Use amounts exactly as written. Do not add up or estimate totals.',
});

/**
 * Key definitions.
 * Not a search at all: take the definition chunks and list the terms. Dense mode with a
 * generous `topK` returns all of them when the filter leaves fewer than that.
 */
const definitions = defineChip({
  id: 'definitions',
  label: 'Key definitions',
  strategy: 'definitions',
  queries: ['definitions of terms used in this act'],
  filter: { chunkType: ['definition'] },
  retrieval: { mode: 'dense', topK: 60 },
  answerInstruction:
    "List the defined terms, one per line, with the meaning given in the bill in plain words. Use the bill's own definition for each term.",
});

/**
 * Who sponsored it?
 * Answered from `BillMetadata.sponsors`. No retrieval, no LLM call: a sponsor list is either
 * printed on the bill or it is not, and a model could only invent one.
 */
const sponsors = defineChip({
  id: 'sponsors',
  label: 'Who sponsored it?',
  strategy: 'metadata',
  queries: [],
});

/** Every chip in display order. Frozen. */
export const CHIPS: readonly ChipDefinition[] = Object.freeze([
  summary,
  whatChanges,
  whoAffected,
  penalties,
  effectiveDate,
  money,
  definitions,
  sponsors,
]);

/** The chip with this id. Every `ChipId` has one (enforced by a test). */
export function getChip(id: ChipId): ChipDefinition {
  const chip = CHIPS.find((c) => c.id === id);
  if (!chip) throw new Error(`Unknown chip: ${id}`);
  return chip;
}
