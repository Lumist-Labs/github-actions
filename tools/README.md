# `tools/`

**Admin / one-off bash scripts** run by a maintainer from a local checkout. These don't ship to consumer workflows — they manage org-wide GH config (secrets, vars, env stores) where `gh` CLI auth as a human user is required.

For scripts the workflows and actions run, see [`../scripts/`](../scripts/).

## Available tools

| Script | Description | Audience |
|---|---|---|
| [`setup-github-project.sh`](setup-github-project.sh) | One-shot setup of the standard Areté GH project + label structure on a new repo. Three modes: clone-from-template, greenfield, interactive. Backfills existing issues into the project. | Maintainer, new repo setup |
| [`sync-infisical-config.sh`](sync-infisical-config.sh) | Mirror org-level Infisical secrets/vars to per-repo level across N repos. Workaround for GitHub Free org's lack of org-secret cascade to private repos. Its hardcoded repo list is the pre-move `aretecp` one; edit it before running. | Maintainer |
| [`stale-blockers.sh`](stale-blockers.sh) | Report comments under `.github/` that claim a blocker (`requires #N`, `blocked on`, `must merge`) whose referenced issue or PR is already closed. Read-only; both orgs by default, `ORGS=` to narrow. Exits 1 on a hit. | Maintainer |
| [`stale-blocker-scan.py`](stale-blocker-scan.py) | The scanner `stale-blockers.sh` runs over each repo's `.github/` directory. | Called by `stale-blockers.sh` |
| [`cleanup-areteos-after-prod.sh`](cleanup-areteos-after-prod.sh) | Delete now-redundant per-repo / per-environment GH secrets in `aretecp/areteos` after both prod and dev workflows finish migrating to Infisical. | Maintainer, post-migration |
| [`cleanup-arilearn-phx-after-prod.sh`](cleanup-arilearn-phx-after-prod.sh) | Same idea for `aretecp/arilearn-phx`. | Maintainer, post-migration |

## Usage

Clone this repo, `chmod +x` if needed (the scripts already are), follow the per-script header for required env vars or interactive prompts, run from the repo root.

These scripts assume:
- `gh` CLI is authenticated as an org admin (`gh auth status` shows admin scope)
- `bash 3.2+` (macOS default works; uses parallel arrays, no associative arrays)
- Network access to GitHub API + Infisical where applicable

## Why a separate directory?

`scripts/` is for what workflows and actions run — executed unattended, so security-sensitive and version-pinned. `tools/` is for admin one-offs — invoked by hand, may make destructive changes (delete secrets, alter env config), require human attention.

Mixing the two in one directory blurred audiences and security models. Splitting clarifies: `scripts/` is consumed by workflows (shipped by an action, never fetched by URL — see `scripts/README.md`); `tools/` is local-only.
