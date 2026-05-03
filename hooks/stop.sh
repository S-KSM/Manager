#!/usr/bin/env sh
# Manager hook: Stop. Session ended.
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/_common.sh"
manager_post stop
exit 0
