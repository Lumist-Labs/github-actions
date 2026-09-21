#!/usr/bin/env bash
# Report comments that claim a blocker which no longer exists.
#
#   tools/stale-blockers.sh          # both orgs
#   ORGS="Lumist-Labs" tools/stale-blockers.sh
#
# Uses your own gh auth, which spans both orgs. Read-only. Silent when clean;
# exits 1 when it finds something.
#
# Why: on 2026-09-20 Lumist-Labs ran out of Actions minutes with 7 self-hosted
# runners idle. 43 jobs were still on billable ubuntu-latest because five repos
# said `requires github-actions#113 (must merge + the v2 tag moved first)`.
# #113 had merged months earlier. The comment was the only record of the intent,
# and it was wrong.
#
# Not a TODO grep: it joins runs of comment lines into one block, requires
# language asserting a wait, then asks GitHub whether the referenced issue or PR
# is actually closed. A closed reference under blocker language is the signal.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
found=0; skipped=0

for org in ${ORGS:-aretecp Lumist-Labs}; do
  if ! gh repo list "$org" --limit 1 >/dev/null 2>&1; then
    echo "skip: cannot list $org with your current gh auth" >&2; skipped=1; continue
  fi
  for repo in $(gh repo list "$org" --limit 200 --no-archived --json name --jq '.[].name'); do
    d="$work/$org-$repo"
    git clone -q --depth 1 --filter=blob:none --sparse \
      "git@github.com:$org/$repo.git" "$d" 2>/dev/null || { echo "skip: $org/$repo" >&2; skipped=1; continue; }
    git -C "$d" sparse-checkout set .github >/dev/null 2>&1
    [ -d "$d/.github" ] || continue
    out=$(python3 "$here/stale-blocker-scan.py" "$d/.github" "$org/$repo")
    [ "$out" = "[]" ] && continue
    python3 -c "
import json,sys
for r in json.loads(sys.argv[1]):
    print(f'{r[0]} {r[1]}:{r[2]}  {r[3]} is closed')
    print(f'    {r[4]}')
" "$out"
    found=1
  done
done

# A scan that skipped targets has not cleared them. Say so — the whole point of
# this tool is that a silent pass is how the #113 comments survived for months.
[ "$skipped" = "1" ] && echo >&2 "Some targets were skipped — this run does not clear them."
[ "$found" = "0" ] && exit 0
exit 1
