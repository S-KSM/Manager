#!/usr/bin/env sh
# Manager hook: PreToolUse. Low-fidelity activity event before a tool call.
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/_common.sh"
manager_post pre-tool-use
exit 0
