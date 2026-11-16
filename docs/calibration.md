# Cost estimator calibration

Generated 2026-11-16T16:11:28.927Z. Spent $2.17 of a $4.00 cap ($2.00 per run).

Measured is what the providers reported for each call, priced with the same table the budgets use. Estimated is `estimateBill` for the same bill, model plan and coverage settings. Ratio is measured over the estimate's **high** bound; the bound holds when it is at most 1.00x.

## Totals by run

| Bill             | Plan         |    Status | Sections | Briefs | Estimate low | Estimate high | Measured | Measured / high |
| ---------------- | ------------ | --------: | -------: | -----: | -----------: | ------------: | -------: | --------------: |
| S. 1582          | haiku        | completed |      684 |     18 |        $0.03 |         $0.20 |    $0.07 |           0.34x |
| S. 5687          | haiku        |    failed |      n/a |      0 |      $0.0000 |       $0.0000 |  $0.0000 |             n/a |
| NY A. 5000       | haiku        |    failed |      n/a |      0 |      $0.0000 |       $0.0000 |  $0.0000 |             n/a |
| NJ S. 1000       | haiku        | completed |        3 |      2 |      $0.0036 |         $0.05 |  $0.0076 |           0.15x |
| Ohio S.B. 113    | haiku        | completed |      101 |      7 |        $0.01 |         $0.08 |    $0.02 |           0.24x |
| H.R. 5009 (NDAA) | haiku        | completed |     8618 |     28 |        $0.02 |         $0.26 |    $0.04 |           0.15x |
| S. 1582          | sonnet+haiku | completed |      684 |     18 |        $0.53 |         $3.36 |    $1.34 |           0.40x |
| S. 5687          | sonnet+haiku |    failed |      n/a |      0 |      $0.0000 |       $0.0000 |  $0.0000 |             n/a |
| NY A. 5000       | sonnet+haiku |    failed |      n/a |      0 |      $0.0000 |       $0.0000 |  $0.0000 |             n/a |
| NJ S. 1000       | sonnet+haiku | completed |        3 |      2 |        $0.06 |         $0.79 |    $0.11 |           0.14x |
| Ohio S.B. 113    | sonnet+haiku | completed |      101 |      7 |        $0.17 |         $1.35 |    $0.30 |           0.22x |

Totals cover the bill's generation (metadata, summary and its story, breakdown, pictures, examples). Questions are below.

- S. 5687 on haiku: quote refused (HTTP 500)
- NY A. 5000 on haiku: ingest failed: PAYMENT_REQUIRED
- S. 5687 on sonnet+haiku: quote refused (HTTP 500)
- NY A. 5000 on sonnet+haiku: ingest failed: PAYMENT_REQUIRED

## Measured / high by feature

| Bill             | Plan         | metadata | summary | summaryScenario | breakdown | pictures | examples | Question |
| ---------------- | ------------ | -------: | ------: | --------------: | --------: | -------: | -------: | -------: |
| S. 1582          | haiku        |    0.47x |   0.47x |           0.84x |     0.40x |    0.22x |    0.26x |    0.16x |
| S. 5687          | haiku        |      n/a |     n/a |             n/a |       n/a |      n/a |      n/a |      n/a |
| NY A. 5000       | haiku        |      n/a |     n/a |             n/a |       n/a |      n/a |      n/a |      n/a |
| NJ S. 1000       | haiku        |    0.00x |   0.09x |           0.75x |     0.18x |    0.10x |    0.10x |    0.05x |
| Ohio S.B. 113    | haiku        |    0.49x |   0.20x |           0.53x |     0.28x |    0.31x |    0.18x |    0.07x |
| H.R. 5009 (NDAA) | haiku        |    0.72x |   0.27x |             n/a |     0.16x |    0.21x |    0.00x |    0.22x |
| S. 1582          | sonnet+haiku |    0.00x |   0.43x |           0.61x |     0.30x |    0.28x |    0.42x |    0.22x |
| S. 5687          | sonnet+haiku |      n/a |     n/a |             n/a |       n/a |      n/a |      n/a |      n/a |
| NY A. 5000       | sonnet+haiku |      n/a |     n/a |             n/a |       n/a |      n/a |      n/a |      n/a |
| NJ S. 1000       | sonnet+haiku |    0.00x |   0.05x |           0.74x |     0.08x |    0.25x |    0.21x |    0.02x |
| Ohio S.B. 113    | sonnet+haiku |    0.00x |   0.13x |           0.95x |     0.20x |    0.33x |    0.18x |    0.03x |

Question is the average of the two questions asked against the one-question estimate.

## Calls

Measured calls (of which the provider gave no usage, so a conservative guess was charged) against the estimate's high call count.

