# 0011: "Who decides later" is extracted by rules

**Status:** accepted (2026-10-14), issues #201, #202 (for #144)

## Context

A bill often leaves the hard choices to someone else: an agency writes the rules, an official picks the date, voters must approve, or money must be appropriated first. A reader asking "what happens next, and who decides?" gets little from a summary of what the text says now. This is also a place where a model can invent: naming an agency that the bill never names, or turning a plain duty into a power.

## Decision

**A rule-based extractor finds the items. A model never decides what is on the list.** `src/core/enrich/delegations.ts` mirrors `definitions.ts`: regex candidates, sentence segmenting and section scoping, over text with struck characters removed. It runs when the chip runs, on the sections the chip is given, so no new stored field is needed. Every item carries a section id and a line for its citation.

**Decided later** covers rule-making and discretion verbs only:

- "shall prescribe" or "shall promulgate" regulations or rules;
- "shall establish" standards, criteria or procedures;
- "as determined by ...";
- "may waive";
- "designate" and "approve".

Each item records the actor, what is decided, and any deadline ("not later than 180 days after ..."). **Plain duties are excluded.** "The board of elections shall certify the results" is a duty the bill already states in full. Listing it would make every sentence with "shall" look like a delegation.

**Depends on** covers:

- other laws and charters, taken from the reference extractor;
- outside agencies or bodies named as deciding or approving;
- "subject to appropriation" and "to the extent funds are available";
- voter approval;
- effective-date and contingency triggers ("takes effect if ...", "contingent on the enactment of ...").

Each group is capped, with a "more" count.

**The chip.** `delegations` is a new chip with the `extract` strategy. Its answer is a markdown list grouped "Decided later by", "Depends on" and "Takes effect when", with a citation marker on each item. A short plain-language lede comes first.

**The lede is grounded only in the extracted list.** The model sees the list, not the document, and is told to summarize only what the list says. The lede and the list are then validated together through `validateCitations` with synthetic chunks, as scenarios are (see [ADR 0009](0009-scenario-grounding.md)), so the numbering covers both. Drop is whole and never a rewrite: a lede with any sentence that lacks a valid citation, or with any invalid citation, is dropped, and the list stands alone.

**No provider, no lede.** With no usable provider (a missing key), or in public mode, the chip returns the list alone. The list needs no model, so it always works: the same holds when the lede call is refused by the rate limit (aborts and other errors still surface). The provider is passed lazily, because resolving it throws when the key is missing.

## Failure modes this guards against

- **Invented delegates.** A model asked "who decides?" will name a plausible agency. The extractor only reports what the text says, and the lede cannot add to it.
- **Duties passed off as delegations.** The verb list excludes plain duties.
- **Repealed text counted.** The extractor reads struck-free text.
- **Unsupported lede claims.** Joint citation validation drops the whole lede if any sentence does not cite a listed item.

## Consequences

- The list is only as complete as the patterns. A delegation phrased in an unusual way will be missed. The chip reports what it found, not that nothing else exists, and the copy must not claim completeness.
- The extractor is deterministic, so tests pin exact outputs, including negatives: plain duties, struck text and definitions.
- The chip row grows from 9 to 10 chips. The chip-count tests and the mock API change with the chip.
- Hand checks on S. 202 and Issue 8 are recorded in the pull request.
