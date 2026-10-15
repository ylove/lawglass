/**
 * "Who decides later?": what the bill leaves to someone else to decide, what it depends on, and
 * what must happen before it takes effect.
 *
 * The facts come from code (`extractDelegations` over the section tree), not from a model. A
 * model is asked for one thing only: a one or two sentence lede, written from the extracted list
 * and nothing else. So the list can be wrong only the way the extractor is wrong, and the lede
 * can be dropped without losing any fact. The lede is skipped (the list stands alone) when:
 *
 *   - the server is in public mode (a visitor never triggers an extra model call),
 *   - no API key is configured (the provider throws MISSING_KEY when first used), or
 *   - the lede fails the checks in `cleanLede` (declined, cut off, or cites nothing in the list).
 *
 * Citations. The lede and the list are validated together, against one synthetic excerpt per
 * listed item, so a marker the list does not support is stripped from either part and the web
 * numbers both with the same `numberCitations`.
 */
import {
  answer,
  fleschKincaidGrade,
  validateCitations,
} from './answer/index.js';
import { coveredSectionIds } from './answer/citations.js';
import { cleanRecordText, unescapeRecordText } from './chip-history.js';
import {
  syntheticHit,
  withoutSyntheticChunks,
  type ChipDeps,
  type ChipRun,
  type RunChipOptions,
} from './chip-types.js';
import { breadcrumb } from './chunk/index.js';
import {
  extractDelegations,
  type DelegationItem,
} from './enrich/delegations.js';
import {
  findCitationIds,
  isAppError,
  ZERO_USAGE,
  type AnswerResult,
  type ChipDefinition,
  type LlmProvider,
  type LlmUsage,
  type SearchHit,
  type Section,
} from './model/index.js';

/** Items listed per group; the rest are counted ("and 4 more"). */
export const MAX_ITEMS_PER_GROUP = 8;
/** The lede is two sentences; a model that rambles past this is not following the instruction. */
const LEDE_MAX_TOKENS = 300;
const LEDE_MAX_CHARS = 600;

export const NOTHING_LEFT_TEXT =
  'Nothing in the text is left for later decision or depends on outside action.';

/** Sent as the chip's `<task>`. It is trusted text from our code. */
export const LEDE_INSTRUCTION =
  'Each excerpt is one sentence quoted from the bill, tagged with the kind of item it is: "decided later", "depends on" or "takes effect when". Write a lede of one or two short sentences that tells the reader, in plain words, what the bill leaves to others to decide and what it depends on. Use only what these excerpts say. Do not add facts, dates or names that are not in them. Do not list every item and do not use a list; a longer list follows your lede. End each sentence with the section marker of an excerpt it relies on.';

const GROUP_TITLES = {
  decidedLater: 'Decided later by',
  dependsOn: 'Depends on',
  takesEffect: 'Takes effect when',
} as const;
type Group = keyof typeof GROUP_TITLES;
const GROUPS = Object.keys(GROUP_TITLES) as Group[];

const GROUP_TAGS: Record<Group, string> = {
  decidedLater: 'decided later',
  dependsOn: 'depends on',
  takesEffect: 'takes effect when',
};

/** Section id to its path from the top, for excerpt headings. */
function pathsById(
  sections: readonly Section[],
  parents: readonly Section[] = [],
  into = new Map<string, readonly Section[]>(),
): Map<string, readonly Section[]> {
  for (const s of sections) {
    const path = [...parents, s];
    into.set(s.id, path);
    pathsById(s.children, path, into);
  }
  return into;
}

/**
 * Bill text is shown by a markdown renderer and validated for citations: flatten and escape it,
 * and turn a literal "[S:" into "(S:" so it can never be read as a citation marker (a
 * backslash does not help: the validator still sees the marker behind it).
 */
