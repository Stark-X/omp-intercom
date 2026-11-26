#!/usr/bin/env bash
set -euo pipefail

harness_dir="$(mktemp -d "$RUNNER_TEMP/omp-harnesses.XXXXXX")"
report_dir="$RUNNER_TEMP/compatibility-report"
mkdir -p "$report_dir"

install_args="$(node .github/scripts/compatibility.mjs install-args)"
mapfile -t packages <<< "$install_args"

report() {
  jq -n --argjson versions "${HARNESS_VERSIONS:-null}" --arg status "$1" --arg diagnostic "${2:-}" \
    '{versions: $versions, status: $status, diagnostic: $diagnostic}' > "$report_dir/report.json"
}

report infrastructure
npm install --prefix "$harness_dir" --no-audit --no-fund "${packages[@]}"
npm ls --prefix "$harness_dir" --depth=0
export PATH="$harness_dir/node_modules/.bin:$PATH"

attempt() {
  python3 tests/cross-harness.py "$harness_dir/node_modules/pi-intercom/index.ts" 2>&1 | tee "$harness_dir/attempt-$1.log"
}

if attempt 1; then
  report pass
  exit 0
fi

if [[ "${COMPATIBILITY_REPORT:-}" != "true" ]]; then
  exit 1
fi

printf '\nRechecking the same installed versions in a fresh fixture.\n'
if attempt 2; then
  report pass "Passed on retry"
  exit 0
fi

signature() {
  sed '/^[[:space:]]*$/d' "$1" | tail -1 |
    sed -E 's@/tmp/omp-ic-[a-zA-Z0-9_]+@/tmp/omp-ic-fixture@g; s/[[:xdigit:]]{8}(-[[:xdigit:]]{4}){3}-[[:xdigit:]]{12}/SESSION-ID/g' |
    cut -c1-1000
}

first="$(signature "$harness_dir/attempt-1.log")"
second="$(signature "$harness_dir/attempt-2.log")"
if [[ -n "$first" && "$first" == "$second" ]]; then
  report regression "$second"
else
  report unconfirmed "$second"
fi
exit 1
