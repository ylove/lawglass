/**
 * Question chips (spec §3.3): the ten one-click questions, each with its own explicit
 * retrieval strategy. This file is the showcase of "retrieval is a per-question decision":
 *
 *   sparse-heavy   effective-date, penalties   exact words ("shall take effect", "fine") matter
 *                                              more than meaning, so BM25 gets more vote
 *   filtered       what-changes, money,        the chunk classifier (core/enrich) lets us skip
 *                  definitions                 text that cannot answer the question
 *   reranked       who-affected                the question is vague, so a cross-encoder
 *                                              re-orders the candidates
 *   structural     summary                     no query at all: walk the outline instead
 *   extracted      delegations                 a list built in code from the section tree
 *   no model       sponsors,                   the answer is a stored record, so no retrieval
 *                  history                     and no LLM call
 *
 * The shape is the frozen `ChipDefinition` contract. The executor that runs a chip lives in
 * ./chip-runner.ts (re-exported here), so this file stays plain, readable configuration.
 */
import { AppError, ChipDefinition, type ChipId } from './model/index.js';
import { LEDE_INSTRUCTION } from './chip-delegations.js';
import { SUMMARY_INSTRUCTION, SUMMARY_LABEL } from './chip-summary.js';

export { runChip } from './chip-runner.js';
export type {
  ChipDeps,
  ChipDoc,
  ChipRun,
  RunChipOptions,
} from './chip-types.js';

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
  label: SUMMARY_LABEL,
  strategy: 'outline',
  queries: [],
  answerInstruction: SUMMARY_INSTRUCTION,
});

/**
 * What does it change?
 * Spec §3.3 says "filter amendment_status IN [inserted, deleted], group by section". The
 * executor (chip-changes.ts) does the exact version of that: it reads the struck and underlined
 * runs from the section tree, so there is no query or filter to configure here. A retrieved
 * `inserted` chunk is mostly existing law with a few new words, which is the wrong thing to
 * call "added".
 */
const whatChanges = defineChip({
  id: 'what-changes',
  label: 'What does it change?',
  strategy: 'retrieve',
  queries: [],
  answerInstruction:
    'Each changed section has up to two excerpts that show only the sentences containing a change. status="deleted" is the BEFORE text: words in [-this form-] are struck out by the bill. status="inserted" is the AFTER text: words in [+this form+] are added by the bill. Only the marked words changed; all other words are existing law that stays as it is. A section marked "Newly enacted" is entirely new. Group your answer by section, in the order given. For each section say, in plain words, what the bill removes and what it adds, keeping the two apart. Never describe struck words as something the bill requires.',
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
 * gets 75% of the vote in weighted RRF. There is deliberately no chunk-type filter: the
 * classifier gives a chunk the first matching type, so a penalty clause in a section that also
 * says "for purposes of" is typed `findings`, and a filter would hide it. The BM25 weighting
 * already does the narrowing. The queries are keyword bags, so the merged candidates get one
 * cross-encoder pass against the question (see runRetrieveChip).
 */
const penalties = defineChip({
  id: 'penalties',
  label: 'Penalties and enforcement',
  strategy: 'retrieve',
  queries: [
    'penalty fine violation',
    'enforce enforcement civil penalty misdemeanor imprisonment',
  ],
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
 * Hybrid search over appropriation and operative chunks, where amounts are stated, plus
 * `findings`: the classifier types any chunk containing "for purposes of" as findings, and
 * those include dollar amounts (on H.R. 5009, 6 of 7 chunks with an amount that `money` missed).
 */
const money = defineChip({
  id: 'money',
  label: 'Taxes, fees, and spending',
  strategy: 'retrieve',
  queries: [
    'tax rate fee charge payment',
    'appropriation funding spending dollars grant',
  ],
  filter: { chunkType: ['appropriation', 'operative', 'findings'] },
  retrieval: { mode: 'hybrid', topK: 8 },
  answerInstruction:
    'List the taxes, fees and spending in the bill: what is charged or paid, by whom, and how much. Use amounts exactly as written. Do not add up or estimate totals.',
});

/**
 * Key definitions.
 * Not a search at all: the executor takes every definition chunk (the generous `topK` is a
 * fetch-all, not a relevance cut), puts document-wide definitions first in document order,
 * lists the first 25 and says how many more there are.
 */
const definitions = defineChip({
  id: 'definitions',
  label: 'Key definitions',
  strategy: 'definitions',
  queries: ['definitions of terms used in this act'],
  filter: { chunkType: ['definition'] },
  retrieval: { mode: 'dense', topK: 1000 },
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

/**
 * How did it get here?
 * Built in code from the stored `BillHistory` (chip-history.ts). No retrieval, no LLM call: it
 * is about who did what, so a model could only invent an attribution.
 */
const history = defineChip({
  id: 'history',
  label: 'How did it get here?',
  strategy: 'metadata',
  queries: [],
});

/**
 * Who decides later?
 * Not a search: the executor (chip-delegations.ts) reads the section tree for rule-making and
 * discretion phrases, outside dependencies and conditional start dates. Code finds the items; a
 * model, when a key is available, only writes a short lede from that list.
 */
const delegations = defineChip({
  id: 'delegations',
  label: 'Who decides later?',
  strategy: 'extract',
  queries: [],
  // Instructs only the optional lede; the list itself is built in code.
  answerInstruction: LEDE_INSTRUCTION,
});

/** Every chip in display order. Frozen. */
export const CHIPS: readonly ChipDefinition[] = Object.freeze([
  summary,
  whatChanges,
  whoAffected,
  history,
  penalties,
  effectiveDate,
  delegations,
  money,
  definitions,
  sponsors,
]);

/** The chip with this id. Every `ChipId` has one (enforced by a test). */
export function getChip(id: ChipId): ChipDefinition {
  const chip = CHIPS.find((c) => c.id === id);
  if (!chip)
    throw new AppError(
      'INVALID_INPUT',
      `Unknown chip (not available yet): ${id}`,
      {
        userMessage: 'That question chip is not available yet.',
      },
    );
  return chip;
}
