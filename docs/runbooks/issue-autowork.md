# Issue autowork

`claude-issue-autowork.yml` lets a service account's small issues implement
themselves. It scores every eligible issue, and for the ones that are genuinely
trivial it opens a **draft** pull request. Nothing merges without a person, and
nothing is verified before the PR exists — the PR's own CI is the first check the
change gets.

This is a different job from [`claude-issue-triage.yml`](../../.github/workflows/claude-issue-triage.yml).
Triage is advisory and runs on everything; autowork is a gate that authorizes an
unsupervised change and runs only on an allowlist. They can both be installed in
the same repo.

## Turning it on

```yaml
# .github/workflows/claude-autowork.yml
name: Claude Autowork
on:
  issues:
    types: [opened, labeled]
permissions:
  contents: read
  issues: write
  id-token: write
jobs:
  autowork:
    uses: Lumist-Labs/github-actions/.github/workflows/claude-issue-autowork.yml@v2
    secrets: inherit
    with:
      runner: kenya
      base-branch: develop
      author-allowlist: areteintelligence
```

Three things must exist in the consumer repo first, and the workflow fails with a
named error if any is missing:

- `vars.RELEASE_BOT_APP_ID` and `secrets.RELEASE_BOT_PRIVATE_KEY`, with the App
  **installed on the repo** and granted `contents: write` and
  `pull-requests: write`. `secrets: inherit` is what forwards the private key.
- `vars.INFISICAL_OIDC_IDENTITY_ID` and `vars.INFISICAL_INTERNAL_PROJECT_SLUG`,
  the same pair triage uses.
- The labels `autowork`, `autowork-queued`, `autoworked` and `needs-human`.

`author-allowlist` is the kill switch. Clearing it disables the on-open path
entirely and leaves only the manual `autowork` label, without deleting the shim.

## The App token is not optional

A pull request opened with the default `GITHUB_TOKEN` does not fire
`on: pull_request`. That is deliberate on GitHub's side — it stops workflows
recursing — but it means an auto-PR opened that way arrives with **no checks at
all**, which destroys the only real verification this design has. The PR is
therefore opened with a GitHub App installation token, whose PRs do trigger
workflows. If you ever see an autowork PR with an empty checks list, that is the
thing that broke.

## The gate

Two jobs. `score` decides; `work` runs only if `score` said `work`.

`score` runs Claude with [`ci-autowork-score.md`](../../.claude/prompts/ci-autowork-score.md)
and gets back strict JSON — points, decision, branch, the files it expects to
touch, and the acceptance criteria. That JSON is then handed to
[`scripts/autowork-verdict.js`](../../scripts/autowork-verdict.js), **which is
the actual guardrail**. The prompt is the fast path; the script is the boundary.
It re-derives the decision itself and downgrades to `review` on any of:

| Check | Why it is enforced outside the model |
|---|---|
| `points > max-points` | The threshold is the operator's call, not the model's |
| any reported path matches `blocked-paths` | A model that was talked into `decision: "work"` cannot also talk its way past a regex |
| no files, or no acceptance criteria | Nothing was actually authorized, and there is no definition of done |
| branch prefix outside `branch-prefixes` | A prefix outside the consumer's CI branch filter gives the PR no checks, silently |
| branch missing the issue number | The repeat-run guard matches on it |
| output was not parseable JSON | Fail closed |

The comment posted to the issue lists whichever of these fired, so "why didn't it
work this one" is answerable without opening the run log.

`work` then checks the same pattern a third time, against the diff that actually
happened on disk, and refuses to push on a hit. Three layers because the first
two are both statements of intent and only the third is a fact.

`blocked-paths` is broad on purpose: a false positive costs one human review, a
false negative costs an unreviewed change to something load-bearing. Narrow it
per consumer if it is catching too much, but narrow it deliberately.

It is matched **case-insensitively** at both enforcement points — `grep -iE` in
the work job and `new RegExp(…, 'i')` in the verdict script — so keep consumer
patterns lowercase. `audit` already catches `AdminAudit.tsx`, and writing
`[Aa]udit` only makes the pattern look like it has to.

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

## Why the work job runs no tests

It has no toolchain and does not try to get one. `actions/setup-python` 404s on
the self-hosted host (see [`runners-and-ci.md`](runners-and-ci.md)), so a
toolchain step here is a reliable way to fail runs for reasons unrelated to the
change. The consumer's CI is the real gate and it fires on the PR.

The cost is honest and stated in the PR body: nothing was verified before the
push. If you want pre-push gates, containerize the `work` job in
`ghcr.io/lumist-labs/ci-python-uv:3.12` the way the consumer's `ci.yml` does —
that is the intended upgrade, not a rewrite.

## Re-running, and not running twice

The `score` job stops before spending anything if the issue is already labelled
`autoworked`, or if a branch matching `*/<issue#>-*` already exists on the
remote. Either marker alone is enough — the label survives a deleted branch, the
branch survives a stripped label.

To deliberately re-run after editing an issue body: delete the branch, remove the
`autoworked` label, and re-apply `autowork`.

`cancel-in-progress` is **false** here, unlike triage. A cancel landing between
`git push` and `gh pr create` leaves an orphan branch and no PR, which is worse
than a duplicate run the guard would have caught anyway.

## When a run fails

The `work` job labels the issue `needs-human`, comments with the run URL, and
leaves any pushed branch in place. A half-finished run must not sit there looking
queued.

## Issue titles are untrusted input

Anyone who can file an issue controls the title and body. Neither ever reaches a
`run:` block through `$GITHUB_OUTPUT` — both are written to files and `cat`'d, so
a backtick or `$(...)` in a title is text rather than shell. Keep it that way if
you edit this workflow.
