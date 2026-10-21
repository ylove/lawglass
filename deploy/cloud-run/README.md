# Hosted private preview on Cloud Run

This is the runbook for the invite-only preview (decision 0014). One Cloud Run instance runs `serve --private`. Its state lives in a private Cloud Storage bucket, and its secrets live in Secret Manager. Everything here fits in Google Cloud's free tier at preview traffic, but Cloud Run still requires a billing account.

## What is where

| Piece                              | Where                                                              |
| ---------------------------------- | ------------------------------------------------------------------ |
| Image build                        | `Dockerfile` (models baked in, non-root, no secrets)               |
| State save and restore             | `deploy/cloud-run/entrypoint.sh` (a tarball on the mounted bucket) |
| Service settings                   | `deploy/cloud-run/service.yaml`                                    |
| Build and deploy from a tag        | `deploy/cloud-run/deploy.sh`                                       |
| Model provider key                 | Secret Manager secret `anthropic-api-key`                          |
| Invite key (`LAWGLASS_ACCESS_KEY`) | Secret Manager secret `lawglass-access-key`                        |
| Saved state                        | `gs://<bucket>/state.tar.gz` (versioned)                           |

## One-time setup

Replace `PROJECT_ID` and `BUCKET` with your own values. Region `us-east1` supports both the free tier and domain mapping.

```sh
gcloud projects create PROJECT_ID
gcloud billing projects link PROJECT_ID --billing-account=BILLING_ACCOUNT_ID
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com storage.googleapis.com

# Image registry
gcloud artifacts repositories create lawglass --repository-format=docker --location=us-east1

# Private, versioned state bucket. Keep the last three saves.
gcloud storage buckets create gs://BUCKET --location=us-east1 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://BUCKET --versioning
gcloud storage buckets update gs://BUCKET --lifecycle-file=- <<'JSON'
{"rule": [{"action": {"type": "Delete"}, "condition": {"numNewerVersions": 3, "isLive": false}}]}
JSON

# A service account that can do two things: use the bucket and read two secrets.
gcloud iam service-accounts create lawglass-run --display-name="Lawglass Cloud Run"
SA=lawglass-run@PROJECT_ID.iam.gserviceaccount.com
gcloud storage buckets add-iam-policy-binding gs://BUCKET \
  --member=serviceAccount:$SA --role=roles/storage.objectUser

# Empty secrets. Add their values in the console (Security, then Secret Manager, then the
# secret, then New version), so they never pass through a terminal history or a chat.
gcloud secrets create anthropic-api-key --replication-policy=automatic
gcloud secrets create lawglass-access-key --replication-policy=automatic
for secret in anthropic-api-key lawglass-access-key; do
  gcloud secrets add-iam-policy-binding $secret \
    --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done
```

Make the access key at least 32 random characters, for example `openssl rand -base64 36 | tr -d '/+='`, and keep a copy in a password manager. The invite link is `https://lawglass.xyz/?k=<key>`.

For the provider key, create a dedicated workspace in the Anthropic Console with a monthly spend limit, then create the key in that workspace. Usage is billed to the organization that owns the workspace.

Add a budget alert under Billing, then Budgets & alerts, for example $5 with alerts at 50, 90 and 100%.

## Deploy

```sh
PROJECT_ID=PROJECT_ID BUCKET=BUCKET deploy/cloud-run/deploy.sh v1.0.0
```

The script exports the tag with `git archive`, builds the image with Cloud Build, fills in `service.yaml`, deploys it and allows unauthenticated requests (the app checks invites itself). It prints the `run.app` URL.

## Custom domain

1. Verify the domain once: `gcloud domains verify lawglass.xyz`, then add the TXT record that Search Console shows at your DNS host.
2. Map it:
   ```sh
   gcloud beta run domain-mappings create --service=lawglass --domain=lawglass.xyz --region=us-east1
   gcloud beta run domain-mappings create --service=lawglass --domain=www.lawglass.xyz --region=us-east1
   gcloud beta run domain-mappings describe --domain=lawglass.xyz --region=us-east1
   ```
3. Add the A and AAAA records (apex) and the CNAME (www) that `describe` lists at the DNS host. With Vercel DNS: `vercel dns add lawglass.xyz '' A <ip>`, and so on. The certificate usually arrives within 15 minutes, but can take up to 24 hours.

## Day to day

- **Logs:** run `gcloud run services logs read lawglass --region=us-east1`. App events are JSON lines. Snapshot events have `"event":"snapshot"`.
- **Roll back:** run `gcloud run services update-traffic lawglass --region=us-east1 --to-revisions=<revision>=100`.
- **Rotate the access key:** add a new version of `lawglass-access-key`, then redeploy, or run `gcloud run services update lawglass --region=us-east1` to start a new revision. Every existing session cookie stops working.
- **Rotate the provider key:** create the new key in the Anthropic Console, add it as a new version of `anthropic-api-key`, start a new revision, then revoke the old key.
- **Wipe all documents:** delete `gs://BUCKET/state.tar.gz` and start a new revision. Earlier versions stay in the bucket until the lifecycle rule removes them.
- **Restore an earlier save:** list versions with `gcloud storage ls -a gs://BUCKET/state.tar.gz`, copy the one you want over the live object, and start a new revision.

## Limits to know

- **One instance.** A deploy starts a new instance before the old one stops, so a document added in those few seconds can be lost. Deploy when nobody is using the preview.
- **Cold starts.** After about 15 idle minutes the instance stops. The next visit waits for a cold start, about 5 to 15 seconds. Open the site a minute before a demo.
- **Lost work on a crash.** A crash loses changes made since the last save; a clean shutdown loses none.
