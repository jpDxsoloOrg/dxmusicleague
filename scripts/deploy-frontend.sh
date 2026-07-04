#!/usr/bin/env bash
# Build and publish the frontend to S3 + CloudFront with correct cache headers.
#
# The whole point of this script over a plain `aws s3 sync`: content-hashed
# assets (assets/index-<hash>.js) are cached forever (immutable), but index.html
# must NEVER be cached — it's the file that points at the current hashed bundle.
# Cache index.html and users keep loading a stale app until they hard-refresh
# (which is exactly what bit us once). So we upload it with `no-cache`.
#
# VITE_* are public client-side identifiers (not secrets); defaults match the
# deployed MusicLeagueStack. Override via env for another environment.
#
#   ./scripts/deploy-frontend.sh
set -euo pipefail

cd "$(dirname "$0")/.."

: "${VITE_API_URL:=https://uncjl7aiph.execute-api.us-east-1.amazonaws.com/prod}"
: "${VITE_COGNITO_USER_POOL_ID:=us-east-1_BmxDHFhef}"
: "${VITE_COGNITO_CLIENT_ID:=4fldkrmdloui2fgg8lmlqisr38}"
: "${SITE_BUCKET:=musicleaguestack-sitebucket397a1860-lqqfzofq24cj}"
: "${DISTRIBUTION_ID:=E23KX4CNR9J5WH}"
export VITE_API_URL VITE_COGNITO_USER_POOL_ID VITE_COGNITO_CLIENT_ID

echo "▸ Building (VITE_API_URL=$VITE_API_URL)"
npm run build

echo "▸ Syncing hashed assets (immutable, cache 1y) — everything except index.html"
aws s3 sync dist/ "s3://$SITE_BUCKET" --delete \
  --exclude index.html \
  --cache-control "public,max-age=31536000,immutable"

echo "▸ Uploading index.html (no-cache — always revalidate)"
aws s3 cp dist/index.html "s3://$SITE_BUCKET/index.html" \
  --cache-control "no-cache" \
  --content-type "text/html"

echo "▸ Invalidating CloudFront"
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" \
  --paths '/*' --query "Invalidation.{Id:Id,Status:Status}" --output table

echo "✓ Frontend deployed → https://djdsot446j15p.cloudfront.net"