| Bill             | Plan         | metadata | summary |     summaryScenario | breakdown | pictures |              examples |
| ---------------- | ------------ | -------: | ------: | ------------------: | --------: | -------: | --------------------: |
| S. 1582          | haiku        |    1 / 1 |   2 / 2 |               1 / 2 |     4 / 6 |   7 / 12 |               14 / 36 |
| S. 5687          | haiku        |    0 / 0 |   0 / 0 |               0 / 0 |     0 / 0 |    0 / 0 |                 0 / 0 |
| NY A. 5000       | haiku        |    0 / 0 |   0 / 0 |               0 / 0 |     0 / 0 |    0 / 0 |                 0 / 0 |
| NJ S. 1000       | haiku        |    0 / 1 |   2 / 2 | 2 (1 estimated) / 2 |     2 / 3 |    2 / 6 |                 1 / 4 |
| Ohio S.B. 113    | haiku        |    1 / 1 |   2 / 2 |               1 / 2 |     2 / 3 |    5 / 6 |                5 / 14 |
| H.R. 5009 (NDAA) | haiku        |    1 / 1 |   4 / 4 |               0 / 0 |   16 / 24 |   7 / 15 |                0 / 16 |
| S. 1582          | sonnet+haiku |    0 / 1 |   2 / 2 | 1 (1 estimated) / 2 |     4 / 6 |   6 / 12 | 26 (1 estimated) / 36 |
| S. 5687          | sonnet+haiku |    0 / 0 |   0 / 0 |               0 / 0 |     0 / 0 |    0 / 0 |                 0 / 0 |
| NY A. 5000       | sonnet+haiku |    0 / 0 |   0 / 0 |               0 / 0 |     0 / 0 |    0 / 0 |                 0 / 0 |
| NJ S. 1000       | sonnet+haiku |    0 / 1 |   2 / 2 | 2 (1 estimated) / 2 |     2 / 3 |    3 / 6 |                 2 / 4 |
| Ohio S.B. 113    | sonnet+haiku |    0 / 1 |   2 / 2 | 2 (1 estimated) / 2 |     2 / 3 |    6 / 6 |                6 / 14 |

## Quality

Citation validity is valid citations over all citations; declines are answers that said the bill does not address the question, or briefs left empty.

| Bill             | Plan         | Answer citations | Answer validity | Answer declines | Brief citations | Brief validity | Brief declines |
| ---------------- | ------------ | ---------------: | --------------: | --------------: | --------------: | -------------: | -------------: |
| S. 1582          | haiku        |               78 |          100.0% |               0 |              55 |         100.0% |              0 |
| S. 5687          | haiku        |                0 |             n/a |               0 |               0 |            n/a |              0 |
| NY A. 5000       | haiku        |                0 |             n/a |               0 |               0 |            n/a |              0 |
| NJ S. 1000       | haiku        |                7 |          100.0% |               0 |               2 |         100.0% |              0 |
| Ohio S.B. 113    | haiku        |               18 |          100.0% |               0 |               8 |         100.0% |              0 |
| H.R. 5009 (NDAA) | haiku        |               21 |          100.0% |               0 |              53 |         100.0% |              0 |
| S. 1582          | sonnet+haiku |               68 |          100.0% |               0 |              64 |         100.0% |              0 |
| S. 5687          | sonnet+haiku |                0 |             n/a |               0 |               0 |            n/a |              0 |
| NY A. 5000       | sonnet+haiku |                0 |             n/a |               0 |               0 |            n/a |              0 |
| NJ S. 1000       | sonnet+haiku |                4 |          100.0% |               1 |               2 |         100.0% |              0 |
| Ohio S.B. 113    | sonnet+haiku |               16 |          100.0% |               0 |               8 |         100.0% |              0 |

Answers include the summary and the two fixed questions.

## Coverage

| Bill             | Plan         | Briefs | Left out | Example available | With picture | With example |
| ---------------- | ------------ | -----: | -------: | ----------------: | -----------: | -----------: |
| S. 1582          | haiku        |     18 |        0 |                11 |     1 (9.1%) |    9 (81.8%) |
| S. 5687          | haiku        |      0 |        0 |                 0 |      0 (n/a) | not measured |
| NY A. 5000       | haiku        |      0 |        0 |                 0 |      0 (n/a) | not measured |
| NJ S. 1000       | haiku        |      2 |        0 |                 1 |   1 (100.0%) |   1 (100.0%) |
| Ohio S.B. 113    | haiku        |      7 |        0 |                 4 |    3 (75.0%) |   4 (100.0%) |
| H.R. 5009 (NDAA) | haiku        |     28 |      882 |                 6 |     0 (0.0%) | not measured |
| S. 1582          | sonnet+haiku |     18 |        0 |                13 |    4 (30.8%) |    4 (30.8%) |
| S. 5687          | sonnet+haiku |      0 |        0 |                 0 |      0 (n/a) | not measured |
| NY A. 5000       | sonnet+haiku |      0 |        0 |                 0 |      0 (n/a) | not measured |
| NJ S. 1000       | sonnet+haiku |      2 |        0 |                 1 |   1 (100.0%) |     0 (0.0%) |
| Ohio S.B. 113    | sonnet+haiku |      7 |        0 |                 4 |    2 (50.0%) |    2 (50.0%) |

