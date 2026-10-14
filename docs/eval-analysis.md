# Eval analysis

What the numbers in [`eval/results.md`](../eval/results.md) and [`eval/results-answers.md`](../eval/results-answers.md) say, what they do not, and what changed because of them. How the harness works is in [eval.md](eval.md).

## Setup

- **Golden sets**: five, frozen at commit `7639f18` before the first run and not edited since. 119 questions: 31 exact lookups, 43 paraphrases, 19 definition questions, 11 "what does it remove" questions and 15 unanswerable ones (three per set).
- **Bills**: Ohio HB 62, SB 113 and SB 203 (PDFs with printed line numbers), federal S. 202 (XML) and federal H.R. 5009, the FY2025 NDAA (XML, 8,618 sections, about 1.8 million characters of text; 936k tokens in the most compact prompt form measured below).
- **Retrieval**: local backend only: `bge-small-en-v1.5` embeddings, BM25, `ms-marco-MiniLM-L-6-v2` cross-encoder. Pinecone rows are pending until the nightly job runs with a key.
- **Answers**: `claude-cli` provider with the `sonnet` model (Claude Sonnet 5.5), default mode `hybrid_rerank` only, at commit `a651f35` (retrieval tables are from the same commit). Scoring answers for the other modes too would have meant 476 model calls instead of 119 (the weighted-fusion variant has no answer path).
- Small samples: one question moves recall@5 by about 0.05 on a set of 20. Read differences of one or two questions as noise.

## Retrieval

`hybrid_rerank` (the default) has the best ranking (MRR) on four of five bills. On recall@5 it beats dense on SB 203 (0.95 against 0.71), ties on HB 62 and SB 113, and loses on S. 202 (17 of 20 questions with a relevant section in the top 5, against 18) and the NDAA (22 of 25, against 24).

By question kind, pooled over all bills (share with a relevant section in the top 5):

| Kind       | n   | dense    | sparse | hybrid (RRF) | hybrid (weighted) | hybrid_rerank |
| ---------- | --- | -------- | ------ | ------------ | ----------------- | ------------- |
| exact      | 31  | 0.90     | 0.87   | 0.94         | 0.94              | **0.97**      |
| paraphrase | 43  | **0.95** | 0.77   | 0.88         | 0.93              | 0.93          |
| definition | 19  | 0.79     | 0.79   | 0.79         | 0.79              | **0.84**      |
| removed    | 11  | **1.00** | 0.82   | **1.00**     | **1.00**          | 0.91          |

This is roughly the expected shape: lexical signal helps exact lookups, embeddings help paraphrases. Definition questions move only with the reranker, and by one question (0.79 to 0.84).

### Dense misses, the reranked hybrid finds it

SB 203, sb203-04: _"Does trading one gun for another count as a 'transfer'?"_ The answer is division (A) of section 2923.27, whose item (7) defines "transfer". Dense ranks that division 8th, behind seven other passages of the same section; BM25 and plain RRF fusion do not put it in the top 10 at all. Plain fusion does not fix it either (RRF leaves it outside the top 10, weighted fusion ranks it 9th). Because dense and sparse candidates go into one pool, the cross-encoder reads the question against that division and ranks it first: the win here is the reranker's.

### Where the reranker hurts

Both NDAA losses are paraphrases:

- hr5009-13, _"Does the military now have to buy American-made forks, spoons, and dishes?"_ Sec. 842 is titled "Domestic production of stainless steel flatware and dinnerware". Dense ranks it 1st; after reranking it is not in the top 10.
- hr5009-10, _"Will horse-drawn funerals come back at Arlington National Cemetery?"_ Sec. 1088 is about "caisson services". Dense: 1st; reranked: 8th.

