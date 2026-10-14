# 0009: Grounding rules for scenarios

**Status:** accepted (2026-10-14), issue #118

## Context

A scenario is a short illustrated story: a made-up person, 3 to 4 frames, each with an avatar, an icon and a caption. Stories help readers see what a bill does to a life, and they are also the riskiest thing we show. A story invites numbers, and a model will supply them whether or not the bill does. A confident wrong figure on a tax bill is worse than no story.

## Decision

**Invented numbers are allowed only as labeled assumptions.** A story needs a person with an income, a home and a bill, and the bill will not supply those. So the profile is invented, and every profile number is visibly labeled "example". Everything about the bill's _effect_ is held to a stricter rule:

- An effect uses only a rate or amount stated in the bill, with a citation, or a calculation shown from those figures plus the labeled assumptions.
- When the bill states no figure, the frame is qualitative: it says what changes, not by how much.

**Frame kinds.** A `setup` frame states only the labeled example profile. A `rule` or `effect` frame states what the bill does.

**Validator rules.** Parsing comes first, then a validator runs on every scenario before it is shown.

- A scenario that fails schema parsing is dropped whole. This covers an unknown avatar or icon (closed lists, so the model never produces markup) and the wrong number of frames.
- A `setup` frame may have no citations, but may state only the labeled profile, never a claim about the bill. Setup captions are composed in code after parsing: `This is <name>. <label>.` followed by code-rendered, explicitly labeled example assumptions. The validator requires an exact template match; profile and assumption labels are limited to short descriptive text without numbers or claim verbs.
- Every `rule` or `effect` frame needs at least one valid citation, resolved against the retrieved sections as in §5.7. A frame with no valid citation is dropped.
- Every figure in a `rule` or `effect` caption must appear in the cited text, or in a displayed calculation whose inputs are cited figures or labeled assumptions. The arithmetic is recomputed. A frame whose figure fails is dropped, because its caption embeds the number.
- Failed frames are never rewritten. Stripping a citation or a figure from a caption would leave the claim standing without support. A frame is qualitative only if it was generated without figures.
- If fewer than 3 frames survive, the scenario is dropped and nothing is shown in its place. At most one regeneration attempt is allowed before dropping.

**Neutral language.** Captions describe effects and never judge them. No "unfair", "relief" or "burden". The same bill text must produce the same framing whatever the question implies.

**Neutral, diverse personas.** Avatars are drawn to be neutral and diverse. Names come from a fixed neutral list, so the model does not choose a name, and a name cannot signal a group.

**When a scenario shows** is in spec Amendment 13, as amended by Amendment 17 (rc.3): a default scenario for every bill, plus scenarios on demand. Amendment 13 first limited it to single-subject bills.

## Failure modes this guards against

- **Made-up rates.** The model invents a percentage or limit and presents it as the bill's. The citation check and the figure check stop this.
- **Partisan framing.** Loaded words, or a persona chosen to sway, make the tool an advocate. Neutral wording and the closed lists stop this.
- **Stereotyped personas.** A model left alone picks a persona that fits a stereotype of who a bill helps or hurts. A fixed neutral name list and neutral, diverse avatars stop this, and the profile is labeled an example.
- **False precision.** A calculation that looks exact but rests on a hidden assumption. Showing the calculation and labeling its assumptions stops this.
- **Markup injection.** Model output used as HTML or SVG. Closed lists stop this.

## Consequences

- Many scenarios will be fully or partly qualitative. That is correct when the bill gives no number.
- Some bills will get no scenario. A missing story is better than an ungrounded one.
- The validator and the closed lists are code and need tests, including negative cases: a figure not in the cited text, an unknown icon (whole scenario dropped), a `rule` frame with no valid citation, a scenario that drops to two frames.
- Wording rules are checked in tests of the prompt and by review, since no validator can fully judge tone.
