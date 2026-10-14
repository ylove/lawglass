/**
 * `summary`: the structural outline plus the opening text of each part of the bill.
 *
 * Spec §3.3: "the structural outline (section headings) plus the first chunk of each top-level
 * section; map-reduce for long docs, capped". Steps:
 *
 *   1. Pick the MAP UNITS. Start with the top-level sections and, while there are fewer than
 *      `MIN_MAP_UNITS`, descend through container levels (division, title, subtitle) so a bill
 *      with 7 divisions is summarized by its titles, not by 7 first paragraphs.
 *   2. Give each unit two excerpts: an OUTLINE (indented `num heading` lines of the unit's
 *      subtree, to a character budget) and the unit's FIRST CHUNK.
 *   3. A short outline is summarized in one call. A long one is MAPPED in batches of
 *      `MAP_UNITS_PER_CALL` units and the partial summaries are REDUCED in a last call.
 *
 * Citations in the reduce step: each partial summary reaches the model as an excerpt whose
 * `section` is a stand-in (`summary-part-1`) that is deliberately not citable, while its
 * `coveredSectionIds` are the real sections the partial cited. Only markers copied from the
 * partial's own text therefore validate. A model that cites the stand-in or an ordinal gets
 * that marker stripped and flagged, instead of silently pointing at the wrong section.
 */
import { answer } from './answer/index.js';
import {
  appendNote,
  realHits,
  syntheticHit,
  withoutSyntheticChunks,
  type ChipDeps,
  type ChipRun,
  type RunChipOptions,
} from './chip-types.js';
import {
  makeChunkId,
  sectionText,
  walkSections,
  ZERO_USAGE,
  type AnswerResult,
  type AnswerWarning,
  type Citation,
  type ChipDefinition,
  type RetrievalBackend,
  type SearchHit,
  type Section,
} from './model/index.js';

/** Descend through container levels until there are at least this many map units... */
export const MIN_MAP_UNITS = 12;
/** ...but never use more than this many; the rest are reported as not covered. */
export const MAX_MAP_UNITS = 60;
/** Units per model call. Each unit is two excerpts, so this bounds the prompt. */
export const MAP_UNITS_PER_CALL = 10;
/** Characters of outline lines per unit. */
export const OUTLINE_CHAR_BUDGET = 2500;
/** How many chunks (the unit's own, then its descendants') are tried for a unit's first chunk. */
const FIRST_CHUNK_CANDIDATES = 6;

const MAP_INSTRUCTION =
  "These excerpts come from consecutive parts of one bill. For each part there is an outline (the headings inside it) and its opening text. Summarize what each part does in one to three short sentences. Cite the section of the opening text you are summarizing; cite an outline's section only for what its outline lists. Use the outline only for what a part covers; do not guess at text you cannot see.";

const REDUCE_INSTRUCTION =
  "Each excerpt below is a partial summary of one part of the bill. Its text already carries section markers like [S:sec-1]. Combine the partial summaries into one summary. Keep the markers on the sentences they support, copy them exactly from the partial text, and never cite an excerpt's own section attribute or number.";

/**
 * A container groups sections and has no text of its own: a division, title or subtitle.
 * A real section can also have no text of its own (all its text in subsections), so section
 * ids (`sec-101`, `section-5`) are never treated as containers.
 */
function isContainer(s: Section): boolean {
  if (s.children.length === 0) return false;
  const lastSegment = s.id.split('/').at(-1) ?? s.id;
  if (/^sec(tion)?[-_.\d]/i.test(lastSegment)) return false;
  return sectionText(s, { includeDeleted: true }).trim() === '';
}

/** Choose the sections that become map units. See the file comment, step 1. */
export function chooseMapUnits(sections: readonly Section[]): {
  units: Section[];
  omitted: number;
} {
  let level = [...sections];
  while (level.length < MIN_MAP_UNITS && level.some(isContainer)) {
    const next = level.flatMap((s) => (isContainer(s) ? s.children : [s]));
    if (next.length > MAX_MAP_UNITS) break; // too fine; keep the coarser level
    level = next;
  }
  return {
    units: level.slice(0, MAX_MAP_UNITS),
    omitted: Math.max(0, level.length - MAX_MAP_UNITS),
  };
}

