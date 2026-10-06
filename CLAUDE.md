# Lumist-Labs/github-actions

Shared CI/CD for the Lumist-Labs and aretecp repos: reusable workflows, composite
actions, CI base images and the scripts they run. Consumers pin `@v2`. A merge here
changes every consumer's pipeline once `v2` moves, so treat each change as a fleet deploy.

Public repo. Base branch `main`, no `develop`. PRs go to `main`.

## Layout

| Path | What |
|---|---|
| `.github/workflows/*-shared.yml`, `claude-issue-*.yml`, `pr-to-main-hooks.yml` | Reusable workflows (`workflow_call`) consumers call |
| `.github/workflows/{release,lint-workflows,smoke-teams-notify,smoke-slack-notify,ci-images,pr-hooks,entra-secret-detector}.yml` | This repo's own CI, release and cron jobs |
| `actions/<name>/action.yml` | Composite actions |
| `.claude/prompts/` | System prompts for triage and Autopilot, checked out at run time via `shared-ref` |
| `scripts/` | Scripts workflows run: Autopilot guardrail (`autopilot-verdict.js`), healthcheck, Entra scan |
| `tools/` | Maintainer scripts run by hand with `gh` auth; never fetched by a workflow |
| `images/` | CI base image Dockerfiles; `images/manifest.json` is the build matrix |

## Checks (what CI runs)

`lint-workflows.yml` on PRs (and pushes to `main`) touching `.github/workflows/**`,
`actions/**` or `scripts/**`:

```sh
actionlint -color -shellcheck=      # CI pins actionlint 1.7.12
grep -rn 'uses: *\./' actions/      # must print nothing
node --test scripts/*.test.js       # node 22
```

- `smoke-teams-notify.yml`, `smoke-slack-notify.yml`: PRs touching `actions/{teams,slack}-notify/**`, dry-run payload asserts.
  The Slack one also posts with a fake token to prove `ok: false` fails the step.
- `ci-images.yml`: PRs touching `images/**` build each image and run its `smoke.sh`
  (the two `autopilot-*` images have none, so the step passes without testing them).
  Push to `main`, the Sunday cron and dispatch also publish to `ghcr.io/lumist-labs/ci-*`.
- Nothing else is tested here. Reusable workflows are only exercised by a consumer run.

## Releasing

`release.yml` runs on every push to `main` and reads the squash commit subject (the PR title):

- `feat:` → minor, `fix:` → patch, `feat!:`/`fix!:`/`BREAKING CHANGE` → major. It tags
  `vX.Y.Z` and moves `v2`.
- `chore:`, `docs:`, `refactor:`, `test:`, `style:`, `ci:`, `build:` → no release.
  So does anything else, including a scoped breaking title like `feat(x)!:`.

The trap: a `chore:` merge sits on `main` unreleased and ships silently with the next
`feat:`. #127 (a `chore:` that broke every VPS deploy) went live 8 days later that way;
reverted in #130. Title a caller-visible change `feat:`/`fix:` so it ships and gets
watched when it does.

Never move tags by hand. The org `release-tags` ruleset lets only the `lumist-release-bot`
App (which `release.yml` pushes as) and the `core` team touch `v*`. Manual cuts go through
**Actions → Release → Run workflow** with a `version`. `v1` is frozen; nothing new ships on it.
Detail: [`RELEASING.md`](RELEASING.md).

## Hard rules

- **Sibling refs are absolute.** Inside `actions/` and in reusable workflows, reference
  another action as `Lumist-Labs/github-actions/actions/<x>@v2`, never `./actions/<x>`.
  A `./` path resolves against the caller's checkout, which has no `actions/` directory.
  Only workflows that run in this repo and check it out (`entra-secret-detector.yml`,
  `smoke-{teams,slack}-notify.yml`) may use `./`.
- **No `runner` context in job-level `env:`.** It does not warn. The workflow becomes
  invalid and every run fails at startup with no jobs and no log. Use step-level `env:`.
