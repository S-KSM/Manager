#!/usr/bin/env sh
# Dispatch hook: Stop. Session ended.
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/_common.sh"
dispatch_post stop
exit 0