function lineOf(s: Section, depth: number): string {
  const label = [s.num, s.heading].filter(Boolean).join(' ') || s.id;
  return `${'  '.repeat(depth)}${label}`;
}

/**
 * Outline of one unit. The depth is chosen by budget: every level that fits whole is listed,
 * and the next level is filled as far as the budget allows (in document order). Lines are
 * printed depth-first so each child sits under its own parent.
 */
export function buildOutline(unit: Section): {
  text: string;
  listed: string[];
} {
  const levels: Section[][] = [[unit]];
  for (let next = unit.children; next.length > 0;) {
    levels.push(next);
    next = next.flatMap((s) => s.children);
  }
  const cost = (level: readonly Section[], depth: number): number =>
    level.reduce((n, s) => n + lineOf(s, depth).length + 1, 0);

  // The unit itself is always listed; a deeper level is added only if all of it fits.
  let used = cost(levels[0] ?? [], 0);
  let fullDepth = 0;
  while (
    fullDepth + 1 < levels.length &&
    used + cost(levels[fullDepth + 1] ?? [], fullDepth + 1) <=
      OUTLINE_CHAR_BUDGET
  ) {
    fullDepth++;
    used += cost(levels[fullDepth] ?? [], fullDepth);
  }

  // Spend what is left on a prefix of the next level.
  const partial = new Set<string>();
  for (const s of levels[fullDepth + 1] ?? []) {
    const c = lineOf(s, fullDepth + 1).length + 1;
    if (used + c > OUTLINE_CHAR_BUDGET) break;
    used += c;
    partial.add(s.id);
  }

  const lines: string[] = [];
  const listed: string[] = [];
  const visit = (s: Section, depth: number): void => {
    if (depth > fullDepth && !partial.has(s.id)) return;
    lines.push(lineOf(s, depth));
    listed.push(s.id);
    for (const child of s.children) visit(child, depth + 1);
  };
  visit(unit, 0);

  const remaining = levels.flat().length - listed.length;
  if (remaining > 0) {
    lines.push(
      `  (${String(remaining)} more ${remaining === 1 ? 'section' : 'sections'} not listed)`,
    );
  }
  return { text: lines.join('\n'), listed };
}