- **`shared-ref` defaults track the major tag.** `claude-issue-triage.yml` and
  `claude-issue-autopilot.yml` check this repo out at `inputs.shared-ref` (default `v2`) to
  get prompts and scripts. On a major bump, bump that default too, or new logic runs
  against old prompts.
- **Untrusted text goes through files.** Issue titles, bodies, CI logs and evidence are
  written to `/tmp/*.txt` and `cat`'d. Never route them through `$GITHUB_OUTPUT` into a
  later `run:`.
- **Add inputs here first.** A caller passing an input `@v2` doesn't declare fails the
  call. Merge and release the input here, then change the caller.
- **This repo's own jobs stay on `ubuntu-latest`.** The org runner group disallows public
  repos, so a self-hosted job here queues forever. Do not flip
  `allows_public_repositories` (fork PRs would run on the runner host).
- **Shared workflows default `runner:` to `ubuntu-latest`.** Consumers pass a label.
  Every self-hosted runner carries `omarchy`; only `kenya-lumist-labs-{1,2,3}` carry `kenya`.
- **No `--remove-orphans` in VPS deploys.** Dev and prod share one compose project and
  Traefik runs as its own stack, so the only orphans it can find are live services.
- **`pr-hooks.yml` dogfoods `pr-to-main-hooks.yml@v2`.** A change to that workflow is
  exercised here only after it is tagged.
- **Changing a composite before release** means temporarily pointing a caller's `uses:` at
  a branch (a reusable workflow's `uses:` takes no expressions). Revert before merge; see
  the comment above `vps-deploy-core@v2` in `deploy-vps-shared.yml`.

## Org configuration consumers rely on

| Name | Kind | Scope |
|---|---|---|
| `INFISICAL_OIDC_IDENTITY_ID`, `PROD_DEPLOYERS`, `RELEASE_BOT_APP_ID` | Lumist-Labs org variables | all repos |
| `INFISICAL_{INTERNAL,SHARED,EXTERNAL}_PROJECT_SLUG`, `VPS_USER` | Lumist-Labs org variables | selected: lumist-frontend-templates, passage, vector. Every other repo keeps repo-level copies |
| `RELEASE_BOT_PRIVATE_KEY` | Lumist-Labs org secret | all repos |

A missing variable resolves to empty and fails much later. Check with
`gh variable list --repo <repo>`. `PROD_DEPLOYERS` is managed in
`lumist-terraform-infrastructure/github/actions.tf`.

Infisical auth in shared workflows is GitHub OIDC (`method: oidc`). The CI Anthropic key
lives at `lumist-labs-internal/prod/github-actions`, separate from app keys.

## Docs

| Doc | For |
|---|---|
| [`README.md`](README.md) | Consumer index: every action and workflow, usage, new-app checklist |
| [`docs/architecture.md`](docs/architecture.md) | How workflows, composites and scripts connect; Autopilot end to end; consumer map |
| [`docs/runbooks/runners-and-ci.md`](docs/runbooks/runners-and-ci.md) | Runner rule, concurrency policy, self-hosted traps. Read before touching a workflow |
| [`docs/runbooks/issue-autopilot.md`](docs/runbooks/issue-autopilot.md) | Autopilot gate, labels, adding a repo |
| [`docs/runbooks/deploy-vps-migration.md`](docs/runbooks/deploy-vps-migration.md) | Moving a repo onto `deploy-vps-shared.yml` |
| [`docs/runbooks/entra-secret-detector.md`](docs/runbooks/entra-secret-detector.md) | The daily Entra credential scan |
| [`RELEASING.md`](RELEASING.md), [`CONTRIBUTING.md`](CONTRIBUTING.md) | Release procedure; action conventions and bump rules |
| `actions/<name>/README.md`, `images/README.md`, `scripts/README.md`, `tools/README.md` | Per-directory contracts |

Reusable workflow inputs are documented in each workflow's own `inputs:` block and header
comment; those are the source of truth.
