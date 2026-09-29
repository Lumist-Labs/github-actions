# Releasing

How to cut a release of the actions in this repo. The semver bump rules and naming conventions live in [`CONTRIBUTING.md`](CONTRIBUTING.md#versioning) — this doc covers the *procedure*.

## Versioning model

This repo uses **single-repo versioning**. One annotated `vX.Y.Z` tag per release; one moving `vX` tag per major. Both apply to *every* action in `actions/*` simultaneously.

Consumers pin per-action via path:

```yaml
- uses: Lumist-Labs/github-actions/actions/load-infisical-secrets@v2
- uses: Lumist-Labs/github-actions/actions/load-infisical-secrets@v2.44.1
- uses: Lumist-Labs/github-actions/actions/load-infisical-secrets@<full-sha>
```

Reusable workflows and composites share that one tag. They also reference each other at
`@v2`, so moving the tag ships every changed file at once. `v1` is frozen.

## Pre-release checklist

- [ ] All open PRs targeting this release are merged.
- [ ] **Validation gate.** CI here only lints and runs the script tests. A changed reusable
      workflow or composite is exercised only by a consumer run, so point one consumer's
      `uses:` at the branch, run it, and revert that pin before merging.
- [ ] Action READMEs reflect the inputs/outputs as of the current `main`.
- [ ] Root README's action and workflow tables list anything new.
- [ ] `CONTRIBUTING.md` is up to date if any conventions changed.

## Picking the version

| Change | Bump |
|---|---|
| New action; no change to existing actions | minor |
| Internal refactor or doc-only change | none, unless titled `fix:` (only `feat:`/`fix:` release) |
| Bug fix in an existing action, no caller-visible behavior change | patch |
| New optional input or new behavior, default unchanged | minor |
| Renamed/removed input or output, default change, breaking shape change to any action | **major** |
| Upstream SHA bump with no caller-visible change | patch |
| Upstream SHA bump that changes caller-visible behavior | minor or major as appropriate |

Once the version is chosen, the rest is mechanical.

## Procedure

Most releases happen **automatically** on push to `main`. Override manually only for pre-releases or out-of-band cuts.

### Auto-release (default — every push to main)

The Release workflow (`.github/workflows/release.yml`) runs on every push to `main`. It reads the merge commit's conventional prefix and decides:

| Commit subject pattern | Action |
|---|---|
| `feat: ...` or `feat(scope): ...` | Auto-bump **minor** + cut release |
| `fix: ...` or `fix(scope): ...` | Auto-bump **patch** + cut release |
| `feat!:` / `fix!:` / contains `BREAKING CHANGE` | Auto-bump **major** + cut release |
| `chore:` / `docs:` / `refactor:` / `test:` / `style:` / `ci:` / `build:` | **Skip** — no release |
| Anything else | **Skip** — no release |

**Squash-merge convention.** Areté uses squash-merges, so the merge commit's subject is whatever was in the PR title. **Use a conventional prefix on PR titles** for auto-release to fire correctly.

### Sanity check (optional)

```bash
git fetch origin --tags
git log --oneline $(git describe --tags --abbrev=0 2>/dev/null || echo '')..origin/main
```

### Manual override (workflow_dispatch)

For pre-releases (e.g. `v2.0.0-rc.1`) or out-of-band cuts, override the auto-detect:

1. Go to **Actions → Release** → **Run workflow** in the GitHub UI.
2. Fill in:
   - **Branch:** `main`
   - **Version:** the explicit version (e.g. `v2.0.0-rc.1`). Leave blank to use the auto-detect path.
   - **Update moving major tag:** ✅ checked for stable releases. **Uncheck for pre-releases**.
3. Click **Run workflow**.

The workflow:
1. Determines version (auto-detect from commit prefix, OR uses the manual input)
2. Validates the version format (`vMAJOR.MINOR.PATCH` with optional `-prerelease`)
3. Verifies the tag doesn't already exist
4. Creates the annotated `vX.Y.Z` tag and pushes it
5. Force-updates the moving `vX` tag (unless pre-release or explicitly disabled)
6. Creates a GitHub Release with auto-generated notes (pre-releases marked as such)
7. Posts a step-summary with links

### No manual fallback

`v*` tags are covered by the org `release-tags` ruleset. Only the `lumist-release-bot` App
(which `release.yml` pushes as) and the `core` team can create, move or delete them. Don't
push them by hand even with that access: a hand-moved `v2` skips the version checks and
the GitHub Release. If the workflow is broken, fix `release.yml` and re-run it with an
explicit `version`.

### Moving major tag

`release.yml` force-moves `v2` on every stable release. That is the only force operation in
this repo, and it is intentional.

## Post-release

- [ ] Verify `v2` resolves to the same commit as the new annotated tag:
  ```bash
  git ls-remote --tags origin | grep -E '/v2(\.|$)' | sort
  ```
  Both should point at the same SHA.
- [ ] Repos pinned to `@v2` get the release on their next run. Repos on an exact version
      (bd-pulse, contact-intelligence and performance-review pin `@v2.20.2`) do not.

## If something is wrong after release

- **Bug found in `vX.Y.Z`** → merge the fix as `fix:`. `release.yml` cuts `vX.Y.Z+1` and moves `v2`. The bad version stays; `@v2` consumers get the fix on their next run.
- **Regression that needs an immediate revert** → merge the revert with a `fix:` title (a `revert:` or `chore:` title does not release). Don't rewrite `main` history.
- **A `chore:` merge broke something that is not yet live** → it ships with the next `feat:`/`fix:`. Fix or revert it before anything else merges.

The rule of thumb: **only the moving `vX` tag changes after a push. Everything else is append-only.**
