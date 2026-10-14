# Eval run details

Run eval from the repository root after downloading the named fixture:

```sh
node dist/cli.js eval --fixture us-hr5009-118-enr --backend local
node dist/cli.js eval compare eval/runs/<timestamp>.json --a dense --b hybrid_rerank
```

The run JSON contains a `questions` array on each fixture/backend/mode row.
Each question records its id, kind, question text, expected section ids,
`firstRelevantRank` (1-based, or null when no top-10 hit matches), and `top10`
hits with section ids, breadcrumbs and scores. Scores belong to their mode's
ranking and should not be compared across modes. Chunk text is omitted.
Unanswerable questions are excluded from both retrieval metrics and details.
Hits that contain merged subsections also retain `coveredSectionIds`, so recall
recomputed from the details uses the same sections as the aggregate metrics.
`eval/results.md` continues to show aggregates only.

Compare reads the JSON offline and prints questions where exactly one mode finds
an expected section in the top five. It shows both first relevant ranks and both
top-10 breadcrumb lists, including gains and losses. A hit counts when its section
(or a covered section) equals an expected section, or is its ancestor or descendant.
This is a binary top-five comparison; aggregate recall measures the fraction of
expected sections found and can be fractional for questions with multiple expected
sections.

Rows are paired within each fixture and backend, then printed in stable order by
fixture, backend and question id. Use `--fixture <name>` to select one fixture.
`hybrid` and `hybrid_rerank` select RRF by default; use `hybrid/weighted` for the
weighted fusion row or `hybrid/rrf` to name RRF explicitly. Both selected rows
must exist for each fixture/backend being compared and contain the same questions
and expectations. Older run files without details must be regenerated.

## Prompt-injection eval

`npm run eval:injection` runs 22 synthetic adversarial cases through the real `ask` pipeline and writes `eval/results-injection.md`. Direct cases put the attack in the question (role-play, "ignore previous rules", prompt extraction, off-topic tasks, markdown links and images, forged tags, bidi and zero-width characters, a very long question). Indirect cases plant it in the bill (instructions to the AI, a fake "this section was struck" note, URL and image bait, fake citations, instructions inside struck text). Two cases also attack the illustrated example.

In CI the model is a fake that **obeys** the injection, so a pass shows that the code around the model holds when the model is fooled. With `--provider claude-cli` a real model answers, and the report records whether it resisted. Each case is checked for: escaping in the prompt, citation validation, a leak of the system prompt (8-word overlap), URL or markup text in the answer, every claim cited or flagged, no planted claim repeated, and scenario validation. `src/web/injection-render.test.tsx` renders the same replies with the real `AnswerText` and checks that no link, image, script or event handler exists in the DOM.

Failures that exist today are listed per case as `expectedFailures` in `src/eval/injection/cases.ts` and shown under "Known gaps" in the report. CI fails if one stops reproducing, so the list cannot go stale.

Residual risk (OWASP LLM09, misinformation): a hostile bill can steer a model into a slanted or false but **grounded** answer. The sentence cites a real retrieved section, so citation validation accepts it. Escaping, rule 7, the neutrality rule and the citation drawer reduce the chance; nothing in code can prove a claim is supported. The README should say citations are checked to exist, not that claims are verified.
