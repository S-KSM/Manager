#!/usr/bin/env sh
# Manager hook: SessionStart.
# Notifies the daemon that a Claude Code session attached to a workstream.
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/_common.sh"
manager_post session-start
exit 0
