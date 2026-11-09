# Cost calibration job (#385)

Runs `scripts/calibrate.ts` against the real Anthropic API as a Cloud Run Job and prints a JSON report to the job logs. It measures what the pipeline really spends on a plan of bills and compares it with the estimator in `src/core/cost`. Part of #385: this is the tooling; the run comes after.

**Spend is capped at $10 in total** (`--max-usd`, default 10) and $3 per bill and model plan (`--max-usd-per-bill`, default 3). Every admitted job carries a dollar budget, and once the total is reached no further call is sent. Overshoot is limited to calls already in flight.

The API key reaches the container only as the `ANTHROPIC_API_KEY` environment variable, from Secret Manager. The script never prints it.

## What runs

Five smaller bills on two plans, then the NDAA on one:

| Bill                                                                    | Plans                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| S. 1582 (119th), S. 5687 (118th), NY A. 5000, NJ S. 1000, Ohio S.B. 113 | Haiku 5.5 (answer and extract); Sonnet 5.5 answer with Haiku 5.5 extract |
| H.R. 5009 (118th, NDAA)                                                 | Haiku 5.5 only; breakdown capped at 30 parts, examples `small`           |

Small bills use full coverage (`breakdownMaxUnits: all`, `pregenerateExamples: all`). The order is Haiku runs, then the NDAA, then Sonnet runs, so the cheap and most useful numbers exist if the cap binds. Replace the plan with `--plan plan.json` (an array of `{bill, url, plan, answerModel, extractModel, breakdownMaxUnits, pregenerateExamples}`) and filter with `--only <text>`.

## Build and push an image

The image the service uses (`deploy/cloud-run/deploy.sh`) predates this script, so build a new one from the branch or ref that contains `scripts/calibrate.ts`. The build runs `tsup`, which emits `dist/calibrate.js` (it is left out of the npm package). These are the build steps from `deploy.sh`, without the service deploy:

```sh
PROJECT_ID=lawglass-preview
REGION=us-east1
REF=chore/385-calibration            # or the merged commit
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/lawglass/lawglass:calibration-$(git rev-parse --short "$REF^{commit}")"

context=$(mktemp -d)
git archive "$REF" | tar -x -C "$context"
gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin "https://$REGION-docker.pkg.dev"
docker buildx build --platform linux/amd64 --provenance=false --tag "$IMAGE" --push "$context"
docker logout "https://$REGION-docker.pkg.dev"
```

## Create the job

The container's entrypoint starts the web server, so the job overrides the command. `tsx` is a dev dependency and is pruned from the image, hence `node dist/calibrate.js`.

```sh
gcloud run jobs create lawglass-calibration \
  --project lawglass-preview --region us-east1 \
  --image "$IMAGE" \
  --service-account lawglass-run@lawglass-preview.iam.gserviceaccount.com \
  --command node \
  --args dist/calibrate.js,--max-usd,10,--max-usd-per-bill,3 \
  --set-env-vars LAWGLASS_LLM_PROVIDER=anthropic,LAWGLASS_BACKEND=local \
  --set-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest \
  --max-retries 0 \
  --task-timeout 3600 \
  --cpu 2 --memory 4Gi
```

`--max-retries 0` matters: a retry would spend the budget again from zero. The service account needs `roles/secretmanager.secretAccessor` on `anthropic-api-key`, which the service already has.

To change the image or arguments later, use `gcloud run jobs update lawglass-calibration ...` with the same flags.

## Try it without spending

A dry run uses the mock provider: no key is read, nothing is billed. It still downloads the bills, so it checks that each URL resolves and the flow completes.

```sh
gcloud run jobs execute lawglass-calibration \
  --project lawglass-preview --region us-east1 --wait \
  --args dist/calibrate.js,--dry-run,--only,S.\ 1582
```

If your gcloud version rejects an `--args` override on `execute`, run the dry run locally: `npx tsx scripts/calibrate.ts --dry-run --only "S. 1582"`.

## Run it

```sh
gcloud run jobs execute lawglass-calibration \
  --project lawglass-preview --region us-east1 --wait
```

Time limits: each run (one bill on one plan) stops after `--run-timeout-minutes` (default 10), and no run starts after `--deadline-minutes` (default 55) so the report is written before the 3600 second task timeout. Raise `--task-timeout` and both flags together if the NDAA needs longer.

## Read the output

Everything goes to stdout, which Cloud Run Jobs writes to the job's logs. Progress goes to stderr, also in the logs.

- Each finished run is printed at once as a line starting `CALIBRATION RUN ` followed by its JSON, so a killed or timed-out job still leaves its measurements.
- The final report is one JSON line between `=== CALIBRATION REPORT BEGIN ===` and `=== CALIBRATION REPORT END ===`.

Save the job log and turn it into the markdown for `docs/calibration.md`. The report script accepts the JSON or the raw log lines, and rebuilds a partial report from the `CALIBRATION RUN` lines when the final report is missing.

```sh
EXECUTION=$(gcloud run jobs executions list --job lawglass-calibration \
  --project lawglass-preview --region us-east1 --limit 1 --format 'value(name)')
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=lawglass-calibration AND labels.\"run.googleapis.com/execution_name\"=$EXECUTION" \
  --project lawglass-preview --order asc --limit 100000 --format 'value(textPayload)' > calibration.log

npx tsx scripts/calibration-report.ts calibration.log > docs/calibration.md
```

The report states what was skipped when the cap or the deadline stopped the plan, and recommends a multiplier per feature for the estimator's high bound (the worst measured/high ratio with a 25% margin, rounded up to 0.05).

## Things to know

- Spend is read from the usage each call reports. A call that failed without usage is charged at a conservative guess and flagged `estimated` in the report. A model missing from the price table is charged at the dearest known rate and flagged `unpricedCalls`.
- Metadata is extracted once, at first ingest, so on the second plan for a bill it shows no calls. Compare metadata on the Haiku runs only.
- The quote recorded in each run is the server's own (default part cap). The estimate that measured cost is compared with is computed with the run's real caps.
- The spend gate of #397 is not in this tree; the script enforces the cap through per-job budgets and a guard on every provider call.
- Bills are fetched live from congress.gov, nysenate.gov, njleg.state.nj.us and legislature.ohio.gov. If one is unreachable or moved, its run is reported `failed` and the rest continue.
