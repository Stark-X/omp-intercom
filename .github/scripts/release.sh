#!/usr/bin/env bash
set -euo pipefail

if ! [[ "$COMPATIBILITY_PR" =~ ^[0-9]+$ && "$MERGED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Invalid merge metadata.\n' >&2
  exit 1
fi

git merge-base --is-ancestor "$MERGED_SHA" HEAD
marker="Compatibility-PR: $COMPATIBILITY_PR"
release_commit="$(git log --first-parent -1 --format=%H --grep="^$marker$" HEAD)"

if [[ -z "$release_commit" ]]; then
  tag="$(npm version patch --no-git-tag-version --ignore-scripts)"
  git add -- package.json package-lock.json
  git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    commit -m "Release $tag" -m "$marker"
  release_commit="$(git rev-parse HEAD)"
  git tag "$tag" "$release_commit"
  gh auth setup-git
  git push --atomic origin "HEAD:refs/heads/master" "refs/tags/$tag:refs/tags/$tag"
else
  tag="v$(git show "$release_commit:package.json" | jq -er .version)"
  printf 'Reusing %s from %s.\n' "$tag" "$release_commit"
fi

if [[ "$(git ls-remote origin "refs/tags/$tag" | cut -f1)" != "$release_commit" ]]; then
  printf 'Tag %s does not point to the version commit %s.\n' "$tag" "$release_commit" >&2
  exit 1
fi

if release_url="$(gh release view "$tag" --repo "$GITHUB_REPOSITORY" --json url --jq .url 2>/dev/null)"; then
  printf 'Release already published: %s\n' "$release_url" >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

release_url="$(gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag --title "$tag" \
  --generate-notes --notes "Upstream compatibility fix from #$COMPATIBILITY_PR.")"
printf 'Published %s from master: %s\n' "$tag" "$release_url" >> "$GITHUB_STEP_SUMMARY"
