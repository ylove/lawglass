# 0017: Adding jurisdictions by convention family

**Status:** accepted (2026-10-26), issues #280–#283

## Context

Lawglass read U.S. federal bills and Ohio legislation. The goal is all 50 states. A state is supported only when three things hold: a pasted link resolves to the official full text with no API key, the sections parse, and the change marks read correctly. The last is the one that matters most. A parser that reads a deleted phrase as current text presents repealed law as law, which is worse than refusing the bill.

New Jersey was refused at launch for exactly that reason: it prints removed words in [brackets], and the parsers read brackets as ordinary text.

## Decision

1. **Work by convention family, not by state.** `docs/jurisdictions.md` sorts the 50 states by how their bills mark changes:
   - F1, explicit XML markup (federal);
   - F2, strike-through and underline (Ohio and about 20 others);
   - F3, brackets plus underline (NY, NJ, AK, NM, UT, VT);
   - F4, brackets plus bold or italics;
   - F5, capitals for new text;
   - F6, instructions only;
   - an "unclassified" group for states with no verified sample.

   Parser work is done once per family. Adding a state from a solved family is mostly a resolver and a host allowlist entry.

2. **Gate the bracket convention on the state's own legend.** The bracket rule turns on only when the document comes from that state's official source and carries the state's exact explanation sentence ("Matter in brackets [ ] is old law to be omitted"). A document without the legend keeps the default rules and gets a warning. Under a verified legend every bracketed run is old law, including bracketed citations, which is how these states replace a reference. Only a few editorial labels such as `[Reserved]` stay literal.
3. **Official, keyless sources only, and never a blocked page.** Resolvers map every form of link a reader might paste to an official text that can be fetched without a key. The New York Senate's bill pages sit behind a bot challenge, so they are mapped to the Assembly's text or the Senate's PDFs and never fetched. New Jersey is always read from its PDF, the only format that carries the legend. Hosts are matched exactly, never by suffix.
4. **Structure comes from the bill's own section markers.** For NY and NJ, words like "chapter 397 of the laws of 2021" at the start of a wrapped line are prose, not containers, and only a short leading phrase such as "Short title." counts as a heading.

## Consequences

- New York and New Jersey are supported in v1.1. The hosted allowlist and the refusal message name them.
- Every new state ships with synthetic samples in `tests/synth/` and a local-only test against real bills, whose files are hashed in the manifest and never committed. Each records a span-by-span accuracy count.
- States that block automated fetches (California and Hawaii at the time of writing) need another official route before they can be supported.
