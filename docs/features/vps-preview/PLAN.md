# VPS preview environments

Status: Ready

A `preview` branch per app that deploys to `preview.<app>.lumistlabs.dev` on the same VPS as dev,
runs the branch's code against a **snapshot of dev's DB**, and is torn down on command.
Lumilearn first, then any `deploy-vps-shared` consumer opts in with a shim + compose file.

Flow: `feature → preview` (PR, merge, it deploys) → `preview → develop` when ready, which
tears the preview down. Teardown is also available on dispatch.

## Design

One new reusable workflow, `preview-vps-shared.yml`, with `action: deploy | seed | teardown`.
It composes what already exists rather than copying it:

| action | jobs |
|---|---|
| `deploy` (push to `preview`) | guard → `deploy-vps-shared.yml` |
| `seed` (dispatch) | guard → deploy (so the preview DB exists and the checkout is this ref) → `copy-prod-db-shared.yml` (source = dev DB, target = preview DB) → `deploy-vps-shared.yml` again so the branch's migrations re-apply on top of dev's schema |
| `teardown` (dispatch) | guard → ssh `docker compose -f <preview compose> down` in the preview `repo-dir`; volumes kept unless `delete-data: true` |

Nesting depth is consumer → preview-vps-shared → deploy/copy-db = 3, under GitHub's limit of 4.

### Why this isolates from dev

- Own `repo-dir` (`/home/sglyon/<app>-preview`) → own checkout, own compose project
  (named from the directory), own concurrency group. `git checkout --force` never runs in dev's tree.
- Own DB container + volume. Branch migrations hit only the preview DB.
- `copy-prod-db-shared` only reads the source side (`pg_dump`), so dev's DB is read-only here.

### Guard job (the reason this is a wrapper, not docs)

Fails before anything touches the VPS unless:
- `repo-dir` ends in `-preview`
- the seed target container ends in `_preview`
- `environment` is not `prod`/`production`

Without it, one wrong input in a consumer shim means `compose down` on dev's shared
compose project, or `pg_restore --clean` into dev's DB.

### Seeding is explicit, not per-push

Re-seeding on every push would wipe whatever testers did in preview. So `deploy` never
seeds; a dev runs `seed` after the first deploy and whenever they want fresh dev data.
First push brings up an empty, migrated DB.

## Consumer side (lumilearn)

- `docker-compose.preview.yml`: copy of `docker-compose.dev.yml` with
  - services/containers/volumes suffixed `-preview` / `_preview`
  - Traefik routers renamed `arilearn-preview*`
  - **Host hardcoded or from `PHX_HOST_PREVIEW`, never `${PHX_HOST}`.** `.env.preview` is
    rendered from dev's Infisical folder, so `${PHX_HOST}` is dev's hostname — a second
    router claiming it would split dev traffic onto preview.
  - `PHX_HOST` overridden in `environment:` too (URL generation, LiveView `check_origin`,
    magic-link URLs)
  - every other host-derived value from dev's folder overridden too. For lumilearn at least
    `MCP_RESOURCE_URL` / `MCP_OAUTH_ISSUER` (`config/runtime.exs`): left alone, preview
    would mint MCP tokens under dev's issuer
- `.github/workflows/deploy-preview.yml`: `push: [preview]` → `action: deploy`;
  `workflow_dispatch` with an `action` choice (`deploy` / `seed` / `teardown`)
- DNS: none needed. `dig +short preview.lumilearn.lumistlabs.dev` already returns the VPS
  (178.156.139.78), same as `lumilearn.lumistlabs.dev`
- Entra: add `https://preview.lumilearn.lumistlabs.dev/auth/user/microsoft/callback` and
  `.../auth/callback` to `redirect_uris` in `microsoft-entra-terraform-infrastructure`
  `apps/arilearn/main.tf`. Entra matches exactly, no wildcards, so every opting-in app
  needs its own entry

### Access

Same as dev: the app's own login (Entra SSO + magic link) with dev's Traefik middlewares
(`arilearn-headers@file,rate-limit@file`). Dev has no network-level restriction either.
Dev logins work on preview because the seeded users table is dev's. Before the first
`seed`, the DB is empty and nobody can sign in except via a fresh Entra account.

## Pieces

| # | Repo | What | Size | Deps |
|---|---|---|---|---|
| 1 | github-actions | `preview-vps-shared.yml` with guard + `deploy` + `teardown` | ~150 lines | — |
| 2 | github-actions | `seed` action (copy-db job + redeploy) | ~50 lines | 1 |
| 3 | github-actions | README entry + `docs/runbooks/vps-preview.md` (adding a repo, seed, teardown) | ~150 lines docs | 2 |
| 4 | DNS zone for `lumistlabs.dev` + `microsoft-entra-terraform-infrastructure` | preview DNS record; Entra redirect URIs | small | — |
| 5 | lumist-terraform-infrastructure | `preview` org ruleset in `github/rulesets.tf` (below) | ~30 lines | — |
| 6 | lumilearn | `docker-compose.preview.yml` + `deploy-preview.yml` shim | ~150 lines | 2 released, 4, 5 |

### Branch protection on `preview`

New `github_organization_ruleset "preview"` beside `develop` and `main`, on
`refs/heads/preview` across `~ALL` repos (a ruleset on a branch a repo doesn't have is inert,
so opting in later needs no change):

- `deletion = true`: the deploy target can't vanish under a running stack
- `pull_request` with `required_approving_review_count = 0`: every change lands as a PR
  (visible, CI runs), no approval gate, since preview is for unfinished work
- `non_fast_forward = true` with `core` as a bypass actor: nobody else force-pushes,
  but core can reset `preview` to `develop` after a promotion (the branch-drift item below)

Note this ruleset only covers the Lumist-Labs org. aretecp repos (areteos) would need
the same resource in whatever manages that org; not checked.

1 and 2 land as one PR (~200 lines), `feat:` so it releases and moves `v2`.

## Open questions

- **VPS capacity.** A third stack (db + app + build) on the dev/prod box. Disk was at 98%
  once from stranded images (see the prune step in `vps-deploy-core`). Not measured.
- **One slot per app.** Two devs pushing to `preview` overwrite each other. Per-PR previews
  (`pr-<n>.preview...`) are a later step if this gets contended.
- **Branch drift.** After a feature is promoted to `develop`, someone resets `preview` to
  `develop`; otherwise preview accumulates abandoned work. Document, or automate later.
- **Copy-db naming.** Calling `copy-prod-db-shared` with dev as the `prod-*` side works
  (inputs are just container names) but reads oddly. Leave it with a comment; renaming
  the inputs would break existing callers.

## Verification

- `actionlint` + `lint-workflows.yml` on 1–3.
- Real check is lumilearn: push to `preview` before `v2` moves, by pointing the shim at the
  branch (per CLAUDE.md, revert before merge). Confirm: preview host serves the branch,
  dev host still serves `develop`, `seed` brings dev rows in, `teardown` leaves dev's
  containers untouched (`docker ps` before/after).
