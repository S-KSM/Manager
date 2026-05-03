#!/usr/bin/env sh
# Manager hook: UserPromptSubmit. v0 just notifies the daemon; v0.5 will also
# drain the intervention queue and prepend pending nudges/redirects/rollbacks
# to the next turn.
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/_common.sh"
manager_post user-prompt-submit
exit 0