const plain = (text: string): string =>
  cleanRecordText(
    text
      // Fold look-alikes (full-width brackets), then drop invisible characters BEFORE looking
      // for a marker: "[\u200bS:x]" must not survive as one once cleanRecordText removes them.
      .normalize('NFKC')
      .replace(INVISIBLE, '')
      .replace(/\[\s*S\s*:/gi, '(S:'),
    300,
  );

/** Zero-width, bidi, soft-hyphen, BOM and control characters. */
const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** "15 U.S.C. 80b-2" and "15 U.S.C. 80b–2(a)" name the same thing; say it once. */
const squash = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]/g, '');

function line(group: Group, item: DelegationItem): string {
  const what = plain(item.what);
  const actor = item.actor === undefined ? '' : plain(item.actor);
  const marker = `[S:${item.sectionId}]`;
  switch (group) {
    case 'decidedLater': {
      const deadline =
        item.deadline === undefined ? '' : ` (${plain(item.deadline)})`;
      return `- ${actor === '' ? '' : `${actor} — `}${what}${deadline} ${marker}`;
    }
    case 'dependsOn': {
      const repeated = squash(what).startsWith(squash(actor));
      return `- ${actor === '' || repeated ? '' : `${actor}: `}${what} ${marker}`;
    }
    case 'takesEffect':
      return `- ${what} ${marker}`;
  }
}

interface Shown {
  group: Group;
  items: DelegationItem[];
  /** Items not shown: over the display cap here, plus those the extractor itself capped. */
  more: number;
}

function renderList(shown: readonly Shown[]): string {
  return shown
    .map(({ group, items, more }) => {
      const rows = items.map((item) => line(group, item));
      if (more > 0) rows.push(`- and ${String(more)} more`);
      return `**${GROUP_TITLES[group]}**\n${rows.join('\n')}`;
    })
    .join('\n\n');
}

/** One excerpt per listed item, quoting the sentence the extractor matched. */
function excerpts(
  docId: string,
  shown: readonly Shown[],
  paths: ReadonlyMap<string, readonly Section[]>,
): SearchHit[] {
  return shown.flatMap(({ group, items }) =>
    items.map((item, i) => {
      const path = paths.get(item.sectionId);
      return syntheticHit(docId, {
        key: `delegations:${group}:${String(i)}`,
        sectionId: item.sectionId,
        breadcrumb: path ? breadcrumb(path) : item.sectionId,
        text: `(${GROUP_TAGS[group]}) ${item.quote}`,
        location: {
          ...(item.page !== undefined && {
            pageStart: item.page,
            pageEnd: item.page,
          }),
          ...(item.line !== undefined && { lineStart: item.line }),
        },
      });
    }),
  );
}

/**
 * The first paragraph of the model's reply, if it is usable as a lede: not the decline
 * sentence, not cut off, and still citing at least one listed section after invalid markers
 * were stripped. A lede that cites nothing is not grounded in the list, so it is dropped.
 */
