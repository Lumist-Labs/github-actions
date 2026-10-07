# Lumist-Labs shared GitHub Actions

Reusable workflows and composite actions for `Lumist-Labs` repos, and the `aretecp` repos
that still call them. Consumers pin `@v2`. Working in this repo: start at
[`CLAUDE.md`](CLAUDE.md).

## Composite actions

| Action | What it does |
|---|---|
| [`load-infisical-secrets`](actions/load-infisical-secrets) | Load secrets from Infisical at runtime: env export, JSON output, or a bare dotenv file. OIDC or Universal Auth. |
| [`tailscale-connect`](actions/tailscale-connect) | Join the tailnet. Wraps `tailscale/github-action` at a pinned SHA; skips the join on a runner that is already a node. |
| [`vps-deploy-core`](actions/vps-deploy-core) | The VPS deploy engine behind the three VPS workflows: render `.env`, SSH, checkout, optional DB snapshot, compose up, healthcheck. |
| [`wait-for-healthy`](actions/wait-for-healthy) | Poll `docker inspect` over SSH until every named container is `healthy`, dumping compose logs on timeout. Ships the script over SSH. |
| [`assert-prod-deployer`](actions/assert-prod-deployer) | Fail unless the triggering actor is in the `PROD_DEPLOYERS` org variable. First step of every prod deploy, rollback and DB copy. |
| [`aws-deploy-core`](actions/aws-deploy-core) | Assume an AWS role via OIDC, resolve names from SSM, deploy, wait until live. Targets `s3-cloudfront`, `ec2-compose`, `ecs-service`. Does not build. |
| [`ecr-build-push`](actions/ecr-build-push) | Build and push an image to ECR tagged by SHA and version; retag instead of rebuilding when the SHA already exists. |
| [`teams-notify`](actions/teams-notify) | Post a MessageCard to a Teams webhook. `status` colours, facts, a button, `dry-run`. Webhook comes via `env:`. |
| [`slack-notify`](actions/slack-notify) | Post a Block Kit message to a Slack channel. Same inputs as `teams-notify` plus `channel`, `username`, `icon-emoji`; outputs `ts`. Bot token via `env:`. |

## Reusable workflows

Called as `jobs.<name>.uses: Lumist-Labs/github-actions/.github/workflows/<file>@v2`. Each
file's `inputs:` block and header comment are the contract.

