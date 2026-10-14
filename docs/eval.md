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
