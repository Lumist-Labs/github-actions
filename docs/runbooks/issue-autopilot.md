# Issue autopilot

`claude-issue-autopilot.yml` scores one issue in a target repo and, for the ones
that are genuinely small, opens a **draft** pull request. Nothing merges without
a person, and nothing is verified before the PR exists — the PR's own CI is the
first check the change gets.

Beacon runs it. Its dispatcher, `beacon/.github/workflows/autopilot.yml`, is the
only caller: Beacon dispatches it with `repo`, `issue` and `mode`, and the
dispatcher looks up that repo's settings in `beacon/.github/autopilot-repos.json`.
Target repos carry no autopilot files. Plan and rationale: beacon
`docs/features/auto-dev-loop/CONNECTING.md`.

This is a different job from [`claude-issue-triage.yml`](../../.github/workflows/claude-issue-triage.yml).
Triage is advisory and runs in each repo on every issue; autopilot authorizes an
unsupervised change and runs only when Beacon asks.

## Modes

- `auto` — Beacon dispatches it on promote. The thresholds apply.
- `override` — a Beacon admin's Start anyway. It waives size, confidence,
  sensitive paths and the model's own `review`. It never waives blocked paths,
  unparseable output, invalid points or a bad branch.
- `fix` — Beacon dispatches it when an Autopilot PR's CI fails. It pushes to that
  PR's branch; at most two per PR.

Only Beacon holds a token that can dispatch, so admin rights live in Beacon and
nowhere else.

## Adding a repo

- Add it to `beacon/.github/autopilot-repos.json` with its base branch, runner,
  `blocked-paths` and `sensitive-paths`. Check both against the repo's tree with
  `node scripts/autopilot-paths-audit.js <autopilot-repos.json> <owner/repo>`.
- Install `lumist-release-bot` on the repo with contents, pull-requests and
  issues write. A repo in another org needs that org's own installation.
- Create the labels `autopilot-queued`, `autopilot-offered`, `autopiloted`,
  `autopilot-already-fixed`, `autopilot-sensitive` and `needs-human`.
- Confirm the repo's CI `pull_request` filter covers every `branch-prefixes`
  entry.

## The App token is not optional

A pull request opened with the default `GITHUB_TOKEN` does not fire
`on: pull_request`. That is deliberate on GitHub's side — it stops workflows
recursing — but it means an auto-PR opened that way arrives with **no checks at
all**, which destroys the only real verification this design has. The PR is
therefore opened with a GitHub App installation token, whose PRs do trigger
workflows. If you ever see an autopilot PR with an empty checks list, that is the
thing that broke.

## The gate

Two jobs. `score` decides; `work` runs only if `score` said `work`.

`score` runs Claude with [`ci-autopilot-score.md`](../../.claude/prompts/ci-autopilot-score.md)
and gets back strict JSON — points, decision, branch, the files it expects to
touch, and the acceptance criteria. That JSON is then handed to
[`scripts/autopilot-verdict.js`](../../scripts/autopilot-verdict.js), **which is
the actual guardrail**. The prompt is the fast path; the script is the boundary.
It re-derives the decision itself. There are three outcomes:

| Decision | When | Label |
|---|---|---|
| `work` | ≤ `max-points`, confidence high, no hard stop | `autopilot-queued`, then `autopiloted` |
| `offer` | ≤ `offer-max-points` or confidence medium, no hard stop | `autopilot-offered` — a Beacon admin decides |
| `review` | anything else | `needs-human` |

Confidence missing or unrecognised counts as low. These are hard stops, always
`review` whatever the size:

| Check | Why it is enforced outside the model |
|---|---|
| `points > offer-max-points`, or confidence low | The thresholds are the operator's call, not the model's |
| any reported path matches `blocked-paths` | A model that was talked into `decision: "work"` cannot also talk its way past a regex |
| any reported path matches `sensitive-paths` | Same, but a person may decide to build it: Start anyway waives this one |
| no files, or no acceptance criteria | Nothing was actually authorized, and there is no definition of done |
| branch prefix outside `branch-prefixes` | A prefix outside the target repo's CI branch filter gives the PR no checks, silently |
| branch missing the issue number | The repeat-run guard matches on it |
| output was not parseable JSON | Fail closed |

