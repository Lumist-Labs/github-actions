# Architecture

How the pieces in this repo call each other, what a consumer actually runs, and
who consumes what. Rules for changing any of it are in [`CLAUDE.md`](../CLAUDE.md).

## Call graph

Consumers call a reusable workflow (`jobs.<id>.uses: …/.github/workflows/<file>@v2`) or a
composite (`steps[].uses: …/actions/<name>@v2`). Everything below the first hop is
referenced at `@v2` too, so one tag move ships the whole graph.

| Entry point | Composites it uses | Files it checks out from this repo |
|---|---|---|
| `deploy-vps-shared.yml` | `assert-prod-deployer` (prod only) → `vps-deploy-core` | — |
| `rollback-vps-shared.yml` | `assert-prod-deployer` (prod only) → `vps-deploy-core` | — |
| `copy-prod-db-shared.yml` | `assert-prod-deployer` (prod only), `load-infisical-secrets`, `tailscale-connect`, `wait-for-healthy` | — |
| `vps-deploy-core` | `load-infisical-secrets` (app, extras, infra), `tailscale-connect`, `wait-for-healthy` | — |
| `wait-for-healthy` | — | `scripts/wait-for-healthy.sh`, read from its own action checkout (`github.action_path/../../scripts`) and piped over SSH |
| `release-shared.yml` | — (semantic-release in the caller's repo) | — |
| `pr-to-main-hooks.yml` | `load-infisical-secrets` ×2 (CI Anthropic key, Teams webhook) | — |
| `claude-issue-triage.yml` | `load-infisical-secrets` | `.claude/prompts/ci-triage.md` at `shared-ref` |
| `claude-issue-autopilot.yml` | none (key is a forwarded secret) | `.claude/prompts/ci-autopilot-{score,implement}.md`, `scripts/autopilot-verdict.js`, `scripts/autopilot-attachments.js` at `shared-ref` |
| `aws-deploy-core` | — (`aws-actions/configure-aws-credentials`, SHA-pinned) | `actions/aws-deploy-core/scripts/{ec2-compose-deploy,ecs-run-task}.sh`, from its own action checkout |
| `ecr-build-push` | — (AWS and Docker upstream actions, SHA-pinned) | — |

Workflows that run in this repo only: `release.yml`, `lint-workflows.yml`,
`smoke-teams-notify.yml`, `ci-images.yml`, `pr-hooks.yml` (dogfoods
`pr-to-main-hooks.yml@v2`), and `entra-secret-detector.yml` (uses `./actions/load-infisical-secrets`,
`./actions/teams-notify` and `scripts/entra-credential-scan.sh` from its own checkout).

### Why composites reference each other at `@v2`

Inside a composite, `uses: ./actions/x` resolves against the caller's workspace,
which has no `actions/`. So every sibling ref is `Lumist-Labs/github-actions/actions/x@v2`,
and `lint-workflows.yml` rejects any `uses: ./` under `actions/`. The cost: a change to a
composite cannot be tested through a workflow here before the tag moves. To validate one,
temporarily point a caller's `uses:` at the branch, and revert before merge (the comment
above the `vps-deploy-core@v2` step in `deploy-vps-shared.yml` is the incident record).

### `shared-ref`

A reusable workflow's files are not on disk in the caller's job, and there is no
expression for the workflow's own ref. The two Claude workflows therefore
`actions/checkout` this repo at `inputs.shared-ref` (default `v2`) into `.shared-actions/`
to get prompts and scripts. The default must track the major tag: triage once defaulted
to `v1` while callers ran `@v2`, so v2 logic ran against a frozen v1 prompt.
`wait-for-healthy` needs no `shared-ref` because a composite's own files are checked
out with it (`github.action_path`).

## VPS deploy family

All three workflows share `vps-deploy-core` (or its pieces) and a job-level concurrency
group on the target, `vps-<caller repo>-<vps-user>-<repo-dir>`, overridable by
`deploy-concurrency-group`. Deploy and copy-db queue on it; rollback pre-empts.

`vps-deploy-core` steps, in order (`actions/vps-deploy-core/action.yml`):

