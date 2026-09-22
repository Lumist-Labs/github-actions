# Areté Capital Partners — Shared GitHub Actions

Reusable composite actions and workflows for `Lumist-Labs` repos (and the `aretecp` repos that still call them). Drop-in `uses:` references with org defaults baked in — no copy-pasted workflow steps across repos.

## Available composite actions

| Action | Description | Status |
|---|---|---|
| [`load-infisical-secrets`](actions/load-infisical-secrets) | Load secrets from Infisical at workflow runtime. Supports env export, JSON output, and bare dotenv file render (v2). | `v2` (`@v1` frozen) |
| [`tailscale-connect`](actions/tailscale-connect) | Join the Areté Tailscale tailnet. Wraps `tailscale/github-action` with a pinned SHA and corrected input names. | `v1` |
| [`aws-deploy-core`](actions/aws-deploy-core) | Assume an AWS role via OIDC, resolve resource names from SSM, deploy, and wait for it to be live. Strategy by `target` input; `s3-cloudfront` shipped. Does not build. | `_in development_` |
| [`teams-notify`](actions/teams-notify) | Post a MessageCard to a Teams incoming webhook. Semantic `status` colours, optional facts block and button, `dry-run` mode. Webhook passed via `env:`, not an input. | `v1` |
| [`wait-for-healthy`](actions/wait-for-healthy) | Poll `docker inspect` over SSH until every named container is `healthy`, dumping compose logs on timeout. Ships `scripts/wait-for-healthy.sh` to the host instead of having the host `curl` it. | `v2` |

More to come — Elixir/OTP setup, uv/Python setup. Each ships as its own composite action under `actions/<name>/`.

> **`@v1` is frozen.** All existing consumers that pin `load-infisical-secrets@v1` are unaffected. The v2 `dotenv` render mode is additive — migrate one repo at a time via the [VPS deploy migration runbook](docs/runbooks/deploy-vps-migration.md).

## Available reusable workflows