| Workflow | What it does |
|---|---|
| [`deploy-vps-shared.yml`](.github/workflows/deploy-vps-shared.yml) | Render the app's Infisical folder to `.env`, write it to the VPS, `docker compose up`, healthcheck. Callers are short shims. |
| [`rollback-vps-shared.yml`](.github/workflows/rollback-vps-shared.yml) | Redeploy a previous tag, optionally restoring the latest pre-deploy DB snapshot (`confirm: RESTORE-DB`). |
| [`copy-prod-db-shared.yml`](.github/workflows/copy-prod-db-shared.yml) | Copy the prod DB over dev on the same VPS. Prod is read-only; needs `confirm: CLOBBER-DEV`. |
| [`release-shared.yml`](.github/workflows/release-shared.yml) | semantic-release on `main`, then dispatch the caller's deploy workflow. `ci-gated: true` tags only a CI-passed SHA. |
| [`pr-to-main-hooks.yml`](.github/workflows/pr-to-main-hooks.yml) | Every PR: retitle as `… → <base>`. PRs into `main`/`master`: Claude summary into the body, `Closes #N`, request `core` review, Teams card. |
| [`claude-issue-triage.yml`](.github/workflows/claude-issue-triage.yml) | Triage new issues and `@claude` comments with Claude Code. Callers pass no inputs; see [zero-config shim](#zero-config-consumer-shim). |
| [`claude-issue-autopilot.yml`](.github/workflows/claude-issue-autopilot.yml) | Beacon-dispatched: score one issue and, if it passes the gate, implement it as a draft PR. See [`docs/runbooks/issue-autopilot.md`](docs/runbooks/issue-autopilot.md). |

### Scheduled workflows (run here, not called)

| Workflow | What it does | Schedule (UTC) |
|---|---|---|
| [`entra-secret-detector.yml`](.github/workflows/entra-secret-detector.yml) | Read-only Graph scan of every Entra app registration; reports credentials nearing expiry. Silent when nothing is in window. See [runbook](docs/runbooks/entra-secret-detector.md). | `0 13 * * *` |
| [`ci-images.yml`](.github/workflows/ci-images.yml) | Rebuild and publish the CI base images in [`images/`](images). Also runs on change to `images/**`. | `17 4 * * 0` |

### Zero-config consumer shim

`claude-issue-triage.yml@v2` needs **no `with:` block**. It reads the caller's own
`vars.INFISICAL_OIDC_IDENTITY_ID` / `vars.INFISICAL_INTERNAL_PROJECT_SLUG` (unlike secrets, org
variables resolve against the caller), loads `ANTHROPIC_API_KEY` from the shared CI folder
`lumist-labs-internal/prod/github-actions`, and checks out the consumer's own default branch:

```yaml
name: Claude Issue Triage

on:
  issues:
    types: [opened]
  issue_comment:
    types: [created]

# Reusable workflows can only USE permissions the caller grants.
permissions:
  contents: read
  issues: write
  id-token: write

jobs:
  triage:
    uses: Lumist-Labs/github-actions/.github/workflows/claude-issue-triage.yml@v2
```

That is the entire file. Every `infisical-*` input, plus `checkout-ref`, `environment`, and
`claude-model`, remain available as optional overrides — pass `checkout-ref` only if you want to
triage against something other than your default branch.

> The CI key in `/github-actions` is deliberately separate from each app's own
> `ANTHROPIC_API_KEY`. Apps keep theirs for runtime use; CI has its own so spend is attributable
> and revocation is isolated.

## New app checklist

Everything a new repo needs to behave like the rest of the fleet. Org rulesets
(`main`/`master` need a PR, `develop` can't be force-pushed or deleted, `v*` tags
are core-only) apply the moment the repo exists — nothing to do for those.

1. **Branches.** Create `develop` off `main` and make it the default. Work goes
   feature → `develop` → `main`; `main` is production.
2. **Repo variables.** `INFISICAL_INTERNAL_PROJECT_SLUG`,
   `INFISICAL_SHARED_PROJECT_SLUG`, and `VPS_USER` if it deploys to the VPS. The org-level
   copies of these are visible only to lumist-frontend-templates, passage and vector, so
   every other repo sets its own. `INFISICAL_OIDC_IDENTITY_ID`, `PROD_DEPLOYERS` and
   `RELEASE_BOT_APP_ID` are org variables visible to every repo. Check with
   `gh variable list --repo <repo>`, which shows inherited ones, before assuming.
3. **Infisical folder.** `/<app>` in `lumist-labs-internal`, one set of values per
   environment. Everything the app reads at runtime lives here — the deploy renders
   `.env` from it, so a value hardcoded in a workflow is a value that will drift.
4. **Release.** Copy a `release.yml` shim over
   [`release-shared.yml`](.github/workflows/release-shared.yml), plus `.releaserc.json`
   and a tooling-only `package.json` (see litellm-gateway). Releases push as
   `lumist-release-bot`, which is what gets them past the `main` ruleset.
5. **Deploy.** A shim over [`deploy-vps-shared.yml`](.github/workflows/deploy-vps-shared.yml).
   An app that deploys itself (blue/green, say) passes `deploy-command`; work that
   needs the new version running goes in `post-deploy-command`. AWS deploys have no
   shared workflow yet: lumios and vector compose
   [`ecr-build-push`](actions/ecr-build-push) and [`aws-deploy-core`](actions/aws-deploy-core)
   in their own workflow. Copy one, and keep its
   [`assert-prod-deployer`](actions/assert-prod-deployer) step.
6. **PR hooks.** A shim over [`pr-to-main-hooks.yml`](.github/workflows/pr-to-main-hooks.yml),
   triggered on PRs into `develop` and `main`.
7. **Production environment.** If it deploys to prod, add the repo to
   `local.production_repos` in `lumist-terraform-infrastructure/github/locals.tf`
   so its `production` environment only deploys from `main` or a `v*` tag. `core`
   team access and delete-branch-on-merge need no edit — they are keyed on every
   non-archived repo — but they do wait for that module's next apply.

## CI base images ([`images/`](images))

Prebuilt container images for CI jobs, published to GHCR. A consuming workflow sets
`container.image` and deletes its `Install OS prereqs` step — that step reinstalled
byte-identical packages on every run and, on a runner host with slow fsync, reached 16 minutes.

| Image | For |
|---|---|
| `ghcr.io/lumist-labs/ci-elixir:1.18.4-otp-27` | Elixir 1.18 / OTP 27 |
| `ghcr.io/lumist-labs/ci-elixir:1.19.5-otp-28` | Elixir 1.19 / OTP 28 |
| `ghcr.io/lumist-labs/ci-python-uv:3.12` | uv-managed Python backends, incl. chromium |
| `ghcr.io/lumist-labs/ci-python:3.12` | Python backends that drive uv themselves |
| `ghcr.io/lumist-labs/ci-node:22` | Node 22 frontends; the default Autopilot image |
| `ghcr.io/lumist-labs/ci-rust-tauri:1.97` | Tauri desktop workspace |
| `ghcr.io/lumist-labs/ci-autopilot-python:3.12` | Autopilot jobs on Python repos |
| `ghcr.io/lumist-labs/ci-autopilot-elixir:1.19.5-otp-28` | Autopilot jobs on Elixir repos |

Public packages, so no `container.credentials` block is needed. Rebuilt on change and weekly for
OS security patches. See [`images/README.md`](images/README.md) for contents, tag policy, and
what must never be baked in.

## Usage

Pin the moving major tag:

```yaml
permissions:
  contents: read
  id-token: write   # OIDC
steps:
  - uses: Lumist-Labs/github-actions/actions/load-infisical-secrets@v2
    with:
      method: oidc
      identity-id: ${{ vars.INFISICAL_OIDC_IDENTITY_ID }}
      project-slug: ${{ vars.INFISICAL_INTERNAL_PROJECT_SLUG }}
      environment: prod
      path: /<app>
```

Or an exact version or SHA for stricter reproducibility:

```yaml
- uses: Lumist-Labs/github-actions/actions/load-infisical-secrets@v2.44.1
- uses: Lumist-Labs/github-actions/actions/load-infisical-secrets@<full-commit-sha>
```

## Runners and CI

Which runner a job belongs on, the concurrency policy, and the traps on the
self-hosted host — read this before moving a job or adding a workflow:
[`docs/runbooks/runners-and-ci.md`](docs/runbooks/runners-and-ci.md).

Short version: containerized CI and dev deploys on `[self-hosted, omarchy]`,
release and prod deploys on `ubuntu-latest`. The `runner:` input on every shared
workflow defaults to hosted and is the fail-back when the self-hosted box is down.

## Versioning

- `@v2` — moving major tag; tracks the latest `2.x.y`. What every consumer should pin.
- `@v2.x.y` — exact version.
- `@<sha>` — strictest.
- `@v1` — frozen. It predates most of this repo; nothing new ships on it.

`release.yml` cuts the version and moves `v2` on each `feat:`/`fix:` merge. See
[`RELEASING.md`](RELEASING.md).

## Shared scripts ([`scripts/`](scripts))

Scripts the workflows and actions here run: the healthcheck shipped to the VPS over SSH by
`wait-for-healthy`, the Autopilot guardrail, the Entra scan, and the VPS Docker janitor. See
[`scripts/README.md`](scripts/README.md).

## Admin tools ([`tools/`](tools))

Maintainer scripts for org-wide GitHub config: project setup, secret syncing, stale-blocker scans, post-migration cleanup. Run locally with `gh` CLI auth, never fetched from a workflow. See [`tools/README.md`](tools/README.md).

## Releasing

Cutting a new version of any action in this repo: see [`RELEASING.md`](RELEASING.md).

## License

MIT — see [`LICENSE`](LICENSE).