1. Fail unless `healthcheck-containers` or `deploy-command` is set.
2. Render `app-path` from `app-project-slug` to a dotenv file (OIDC, `include-imports`),
   then each non-empty `extra-shared-path-*` / `extra-app-path-*` (recursive), and
   concatenate. Keys must be disjoint across folders (see the merge step's comment).
3. Append `VERSION=<ref>`; assert `required-keys` are present and non-empty; base64 the
   file for transfer.
4. Load `infra-path` (default `/tailscale`) from the shared project in env mode:
   `TAILSCALE_AUTHKEY`, `VPS_TAILSCALE_IP`, `VPS_SSH_KEY`. Never written to `.env`.
5. `tailscale-connect`.
6. On the VPS: fetch and check out `ref` in `repo-dir` (https remotes use the job token
   via `github-token`); clone only if `allow-clone: true`.
7. Write the env file (base64 through `appleboy/ssh-action` `envs`).
8. Pre-deploy DB snapshot when `db-type` is `sqlite` or `postgres` and `skip-pre-deploy`
   is false.
9. Optional `pre-compose-up-script` (rollback's DB restore).
10. `docker compose up -d` (`--build` unless `compose-build: false`, `--force-recreate`
    if set), or `deploy-command` instead.
11. `wait-for-healthy` over `healthcheck-containers`, then `post-deploy-command`.

### Inputs at a glance

Full descriptions live in each workflow's `inputs:` block.

| Workflow | Required | Notable optional |
|---|---|---|
| `deploy-vps-shared` | `environment`, `infisical-identity-id`, `shared-project-slug`, `app-project-slug`, `env-slug`, `app-path`, `vps-user`, `repo-dir`, `compose-file` | `ref` (`main`), `allow-clone` (false), `healthcheck-containers`, `required-keys`, `deploy-command`, `post-deploy-command`, `extra-{shared,app}-path-1..3`, `db-*`, `compose-build` (true), `compose-up-timeout` (30m), `runner` |
| `rollback-vps-shared` | the deploy set plus `version`, `healthcheck-containers` | `restore-db-snapshot` + `confirm: RESTORE-DB`, `db-*`, `snapshot-dir` |
| `copy-prod-db-shared` | `environment`, `confirm: CLOBBER-DEV`, `infisical-identity-id`, `shared-project-slug`, `env-slug`, `vps-user`, `repo-dir`, `db-type`, `dev-compose-file` | `prod-/dev-db-container`, `prod-/dev-db-path` (sqlite), `db-name`/`prod-db-name`/`dev-db-name`, `db-user` (postgres), `dev-app-container`, `dev-healthcheck-containers`, `dev-backup-dir` |
| `release-shared` | — | `ci-gated` (false), `deploy-workflow` (`deploy-prod.yml`, `''` skips), `major`, `node-version` (22), `runner` |

`copy-prod-db-shared`'s `environment` input exists so the OIDC subject matches the
Infisical trust policy (callers pass `production`); the write target is always dev. It loads infra credentials
only, no app `.env`.

`release-shared` reads `secrets.RELEASE_BOT_PRIVATE_KEY` and declares no `secrets:`,
so callers pass `secrets: inherit`. It pushes as `lumist-release-bot` (the `main`
ruleset exempts it), or as `GITHUB_TOKEN` where `RELEASE_BOT_APP_ID` is unset (aretecp), runs semantic-release from the caller's `.releaserc.json`, then
dispatches `deploy-workflow` on `main` with `version=<new tag>`. With `ci-gated: true`
the caller triggers it from CI's `workflow_run`, and it refuses to tag a SHA CI didn't
test.

## Prod-deployer gate

`deploy-vps-shared`, `rollback-vps-shared` and `copy-prod-db-shared` run
`actions/assert-prod-deployer` first when `environment` is `prod` or `production`. It
fails unless `github.triggering_actor` is in the org variable `PROD_DEPLOYERS`, a JSON
list managed in `lumist-terraform-infrastructure/github/actions.tf`. Repos outside
`Lumist-Labs` skip the check with a notice, since the variable and the `core` team exist
only there. AWS deploys (lumios, vector) call the action themselves.

Separately, `lumist-terraform-infrastructure/github/locals.tf::production_repos` limits a
repo's `production` environment to `main` and `v*` refs.

## Autopilot end to end

Runbook with the gate rules: [`runbooks/issue-autopilot.md`](runbooks/issue-autopilot.md).

1. **Beacon dispatches.** Beacon's backend dispatches `beacon/.github/workflows/autopilot.yml`
   with `repo`, `issue`, `mode` (`auto`, `override`, `fix`) and `evidence`. Its `config`
   job reads that repo's entry from `beacon/.github/autopilot-repos.json` and calls
   `claude-issue-autopilot.yml@v2`, passing `TARGET_REPO_TOKEN` for `aretecp/` repos.
2. **`score` job** (skipped in `fix`): validate inputs, mint an App token for the target,
   run the repeat guard (closed issue, `autopiloted` label, or a live `<prefix>/<issue>-*`
   branch stops it), check out the target and `.shared-actions/`, load the CI Anthropic
   key, run Claude read-only with `ci-autopilot-score.md`.
3. **Verdict.** `scripts/autopilot-verdict.js` parses the JSON, re-checks files against
   `blocked-paths`/`sensitive-paths` and the branch against `branch-prefixes`, and
   writes `decision` (`work`, `offer`, `review`, `already_fixed`) to `GITHUB_OUTPUT` plus
   the verdict comment with its `<!-- autopilot-verdict -->` marker.
4. **Labels.** `score` comments, strips and re-adds one of `autopilot-queued`,
   `autopilot-offered`, `needs-human`, `autopilot-already-fixed`, and assigns LumistBot on
   `work`. Beacon's webhook (`backend/app/routers/webhooks.py::_AUTOPILOT_LABELS`) moves
   the card on the `labeled` event. An admin's Start anyway dispatches again with
   `mode: override`.
5. **`work` job** (on `work`, or `fix`): check out with a read-only token, re-read the brief
   from the verdict comment, run `setup` and Postgres, run Claude with
   `ci-autopilot-implement.md` and no GitHub token, and upload the patch as an artifact.
   A **`publish` job** on a fresh hosted runner applies it to a clean checkout, re-checks
   the real diff, then mints the write token, commits, pushes and opens a **draft** PR whose body opens with the
   blockquote `> Opened automatically by [Autopilot](<run>) because …`. The issue flips `autopilot-queued` → `autopiloted`.
   No change plus questions → the questions go back as an `offer`.
6. **Fix mode.** When the PR's CI fails, Beacon collects the failing logs and dispatches
   `mode: fix` with `pr`, `branch`, `ci-logs`; `work` pushes one commit to the branch and
   comments on the PR. Beacon allows two attempts (`backend/app/services/autopilot_ready.py::MAX_FIX_ATTEMPTS`).
   Green CI → Beacon dispatches `beacon/.github/workflows/autopilot-ready.yml` to mark
   the PR ready.
7. **Failure** labels `needs-human`. A `work` failure comments an
   `<!-- autopilot-failure -->` marker with the reason; a `score` failure posts a plain
   "could not score" comment. Beacon's Retry on a closed-unmerged Autopilot PR removes `autopiloted`
   and dispatches again; the guard treats that branch as scrapped and `work` force-pushes.

## Release of this repo

`release.yml` on push to `main`: `feat:`/`fix:`/breaking subjects cut `vX.Y.Z` and move
`v2`; other prefixes skip. It pushes as `lumist-release-bot`, which the org
`release-tags` ruleset lets touch `v*`. See [`RELEASING.md`](../RELEASING.md).

## Consumer map

From `git grep` of `.github/` on each non-archived Lumist-Labs and aretecp repo's
`main`/`master` and `develop` branches (whichever exist), 2026-09-29. Other branches
and non-`.github` paths were not scanned. Pins other than `@v2` are noted.

| Workflow / action | Consumers |
|---|---|
| `deploy-vps-shared.yml` | areteos-elixir, beacon, claude-otel, litellm-gateway, lumi-command-center, lumilearn, lumios, lumist-vendor-matching; aretecp: areteos, sat-crm, watterson-vendor-matching, bd-pulse / contact-intelligence / performance-review (`@v2.20.2`) |
| `rollback-vps-shared.yml` | areteos-elixir; aretecp: areteos, bd-pulse (`@v2.20.2`) |
| `copy-prod-db-shared.yml` | areteos-elixir; aretecp: areteos, bd-pulse (`@v2.20.2`) |
| `release-shared.yml` | areteos-elixir, beacon, litellm-gateway, lumi-command-center, lumilearn, lumios, lumist-vendor-matching, vector; aretecp: areteos, ms-365-mcp-server |
| `pr-to-main-hooks.yml` | areteos-elixir, beacon, litellm-gateway, lumi-command-center, lumilearn, lumios, lumist-terraform-infrastructure, lumist-website, microsoft-entra-terraform-infrastructure, standby, vector; aretecp: areteos, bd-pulse |
| `claude-issue-triage.yml` | areteos-elixir, beacon, lumilearn, lumios, lumist-website, vector; aretecp: areteos, bd-pulse, contact-intelligence, watterson-vendor-matching (`@v1`) |
| `claude-issue-autopilot.yml` | beacon only (targets: lumios, lumilearn, vector, aretecp/bd-pulse per `autopilot-repos.json`) |
| `load-infisical-secrets` | beacon, litellm-gateway, lumi-command-center, lumilearn, lumios, lumist-terraform-infrastructure, vector, standby (`@v1`); aretecp: ms-365-mcp-server, bd-pulse (`@v2.20.2`), teams-bot (`@v1`) |
| `tailscale-connect` | litellm-gateway, lumilearn, vector; aretecp: ms-365-mcp-server (`@v1`), teams-bot (`@v1`) |
| `wait-for-healthy` | aretecp: ms-365-mcp-server, teams-bot |
| `assert-prod-deployer` | litellm-gateway, lumios, vector |
| `aws-deploy-core`, `ecr-build-push`, `teams-notify` | lumios, vector |

Callers of `vps-deploy-core` directly, or of `scripts/*` over raw URLs: none found in
`.github/`; anything outside `.github/` is **unknown**. CI image consumers are recorded
in `images/manifest.json`. Several repos still pull the old `ghcr.io/aretecp/ci-*` names
(areteos, areteos-elixir, bd-pulse, vector).
