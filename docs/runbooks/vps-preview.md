# VPS preview environments

`preview-vps-shared.yml` runs a repo's `preview` branch as a second stack beside dev on the
same VPS, at `preview.<app>.lumistlabs.dev`, against a snapshot of dev's database.

Flow: merge a feature PR into `preview` → it deploys. Merge `preview` into `develop` → it
tears down. Anyone with write access can also deploy, seed or tear down from the Actions tab.

## Adding a repo

1. **Compose file** `docker-compose.preview.yml`, copied from the dev one, then:
   - suffix every service `-preview`, every `container_name` `_preview`, every volume `-preview`
   - delete any top-level `name:` (or end it in `-preview`; the guard refuses anything else)
   - Traefik routers renamed (`<app>-preview`), rule `Host(\`preview.<app>.lumistlabs.dev\`)`
     written out. Never `${PHX_HOST}`: `.env.preview` is rendered from dev's Infisical folder,
     so that is dev's hostname and preview would take half of dev's traffic
   - override every host-derived value from dev's folder in `environment:` (`PHX_HOST`,
     OAuth issuers, public URLs)
   - `env_file: .env.preview`
2. **Entra**: nothing to add. In `microsoft-entra-terraform-infrastructure`, `modules/app_registration`
   gives every `<label>.lumistlabs.dev` redirect URI a `preview.<label>.lumistlabs.dev` sibling on
   the dev registration (never prod). An app with no `lumistlabs.dev` URI gets none.
3. **DNS**: `*.lumistlabs.dev` points at the VPS already. Check with `dig +short preview.<app>.lumistlabs.dev`.
4. **Shim** `.github/workflows/deploy-preview.yml` on `develop`:

```yaml
name: Preview

on:
  push:
    branches: [preview]
  pull_request:
    types: [closed]
    branches: [develop]
  workflow_dispatch:
    inputs:
      action:
        type: choice
        options: [deploy, seed, teardown]
        default: deploy

permissions:
  contents: read
  id-token: write

jobs:
  preview:
    # On pull_request, only a merged `preview` → develop PR (teardown).
    if: >-
      github.event_name != 'pull_request' ||
      (github.event.pull_request.merged && github.event.pull_request.head.ref == 'preview' &&
       github.event.pull_request.head.repo.full_name == github.repository)
    # One run at a time: a push and a seed on the same checkout would race.
    # Job level: at workflow level, the skipped run every PR closed into develop
    # starts would take the pending slot and cancel a queued push or seed.
    concurrency:
      group: preview
      cancel-in-progress: false
    uses: Lumist-Labs/github-actions/.github/workflows/preview-vps-shared.yml@v2
    with:
      action: ${{ github.event_name == 'pull_request' && 'teardown' || inputs.action || 'deploy' }}
      environment: development                      # whatever deploy-dev uses
      infisical-identity-id: ${{ vars.INFISICAL_OIDC_IDENTITY_ID }}
      shared-project-slug: ${{ vars.INFISICAL_SHARED_PROJECT_SLUG }}
      app-project-slug: ${{ vars.INFISICAL_INTERNAL_PROJECT_SLUG }}
      app-path: /<app>
      vps-user: ${{ vars.VPS_USER }}
      repo-dir: /home/sglyon/<app>-preview
      repo-url: https://github.com/<org>/<repo>.git
      compose-file: docker-compose.preview.yml
      healthcheck-containers: <app>_app_preview <app>_db_preview
      # seed
      db-type: postgres
      source-db-container: <app>_db_dev
      preview-db-container: <app>_db_preview
      db-user: postgres
      source-db-name: <app>_dev
      preview-db-name: <app>_preview
```

5. **Branch protection** comes from the org `preview` ruleset (`lumist-terraform-infrastructure/github/rulesets.tf`):
   PR required, no deletion, no force push, no bypass. Create the branch before the ruleset
   reaches the repo, since a PR rule may refuse creating it by push:
   `git push origin origin/develop:refs/heads/preview`.

## Using it

| Want | Do |
|---|---|
| Show a feature | PR it into `preview`, merge |
| Dev data in preview | Actions → Preview → `seed`. Deploys, copies dev's DB over preview's, redeploys with `--force-recreate` so the branch's migrations apply on top. Run after the first deploy and whenever you want fresh data |
| Take it down | Actions → Preview → `teardown`, or merge `preview` into `develop`. Volumes are kept; the next deploy comes back with the old preview data |
| Catch `preview` up with `develop` | PR `develop` → `preview`. Nobody can force-push it, so work abandoned on `preview` has to be reverted there |

## What the guard refuses

- `repo-dir` not ending in `-preview`, or `compose-file` / `env-file-name` escaping it
- `environment` or `env-slug` of `prod` / `production`
- a top-level compose `name:` not ending in `-preview` (checked on the branch being deployed)
- seed into a container not ending in `_preview`; sqlite seed without `preview-app-container`
- teardown of a compose project not ending in `-preview` (checked on the VPS)

It cannot see a volume or network given an explicit `name:` of dev's. Don't do that.

## Traps

- One slot per repo. Everyone merging into `preview` shares it.
- A push to `preview` while a `seed` waits can replace the seed's redeploy in GitHub's
  concurrency queue. The branch's migrations then haven't run on the seeded data; run `deploy`
  or `seed` again.
- Seeding keeps a dump of the old preview DB in `<repo-dir>/dev-db-backups/`, never pruned.
