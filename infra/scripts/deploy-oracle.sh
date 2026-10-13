#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="${CONCORD_APP_DIR:-$HOME/concord}"
readonly BRANCH="${CONCORD_BRANCH:-main}"

cd "$APP_DIR"
git fetch --prune origin "$BRANCH"
git checkout --force "$BRANCH"
git reset --hard "origin/$BRANCH"

test -f infra/.env
test -f infra/users.json
docker compose -f infra/docker-compose.yml config >/dev/null
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml ps

for attempt in $(seq 1 30); do
  if docker compose -f infra/docker-compose.yml exec -T api \
      wget --quiet --output-document=- http://127.0.0.1:3000/api/health >/dev/null; then
    exit 0
  fi
  sleep 2
done

echo "Concord health check failed" >&2
docker compose -f infra/docker-compose.yml logs --tail=100 api caddy
exit 1
