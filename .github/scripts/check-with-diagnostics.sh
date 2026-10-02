#!/usr/bin/env bash
set -uo pipefail

log="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/canvas-check.XXXXXX")"
if "$@" 2>&1 | tee "$log"; then
  exit 0
fi

# Keep the failure visible in check annotations as well as authenticated job logs.
details="$(tail -n 80 "$log")"
details="${details//'%'/'%25'}"
details="${details//$'\r'/'%0D'}"
details="${details//$'\n'/'%0A'}"
printf '::error title=Check failed::%s\n' "$details"
exit 1
