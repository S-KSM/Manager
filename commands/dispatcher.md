---
description: Open this workstream in the Dispatch app's Radar.
---

Derive the current workstream id and open Dispatch.

Steps:
1. If the user passed text after `/dispatcher`, treat as the workstream id verbatim.
   Otherwise, derive the slug:
   - If inside a git repo: `basename "$(git rev-parse --show-toplevel)"`, lowercased,
     non-`[a-z0-9-]` → `-`, collapse repeats, trim leading/trailing `-`. Empty → `default`.
   - Else: same transform on `basename "$PWD"`.
2. Run: `open "dispatch://workstream/<slug>"`
3. Report the URL you opened.

This matches the slugifier in `hooks/_common.sh:dispatch__slugify`.