function cleanLede(result: AnswerResult): string | undefined {
  if (result.declined || result.warnings.includes('TRUNCATED'))
    return undefined;
  const first = result.text.trim().split(/\n\s*\n/)[0] ?? '';
  const flat = first.replace(/\s+/g, ' ').trim();
  // Grounding is judged on the text we keep, not on the whole reply: a cited second paragraph
  // must not vouch for an uncited first one.
  const valid = new Set(
    result.citations.filter((c) => c.valid).map((c) => c.sectionId),
  );
  if (!findCitationIds(flat).some((id) => valid.has(id))) return undefined;
  // A list or heading in the lede would break the "lede, then list" shape.
  if (
    flat === '' ||
    flat.length > LEDE_MAX_CHARS ||
    /^(?:[-*#]|\d+\.)\s/.test(flat)
  )
    return undefined;
  return flat;
}

/** True when the provider is usable. Only a missing key means "go on without the model". */
function hasKey(provider: LlmProvider): boolean {
  try {
    // Reading `id` is what throws MISSING_KEY on a lazy provider.
    return provider.id.length > 0;
  } catch (error) {
    if (isAppError(error) && error.code === 'MISSING_KEY') return false;
    throw error;
  }
}

interface ModelInfo {
  provider: AnswerResult['provider'];
  model: string;
  usage: LlmUsage;
}

function result(
  chip: ChipDefinition,
  text: string,
  base: Pick<AnswerResult, 'citations' | 'invalidCitations' | 'warnings'>,
  model: ModelInfo,
  onToken: RunChipOptions['onToken'],
): ChipRun {
  // One piece, after validation: what is streamed is exactly the final text.
  onToken?.(text);
  return {
    answer: {
      text,
      ...base,
      declined: false,
      readingGrade: fleschKincaidGrade(text),
      ...model,
    },
    hits: [],
    backendUsage: ZERO_USAGE,
    mode: 'none',
  };
}

export async function runDelegationsChip(
  chip: ChipDefinition,
  docId: string,
  deps: ChipDeps,
  options: RunChipOptions,
): Promise<ChipRun> {
  const found = extractDelegations(deps.doc.sections, deps.doc.externalRefs);
  const shown: Shown[] = GROUPS.flatMap((group) => {
    const all = found[group];
    if (all.length === 0) return [];
    const items = all.slice(0, MAX_ITEMS_PER_GROUP);
    return [
      {
        group,
        items,
        more: all.length - items.length + found.truncated[group],
      },
    ];
  });
  const none: ModelInfo = {
    provider: 'none',
    model: chip.id,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  if (shown.length === 0)
    return result(
      chip,
      NOTHING_LEFT_TEXT,
      { citations: [], invalidCitations: [], warnings: [] },
      none,
      options.onToken,
    );

  const list = renderList(shown);
  const hits = excerpts(docId, shown, pathsById(deps.doc.sections));
  const chunks = hits.map((h) => h.chunk);
  const validate = (text: string) =>
    validateCitations(text, new Set(chunks.flatMap(coveredSectionIds)), chunks);

  let lede: string | undefined;
  let replyInvalid: string[] = [];
  let replyWarnings: AnswerResult['warnings'] = [];
  let model: ModelInfo = none;
  if (deps.publicMode !== true && hasKey(deps.provider)) {
    const reply = await answer({
      provider: deps.provider,
      question: chip.label,
      context: { hits, metadata: deps.doc.metadata },
      chipInstruction: chip.answerInstruction ?? LEDE_INSTRUCTION,
      signal: options.signal,
      maxTokens: Math.min(
        options.maxTokens ?? LEDE_MAX_TOKENS,
        LEDE_MAX_TOKENS,
      ),
    });
    // The call was made and paid for even when the lede is then dropped.
    model = {
      provider: reply.provider,
      model: reply.model,
      usage: reply.usage,
    };
    lede = cleanLede(reply);
    // Mis-citations the model made are worth reporting even though they were stripped.
    replyInvalid = reply.invalidCitations;
    replyWarnings = reply.warnings.filter(
      (w) => w === 'INVALID_CITATIONS_REMOVED',
    );
  }

  // Lede and list are validated as one text, so both get numbered together in the web.
  const validated = validate(lede === undefined ? list : `${lede}\n\n${list}`);
  return result(
    chip,
    validated.text,
    {
      citations: validated.citations.map((c) =>
        withoutSyntheticChunks(c, docId),
      ),
      invalidCitations: [
        ...new Set([...replyInvalid, ...validated.invalidCitations]),
      ],
      warnings: [...new Set([...replyWarnings, ...validated.warnings])],
    },
    model,
    options.onToken,
  );
}

/**
 * The CLI prints the web renderer's escapes as plain text. Only the list rows are escaped by our
 * code, so unescape from the first group heading on and leave the model's lede untouched.
 */
export function unescapeDelegationList(text: string): string {
  const at = text.search(
    /(?:^|\n\n)\*\*(?:Decided later by|Depends on|Takes effect when)\*\*\n/,
  );
  return at < 0 ? text : text.slice(0, at) + unescapeRecordText(text.slice(at));
}
