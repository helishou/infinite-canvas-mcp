#!/usr/bin/env bash
set -uo pipefail

log="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/canvas-check.XXXXXX")"
if "$@" 2>&1 | tee "$log"; then
  exit 0
fi

# Keep the failure visible in check annotations as well as authenticated job logs.
while IFS= read -r line; do
  line="${line//'%'/'%25'}"
  line="${line//$'\r'/'%0D'}"
  printf '::error title=Check failed::%s\n' "$line"
done < <(tail -n 80 "$log")
exit 1
