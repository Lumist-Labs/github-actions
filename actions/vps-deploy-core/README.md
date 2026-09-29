# `vps-deploy-core`

The VPS deploy engine. [`deploy-vps-shared.yml`](../../.github/workflows/deploy-vps-shared.yml)
and [`rollback-vps-shared.yml`](../../.github/workflows/rollback-vps-shared.yml) call it;
consumers call those workflows, not this. The step order is in
[`docs/architecture.md`](../../docs/architecture.md#vps-deploy-family).

Callers must grant `id-token: write` and `contents: read`. Every input description is in
[`action.yml`](action.yml); this is the contract in brief.

## Inputs

**Infisical** (all loads use OIDC)

| Input | Required | Default | Notes |
|---|---|---|---|
| `infisical-identity-id` | yes | — | `vars.INFISICAL_OIDC_IDENTITY_ID` |
| `shared-project-slug` | yes | — | Holds `infra-path` and `extra-shared-path-*` |
| `app-project-slug` | yes | — | Holds `app-path` and `extra-app-path-*` |
| `env-slug` | yes | — | Applied to every load |
| `app-path` | yes | — | Rendered to the `.env`, imports included |
| `extra-shared-path-1..3`, `extra-app-path-1..3` | no | `''` | More folders merged into the `.env`. Keys must not collide with any other loaded folder |
| `infra-path` | no | `/tailscale` | `TAILSCALE_AUTHKEY`, `VPS_TAILSCALE_IP`, `VPS_SSH_KEY`; env mode only, never in the `.env` |
| `required-keys` | no | `''` | Space-separated; each must be present and non-empty or the deploy fails before touching the VPS |

**Target**

| Input | Required | Default | Notes |
|---|---|---|---|
| `vps-user` | yes | — | `vars.VPS_USER` |
| `repo-dir` | yes | — | Absolute path on the VPS, `/home/sglyon/<app>` |
| `compose-file` | yes | — | Relative to `repo-dir` |
| `env-file-name` | no | `.env` | Written into `repo-dir` |
| `ref` | no | `main` | Checked out with `git checkout --force`; also written as `VERSION` |
| `allow-clone` | no | `false` | `true` lets it clone `repo-url` when `repo-dir` has no checkout (dev). Prod must already have one |
| `repo-url` | no | `''` | Clone URL for `allow-clone` |
| `github-token` | no | `github.token` | Lets an `https://` remote fetch a private repo. `''` keeps the box's own credential. `git@` remotes never use it |

On every run it also repoints `origin` to the calling repo (same scheme) if the remote
still names an old org.

**Run**

| Input | Required | Default | Notes |
|---|---|---|---|
| `healthcheck-containers` | one of these two | `''` | Space-separated; each must reach `healthy` via [`wait-for-healthy`](../wait-for-healthy) |
| `deploy-command` | one of these two | `''` | Run in `repo-dir` instead of `compose up`, for an app that deploys itself (lumilearn blue/green) |
| `post-deploy-command` | no | `''` | Run last, after the healthcheck |
| `compose-build` | no | `true` | `up -d --build`; `false` pulls instead |
| `compose-up-timeout` | no | `30m` | Must outlast a cold build on the VPS |
| `compose-force-recreate` | no | `false` | For fixed `container_name`s that come back hash-prefixed |
| `pre-compose-up-script` | no | `''` | Bash run after the `.env` write, before compose up. Rollback's DB restore goes here |

**Pre-deploy DB snapshot**

| Input | Default | Notes |
|---|---|---|
| `db-type` | `none` | `sqlite` (integrity check + `.backup()` inside `db-container`) or `postgres` (`pg_dump` via `docker exec`) |
| `db-container` | `''` | Required unless `none` |
| `db-path` | `''` | sqlite: path inside the container |
| `db-name`, `db-user` | `''` | postgres |
| `snapshot-dir` | `''` | sqlite: `<dirname db-path>/pre-deploy-snapshots` in the container; postgres: `<repo-dir>/pre-deploy-snapshots` on the host |
| `snapshot-retention-days` | `7` | |
| `skip-pre-deploy` | `false` | Break-glass |

The snapshot is skipped when the DB container is not cleanly running (first deploy).

No outputs.

## Not here on purpose

- **`--remove-orphans`.** Dev and prod share one compose project and Traefik runs as its
  own stack, so the only orphans it could find are live services.
- **Relative sibling refs.** Every `uses:` inside is `Lumist-Labs/github-actions/…@v2`.
  A `./` ref resolves against the caller's checkout and fails every deploy on its first
  step (#127, reverted in #130).
