# Contributing

This repo holds shared composite actions and reusable workflows for `Lumist-Labs` and `aretecp` repos. Consumers call them as `uses: Lumist-Labs/github-actions/actions/<name>@v2` or `.../.github/workflows/<file>@v2`. Repo-wide rules for agents and humans are in [`CLAUDE.md`](CLAUDE.md).

## Repo layout

```
.
├── actions/<name>/
│   ├── action.yml         # composite action definition
│   └── README.md          # inputs, outputs, usage
├── .github/workflows/     # reusable workflows, plus this repo's CI, release and cron jobs
├── .claude/prompts/       # prompts the Claude workflows check out at run time
├── scripts/               # scripts workflows and actions run (see scripts/README.md)
├── tools/                 # maintainer scripts run by hand (see tools/README.md)
├── images/                # CI base images; manifest.json drives ci-images.yml
└── docs/                  # architecture, runbooks
```

One action per directory. The directory name is the action's public name — pick it carefully.

## Adding a new action

1. **Open an issue first** using the `Feature request` template. Describe the problem you're solving across repos and sketch the inputs/outputs. Get a thumbs-up before writing code.
2. **Branch off `main`** (this repo has no `develop`) with `feat/<issue#>-<short-name>` (e.g. `feat/12-tailscale-connect`).
3. **Create `actions/<name>/action.yml`** following the schema below.
4. **Write `actions/<name>/README.md`** — show a `uses:` block, document every input and output, list any required secrets/permissions.
5. **Add a smoke-test workflow** under `.github/workflows/smoke-<name>.yml` if the action can run without real credentials. [`smoke-teams-notify.yml`](.github/workflows/smoke-teams-notify.yml) is the pattern. Actions that need a VPS, AWS or Infisical are validated by a consumer run instead (see [`RELEASING.md`](RELEASING.md#pre-release-checklist)).
6. **Open a PR** linking the issue with `Closes #N`, titled `feat:` so merging releases it. Verify `lint-workflows.yml` and any smoke test are green.

## `action.yml` schema

Composite actions only — no Docker, no JS bundles. Keep dependencies to widely-available shell tools or `setup-*` actions from the marketplace.

```yaml
name: <Human-readable name>
description: <One sentence — what it does, who calls it>

inputs:
  <input-name>:
    description: <What it is, why it's needed>
    required: true | false
    default: <only if required: false>

outputs:
  <output-name>:
    description: <What downstream steps can use this for>
    value: ${{ steps.<id>.outputs.<key> }}

runs:
  using: composite
  steps:
    - name: <Verb-first step name>
      shell: bash
      run: |
        # bash steps must set `shell:` explicitly — composite actions don't inherit it
        ...
```

Conventions:

- **Input names** are `kebab-case` (`project-id`, not `projectId` or `project_id`).
- **Required vs optional** — required inputs have no `default`; optional inputs always have one.
- **Secrets** go through `env:` at the call site, not inputs, so they don't leak into the workflow log on misuse (`teams-notify` reads `TEAMS_WEBHOOK_URL` this way). Document the env var names in the action's README. Older exceptions exist: `load-infisical-secrets` takes `client-secret` and `wait-for-healthy` takes `key` as inputs.
- **Outputs** must come from a step with an explicit `id:`. Don't rely on implicit step IDs.
- **Idempotency** — composite actions get re-run on `act` and during PR rebases. Don't write to shared state without guards.

## Versioning

We follow semver and ship a moving major tag.

- `vMAJOR.MINOR.PATCH` — annotated tags, immutable.
- `vMAJOR` — moving tag (`v1`, `v2`, ...). Always points to the latest `MAJOR.x.y`. Most consumers pin to this.

Bump rules:

| Change | Bump |
|---|---|
| Internal refactor, no caller-visible change | patch (title it `fix:`; `refactor:` does not release) |
| New optional input, new output, additional behavior behind a flag | minor |
| Renamed/removed input or output, default change, behavior change that affects existing callers | **major** — bump the moving tag too |

**Exception — a default that changes *where* we point, not *what* callers get.**
A default change is normally major. But this repo's reusable workflows and
composites reference each other by the **moving** `@vN` tag, and none of them
expose the underlying input as a passthrough. So a major bump does not let
consumers opt in gradually — it strands them on the old value until every
internal ref *and* every consumer pin is retagged, and any pin missed stays
silently on the old value.

When the new default is observably equivalent to the old — same service, same
data, same auth, verified before the change — prefer a patch and let the moving
tag carry it. Record the equivalence check in the PR. Applied 2026-08-17 for the
Infisical `domain` default (`secrets.areteintelligence.ai` →
`secrets.lumistlabs.ai`: one instance, both hostnames served, both certs valid).
This is not licence to ship behaviour changes as patches.

**Never amend a published tag.** If you need to fix a release, cut a new patch and update the moving major tag to point at it.

When you bump major, the old `vN` tag stays where it is — it does not advance. Consumers on `@v1` keep getting `1.x.y`; only repos that explicitly retarget to `@v2` get the new behavior.

## Smoke tests

Only `teams-notify` has one today. Where an action can run without real infrastructure, add a smoke-test workflow that runs on PRs touching `actions/<name>/**`. It should:

- Run on the OS(es) the action supports (`ubuntu-latest` at minimum)
- Exercise the action with realistic inputs
- Assert outputs / side effects via subsequent steps
- Use a non-prod environment / project where applicable

If your action needs secrets, get them added as **org-level** Actions secrets so other consumers can use the same names — don't bake repo-specific secret names into the action.

## Env-scoping rule for workflows

**Any workflow consuming environment-level GH Actions secrets MUST declare `environment:` on the job that needs them.**

```yaml
jobs:
  triage:
    runs-on: ubuntu-latest
    environment: production   # ← required, otherwise env-scoped secrets are empty
    steps:
      - run: echo "$ANTHROPIC_API_KEY"
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Without the `environment:` line, `${{ secrets.X }}` resolves to empty for any secret stored at the environment level. Repo-level secrets still resolve. **In private repos on GitHub Free orgs, org-level secrets also fail to resolve regardless** — workaround in [`tools/sync-infisical-config.sh`](tools/sync-infisical-config.sh) for that case.

This rule cost us a debugging cycle on the `load-infisical-secrets` pilot and silently broke the `pr-to-main-hooks.yml` workflow in two repos (Claude PR summaries + Teams notifications no-op'd for months). When in doubt, add the `environment:` line.

## Commit + PR conventions

- Conventional prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- Tag the issue number when the commit is directly tied to one: `feat: #12 add tailscale-connect action`.
- One logical change per PR. If you find yourself touching multiple actions, split it.
- The PR template asks for test evidence — link the green smoke-test run.

## Releases

Merging a `feat:` or `fix:` PR to `main` releases it: `release.yml` tags `vX.Y.Z` and moves `v2`. `chore:`/`docs:`/`refactor:` merges do not release. Procedure and recovery: [`RELEASING.md`](RELEASING.md).

## Questions

File an issue or ping `@DominickGiordano`.
