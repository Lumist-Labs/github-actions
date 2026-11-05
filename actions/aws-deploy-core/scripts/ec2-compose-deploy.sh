#!/usr/bin/env bash
# Runs on the target EC2 host via SSM. Static file, checked into the repo —
# not generated per-invocation. Every value it needs arrives as a plain
# environment variable, exported ahead of this script by the calling action.
#
# Expects: REPO_DIR, IMAGE, COMPOSE_FILE, COMPOSE_PROFILES_LIST, AWS_REGION,
# ENV_PARAMETER_NAME, ENV_FILE_NAME, HEALTHCHECK_URL, IMAGE_KEEP, and COMPOSE_B64_0,
# COMPOSE_B64_1, ... — one per file in COMPOSE_FILE, in the same order. The
# index is positional, set by the caller iterating `for f in $COMPOSE_FILE`
# the same way this script does — nothing about the filename itself needs to
# match between the two sides.
set -euo pipefail

mkdir -p "$REPO_DIR"
cd "$REPO_DIR"

# A boot-time unit can be bringing this same project up concurrently (a
# fresh instance, or a replacement under an ASG), and it writes these same
# compose files too -- the lock has to start before that write, not just
# before `up -d`, or the two processes can still interleave writes to the
# same file. 900s matches this action's command-timeout default of 1800s,
# so the wait cannot silently outlive the SSM command itself.
LOCK_FILE="/var/lock/$(basename "$REPO_DIR")-compose.lock"
exec 200>"$LOCK_FILE"
flock -w 900 200 || { echo "FATAL: timed out waiting for $LOCK_FILE" >&2; exit 1; }

i=0
for f in $COMPOSE_FILE; do
  var_name="COMPOSE_B64_$i"
  printf '%s' "${!var_name}" | base64 -d > "$REPO_DIR/$f"
  i=$((i + 1))
done

# ECR auth via the instance's own role — no credential is ever placed on
# this host by hand or by us.
REGISTRY=$(printf '%s' "$IMAGE" | cut -d/ -f1)
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

# Fetched here rather than passed in: SendCommand parameters are kept on the
# command record and copied into CloudWatch.
umask 077
aws ssm get-parameter --name "$ENV_PARAMETER_NAME" --with-decryption \
  --query Parameter.Value --output text > "$REPO_DIR/$ENV_FILE_NAME"

# IMAGE only exists as a shell var for this invocation -- a later, separate
# `docker compose` call on this host (a smoke check, a manual restart) has
# no idea what to interpolate otherwise. Persisting it here, not just
# exporting it below, is what makes those later calls work at all. Only
# takes effect when ENV_FILE_NAME is Compose's own auto-loaded `.env`.
echo "IMAGE=$IMAGE" >> "$REPO_DIR/$ENV_FILE_NAME"

# One -f per file and one --profile per profile. Built as an array so a
# multi-file override stack works without the caller quoting anything.
compose_args=()
for f in $COMPOSE_FILE; do compose_args+=(-f "$f"); done
for p in $COMPOSE_PROFILES_LIST; do compose_args+=(--profile "$p"); done

# --quiet: SSM caps command output at 24KB. Multi-layer pull progress alone
# blows past that, so a real failure's actual message never made it back --
# both GitHub's log and SSM's own API were truncating the same noise.
IMAGE="$IMAGE" docker compose "${compose_args[@]}" pull --quiet
IMAGE="$IMAGE" docker compose "${compose_args[@]}" up -d --remove-orphans

# Released once the containers are up -- the healthcheck poll below doesn't
# touch shared compose state, so it shouldn't make a concurrent deploy wait.
exec 200>&-

if [ -n "$HEALTHCHECK_URL" ]; then
  healthy=false
  for i in $(seq 1 30); do
    if curl -fsS "$HEALTHCHECK_URL" >/dev/null 2>&1; then
      echo "healthy after $i attempt(s)"
      healthy=true
      break
    fi
    sleep 10
  done
  if [ "$healthy" != true ]; then
    echo "FATAL: $HEALTHCHECK_URL never returned 2xx" >&2
    docker compose "${compose_args[@]}" ps
    exit 1
  fi
fi

# Every release pulls a new tag and nothing removed the old ones: 74 of them
# (158GB) filled lumios prod's Docker disk on 2026-11-05. Runs only once the
# deploy is healthy, so a failed one leaves the previous images in place.
# Keeps IMAGE plus the newest IMAGE_KEEP-1 others of the same repository;
# `image rm` without -f refuses anything a container still references.
if [ "$IMAGE_KEEP" -eq 0 ]; then
  echo "image prune skipped (image-keep 0)"
  exit 0
fi
repo="${IMAGE%@*}"
repo="${repo%:*}"
# `image ls` order is not creation order (it differs under the containerd
# image store), so sort on each image's RFC 3339 Created timestamp.
keep_ids=$(
  { docker image inspect --format '{{.Id}}' "$IMAGE"
    docker image ls --no-trunc --format '{{.ID}}' "$repo" | sort -u \
      | xargs -r docker image inspect --format '{{.Created}} {{.Id}}' \
      | sort -r | cut -d' ' -f2; } \
    | awk -v n="$IMAGE_KEEP" '!seen[$0]++ && ++kept <= n'
)
removed=0
failed=0
while read -r id ref; do
  grep -qxF "$id" <<<"$keep_ids" && continue
  # A re-pushed tag leaves its old image as <repo>:<none>, removable only by ID.
  [[ "$ref" == *":<none>" ]] && ref="$id"
  if docker image rm "$ref" >/dev/null; then
    removed=$((removed + 1))
  else
    echo "WARN: could not remove $ref" >&2
    failed=$((failed + 1))
  fi
done < <(docker image ls --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}' "$repo")
echo "image prune: removed $removed, failed $failed, kept newest $IMAGE_KEEP of $repo"
