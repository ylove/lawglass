# syntax=docker/dockerfile:1.7
# Image for the hosted private preview on Cloud Run. See deploy/cloud-run/README.md and
# docs/decisions/0014-hosted-private-preview.md. Nothing secret is built into this image: API
# keys and the access key arrive at runtime as environment variables from Secret Manager.

# Pinned by digest. Node 22.23.4 is the 2026-10-20 security release, so it is exempt from the
# repository's 7-day release-age cooldown.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:5991875dfb80938dd8a6ba3fe3e96fd04929e70792762b3319d8caadbbe229bc

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# onnxruntime-node's postinstall downloads CUDA libraries for linux/x64. The CPU build we use
# already ships inside the package.
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
# Bake the local retrieval models (revisions pinned in models.lock.json) into the image, so an
# instance never downloads them at startup.
RUN npx tsx scripts/fetch-models.ts --config-dir /opt/state/.lawglass
RUN npm prune --omit=dev --no-audit --no-fund
# Keep only the ONNX runtime for this platform. transformers' Node build needs onnxruntime-node
# and onnxruntime-common, never onnxruntime-web (about 140 MB).
RUN set -eu; \
    arch="$(node -p process.arch)"; \
    for dir in node_modules/onnxruntime-node/bin/napi-v*/*; do \
      [ "$(basename "$dir")" = linux ] || rm -rf "$dir"; \
    done; \
    for dir in node_modules/onnxruntime-node/bin/napi-v*/linux/*; do \
      [ "$(basename "$dir")" = "$arch" ] || rm -rf "$dir"; \
    done; \
    rm -rf node_modules/onnxruntime-web

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOME=/home/node
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build --chown=node:node /opt/state/.lawglass /home/node/.lawglass
COPY --chmod=755 deploy/cloud-run/entrypoint.sh /usr/local/bin/entrypoint
# The app refuses a config directory that other users can write to.
RUN chmod 700 /home/node/.lawglass
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint"]
# Arguments for `serve`. Cloud Run terminates TLS in one hop in front of the container.
CMD ["--private", "--host", "0.0.0.0", "--port", "8080", "--no-open", "--trust-proxy", "1"]
