# 0101. Knowledge managed in the metarepo: git wikis, reviews, rescans, teams and vendors, and what a change needs

- Status: accepted (pending review by the product owner)
- Date: 2026-10-22
- Builds on: ADR 0083 (knowledge sources tagged, snapshot, scanned and queryable), 0074 (the AI reads; every fact cites), 0100 (everything from the plugin)

## Context

The metarepo is where an organisation's knowledge is managed for its developers: integration and architecture patterns, standards, how-tos for its processes, the requests a change sets off (a change task, SSO setup and intake, a Kafka topic), the teams, their products and the vendors they use. It is all kept in git and read by agents. ADR 0083 read wiki folders into checked items. What was missing:

- Wikis kept in git (Azure DevOps and GitHub wikis are git repositories, and so are docs repos) could only be read after someone cloned them by hand.
- A person could not mark an item right, or correct its details.
- Every scan read every page again.
- Teams, products and vendors weren't read at all.
- What a change needs from the organisation was suggested only at the stories stage, as text in `requests.md`, and nothing tracked it.

This ADR is built in stages. Each section says whether it is built.

## Decision

### 1. Wikis kept in git (built)

- **`sources.yaml`**: a wiki entry may have `type: git` (C6, additive). Its `location` is the repository: a URL, or a path relative to the org-pack folder. It takes:
  - `ref`: a branch or tag; default the repository's own default branch.
  - `path`: the folder its pages are in; default the whole repository.
  - `checkout`: `clone` (the default) or `submodule`.

  `ref`, `path` and `checkout` are refused on any other type of wiki.

- **`clone`**: `atticus sources sync` clones the repository into the metarepo's local state (`workspace/knowledge/<id>`, git-ignored, as base clones are). On later syncs it fetches the ref and checks it out.
- **`submodule`**: the repository is a submodule of the metarepo at `knowledge/repos/<id>`, added on the first sync. The commit read is then pinned in the metarepo's own history. When a sync moves it, the sync says so, and the person commits the bump through a pull request. A metarepo that isn't a git repository can't have one, and the sync says to use `clone`.
- **Reading the pages**: they are read from the checkout's folder like any Markdown folder. Each is dated by the last commit that touched it, and its version is the commit. The snapshot's `snapshot.yaml` records the `commit`, so the scan says exactly what it read.
- **Running only git**: nothing in the wiki is run. A repository that can't be fetched is reported for that source, and the rest are still read.
- **`atticus sources add git <url|path>`** takes `--id`, `--path`, `--ref`, `--submodule`, `--kind`, `--framework` and `--owner`. **`--save`** (for any type of wiki) writes the entry into `sources.yaml`, keeping its comments, as `sources tag` does: the change is a file, committed through a pull request, and merging it is the approval. Without `--save` it prints the entry, as before.
- **Confluence and SharePoint** still need their API adapter wired to the command line (as ADR 0083 says); an ADO wiki can be read as `git`.

### 2. People review what the scan read (built)

The scan's items are the AI's own, and each scan replaces them. A person's verdict is their own file, `knowledge/reviews/<item>.yaml`, committed with the metarepo, so it survives every rescan. The file holds:

- the verdict;
- who gave it, named as git names them;
- when;
- a note;
- the fields corrected;
- `checked`: a hash of what the item meant when it was checked. This leaves out its evidence and where its quotes were read, since those move when a page is copied again.

The verdicts are:

- **`atticus knowledge verify <item>`**: the item is right as read.
- **`atticus knowledge correct <item> --set field=value`**: right once corrected. A list field takes `a|b|c`. The fields a person may correct are given per kind:
  - for a request or process: title, applies when, lead time, handled by, catalogue item (a CTASK's form), inputs, steps and notes;
  - for patterns, decisions, teams and products: their own descriptive fields.

  What the page quoted can never be corrected: a quote is checked word for word.

- **`atticus knowledge reject <item> --note why`**: the item is wrong. The reason is required.

Reading the knowledge applies the reviews, so everything that reads items sees the same thing: the stages, `knowledge ask`, `knowledge list`, the plugin and the app.

- A corrected item is read with its corrections. The scan's own record on disk stays as the scan read it.
- A rejected item is left out of what plans and answers read. It is still listed, marked, with its reason.
- When a rescan changes what a reviewed item means, the review is **stale**. Lists show "check again" instead of the tick until a person reviews it again.

`knowledge list` shows "✓ <who>" for verified, "✓ corrected by <who>", "✗ rejected by <who>" and "check again". Its `--json` carries each item's review.

### 3. Rescans (built)

`knowledge/scan.yaml` keeps each page's sha-256 with its snapshot. `atticus knowledge scan` then reads only the pages that changed or are new since the last scan:

- The items of unchanged pages stay as they were.
- The items of a page that is gone are dropped.
- The items read last time from a changed page go to the AI with the page, so an item still there keeps its id. A change to it then shows as a change, not as one item gone and another added.
- The scan says what changed (new, changed, gone, by id), keeps it in `scan.yaml` (`changes`), and names the reviews to check again.
- When nothing changed, nothing is sent to the AI.
- `--full` reads every page again.

A first scan reads everything, so a single scan gives the same organised result as a series of rescans: snapshots, `knowledge/items/<kind>/`, reviews and the report.

### 4. Teams, vendors, products and projects (built)

The scan also reads who and what the pages name. It has four more knowledge kinds:

- **team** and **vendor** are `Party` records (C1, which already had `internal-team` and `vendor`), with new optional fields:
  - `responsibilities`;
  - `owns`: for a team, its products and projects; for a vendor, what it provides;
  - `uses`: the vendors and products it uses;
  - `tags`, `quote` and `alsoOn`.

  A Party is a knowledge item only when a page was read for it; the catalog's own Parties are not.

- **product** and **project** are the new `Product` kind (C1, additive). It has its name, what it is, the team that owns it, the teams that use it, its vendor, the systems it is, and its quote.

These four kinds need no "applies when". The catalog's Systems still come from code and are unchanged. The local API (C4) lists the new kind: API 2.6.0, additive.

### 5. What a change needs (built)

`atticus change needs <change>` is an AI step: AI → check → AI, through the AI runtime. It takes `--mode`, `--resume` and `--handoff`, and Copilot Chat runs it as `/atticus-needs`.

- **What the assistant reads**: the change's files (brief, proposal, feature, design, interfaces, stories, tasks, target flows) and the knowledge items, as people reviewed them, with rejected items left out.
- **What it answers**: which items apply, to what, and why:
  - requests and processes to raise;
  - standards and patterns to follow;
  - decisions and constraints to keep to;
  - teams, vendors and products to involve.

  Each need is for the whole `change`, or a `feature:<id>` or `flow:<id>` (from `feature.yaml` and `target-flows/`), a `story:<id>` (from `stories/`), or a `task:<n.m>` (from `tasks.md`). It quotes the change's own words that call for it, and may say `when`: before design, build or release. Items it considered and left out are listed with why, for a reviewer.

- **What Atticus checks**: the item is a knowledge item and no person rejected it; the target is in the change; the quote is word for word in the file it names. What fails goes back to the assistant, three attempts by default.
- **What it writes**: the change's `needs.yaml` and `needs.md`. Each need carries its item's lead time, who handles it, the catalogue item (a CTASK's form), inputs, steps and rules, as people corrected them, and where it was read. `needs.md` groups them, gives each its how-to, and marks a need whose item a person verified with "✓ verified by <who>".
- **Who acts on it**: a person records each need with `atticus needs done <change> <item> [--note CTASK…]`, `atticus needs skip … --note why` (the reason is required) or `atticus needs reopen …`. That survives every rerun: a rerun replaces only the open needs that came from the same finder.
- **The stories stage** adds its suggested requests to the same list (`from: stories`, for the flow they were matched on), beside `requests.md`.
- **`atticus needs [--change id] [--all] [--json]`** lists them across changes.
- **`atticus next`**: once a change's feature is placed and it has no `needs.yaml`, the next step is `atticus change needs <change>`, early, because a request's lead time runs from the day it is raised. While needs are open, a person's step says how many, naming the one with the longest lead time.
- Nothing is raised for the developer. Atticus suggests; a person raises.

## Consequences

- An organisation's wikis and docs repos are read straight from git, pinned when it wants them pinned, with the commit each snapshot read.
- What the pages say is checked by people where it matters. A correction is what everyone reads from then on, and a tick lasts until the page under it changes.
- A rescan costs only the pages that changed.
- A developer starting a change gets, early, the list of what the organisation needs from it: each item with its how-to, lead time and who to ask, quoting why, marked when a person has verified it.
- C1 now has 33 kinds. As in ADR 0083, every existing record file reads unchanged, so the catalog schema version stays 2 and no migration is needed.
