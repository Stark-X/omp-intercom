#!/usr/bin/env bash
set -euo pipefail

existing="$(bash .github/scripts/find-repair-pr.sh)"
if [[ -n "$existing" ]]; then
  printf 'An automated repair is already open: %s\n' "$existing" >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

remote_sha="$(git ls-remote origin refs/heads/master | cut -f1)"
if [[ "$remote_sha" != "$GITHUB_SHA" ]]; then
  echo "master advanced while the repair was being tested. Run compatibility again on the new commit." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

branch="automation/intercom-compatibility/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
git apply --index "$RUNNER_TEMP/repair/repair.patch"
node .github/scripts/validate-repair.mjs
git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit -m "Fix upstream Intercom compatibility"
gh auth setup-git
git push origin "HEAD:refs/heads/$branch"

body="$RUNNER_TEMP/repair-pr.md"
{
  printf 'The pinned baseline passed and these version combinations reproduced an incompatibility.\n\n'
  jq -r '.[] | "- `\(.scenario)` with Pi \(.versions.pi), OMP \(.versions.omp), Bun \(.versions.bun), pi-intercom \(.versions.intercom)"' \
    "$RUNNER_TEMP/evidence/compatibility-evidence.json"
  printf '\nThe candidate passed unit and cross-harness tests for the baseline and all latest version combinations.\n'
  printf '\n[Compatibility run](%s/%s/actions/runs/%s)\n' "$GITHUB_SERVER_URL" "$GITHUB_REPOSITORY" "$GITHUB_RUN_ID"
} > "$body"

pr="$(gh pr create --repo "$GITHUB_REPOSITORY" --base master --head "$branch" \
  --title "Fix upstream Intercom compatibility" --body-file "$body")"
printf 'Opened repair PR: %s\n' "$pr" >> "$GITHUB_STEP_SUMMARY"
gh api --method POST "repos/$GITHUB_REPOSITORY/pulls/${pr##*/}/requested_reviewers" \
  -f "reviewers[]=$REVIEWER" --silent
