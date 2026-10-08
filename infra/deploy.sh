#!/usr/bin/env bash
# Run on the Prelude EC2 instance, from the repo root (/opt/prelude).
# Pulls main, rebuilds, restarts. No CI — this is the whole pipeline.
set -euo pipefail

cd "$(dirname "$0")/.."

git pull origin main
docker-compose -f infra/docker-compose.prod.yml --env-file .env up -d --build
docker-compose -f infra/docker-compose.prod.yml --env-file .env ps
