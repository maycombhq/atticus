---
id: read-forge-web-ui
name: Read a Forge web UI
description: What to look for when surveying a Forge browser app.
appliesTo:
  repoTypes: [forge-web-ui]
owner: team-platform
source: process/skills/read-forge-web-ui/SKILL.md
status: active
reviewedAt: 2026-10-21
---

1. A Forge web UI serves no HTTP endpoints of its own; it calls its back end with `fetch`.
2. A call to a path starting with `/api` goes to the portal BFF, through the same host.
3. `storybook-static/` is a built component gallery, not the product.
