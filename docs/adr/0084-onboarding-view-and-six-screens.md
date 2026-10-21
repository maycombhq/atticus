# 0084. The onboarding view, and the app's six screens (C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0015 (local API), ADR 0075 (scan settings per repo), ADR 0078 (questions as files)

## Context

The revamp plan (4.5, Phase 4 item B1) cuts the app's menu to six screens that follow the work: Dashboard, Onboarding, Feature design, Architecture, Stories and Tasks. Every other page stays under More until it is reviewed. Each page shows the command to run next and, where one exists, the slash command to type in Copilot Chat (principle 8). The app shows commands; it never runs them.

Onboarding and the Dashboard need, per repo: the manifest that lists it, whether its base clone is there, whether it has scan settings (`org-pack/scan/<repo>.yaml`) and what the last scan wrote for it. They also need the knowledge sources in `sources.yaml`. `GET /api/repos` gives the manifest entry and the clone; nothing gives the rest, and `/api/view/sources` runs `atticus sources sync`, which reads every wiki.

## Decision

A new read-only call, `GET /api/onboarding` (schema `OnboardingView`, API version 2.2.0). It reads files only and runs nothing:

- `manifests`: each `org-pack/profiles/<platform>/repos.manifest.yaml`, with its repo count.
- `repos`: each manifest repo's id, platform, type, owner and manifest file; `cloned` (the base clone has a `.git`); `scanSettings` (the path, and whether the file is there); `lastScan`, counted from `catalog/generated`. A record counts once for each repo its evidence cites, by kind, with the newest `scannedAt` and its commit. It is null when no record cites the repo.
- `sources`: `sources.yaml` as written: its wikis and absorbed repos.
- `catalog.records` and `problems`: a manifest, `sources.yaml` or catalog file that can't be read is named as a problem, and the call still answers.

The matched repo type isn't in the view. Matching reads the whole clone (ADR 0077), which is too slow for every page load. The page shows `atticus repo-type detect <repo>` instead.

The app's menu shows the six screens, then a More button (`aria-expanded`, keyboard operable). More opens every earlier page in its old group. More is open whenever the current page is one of its pages. No page is removed and no route changes. `#/` now opens the Dashboard; the Command center is still at `#/home`.

## Consequences

- C4 gains one call; nothing existing changes, so no migration. `docs/api/openapi.json` is regenerated.
- Feature design, Stories and Tasks use the existing change calls for now. They become the stage screens of plan 4.4 when the stage loops land.
- Slash commands are shown only where `atticus assistant-files` writes one today: `/atticus-ask`, `/atticus-impact`, `/atticus-critic`, `/atticus-plan`, `/atticus-snow`, `/atticus-release` (metarepo) and `/atticus-task` (code repo). The step commands of plan 4.8 (`/atticus-onboard`, `/atticus-scan`, `/atticus-spec` and the rest) don't exist yet, and the page says so.
- The server doesn't watch files. A page reloads its data on the live `file.changed` events the API's own writes send; a command run in a terminal shows after a page reload.