The comment posted to the issue lists whichever of these fired, so "why didn't it
work this one" is answerable without opening the run log.

`work` then checks both patterns a third time, against the diff that actually
happened on disk. A blocked hit refuses the push in every mode. A sensitive hit
refuses it in `auto`. In `override` and `fix` it pushes, labels the PR
`autopilot-sensitive` and lists the files at the top of the PR body. Three layers
because the first two are both statements of intent and only the third is a fact.
A pattern `grep -E` can't compile stops the push too, since JS accepts syntax
(lookarounds) that ERE doesn't.

`sensitive-diff` covers what no path can: an Ash `policies` block inside an
ordinary resource, a pgvector `ORDER BY`. It is matched against the lines the
real diff changes plus three lines of context, and a hit makes that file
sensitive. It only exists at the diff layer, since the scorer's file list says
nothing about which lines will change.

The two lists do different jobs. `blocked-paths` is what a bot never writes:
CI, container and deploy config, lockfiles, migrations, secret stores.
`sensitive-paths` is what a person decides on: auth, tenancy, policy, audit,
redaction, a core runtime. Write both from the repo's CLAUDE.md invariants, as
path segments (`(^|[/_.-])auth([/_.-]|$)`) rather than substrings, which also hit
`authored_fallback.ex`. Keywords are per repo; bd-pulse's "credentials" are team
members' deal experience, not secrets.

Both are matched **case-insensitively** at both enforcement points (`grep -iE` in
the work job and `new RegExp(…, 'i')` in the verdict script), so keep repo
patterns lowercase, and ERE-only.

## What Claude can reach

The issue body is untrusted — Beacon promotes end-user text and forwarded email
verbatim. So neither pass holds a token that can write to GitHub:

- `score` runs with `--tools Read,Glob,Grep`, no `GH_TOKEN`, and the default
  permission mode, which denies reads outside the checkout.
- `work` checks out with `persist-credentials: false`, gives Claude no
  `GH_TOKEN`, and mints the App token only after Claude exits. The App can push
  to protected `main` for `release-shared.yml`; it must never be in reach of a
  prompt-injected session.

What remains in reach during `work` is `ANTHROPIC_API_KEY` and the runner host
itself (`bypassPermissions` includes Bash). Running `work` in a container is the
fix for the second.

## What the work job tests

With a `setup` command, the job runs in the repo's `container-image`, installs
what the tests need, starts Postgres when `postgres-image` is set, and exports
`test-env`. Claude runs the tests it wrote, the existing tests for the files it
changed, and lint, not the whole suite. The target repo's CI runs the full suite
on the PR and is still the real gate.

Without `setup`, nothing runs before the push, and the PR body says so.

## Re-running, and not running twice

The `score` job stops before spending anything if the issue is already labelled
`autopiloted`, or if a branch matching `*/<issue#>-*` already exists on the
remote, or if the issue is closed. Either marker alone is enough — the label survives a deleted branch, the
branch survives a stripped label.

To deliberately re-run after editing an issue body: delete the branch, remove the
`autopiloted` label, and trigger it again from Beacon.

`cancel-in-progress` is **false** here, unlike triage. A cancel landing between
`git push` and `gh pr create` leaves an orphan branch and no PR, which is worse
than a duplicate run the guard would have caught anyway.

## When a run fails

Both jobs label the issue `needs-human` and comment with the run URL. The `work`
job leaves any pushed branch in place. A half-finished run must not sit there looking
queued.

## Issue titles are untrusted input

Anyone who can file an issue controls the title and body. Neither ever reaches a
`run:` block through `$GITHUB_OUTPUT` — both are written to files and `cat`'d, so
a backtick or `$(...)` in a title is text rather than shell. Keep it that way if
you edit this workflow.