/** The first live chunk of each unit, by unit id. Chunk ids are deterministic, so one fetch. */
async function firstChunks(
  backend: RetrievalBackend,
  docId: string,
  units: readonly Section[],
): Promise<Map<string, SearchHit>> {
  const candidates = units.map((unit) => ({
    unit,
    ids: [...walkSections([unit])]
      .slice(0, FIRST_CHUNK_CANDIDATES)
      .map((s) => makeChunkId(docId, s.id, 0)),
  }));
  const found = await backend.getChunks(
    docId,
    candidates.flatMap((c) => c.ids),
  );
  const byId = new Map(found.map((c) => [c.id, c]));
  const out = new Map<string, SearchHit>();
  for (const { unit, ids } of candidates) {
    const chunk = ids
      .map((id) => byId.get(id))
      .find((c) => c !== undefined && c.amendmentStatus !== 'deleted');
    if (chunk) out.set(unit.id, { chunk, score: 1 });
  }
  return out;
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** A map-step summary as an excerpt: stand-in section id, real cited sections as coverage. */
function partialSummaryHit(
  docId: string,
  index: number,
  partial: AnswerResult,
): SearchHit {
  const cited = [
    ...new Set(
      partial.citations.filter((c) => c.valid).map((c) => c.sectionId),
    ),
  ];
  const standIn = `summary-part-${String(index + 1)}`;
  return syntheticHit(docId, {
    key: `summary-part:${String(index + 1)}`,
    sectionId: standIn,
    coveredSectionIds: cited,
    breadcrumb: `Partial summary ${String(index + 1)}`,
    text: partial.text,
  });
}

export async function runOutlineChip(
  chip: ChipDefinition,
  docId: string,
  deps: ChipDeps,
  options: RunChipOptions,
): Promise<ChipRun> {
  const { units, omitted } = chooseMapUnits(deps.doc.sections);
  const firsts = await firstChunks(deps.backend, docId, units);

  // Two excerpts per unit: its outline, then its opening text.
  const unitHits: SearchHit[][] = units.map((unit, i) => {
    const outline = buildOutline(unit);
    const hits = [
      syntheticHit(docId, {
        key: `outline:${String(i)}`,
        sectionId: unit.id,
        coveredSectionIds: [...new Set([unit.id, ...outline.listed])],
        breadcrumb: `Outline: ${lineOf(unit, 0)}`,
        text: outline.text,
      }),
    ];
    const first = firsts.get(unit.id);
    if (first) hits.push(first);
    return hits;
  });
  const allHits = unitHits.flat();

  const common = {
    provider: deps.provider,
    signal: options.signal,
    maxTokens: options.maxTokens,
  };
  const context = (hits: SearchHit[]) => ({
    hits,
    metadata: deps.doc.metadata,
  });
  const note =
    omitted > 0
      ? `This summary covers the first ${String(MAX_MAP_UNITS)} parts of the bill. ${String(omitted)} more ${omitted === 1 ? 'part is' : 'parts are'} not included.`
      : '';

  let final: AnswerResult;
  let truncatedInMap = false;
  const real = new Map<string, Citation>();

  if (units.length <= MAP_UNITS_PER_CALL) {
    // Short bill: one call over every unit.
    final = await answer({
      ...common,
      question: chip.label,
      context: context(allHits),
      chipInstruction: chip.answerInstruction,
      onToken: options.onToken,
    });
  } else {
    // Map: summarize each batch of units. The cap on units bounds the number of calls.
    const partials = await Promise.all(
      chunkArray(unitHits, MAP_UNITS_PER_CALL).map((batch) =>
        answer({
          ...common,
          question: chip.label,
          context: context(batch.flat()),
          chipInstruction: MAP_INSTRUCTION,
        }),
      ),
    );
    truncatedInMap = partials.some((p) => p.warnings.includes('TRUNCATED'));
    for (const c of partials.flatMap((p) => p.citations)) {
      if (c.valid) real.set(c.sectionId, withoutSyntheticChunks(c, docId));
    }

    // Reduce: combine the partial summaries that cite something real.
    const usable = partials.filter(
      (p) => !p.declined && p.citations.some((c) => c.valid),
    );
    final = await answer({
      ...common,
      question: chip.label,
      context: context(usable.map((p, i) => partialSummaryHit(docId, i, p))),
      chipInstruction:
        `${REDUCE_INSTRUCTION} ${chip.answerInstruction ?? ''}`.trim(),
      onToken: options.onToken,
    });
    const sum = [...partials, final].reduce(
      (n, r) => ({
        inputTokens: n.inputTokens + r.usage.inputTokens,
        outputTokens: n.outputTokens + r.usage.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
    final = { ...final, usage: sum };
  }

  // Point citations at stored chunks: the real ones seen in the map step where there are any.
  const warnings: AnswerWarning[] =
    truncatedInMap && !final.warnings.includes('TRUNCATED')
      ? [...final.warnings, 'TRUNCATED']
      : final.warnings;
  const finished: AnswerResult = {
    ...final,
    warnings,
    citations: final.citations.map((c) =>
      c.valid ? (real.get(c.sectionId) ?? withoutSyntheticChunks(c, docId)) : c,
    ),
  };
  return {
    answer: appendNote(finished, note, options.onToken),
    hits: realHits(allHits, docId),
    backendUsage: ZERO_USAGE,
    mode: 'none',
  };
}
