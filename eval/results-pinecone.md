# Eval results

- Run at: 2026-10-14T18:53:39.325Z
- Commit: 3a0851a8a60bcf392f60d4471cf8391b4f773a8b
- Retrieval models: pinecone backend: llama-text-embed-v2 (dense), pinecone-sparse-english-v0 (sparse), bge-reranker-v2-m3 (reranker)
- Golden sets frozen at: oh-hb62-135-in: 7639f1834cb50bdbd84506716639f9166f44f629; oh-sb113-136-in: 7639f1834cb50bdbd84506716639f9166f44f629; oh-sb203-133-in: 7639f1834cb50bdbd84506716639f9166f44f629; us-hr5009-118-enr: 7639f1834cb50bdbd84506716639f9166f44f629; us-s202-119-is: 7639f1834cb50bdbd84506716639f9166f44f629

Retrieval is scored on ranked hits only (definition injection off). A hit counts when its section, or an ancestor or descendant of it, is an expected section. Recall is the share of expected sections found in the top k chunks; unanswerable questions are excluded from retrieval metrics. Embed tokens and rerank units are totals over the question set.

## oh-hb62-135-in

| Backend  | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| -------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| pinecone | dense               | 0.950    | 1.000     | 0.900 | 122.2  | 389          | 0            |
| pinecone | sparse              | 0.950    | 1.000     | 0.815 | 103.8  | 0            | 0            |
| pinecone | hybrid (rrf)        | 0.950    | 1.000     | 0.871 | 181.6  | 389          | 0            |
| pinecone | hybrid (weighted)   | 0.950    | 1.000     | 0.870 | 164.6  | 389          | 0            |
| pinecone | hybrid_rerank (rrf) | 1.000    | 1.000     | 0.975 | 437.9  | 389          | 20           |

Answer metrics: not run (needs `--answers` and a live provider).

## oh-sb113-136-in

| Backend  | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| -------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| pinecone | dense               | 0.944    | 1.000     | 0.954 | 88.6   | 342          | 0            |
| pinecone | sparse              | 0.833    | 0.889     | 0.761 | 66.7   | 0            | 0            |
| pinecone | hybrid (rrf)        | 0.889    | 0.889     | 0.847 | 158.5  | 342          | 0            |
| pinecone | hybrid (weighted)   | 1.000    | 1.000     | 0.884 | 144.9  | 342          | 0            |
| pinecone | hybrid_rerank (rrf) | 0.944    | 1.000     | 0.954 | 731.0  | 342          | 18           |

Answer metrics: not run (needs `--answers` and a live provider).

## oh-sb203-133-in

| Backend  | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| -------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| pinecone | dense               | 0.881    | 0.976     | 0.808 | 85.5   | 409          | 0            |
| pinecone | sparse              | 0.833    | 0.905     | 0.583 | 63.7   | 0            | 0            |
| pinecone | hybrid (rrf)        | 0.833    | 0.929     | 0.733 | 149.6  | 409          | 0            |
| pinecone | hybrid (weighted)   | 0.833    | 0.929     | 0.773 | 159.8  | 409          | 0            |
| pinecone | hybrid_rerank (rrf) | 0.881    | 0.929     | 0.913 | 567.9  | 409          | 21           |

Answer metrics: not run (needs `--answers` and a live provider).

## us-hr5009-118-enr

| Backend  | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| -------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| pinecone | dense               | 1.000    | 1.000     | 0.953 | 90.4   | 488          | 0            |
| pinecone | sparse              | 0.840    | 0.920     | 0.744 | 71.7   | 0            | 0            |
| pinecone | hybrid (rrf)        | 0.940    | 1.000     | 0.864 | 155.8  | 488          | 0            |
| pinecone | hybrid (weighted)   | 0.960    | 1.000     | 0.899 | 151.7  | 488          | 0            |
| pinecone | hybrid_rerank (rrf) | 0.960    | 0.960     | 0.940 | 826.5  | 488          | 25           |

Answer metrics: not run (needs `--answers` and a live provider).

## us-s202-119-is

| Backend  | Mode                | Recall@5 | Recall@10 | MRR   | p50 ms | Embed tokens | Rerank units |
| -------- | ------------------- | -------- | --------- | ----- | ------ | ------------ | ------------ |
| pinecone | dense               | 0.875    | 1.000     | 0.842 | 83.8   | 336          | 0            |
| pinecone | sparse              | 0.600    | 0.900     | 0.602 | 64.2   | 0            | 0            |
| pinecone | hybrid (rrf)        | 0.800    | 0.900     | 0.686 | 146.6  | 336          | 0            |
| pinecone | hybrid (weighted)   | 0.800    | 0.950     | 0.823 | 140.9  | 336          | 0            |
| pinecone | hybrid_rerank (rrf) | 0.900    | 0.900     | 0.900 | 495.3  | 336          | 20           |

Answer metrics: not run (needs `--answers` and a live provider).
