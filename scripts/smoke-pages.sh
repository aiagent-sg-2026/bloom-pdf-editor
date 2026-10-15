#!/usr/bin/env bash
set -euo pipefail

base_url="${1:?Usage: bash scripts/smoke-pages.sh BASE_URL}"
base_url="${base_url%/}/"

for path in '' 'editor/' 'icon.png' 'brand/paperloom-logo.svg'; do
  url="${base_url}${path}"
  # Allow about two minutes per URL, including the final request timeout.
  if ! status=$(curl --silent --show-error --location --fail \
    --retry 24 --retry-delay 5 --retry-max-time 110 --retry-all-errors \
    --connect-timeout 5 --max-time 10 \
    --output /dev/null --write-out '%{http_code}' "$url"); then
    printf 'Smoke check failed: %s could not be fetched after retries (last HTTP status: %s).\n' \
      "$url" "$status" >&2
    exit 1
  fi
  if [[ "$status" != '200' ]]; then
    printf 'Smoke check failed: %s returned HTTP %s; expected HTTP 200.\n' \
      "$url" "$status" >&2
    exit 1
  fi
  printf 'Smoke check passed: %s returned HTTP 200.\n' "$url"
done
