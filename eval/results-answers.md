# Eval results

- Run at: 2026-10-14T05:36:44.954Z
- Commit: 49a52182994c9b35a0e2e5858319a8ca464be8e4
- Retrieval models: local backend: Xenova/bge-small-en-v1.5 (embedding), Xenova/ms-marco-MiniLM-L-6-v2 (reranker)
- Golden sets frozen at: oh-hb62-135-in: 7639f1834cb50bdbd84506716639f9166f44f629; oh-sb113-136-in: 7639f1834cb50bdbd84506716639f9166f44f629; oh-sb203-133-in: 7639f1834cb50bdbd84506716639f9166f44f629; us-hr5009-118-enr: 7639f1834cb50bdbd84506716639f9166f44f629; us-s202-119-is: 7639f1834cb50bdbd84506716639f9166f44f629

Retrieval is scored on ranked hits only (definition injection off). A hit counts when its section, or an ancestor or descendant of it, is an expected section. Recall is the share of expected sections found in the top k chunks; unanswerable questions are excluded from retrieval metrics. Embed tokens and rerank units are totals over the question set.

## oh-hb62-135-in

| Backend | Mode | Recall@5 | Recall@10 | MRR | p50 ms | Embed tokens | Rerank units |
| --- | --- | --- | --- | --- | --- | --- | --- |
| local | hybrid_rerank (rrf) | 0.950 | 1.000 | 0.870 | 357.0 | 539 | 581 |

### Answers

| Backend | Mode | Provider | Model | Citation validity | Decline rate | Deleted-text leakage | Mean FK grade | Answers > grade 9 | Removal acknowledged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| local | hybrid_rerank (rrf) | claude-cli | sonnet | 100.0% | 100.0% | 8.7% | 8.6 | 12 | 60.0% |

## oh-sb113-136-in

| Backend | Mode | Recall@5 | Recall@10 | MRR | p50 ms | Embed tokens | Rerank units |
| --- | --- | --- | --- | --- | --- | --- | --- |
| local | hybrid_rerank (rrf) | 1.000 | 1.000 | 0.900 | 1428.6 | 459 | 758 |

### Answers

| Backend | Mode | Provider | Model | Citation validity | Decline rate | Deleted-text leakage | Mean FK grade | Answers > grade 9 | Removal acknowledged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| local | hybrid_rerank (rrf) | claude-cli | sonnet | 100.0% | 100.0% | 0.0% | 9.5 | 12 | 100.0% |

## oh-sb203-133-in

| Backend | Mode | Recall@5 | Recall@10 | MRR | p50 ms | Embed tokens | Rerank units |
| --- | --- | --- | --- | --- | --- | --- | --- |
| local | hybrid_rerank (rrf) | 0.952 | 0.952 | 0.744 | 857.2 | 563 | 983 |

### Answers

| Backend | Mode | Provider | Model | Citation validity | Decline rate | Deleted-text leakage | Mean FK grade | Answers > grade 9 | Removal acknowledged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| local | hybrid_rerank (rrf) | claude-cli | sonnet | 100.0% | 100.0% | 0.0% | 8.8 | 11 | 100.0% |

## us-hr5009-118-enr

| Backend | Mode | Recall@5 | Recall@10 | MRR | p50 ms | Embed tokens | Rerank units |
| --- | --- | --- | --- | --- | --- | --- | --- |
| local | hybrid_rerank (rrf) | 0.880 | 0.920 | 0.858 | 1344.0 | 668 | 1597 |

### Answers

| Backend | Mode | Provider | Model | Citation validity | Decline rate | Deleted-text leakage | Mean FK grade | Answers > grade 9 | Removal acknowledged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| local | hybrid_rerank (rrf) | claude-cli | sonnet | 100.0% | 100.0% | 0.0% | 8.5 | 14 | 100.0% |

## us-s202-119-is

| Backend | Mode | Recall@5 | Recall@10 | MRR | p50 ms | Embed tokens | Rerank units |
| --- | --- | --- | --- | --- | --- | --- | --- |
| local | hybrid_rerank (rrf) | 0.850 | 0.900 | 0.833 | 291.9 | 475 | 850 |

### Answers

| Backend | Mode | Provider | Model | Citation validity | Decline rate | Deleted-text leakage | Mean FK grade | Answers > grade 9 | Removal acknowledged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| local | hybrid_rerank (rrf) | claude-cli | sonnet | 100.0% | 66.7% | 0.0% | 10.1 | 16 | 0.0% |
