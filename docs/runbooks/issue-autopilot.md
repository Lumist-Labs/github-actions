# Issue autopilot

`claude-issue-autopilot.yml` scores one issue in a target repo and, for the ones
that pass the gate, opens a **draft** pull request. Nothing merges without a
person. The PR's own CI is the full test run the change gets.

Beacon runs it. Its dispatcher, `beacon/.github/workflows/autopilot.yml`, is the
only caller: Beacon dispatches it with `repo`, `issue` and `mode` (plus `evidence`,
and `pr`/`branch`/`ci_logs` for a fix run, passed on as `ci-logs`), and the dispatcher looks up that repo's
settings in `beacon/.github/autopilot-repos.json`. Target repos carry no autopilot
files. Beacon's side of the loop: beacon `docs/features/auto-dev-loop/CONNECTING.md`.

This is a different job from [`claude-issue-triage.yml`](../../.github/workflows/claude-issue-triage.yml).
Triage is advisory and runs in each repo on every issue; autopilot authorizes an
unsupervised change and runs only when Beacon asks.

## Modes

- `auto` — Beacon dispatches it on promote. The thresholds apply.
- `override` — a Beacon admin's Start anyway. It waives size, confidence,
  sensitive paths and the model's own `review`. It never waives blocked paths,
  a non-empty `blocked_reason`, unparseable output, invalid points or a bad branch.
- `fix` — Beacon dispatches it when an Autopilot PR's CI fails. It skips `score`,
  checks out the PR's branch and pushes a fix to it. It fails without `ci-logs`.
  Beacon caps it at `MAX_FIX_ATTEMPTS` (2) per PR in
  `backend/app/services/autopilot_ready.py`.
- `revise` — Beacon dispatches it when a person asks for changes on an Autopilot
  PR, from Beacon's Request changes box or a changes-requested review. It skips
  `score`, checks out the PR's branch, gives Claude `feedback` (first 8000
  characters, as data) and pushes one commit, `fix: #<issue> address review feedback`.
  It fails without `feedback`. The PR comment opens with
  `<!-- autopilot-revised {"run": "<url>"} -->`, which Beacon counts per PR.
  If that PR already merged, its branch is done: the run branches
  `<branch>-followup-<run>` off the base, which holds the merged change, and opens
  a new draft PR titled `follow-up to #<pr>`, with the usual Autopilot line,
  `Closes #<issue>` and the same marker (plus `"after": <pr>`) in its body.

Only Beacon holds a token that can dispatch, so admin rights live in Beacon and
nowhere else.

## Adding a repo

- Add it to `beacon/.github/autopilot-repos.json` with `base-branch`, `runner`,
  `max-points`, `offer-max-points` and `blocked-paths` (all required by the
  dispatcher), plus `sensitive-paths`, `sensitive-diff`, `setup`,
  `container-image`, `postgres-image`, `postgres-db` and `test-env` as needed.
  Check the path lists against the repo's tree with
  `node scripts/autopilot-paths-audit.js <autopilot-repos.json> <owner/repo> [ref]`.
- Give the workflow a token on the target. Lumist-Labs repos: install
  `lumist-release-bot` with contents, pull-requests and issues write. aretecp
  repos have no App installation, so the dispatcher passes LumistBot's PAT
  (`ARETECP_BOT_TOKEN`) as `TARGET_REPO_TOKEN`.
- Create the labels `autopilot-queued`, `autopilot-offered`, `autopiloted`,
  `autopilot-already-fixed`, `autopilot-sensitive` and `needs-human`.
- Confirm the repo's CI `pull_request` filter covers every `branch-prefixes`
  entry.
- A new dispatcher field needs a matching input here first. A caller passing an
  input `@v2` doesn't declare fails every dispatch, so merge and release the input
  here before Beacon sends it.

## Tokens

A pull request opened with the default `GITHUB_TOKEN` does not fire
`on: pull_request`, and this workflow runs in beacon, whose token can't reach the
target anyway. So every read and write on the target uses a `lumist-release-bot`
installation token scoped to that one repo, or `TARGET_REPO_TOKEN`. If you ever see
an autopilot PR with an empty checks list, the token is what broke.

- `score` mints contents read, issues write and pull-requests read (the last for the
  repeat guard).
