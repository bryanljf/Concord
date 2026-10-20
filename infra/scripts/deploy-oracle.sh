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

# livekit.yaml is a bind mount: `up -d` does not recreate the container when only the file
# changes, so a hash recorded outside the repo decides whether LiveKit must be restarted (rooms
# drop for a few seconds and the apps reconnect). Checked after the reset, so it sees the new
# livekit.yaml. Changes to this script itself only apply on the NEXT deploy: `git reset` replaces
# the file, and bash keeps reading the copy it opened.
readonly LIVEKIT_HASH_FILE="$HOME/.concord-livekit-config.sha256"
livekit_hash="$(sha256sum infra/livekit.yaml | cut -d ' ' -f 1)"
if [ "$(cat "$LIVEKIT_HASH_FILE" 2>/dev/null || true)" != "$livekit_hash" ]; then
  echo "infra/livekit.yaml changed: restarting livekit"
  docker compose -f infra/docker-compose.yml restart livekit
  echo "$livekit_hash" > "$LIVEKIT_HASH_FILE"
fi
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