## Extrapolating a capped run

Dollars per brief from the measured run, scaled to every part the bill would brief with no cap. Pictures scale with briefs; examples are scaled only by the count measured, so this is a floor for the `small` policy.

| Bill             | Plan  | Briefed | All parts | Breakdown $/brief | Pictures $/brief | Breakdown + pictures, all parts |
| ---------------- | ----- | ------: | --------: | ----------------: | ---------------: | ------------------------------: |
| H.R. 5009 (NDAA) | haiku |      28 |       910 |           $0.0009 |          $0.0003 |                           $1.08 |

## Recommendation for the high bound

Worst measured/high ratio over the 7 runs that did not fail, with a 25% margin on top, rounded up to 0.05. Multiply a feature's high-bound dollars by this factor; 1.00 means the bound already holds with room to spare. Stopped and timed-out runs are included as floors (they measured part of the work, so a ratio above 1.00x there is a real overrun). Failed runs are left out.

Not complete: S. 5687 on haiku (failed, excluded); NY A. 5000 on haiku (failed, excluded); S. 5687 on sonnet+haiku (failed, excluded); NY A. 5000 on sonnet+haiku (failed, excluded).

| Feature         | Runs | Worst measured/high | Multiplier |
| --------------- | ---- | ------------------: | ---------: |
| metadata        | 7    |               0.72x |       1.00 |
| summary         | 7    |               0.47x |       1.00 |
| summaryScenario | 6    |               0.95x |       1.20 |
| breakdown       | 7    |               0.40x |       1.00 |
| pictures        | 7    |               0.33x |       1.00 |
| examples        | 7    |               0.42x |       1.00 |
| total           | 7    |               0.40x |       1.00 |

Every feature stayed within its high bound on every run that did not fail.

## Notes on this run

Hand-written after the generated report above. Run `lawglass-calibration-6v4qk` on 2026-11-16, image built from `5fd1f83` (#406, Anthropic SDK 1.6.0, API version 2026-10-21). The cap was lowered from the approved $10 to $4 because the workspace's spending headroom was tight.

- **Three of the five smaller bills were measured, not five.**
  - S. 5687 (118th) failed its quote with HTTP 500. Quoting the same URL locally fails in `chooseVersion` ("could not identify the latest text version", `FETCH_FAILED`), and `FETCH_FAILED` has no entry in the server's status map (#407).
  - NY A. 5000 failed its admitted ingest because New York's bytes change on every download (#407).
  - Neither made a model call. Pick replacement bills once #407 is fixed.
- **No multiplier is applied: a deliberate waiver, not a proof.**
  - In dollars, every feature stayed under its high bound on every completed run, and `total` reached at most 0.40x. That meets #385's criterion for these seven runs.
  - The margin rule's one recommendation above 1.00 is `summaryScenario` at 1.20, from a worst ratio of 0.95x on Ohio S.B. 113 (sonnet+haiku). That ratio includes a call that timed out without usage (#408), charged at the meter's guess: the prompt at four characters a token plus the full 2,000 output tokens.
  - The waiver rests on what was observed, not on a bound. `createScenario` makes at most two calls per invocation, which the high bound counts, but a summary attempt that is not cached can run again after the cool-down. Those repeated attempts fall outside that allowance.
  - Input is the weak side. Whole-bill prompts measured up to 1.87x the high bound's input per call: 76,133 tokens against 40,610 for S. 1582's summary, and 1.24x for Ohio's. The dollar bounds held because the high bound prices every prefix as a cache write and every call at full output, and real calls read from the cache and wrote short replies. A `summaryScenario` that runs twice on a whole-mode bill would exceed its bound, because scenario prompts are uncached: about $0.34 against $0.20 for S. 1582 on Sonnet.
  - A flat 1.20 would not cover that case. #410 fixes the input forecast itself; re-measure after it and #408.
- **Quality:**
  - Answer and brief citations were 100% valid on every run, on both models.
  - The one decline was Sonnet on NJ S. 1000, a three-section bill. The run does not record which answer declined.
- **The NDAA**, capped at 30 parts, extrapolates to about $1.08 for breakdown and pictures across all 910 parts on Haiku. Examples are a floor there (`small` policy).

- **Update (2026-11-16, #410):** the input forecast for whole-bill prompts was corrected. It is now sized from the built `<part>` blocks at a measured characters-per-token figure, not chars/4 times a flat markup, so the input weakness above no longer applies. The numbers recorded in this document are unchanged.
