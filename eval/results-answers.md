# Eval results

- Run at: 2026-10-14T06:11:37.343Z
- Commit: a651f354b1aa7cca7752d80dbdee9d94ae14af93
- Retrieval models: local backend: Xenova/bge-small-en-v1.5 (embedding), Xenova/ms-marco-MiniLM-L-6-v2 (reranker)
- Golden sets frozen at: oh-hb62-135-in: 7639f1834cb50bdbd84506716639f9166f44f629; oh-sb113-136-in: 7639f1834cb50bdbd84506716639f9166f44f629; oh-sb203-133-in: 7639f1834cb50bdbd84506716639f9166f44f629; us-hr5009-118-enr: 7639f1834cb50bdbd84506716639f9166f44f629; us-s202-119-is: 7639f1834cb50bdbd84506716639f9166f44f629

Retrieval is scored on ranked hits only (definition injection off). A hit counts when its section, or an ancestor or descendant of it, is an expected section. Recall is the share of expected sections found in the top k chunks; unanswerable questions are excluded from retrieval metrics. Embed tokens and rerank units are totals over the question set.

## oh-hb62-135-in

| Backend | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| ------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| local   | hybrid_rerank (rrf) | 0.950    | 1.000     | 0.870 | 540.0  | 539          | 627          |

### Answers

| Backend | Mode                | Provider   | Model  | Citation validity | Decline rate | Deleted-text leakage | Mean FK grade | Answers > grade 9 | Removal acknowledged |
| ------- | ------------------- | ---------- | ------ | ----------------- | ------------ | -------------------- | ------------- | ----------------- | -------------------- |
| local   | hybrid_rerank (rrf) | claude-cli | sonnet | 100.0%            | 100.0%       | 4.3%                 | 8.7           | 11                | 80.0%                |

## oh-sb113-136-in

| Backend | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| ------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| local   | hybrid_rerank (rrf) | 1.000    | 1.000     | 0.900 | 1433.5 | 459          | 758          |

### Answers

| Backend | Mode                | Provider   | Model  | Citation validity | Decline rate | Deleted-text leakage | Mean FK grade | Answers > grade 9 | Removal acknowledged |
| ------- | ------------------- | ---------- | ------ | ----------------- | ------------ | -------------------- | ------------- | ----------------- | -------------------- |
| local   | hybrid_rerank (rrf) | claude-cli | sonnet | 100.0%            | 100.0%       | 0.0%                 | 9.6           | 12                | 100.0%               |

## oh-sb203-133-in

| Backend | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| ------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| local   | hybrid_rerank (rrf) | 0.952    | 0.952     | 0.744 | 1116.5 | 563          | 983          |

### Answers

| Backend | Mode                | Provider   | Model  | Citation validity | Decline rate | Deleted-text leakage | Mean FK grade | Answers > grade 9 | Removal acknowledged |
| ------- | ------------------- | ---------- | ------ | ----------------- | ------------ | -------------------- | ------------- | ----------------- | -------------------- |
| local   | hybrid_rerank (rrf) | claude-cli | sonnet | 100.0%            | 100.0%       | 0.0%                 | 8.5           | 8                 | 100.0%               |

## us-hr5009-118-enr

| Backend | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| ------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| local   | hybrid_rerank (rrf) | 0.880    | 0.920     | 0.858 | 1411.4 | 668          | 1597         |

### Answers

| Backend | Mode                | Provider   | Model  | Citation validity | Decline rate | Deleted-text leakage | Mean FK grade | Answers > grade 9 | Removal acknowledged |
| ------- | ------------------- | ---------- | ------ | ----------------- | ------------ | -------------------- | ------------- | ----------------- | -------------------- |
| local   | hybrid_rerank (rrf) | claude-cli | sonnet | 100.0%            | 100.0%       | 0.0%                 | 8.8           | 13                | 100.0%               |

## us-s202-119-is

| Backend | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| ------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| local   | hybrid_rerank (rrf) | 0.850    | 0.900     | 0.833 | 279.0  | 475          | 850          |

### Answers

| Backend | Mode                | Provider   | Model  | Citation validity | Decline rate | Deleted-text leakage | Mean FK grade | Answers > grade 9 | Removal acknowledged |
| ------- | ------------------- | ---------- | ------ | ----------------- | ------------ | -------------------- | ------------- | ----------------- | -------------------- |
| local   | hybrid_rerank (rrf) | claude-cli | sonnet | 100.0%            | 33.3%        | 0.0%                 | 10.2          | 16                | 0.0%                 |