- `work` mints a read-only token for the checkout and never a write token.
- `publish` runs on a fresh GitHub-hosted runner, applies `work`'s patch to a clean
  checkout, re-checks it, and is the only job that mints the write token. The App
  can push to protected `main` for `release-shared.yml`; it must never be in reach
  of a prompt-injected session.
- `TARGET_REPO_TOKEN` is a job secret in `work` for the checkout, but no step after
  Claude reads it, and it never enters a Claude step's environment.

## The gate

`score` runs Claude with [`ci-autopilot-score.md`](../../.claude/prompts/ci-autopilot-score.md)
and gets back strict JSON: points, confidence, decision (`work`, `review` or
`already_fixed`), branch, files, acceptance criteria, `blocked_reason`,
`questions_for_reporter` and `questions_for_dev`. That JSON goes to
[`scripts/autopilot-verdict.js`](../../scripts/autopilot-verdict.js), **which is
the actual guardrail**. It re-derives the decision itself and can overrule the
model in one direction only: more restrictive.

Each objection lands in one of three tiers:

| Tier | Checks | Effect |
|---|---|---|
| unsafe | output not parseable JSON · points not on 1/2/3/5/8/13 · non-empty `blocked_reason` · a reported path matches `blocked-paths` · branch prefix outside `branch-prefixes` · branch not `<prefix>/<issue>-lowercase-kebab` | `review`, in every mode |
| judged | points > `offer-max-points` · confidence missing or unrecognised · a reported path matches `sensitive-paths` | `review`; `override` waives it |
| soft | the model chose `review` · points > `max-points` · confidence medium or low · no files · no acceptance criteria · any `questions_for_dev` | `offer`; `override` waives it |

`decision: "already_fixed"` from the model short-circuits all three, except in
`override` or when the output didn't parse.

| Decision | Label | Meaning |
|---|---|---|
| `work` | `autopilot-queued`, then `autopiloted` when the PR opens | build it now; LumistBot is assigned while it builds |
| `offer` | `autopilot-offered` | a Beacon admin decides |
| `review` | `needs-human` | a developer takes it |
| `already_fixed` | `autopilot-already-fixed` | a person confirms and closes it |

Beacon's webhook maps exactly those four labels to its card state
(`backend/app/routers/webhooks.py::_AUTOPILOT_LABELS`). `score` strips all four
before adding one: re-adding a label the issue already has sends no `labeled`
event, and Beacon would miss the new result.

The comment posted to the issue lists every objection that fired, and carries a
hidden `<!-- autopilot-verdict {json} -->` marker. Beacon stores the score from
it, `questions` (reporter) and `questions_for_dev` included; the `work` job
re-reads it as its brief.

`work` then checks the path patterns a third time, against the diff that actually
happened on disk. A blocked hit refuses the push in every mode. A sensitive hit
refuses it in `auto`. In `override` it pushes, labels the PR `autopilot-sensitive`
and lists the files at the top of the PR body; in `fix` it labels the PR and lists
the files in its PR comment. Three layers
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

## When Claude stops to ask

The implementation prompt lets Claude stop instead of guessing, by emitting a
`<questions>` block. If it changed nothing and asked something (in `auto` or
`override`), `work` posts a verdict comment with `decision: "offer"` and the
questions as `questions_for_dev`, relabels the issue `autopilot-offered` and
unassigns LumistBot. Beacon shows the questions on the card; an answer re-scores
it. If Claude changed files *and* asked, the PR opens with the questions in its
body for the reviewer.

A `<findings>` block (other bugs noticed along the way, up to three) is cut from
the PR body and posted as an `<!-- autopilot-findings -->` comment. Beacon files
each as its own report.

## What Claude can reach

The issue body is untrusted — Beacon promotes end-user text and forwarded email
verbatim. So neither pass holds a token that can write to GitHub:

- `score` runs with `--tools Read,Glob,Grep`, no `GH_TOKEN`, and the default
  permission mode, which denies reads outside the checkout.
- `work` checks out with `persist-credentials: false`, gives Claude no
  `GH_TOKEN`, and runs `--permission-mode bypassPermissions` as its own uid
  (`autopilot`) via `setpriv`, with the runner's `ACTIONS_`/`GITHUB_`/`RUNNER_`
  variables stripped. That uid owns the checkout and nothing else; `.git` stays
  root's. Every process it started is killed when the step ends.

