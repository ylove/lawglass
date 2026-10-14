# 0009: Grounding rules for scenarios

**Status:** accepted (2026-10-14), issue #118

## Context

A scenario is a short illustrated story: a made-up person, 3 to 4 frames, each with an avatar, an icon and a caption. Stories help readers see what a bill does to a life, and they are also the riskiest thing we show. A story invites numbers, and a model will supply them whether or not the bill does. A confident wrong figure on a tax bill is worse than no story.

## Decision

**Invented numbers are allowed only as labeled assumptions.** A story needs a person with an income, a home and a bill, and the bill will not supply those. So the profile is invented, and every profile number is visibly labeled "example". Everything about the bill's _effect_ is held to a stricter rule:

- An effect uses only a rate or amount stated in the bill, with a citation, or a calculation shown from those figures plus the labeled assumptions.
- When the bill states no figure, the frame is qualitative: it says what changes, not by how much.

**Validator rules.** A validator runs on every scenario before it is shown.

- Every citation must resolve to a retrieved section, as in §5.7.
- Every figure in an effect caption must appear in the cited text, or in a displayed calculation whose inputs are cited figures or labeled assumptions. The arithmetic is recomputed.
- A frame that fails is made qualitative: its figures are removed and its citation kept only if valid.
- A scenario with fewer than 3 surviving frames is dropped. Nothing is shown in its place.
- Avatars and icons are values from closed lists, and a value outside the list fails the frame. The model never produces markup.

**Neutral language.** Captions describe effects and never judge them. No "unfair", "relief" or "burden". The same bill text must produce the same framing whatever the question implies.

**Neutral, diverse personas.** Avatars are drawn to be neutral and diverse. Names come from a fixed neutral list, so the model does not choose a name, and a name cannot signal a group.

**When a scenario shows** is in spec Amendment 13: with the summary for a single-subject bill, and otherwise only beside answers that ask for a story.

## Failure modes this guards against

- **Made-up rates.** The model invents a percentage or limit and presents it as the bill's. The citation check and the figure check stop this.
- **Partisan framing.** Loaded words, or a persona chosen to sway, make the tool an advocate. Neutral wording and the closed lists stop this.
- **Stereotyped personas.** A model left alone picks a persona that fits a stereotype of who a bill helps or hurts. A fixed neutral name list and neutral, diverse avatars stop this, and the profile is labeled an example.
- **False precision.** A calculation that looks exact but rests on a hidden assumption. Showing the calculation and labeling its assumptions stops this.
- **Markup injection.** Model output used as HTML or SVG. Closed lists stop this.

## Consequences

- Many scenarios will be fully or partly qualitative. That is correct when the bill gives no number.
- Some bills will get no scenario. A missing story is better than an ungrounded one.
- The validator and the closed lists are code and need tests, including negative cases: a figure not in the cited text, a frame with an unknown icon, a scenario that drops to two frames.
- Wording rules are checked in tests of the prompt and by review, since no validator can fully judge tone.