| Workflow | Description | Status |
|---|---|---|
| [`release-shared.yml`](.github/workflows/release-shared.yml) | Squash-merge → conventional-commit promotion → semantic-release → optional deploy trigger. `ci-gated: true` releases only a CI-passed SHA. | `v2` |
| [`deploy-vps-shared.yml`](.github/workflows/deploy-vps-shared.yml) | Render Infisical folder → dotenv → write to VPS over ssh → docker compose up → healthcheck. Callers become ~15-line shims. | `v2` |
| [`claude-issue-triage.yml`](.github/workflows/claude-issue-triage.yml) | Auto-triage of new issues / `@claude` comments via Claude Code. Bundled system prompt at `.claude/prompts/ci-triage.md`. Callers pass **no inputs at all** — see [zero-config shim](#zero-config-consumer-shim). | `v2` |
| [`pr-to-main-hooks.yml`](.github/workflows/pr-to-main-hooks.yml) | Every PR: retitle as `… → <base>`. On PRs into `main`: Claude summary → PR body + Closes #N → request `core` review → Teams card. | `v2` |

Reusable workflows are called via `jobs.<name>.uses: Lumist-Labs/github-actions/.github/workflows/<file>@v1` in the consumer repo. See the workflow file's header comments for inputs and prerequisites.

### Scheduled workflows (run here, not called)

| Workflow | Description | Schedule |
|---|---|---|
| [`entra-secret-detector.yml`](.github/workflows/entra-secret-detector.yml) | Read-only Graph scan of every Entra app registration. Reports credentials nearing expiry and flags ones Terraform doesn't manage. Silent when nothing is in window. | `17 13 * * *` |
| [`ci-images.yml`](.github/workflows/ci-images.yml) | Build + publish the CI base images in [`images/`](images) to GHCR. Also runs on change to `images/**`. | `17 4 * * 0` |

Not `workflow_call` targets — these run in this repo on a cron. See
[`docs/runbooks/entra-secret-detector.md`](docs/runbooks/entra-secret-detector.md).

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
   `INFISICAL_SHARED_PROJECT_SLUG`, and `VPS_USER` if it deploys to the VPS.
   `INFISICAL_OIDC_IDENTITY_ID`, `PROD_DEPLOYERS` and `RELEASE_BOT_APP_ID` are org
   variables scoped to every repo — check with `gh variable list --repo <repo>`,
   which shows inherited ones, before assuming.
3. **Infisical folder.** `/<app>` in `lumist-labs-internal`, one set of values per
   environment. Everything the app reads at runtime lives here — the deploy renders
   `.env` from it, so a value hardcoded in a workflow is a value that will drift.
4. **Release.** Copy a `release.yml` shim over
   [`release-shared.yml`](.github/workflows/release-shared.yml), plus `.releaserc.json`
   and a tooling-only `package.json` (see litellm-gateway). Releases push as
   `lumist-release-bot`, which is what gets them past the `main` ruleset.
5. **Deploy.** A shim over [`deploy-vps-shared.yml`](.github/workflows/deploy-vps-shared.yml).
   An app that deploys itself (blue/green, say) passes `deploy-command`; work that
   needs the new version running goes in `post-deploy-command`. AWS deploys are
   per-app today — copy lumios or vector, and add the
   [`assert-prod-deployer`](actions/assert-prod-deployer) step yourself.
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
| `ghcr.io/aretecp/ci-elixir:1.18.4-otp-27` | Elixir 1.18 / OTP 27 apps (`areteos`) |
| `ghcr.io/aretecp/ci-elixir:1.19.5-otp-28` | Elixir 1.19 / OTP 28 apps (`arilearn-phx`) |
| `ghcr.io/aretecp/ci-python-uv:3.12` | uv-managed Python backends, incl. chromium (`areteos-py`) |
| `ghcr.io/aretecp/ci-python:3.12` | Python backends that drive uv themselves (`beacon`) |
| `ghcr.io/aretecp/ci-node:22` | Node 22 frontends (`areteos-py`) |
| `ghcr.io/aretecp/ci-rust-tauri:1.97` | Tauri desktop workspace (`areteos/desktop`) |

Public packages, so no `container.credentials` block is needed. Rebuilt on change and weekly for
OS security patches. See [`images/README.md`](images/README.md) for contents, tag policy, and
what must never be baked in.

## Usage

Pin to the moving major tag for non-breaking updates:

```yaml
- uses: Lumist-Labs/github-actions/actions/load-infisical-secrets@v1
  with:
    project-slug: ${{ vars.INFISICAL_INTERNAL_PROJECT_SLUG }}
    environment: prod
    client-id: ${{ secrets.INFISICAL_CLIENT_ID }}
    client-secret: ${{ secrets.INFISICAL_CLIENT_SECRET }}
```

> Each consuming workflow needs access to the `INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET` org secrets and the `INFISICAL_*_PROJECT_SLUG` org variables. See the action's [`README`](actions/load-infisical-secrets/README.md#prerequisites) for full prerequisites.

Or pin to a specific version / SHA for stricter reproducibility:

```yaml
- uses: Lumist-Labs/github-actions/actions/load-infisical-secrets@v1.0.0
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

- `@v1` — moving major tag; tracks the latest `1.x.y`. Recommended for most consumers.
- `@v1.2.3` — exact version; pin if you need reproducibility but can tolerate manual upgrades.
- `@<sha>` — strictest. Pin if your security posture requires it.

Breaking changes bump the major. The `v1` tag stays on `1.x` forever.

## Shared scripts ([`scripts/`](scripts))

Runtime utilities consumer workflows fetch via curl + run inside their existing SSH scripts on the deploy target. The GH runner can't reach the VPS's Docker daemon, so these execute on the VPS at deploy time. See [`scripts/README.md`](scripts/README.md).

## Admin tools ([`tools/`](tools))

Maintainer scripts for org-wide GH config — secret syncing, post-migration cleanup. Run locally with `gh` CLI auth, never fetched from a workflow. See [`tools/README.md`](tools/README.md).

## Releasing

Cutting a new version of any action in this repo: see [`RELEASING.md`](RELEASING.md).

## License

MIT — see [`LICENSE`](LICENSE).
