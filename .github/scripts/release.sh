#!/usr/bin/env bash
set -euo pipefail

if ! [[ "${RELEASE_PR:-}" =~ ^[1-9][0-9]*$ && "${MERGED_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Invalid merge metadata.\n' >&2
  exit 1
fi

marker="Release-PR: $RELEASE_PR"
gh auth setup-git

for attempt in 1 2 3; do
  git fetch origin master
  git switch --detach FETCH_HEAD
  master_commit="$(git rev-parse HEAD)"
  git merge-base --is-ancestor "$MERGED_SHA" "$master_commit"
  release_commit="$(git log --first-parent -1 --format=%H \
    --grep="^$marker$" --grep="^Compatibility-PR: $RELEASE_PR$" "$master_commit")"
  if [[ -n "$release_commit" ]]; then
    tag="v$(git show "$release_commit:package.json" | jq -er .version)"
    printf 'Reusing %s from %s.\n' "$tag" "$release_commit"
    break
  fi

  tag="$(npm version patch --no-git-tag-version --ignore-scripts)"
  git add -- package.json package-lock.json
  git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    commit -m "Release $tag" -m "$marker"
  release_commit="$(git rev-parse HEAD)"
  if git push --atomic origin "HEAD:refs/heads/master" "HEAD:refs/tags/$tag"; then
    break
  fi
  remote_master="$(git ls-remote origin refs/heads/master | cut -f1)"
  if [[ -z "$remote_master" || "$remote_master" == "$master_commit" || "$attempt" == 3 ]]; then
    exit 1
  fi
  printf 'Master advanced during the release. Retrying on %s.\n' "$remote_master"
done

if [[ "$(git ls-remote origin "refs/tags/$tag" | cut -f1)" != "$release_commit" ]]; then
  printf 'Tag %s does not point to the version commit %s.\n' "$tag" "$release_commit" >&2
  exit 1
fi

if release_url="$(gh release view "$tag" --repo "$GITHUB_REPOSITORY" --json url --jq .url 2>/dev/null)"; then
  printf 'Release already published: %s\n' "$release_url" >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

release_url="$(gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag --title "$tag" \
  --generate-notes --notes "Released after merging #$RELEASE_PR.")"
printf 'Published %s from master: %s\n' "$tag" "$release_url" >> "$GITHUB_STEP_SUMMARY"
