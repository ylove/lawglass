#!/bin/sh
# Builds the image from a clean export of a git ref and deploys it to Cloud Run.
# Only committed files reach Cloud Build, so nothing local (.env, downloads, caches) can leak in.
#
# Usage: PROJECT_ID=my-project BUCKET=my-project-state deploy/cloud-run/deploy.sh v1.0.0
# Optional: REGION (default us-east1), SERVICE (default lawglass),
#           PUBLIC_ORIGIN (default https://lawglass.xyz).
set -eu

ref=${1:?usage: deploy.sh <git ref, e.g. v1.0.0>}
: "${PROJECT_ID:?set PROJECT_ID}"
: "${BUCKET:?set BUCKET}"
REGION=${REGION:-us-east1}
SERVICE=${SERVICE:-lawglass}
PUBLIC_ORIGIN=${PUBLIC_ORIGIN:-https://lawglass.xyz}
SERVICE_ACCOUNT="$SERVICE-run@$PROJECT_ID.iam.gserviceaccount.com"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$SERVICE/$SERVICE:$(git rev-parse --short "$ref^{commit}")"

here=$(cd "$(dirname "$0")" && pwd)
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT

git archive "$ref" | tar -x -C "$context"
gcloud builds submit "$context" --project "$PROJECT_ID" --tag "$IMAGE"

sed -e "s|\${SERVICE}|$SERVICE|g" \
  -e "s|\${REGION}|$REGION|g" \
  -e "s|\${SERVICE_ACCOUNT}|$SERVICE_ACCOUNT|g" \
  -e "s|\${IMAGE}|$IMAGE|g" \
  -e "s|\${BUCKET}|$BUCKET|g" \
  -e "s|\${PUBLIC_ORIGIN}|$PUBLIC_ORIGIN|g" \
  "$here/service.yaml" > "$context/service.yaml"
gcloud run services replace "$context/service.yaml" --project "$PROJECT_ID" --region "$REGION"
# The app checks invite links itself, so Cloud Run must let unauthenticated requests through.
gcloud run services add-iam-policy-binding "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
  --member allUsers --role roles/run.invoker >/dev/null
gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
  --format 'value(status.url)'