Both jobs always run in `container-image` (default `ghcr.io/lumist-labs/ci-node:22`;
Beacon sets `ci-autopilot-python` or `ci-autopilot-elixir` per repo). That keeps
Bash off the runner host and avoids the uid-0 checkout failure on shared
self-hosted workspaces. What remains in reach during `work` is `ANTHROPIC_API_KEY`
and the network. Neither job requests `id-token`: a job that has it exposes OIDC
request credentials to every step, and Infisical would trade a minted token for the org
identity that reads every app's secrets. The key comes only from the caller's
forwarded `secrets.ANTHROPIC_API_KEY`.

Claude runs as root in the `work` container, so anything later in that job is
treated as tainted: it only packages the patch, PR body, questions and findings
as an artifact. `publish` treats all of it as data.

Claude's uid can't write the runner's bind mounts (the tool cache and workspaces
later jobs on the same self-hosted host reuse), read root's process environment,
or write the `GITHUB_ENV` file. Tooling that `setup` left in `/root` (uv, pip,
npm and mix caches) is copied to its home first.

Untrusted inputs the prompts receive, all marked as data rather than instructions:

- `evidence` — Beacon's redacted production log excerpt, truncated to 8000 characters.
- `ci-logs` — fix mode's failing check tails, collected by Beacon.
- Screenshots — [`scripts/autopilot-attachments.js`](../../scripts/autopilot-attachments.js)
  downloads only Beacon's signed attachment URLs from the issue body (at most 6,
  5 MB each) into `.autopilot-attachments/`, where the Read tool can open them.

## What the work job tests

With a `setup` command, `work` installs what the tests need, starts Postgres
when `postgres-image` is set, and exports `test-env` (keys that would change
`PATH`, `HOME`, `GITHUB_*`, tokens and the like are refused). Claude runs the
tests it wrote, the existing tests for the files it changed, and lint, not the
whole suite. Tracked files `setup` rewrote (a lockfile after `mix deps.get`) are
restored before the push unless Claude edited them. The target repo's CI runs the
full suite on the PR and is still the real gate.

Without `setup`, nothing runs before the push, and the PR body says so.

## Re-running, and not running twice

The `score` job stops before spending anything if the issue is closed, already
labelled `autopiloted`, or has a live branch matching `<prefix>/<issue#>-*` on the
remote. Either marker alone is enough: the label survives a deleted branch, the
branch survives a stripped label.

A branch is **scrapped**, not live, when every PR on it is closed unmerged and
carries the `Opened automatically by [Autopilot]` line Autopilot writes at the top
of its PR body. A scrapped branch doesn't block, and `work` force-pushes over it.
A branch with an open or merged PR, or no PR at all (a person's own branch), stops
the run. If the PR lookup fails, the branch is treated as live and the run stops
with a warning.

Beacon's Retry on a report whose Autopilot PR was closed unmerged removes the
`autopiloted` label and dispatches again (`backend/app/routers/reports.py`). To
re-run by hand: close the PR unmerged (or delete the branch), remove
`autopiloted`, and trigger it from Beacon.

`cancel-in-progress` is **false** here, unlike triage. A cancel landing between
`git push` and `gh pr create` leaves an orphan branch and no PR, which is worse
than a duplicate run the guard would have caught anyway.

## When a run fails

`score` comments with the run URL and labels the issue `needs-human`. `work`
comments with an `<!-- autopilot-failure {"reason","run"} -->` marker and the last
reason a step recorded, relabels `autopilot-queued` → `needs-human` and unassigns
LumistBot. A null reason tells Beacon to ask the jobs API which step died. Any
pushed branch is left in place. A half-finished run must not sit there looking
queued.

A `work` run where Claude changed nothing and asked nothing is a failure, with
the first lines of its explanation as the reason.

## Issue titles are untrusted input

Anyone who can file an issue controls the title and body. Neither ever reaches a
`run:` block through `$GITHUB_OUTPUT` — both are written to files and `cat`'d, so
a backtick or `$(...)` in a title is text rather than shell. Keep it that way if
you edit this workflow.
