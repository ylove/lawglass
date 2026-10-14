# Eval results

- Run at: 2026-10-14T06:02:26.927Z
- Commit: a651f354b1aa7cca7752d80dbdee9d94ae14af93
- Retrieval models: local backend: Xenova/bge-small-en-v1.5 (embedding), Xenova/ms-marco-MiniLM-L-6-v2 (reranker)
- Golden sets frozen at: oh-hb62-135-in: 7639f1834cb50bdbd84506716639f9166f44f629; oh-sb113-136-in: 7639f1834cb50bdbd84506716639f9166f44f629; oh-sb203-133-in: 7639f1834cb50bdbd84506716639f9166f44f629; us-hr5009-118-enr: 7639f1834cb50bdbd84506716639f9166f44f629; us-s202-119-is: 7639f1834cb50bdbd84506716639f9166f44f629

Retrieval is scored on ranked hits only (definition injection off). A hit counts when its section, or an ancestor or descendant of it, is an expected section. Recall is the share of expected sections found in the top k chunks; unanswerable questions are excluded from retrieval metrics. Embed tokens and rerank units are totals over the question set.

## oh-hb62-135-in

| Backend | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| ------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| local   | dense               | 0.950    | 1.000     | 0.792 | 16.3   | 539          | 0            |
| local   | sparse              | 0.900    | 1.000     | 0.716 | 3.5    | 0            | 0            |
| local   | hybrid (rrf)        | 1.000    | 1.000     | 0.852 | 15.2   | 539          | 0            |
| local   | hybrid (weighted)   | 0.950    | 1.000     | 0.797 | 24.0   | 539          | 0            |
| local   | hybrid_rerank (rrf) | 0.950    | 1.000     | 0.870 | 447.7  | 539          | 627          |

Answer metrics: not run (needs `--answers` and a live provider).

## oh-sb113-136-in

| Backend | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| ------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| local   | dense               | 1.000    | 1.000     | 0.807 | 10.7   | 459          | 0            |
| local   | sparse              | 0.833    | 1.000     | 0.756 | 4.6    | 0            | 0            |
| local   | hybrid (rrf)        | 0.889    | 0.944     | 0.841 | 17.5   | 459          | 0            |
| local   | hybrid (weighted)   | 0.944    | 1.000     | 0.841 | 18.4   | 459          | 0            |
| local   | hybrid_rerank (rrf) | 1.000    | 1.000     | 0.900 | 607.3  | 459          | 758          |

Answer metrics: not run (needs `--answers` and a live provider).

## oh-sb203-133-in

| Backend | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| ------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| local   | dense               | 0.714    | 0.881     | 0.627 | 11.0   | 563          | 0            |
| local   | sparse              | 0.762    | 0.857     | 0.625 | 3.0    | 0            | 0            |
| local   | hybrid (rrf)        | 0.857    | 0.881     | 0.662 | 13.9   | 563          | 0            |
| local   | hybrid (weighted)   | 0.857    | 0.929     | 0.656 | 15.6   | 563          | 0            |
| local   | hybrid_rerank (rrf) | 0.952    | 0.952     | 0.744 | 467.0  | 563          | 983          |

Answer metrics: not run (needs `--answers` and a live provider).

## us-hr5009-118-enr

| Backend | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| ------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| local   | dense               | 0.960    | 0.960     | 0.893 | 384.4  | 668          | 0            |
| local   | sparse              | 0.820    | 0.840     | 0.683 | 322.6  | 0            | 0            |
| local   | hybrid (rrf)        | 0.920    | 0.960     | 0.807 | 609.6  | 668          | 0            |
| local   | hybrid (weighted)   | 0.960    | 0.960     | 0.920 | 476.0  | 668          | 0            |
| local   | hybrid_rerank (rrf) | 0.880    | 0.920     | 0.858 | 2624.8 | 668          | 1597         |

Answer metrics: not run (needs `--answers` and a live provider).

## us-s202-119-is

| Backend | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| ------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| local   | dense               | 0.900    | 0.900     | 0.702 | 18.0   | 475          | 0            |
| local   | sparse              | 0.675    | 0.725     | 0.619 | 5.6    | 0            | 0            |
| local   | hybrid (rrf)        | 0.800    | 0.975     | 0.712 | 17.6   | 475          | 0            |
| local   | hybrid (weighted)   | 0.850    | 0.925     | 0.707 | 11.6   | 475          | 0            |
| local   | hybrid_rerank (rrf) | 0.850    | 0.900     | 0.833 | 325.8  | 475          | 850          |

Answer metrics: not run (needs `--answers` and a live provider).
