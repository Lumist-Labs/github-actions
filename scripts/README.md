# `scripts/`

**Runtime-shared bash utilities** executed on the deploy target (VPS).

A `curl` from inside the remote SSH script was the original mechanism, and
still is for the two `docker-prune` scripts an operator runs by hand. No
workflow should use it: `raw.githubusercontent.com` carries the GitHub org in
its path and does not follow the redirect a repo transfer leaves behind, so an
org move 404s every one of those fetches at once. A workflow gets the script
shipped over the SSH connection by a composite action instead — see
[`actions/wait-for-healthy`](../actions/wait-for-healthy/).

For admin / local-execution scripts run by a maintainer, see [`../tools/`](../tools/).

## Available scripts

| Script | Description | Runs on |
|---|---|---|
| [`wait-for-healthy.sh`](wait-for-healthy.sh) | Poll `docker inspect` for a list of containers until all report `healthy`, or timeout (with optional log dump on failure). Consume via [`actions/wait-for-healthy`](../actions/wait-for-healthy/), not `curl` | VPS |
| [`docker-prune.sh`](docker-prune.sh) | Reclaim Docker disk (dangling images, aged build cache), then exit non-zero if usage or free space breaches a threshold | VPS |
| [`install-docker-prune.sh`](install-docker-prune.sh) | Install `docker-prune.sh` on a VPS and schedule it — systemd timer where sudo allows, user crontab otherwise | VPS |
| [`entra-credential-scan.sh`](entra-credential-scan.sh) | Enumerate every Entra app registration and report each credential's expiry as JSON, soonest-first. Read-only Graph query. | Runner |
| [`autopilot-verdict.js`](autopilot-verdict.js) | Parse the autopilot scoring model's JSON and decide, independently of it, whether an issue may be implemented unsupervised. The guardrail, not a helper — see [`docs/runbooks/issue-autopilot.md`](../docs/runbooks/issue-autopilot.md) | Runner |

> **Note:** `entra-credential-scan.sh` and `autopilot-verdict.js` are the exceptions to
> the "executed on the deploy target" rule above — they run on the GitHub runner, not a
> VPS, and are checked out rather than curl'd. They live here rather than in `tools/`
> because a workflow consumes them, not a maintainer at a terminal. See
> [`entra-secret-detector.yml`](../.github/workflows/entra-secret-detector.yml) and
> [`claude-issue-autopilot.yml`](../.github/workflows/claude-issue-autopilot.yml).
>
> `autopilot-verdict.js` is node rather than bash because it parses JSON, and `jq` is not
> guaranteed on the self-hosted host while node is already installed for Claude Code.

## Consuming a script in a workflow

```yaml
- name: Wait for healthy
  uses: Lumist-Labs/github-actions/actions/wait-for-healthy@v2
  with:
    host: ${{ env.VPS_TAILSCALE_IP }}
    username: ${{ inputs.vps-user }}
    key: ${{ env.VPS_SSH_KEY }}
    containers: areteos_app areteos_db
    compose-file: /home/sglyon/areteos/docker-compose.prod.yml
    env-file: /home/sglyon/areteos/.env
```

Paths must be absolute on the host — no `~`, which does not expand inside the
quoted variable the script receives. The action never reads them itself; it
hands them to `docker compose logs` if the wait times out.

## Docker disk cleanup on a VPS

`docker-prune.sh` is a scheduled janitor, not a workflow step. Install it once per box:

```bash
# From a checkout on the VPS
scripts/install-docker-prune.sh

# Or standalone
curl -fsSL "https://raw.githubusercontent.com/Lumist-Labs/github-actions/v2/scripts/install-docker-prune.sh" | bash
```

It exists because on 2026-08-14 the Areté VPS Docker data-root volume filled to
100% and every Postgres on the box refused to start. The previous janitor pruned
build cache only, and reported nothing anyone read.

**What it prunes:** dangling (untagged) images, then build cache older than 24h.
Images first — releasing their layers lets the cache prune drop the records that
referenced them.

**What it refuses to prune, and why:**

| Not run | Reason |
|---|---|
| `docker volume prune` | ~6.9GB across 25 unused volumes, including `areteos_test_pg` and the arilearn blue/green standby's data |
| `docker image prune -a` | ~12–15GB of images for stopped-but-live apps: `arilearn-phx-migrate`, `contact-intelligence-*`, `openpanel-*`, `litellm`, `clickhouse`, `neo4j` |
| `docker system prune -af` | Both of the above at once |
| `docker container prune` | On the Areté box the 168h filter would delete `arilearn-phx-app_green-1`, the blue/green standby. Reclaims 5.4MB. |

**Reading the result.** Exit 1 means usage is at/over `WARN_PCT` (85) or free
space is under `MIN_FREE_GB` (20) — actionable. Exit 4 means a prune step failed
but the disk is fine. A monitor should read the status file rather than the log:

```
$HOME/.local/state/docker-prune/status.json
```

```json
{"ts":"2026-08-14T17:33:42Z","host":"arete-aichat","usage_pct":52,"free_gb":92.0,
 "reclaimed_gb":0.5,"warn_pct":85,"min_free_gb":20,"exit_code":0,"breach":""}
```

Written atomically, so a poller can never catch it half-written. Both thresholds
matter: 8% of a 197GB volume is 15GB, which is under two areteos-py builds, so
percent alone under-reads the danger on a volume that size.

## Pinning

For the two `docker-prune` scripts. Every pin below hardcodes the org, which is
why a workflow must not fetch this way — a repo transfer breaks all of them.

Pick the ref that matches your trust + reproducibility tradeoff:

| Pin | Use when |
|---|---|
| `https://raw.githubusercontent.com/Lumist-Labs/github-actions/v1/scripts/...` | Default. Get patch fixes automatically. |
| `https://raw.githubusercontent.com/Lumist-Labs/github-actions/v1.2.3/scripts/...` | You want exact reproducibility but can manually upgrade |
| `https://raw.githubusercontent.com/Lumist-Labs/github-actions/<full-sha>/scripts/...` | Strict — security-sensitive workflows |

## Why a script, wrapped in an action

The logic belongs in bash on the VPS: the runner can't reach that box's Docker
daemon, and a composite action wrapping `docker inspect` would have to SSH per
call or go through `DOCKER_HOST=ssh://...`.

The original reading of that was "so the host fetches the script itself," which
put the org in the path. It doesn't follow. A composite action opens one SSH
connection anyway, so it can carry the script's own bytes across and pipe them
to `bash` — the logic still runs on the VPS, and nothing resolves a URL at
deploy time. That is what `actions/wait-for-healthy` does, and it is the pattern
for anything a workflow consumes from here.
