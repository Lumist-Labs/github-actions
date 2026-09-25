# Autopilot path tiers

Status: Ready

## Problem

`blocked-paths` does two jobs with one hard stop. Some paths must never be
written by a bot: CI, container builds, schema migrations, secret stores. Others
are sensitive code a person should look at first: auth, permissions, audit,
redaction, a repo's core runtime. Today both are `unsafe`, so even an admin's
Start anyway can't build them.

The patterns are also substring matches, so they misfire. Measured against each
repo's `develop` tree (2026-09-25):

| Repo | Code files blocked | Misfires, e.g. |
|---|---|---|
| lumios | 469 / 2287 (21%) | `(scope)` hits 54 files, `(auth)` hits `…_oauth_…` merge migrations |
| lumilearn | 242 / 931 (26%) | `(auth)` hits 29 `authored_*` types; `(migration)` hits `learner_context_migration_outcome.ex` |
| bd-pulse | 92 / 1298 (7%) | `^src/db/` blocks all 60 query modules; `(credential)` blocks the credentials UI |
| vector | 236 / 1384 (17%) | `(auth)` hits `author_personas`, `persona_authoring_driver` |

bd-pulse#2935 is the live case: a well-specified 5-point feature that no one can
start, because it needs `src/db/crud_contacts.py`.

## Design

Two lists per repo in `autopilot-repos.json`:

- **`blocked-paths`**: hard stop, as now. The scorer can't propose them. Start
  anyway can't waive them. The work job refuses to push a diff that touches
  them. Kept to: `.github/`, Dockerfiles, compose files, migration directories,
  secret/vault stores, infra.
- **`sensitive-paths`**: new. A hit is `judged`, the same tier as "over 5 points",
  so it matches the rule "protected paths need a dev". It never builds on its
  own. An admin's Start anyway can build it. The PR then gets an
  `autopilot-sensitive` label, and its body lists the sensitive files it touched.

Patterns are anchored on path segments (`(^|/)auth[^/]*$`, `(^|/)auth/`), not bare
substrings. Each repo's lists are checked against its real tree with a script,
and the matched files are listed in the Beacon PR so the review is of files, not
of regexes.

## Pieces

| # | Piece | Size | Needs |
|---|---|---|---|
| 1 | github-actions: `sensitive-paths` input. `autopilot-verdict.js` classifies hits as judged. The work job re-checks the diff: blocked refuses the push, sensitive labels the PR and lists the files. Tests. | ~80 logic + tests | — |
| 2 | github-actions: `scripts/autopilot-paths-audit.js`, which prints what each pattern matches in a repo tree. Used for piece 3 and kept for the next repo added. | ~40 | — |
| 3 | beacon: the dispatcher passes `sensitive-paths`. All four repos' lists are rewritten and split, with the audit output in the PR body. | ~5 logic + config | 1 merged and `v2` moved; 2 |
| 4 | Create the `autopilot-sensitive` label in all four repos. | commands | before 3 ships |

The order matters. Passing an input that `@v2` doesn't declare fails every
dispatch, so 3 can't merge until 1 is on `v2`.

## Acceptance

- bd-pulse#2935 re-scores as needs-dev on size/confidence only, with no unsafe
  objection, and Start anyway builds it.
- A diff that touches a blocked path is still refused on Start anyway (test).
- A PR that touches a sensitive path carries the label and lists the files (test).
- No misfire from the table above survives the audit in piece 3.
