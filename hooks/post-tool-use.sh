#!/usr/bin/env sh
# Manager hook: PostToolUse. Low-fidelity activity event after a tool call.
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/_common.sh"
manager_post post-tool-use
exit 0
