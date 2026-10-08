#!/usr/bin/env bash
# Nightly backup: pg_dump + documents volume archive, uploaded to S3.
# Retention is handled by the bucket's lifecycle rule (14 days), not here.
# Intended to run via cron on the EC2 instance; relies on the instance's
# IAM role for S3 access (no static credentials).
set -euo pipefail

BUCKET="prelude-backups-036281891241"
DATE="$(date +%Y%m%d_%H%M%S)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

docker exec infra-postgres-1 pg_dump -U prelude -Fc prelude > "$TMP_DIR/prelude_${DATE}.dump"

docker run --rm \
  -v infra_documents_data:/data:ro \
  -v "$TMP_DIR":/backup \
  alpine tar czf "/backup/documents_${DATE}.tar.gz" -C /data .

aws s3 cp "$TMP_DIR/prelude_${DATE}.dump" "s3://${BUCKET}/${DATE}/prelude_${DATE}.dump"
aws s3 cp "$TMP_DIR/documents_${DATE}.tar.gz" "s3://${BUCKET}/${DATE}/documents_${DATE}.tar.gz"

echo "Backup ${DATE} uploaded to s3://${BUCKET}/${DATE}/"
