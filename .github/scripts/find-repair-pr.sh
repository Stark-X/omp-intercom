#!/usr/bin/env bash
set -euo pipefail

gh pr list --repo "$GITHUB_REPOSITORY" --base master --state open \
  --json author,headRefName,isCrossRepository,url \
  --jq '[.[] | select(.isCrossRepository == false and .author.login == "github-actions[bot]" and (.headRefName | startswith("automation/intercom-compatibility/")))][0].url // empty'