Our reading, not yet tested: the local cross-encoder is small (about 22M parameters) and trained on web search queries, and it does not bridge synonyms like _forks_ and _flatware_ the way the embedding model does. The NDAA's long heading paths (Division > Title > Subtitle > Sec.) may also crowd its 512-token input. On the NDAA, weighted fusion without reranking is the best local mode (recall@5 0.96, MRR 0.92). A stronger reranker, such as the `bge-reranker-v2-m3` model Pinecone hosts, is the next thing to measure.

_Update, 2026-10-14: we measured it. `bge-reranker-v2-m3` on Pinecone also misses hr5009-13, so the stronger-reranker hypothesis did not hold; see [Pinecone backend (2026-10-14)](#pinecone-backend-2026-10-14)._

### A fix that came from the eval (#97)

The reranker originally scored a chunk's text without its heading path, while the embedder indexed both. Giving the reranker the same `breadcrumb: text` the embedder sees changed `hybrid_rerank` as follows:

| Bill   | recall@5 before | after | MRR before | after |
| ------ | --------------- | ----- | ---------- | ----- |
| HB 62  | 0.95            | 0.95  | 0.81       | 0.87  |
| SB 113 | 1.00            | 1.00  | 0.84       | 0.90  |
| SB 203 | 0.88            | 0.95  | 0.70       | 0.74  |
| NDAA   | 0.84            | 0.88  | 0.77       | 0.86  |
| S. 202 | 0.95            | 0.85  | 0.86       | 0.83  |

Average MRR went from 0.797 to 0.841; average recall@5 barely moved (0.924 to 0.926), because S. 202's fell from 0.95 to 0.85. S. 202 lost two borderline definition questions; in both, the reranker preferred a neighbouring section whose heading shares a word with the question ("program"), which is our best explanation rather than a tested one. The change was made after looking at eval results. It is not tuned to them (it gives the reranker context the first stage already had), but the "before" numbers are reported here so the effect can be judged.

## Pinecone backend (2026-10-14)

The same five golden sets, run against a live Pinecone Starter index (commit `3a0851a`; `llama-text-embed-v2` dense, `pinecone-sparse-english-v0` sparse, `bge-reranker-v2-m3` reranker). The full table is [`eval/results-pinecone.md`](../eval/results-pinecone.md). The run used 104 rerank calls; Starter includes 500 a month.

### Pinecone against local, `hybrid_rerank`

| Bill        | local recall@5 / MRR | Pinecone recall@5 / MRR |
| ----------- | -------------------- | ----------------------- |
| HB 62       | 0.95 / 0.87          | 1.00 / 0.975            |
| SB 113      | 1.00 / 0.90          | 0.944 / 0.954           |
| SB 203      | 0.952 / 0.74         | 0.881 / 0.913           |
| S. 202      | 0.85 / 0.83          | 0.90 / 0.90             |
| NDAA        | 0.88 / 0.86          | 0.96 / 0.94             |
| **Average** | **0.926 / 0.841**    | **0.937 / 0.936**       |

Pinecone ranks better on all five bills: MRR is higher on each, and the average rises from 0.841 to 0.936. Recall@5 is not uniformly better. It is higher on HB 62, S. 202 and the NDAA, and lower on SB 113 (0.944 against 1.00, one expected section out of 18) and SB 203 (0.881 against 0.952, three out of 42). One question moves recall@5 by about 0.05 on these sets, so the average recall difference (0.937 against 0.926) is within noise; the MRR gap is the clearer signal. The two backends also differ in more than the reranker (embedding model, sparse model, chunk scoring), so this does not isolate which part helps.

### The flatware question is still missed

hr5009-13, _"Does the military now have to buy American-made forks, spoons, and dishes?"_ (expected Sec. 842) is still not in the top 10 of `hybrid_rerank` with `bge-reranker-v2-m3`. The reranker puts Sec. 844(b)(4) and Sec. 845 first. On the same question Pinecone's dense search ranks Sec. 842 first, weighted hybrid second, and RRF hybrid fourth.

This **disproves** the earlier hypothesis (above, and in the README) that a stronger reranker such as `bge-reranker-v2-m3` was the obvious next step for this miss. It is a much larger model than the local MiniLM cross-encoder and still pushes the right section out.

What we can rule out: the candidate pool. The reranker is given the top 64 fused hits, and RRF hybrid had Sec. 842 at rank 4, so it was among the candidates and the reranker scored it below ten others. (The run file stores only the top 10 of each mode, not the pool, so this is inferred from the RRF ranking rather than read from the reranker's input.) What is still untested: that the NDAA's long heading paths in the reranker input (Division > Title > Subtitle > Sec.) crowd out the passage text. The next experiment is to rerank the same candidates with a shortened breadcrumb and compare.

### Engineering lesson: a batch that could never succeed

The first NDAA ingest stalled on 429 responses at the same batch, twice. Batches were 96 records, and that one batch alone was larger than Starter's per-minute embedding-token limit, so no amount of waiting would let it through. Retrying harder was the wrong fix. The fix (`3a0851a`) budgets each batch by estimated tokens (20,000 by default), halves a batch that keeps getting 429s, and uses jittered backoff that honors `Retry-After`. After that, the whole five-bill eval, NDAA included, finished in about five minutes.

## Answers

All 119 golden questions, default mode, Claude Sonnet 5.5 through the `claude-cli` provider, commit `a651f35` ([`eval/results-answers.md`](../eval/results-answers.md)):

| Bill              | Citation validity | Unanswerable declined | Deleted-text leakage (heuristic) | Mean reading grade | Removal acknowledged     |
| ----------------- | ----------------- | --------------------- | -------------------------------- | ------------------ | ------------------------ |
| Ohio HB 62        | 100%              | 3 of 3                | 4.3% (1 answer; see below)       | 8.7                | 80% (4 of 5)             |
| Ohio SB 113       | 100%              | 3 of 3                | 0%                               | 9.6                | 100% (1 of 1)            |
| Ohio SB 203       | 100%              | 3 of 3                | 0%                               | 8.5                | 100% (1 of 1)            |
| Federal S. 202    | 100%              | 1 of 3                | 0%                               | 10.2               | n/a (no such questions)¹ |
| Federal H.R. 5009 | 100%              | 3 of 3                | 0%                               | 8.8                | 100% (4 of 4)            |

¹ The generated file prints 0.0% here: it was produced before the n/a fix in this change.

- **Every citation pointed at a section the model was shown.** Citations are checked after generation, so this is a hard guarantee for what is shown, not a model behaviour.
- **Struck text.** HB 62 is the only bill with struck text. The final run flagged one answer; answers are not stored, so its 23 questions were asked again on the same code and every flagged answer was read. That run flagged two, and both were false positives. One answer said _"The excerpts show the bill removing one provision…"_ and then described that provision in the next sentence; the other paraphrased live text (2901.05(B)(1)) that shares a four-word run with a struck clause elsewhere. No answer stated repealed text as current law. The heuristic's limits are tracked in #88.
- **Plain-language change questions were the biggest find.** Before #101, _"What does the bill **cross out**…?"_, _"What old wording is **crossed out**…?"_ and _"Does the bill **get rid of** the rule…?"_ were not recognised as questions about changes, so the struck text never reached the model and it declined or, worse, said nothing had been struck. After the fix, removal acknowledgement on HB 62 rose from 3 of 5 questions to 4 of 5 (one question; small, but the answers themselves changed from declines to correct descriptions of the struck text). Two gaps remain: a one-word strike (_"presented"_) is still too small to retrieve on its own (#102; the "What does it change?" chip handles it), and one answer named only one of the two struck words in a definition. Wider phrasings ("take away", "the old law") are tracked in #104.
- **Declines vary from run to run.** S. 202's unanswerable questions were declined 1, 2 and 3 times out of 3 in three runs. Asking each three more times gave six exact declines and three "soft declines" (_"The excerpts don't show any tax cuts. They describe a pilot program…"_, with citations). None invented an answer; the metric counts only the exact decline sentence (#109).
- **Reading level** averages grade 8.5 to 10.2 against a target of about grade 7. Legal terms ("trier of fact", "affirmative defense") push the score up; the prompt asks for plain language but the measured result is above target.

## Retrieval or the whole bill in the prompt?

The NDAA was the test. Claude Sonnet 5.5 has a 1M-token context window.

- **The structured prompt does not fit.** Sending every chunk in the same excerpt format retrieval uses (section id, heading path, page and lines on each excerpt) comes to about 2.2M tokens.
- **A compact version barely fits.** One excerpt per section with only its id, printed number, heading and current text is about 936k tokens, 94% of the window. A bill much longer than the NDAA would not fit at all.
- **Accuracy on a small sample.** Five NDAA questions, chosen before any run as the first golden question of each kind, asked both ways with the same model, system prompt and citation checks:

| Question                                                                                        | Kind         | Retrieval (`hybrid_rerank`)                                                                                  | Whole bill         |
| ----------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ | ------------------ |
| What is the full short title of this Act?                                                       | exact        | declined: the Act's own short title is not in the top 10 (the NDAA has dozens of "may be cited as" sections) | correct            |
| Starting when can't stores on military bases sell garlic from China?                            | paraphrase   | correct                                                                                                      | correct            |
| Does the Western Hemisphere part of this law count Venezuela as part of the Western Hemisphere? | definition   | correct                                                                                                      | correct            |
| Which law limiting the Pentagon's purchases of drop-in fuels does this Act repeal?              | removed      | correct                                                                                                      | correct            |
| Does this bill raise the federal minimum wage?                                                  | unanswerable | declined (correct)                                                                                           | declined (correct) |

- **Cost.** Retrieval used about 4,500 input tokens per question; the whole bill used about 936,000, roughly 200 times more. At API list prices ($2 per million input tokens, $10 per million output) that is about $0.01 against $1.87 per question. Through Claude Code the whole-bill calls each wrote a fresh one-hour cache, which costs more ($3.74 per question); a client that cached the bill once and appended each question would pay the cache write once and then the cache-read rate per question: about $0.09 or $0.19, depending on which of Anthropic's published cache-read prices ($0.10 or $0.20 per million tokens) applies; the pricing page and the model announcement disagree.
- **Latency.** Similar after the first call: retrieval answers took 4 to 9 seconds, whole-bill answers 3 to 5 seconds, except the first whole-bill call at 35 seconds.

So on this sample the whole bill was as accurate or more, and retrieval's case rests on cost, on bills that do not fit, and on what the pipeline does that a flat prompt cannot: exclude struck text unless the question is about changes, add the definitions a passage depends on, cite page and line, and choose a strategy per question. Five questions is far too few to compare accuracy; the miss above is a real retrieval weakness (a generic phrase repeated across a very large bill) worth its own fix.

## Known limits of the metrics

- **Deleted-text leakage** is a heuristic: a run of four or more words from struck text, not also found in live text, quoted as a claim. It over-counts when an answer paraphrases live text that shares a word sequence with a struck passage. Re-asking HB 62's questions, the one answer it flagged was such a case (it restated live 2901.05(B)(1); the matching four words occur only in struck clauses elsewhere). See #88.
- **Removal acknowledged** is the share of "removed" questions whose answers use removal language ("removes", "strikes", "no longer"...). It is n/a for a set with no such questions.
- **Declined** means the answer is exactly the decline sentence; a correct "the bill doesn't cover this" in other words counts as answered.
- **Ranks are chunk ranks**: the first chunk whose section, or an ancestor, descendant or merged child of it, is expected.
- Two questions name their section numbers (hb62-03, sb203-08), and some paraphrases reuse rare words from the text, which makes them easier for BM25.
