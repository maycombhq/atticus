# 0102. The app for knowledge and needs: sources, reviews, searches, a change's needs and the org pack from the wikis (C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-22
- Builds on: ADR 0101 (knowledge managed in the metarepo), 0083 (knowledge sources scanned and queryable), 0043 (the app runs the commands' own code), 0073 (the person is the Git user)

## Context

ADR 0101 put the organisation's knowledge in the metarepo: wikis kept in git, people's reviews of what the scan read, rescans, teams, vendors and products, searches of the wikis, a change's needs and the org pack drafted from the wikis. The command line does all of it. The app showed none of it: a person who doesn't live in a terminal could not see what the wikis say, mark it right, or see what their change needs from the organisation.

## Decision

The app shows everything ADR 0101 added and lets a person act on it. Each action runs the same code its command runs, as the person `/api/me` names; nothing new is decided in the app.

### Screens (under More, in the Know group)

- **Knowledge sources** (`#/wikis`): each wiki in `sources.yaml` with its type, location, git ref, folder and checkout, tags and owner, and its newest snapshot (date, pages, age, the commit a git wiki was read at), marked "sync it again" when it is missing or over 14 days old, as `atticus next` says.
  - **Sync** runs `atticus sources sync --source <id>`.
  - **Add a source** is the form `atticus sources add <type> <location> --id --path --ref --submodule --kind --framework --owner --save` takes. With Save (the default) the entry is written into `sources.yaml`, keeping its comments; without it, the entry to add is shown.
  - Reading a source with the AI (`atticus knowledge scan`) needs a model, so the app doesn't run it: it shows the command and `/atticus-knowledge <source>` to copy.
  - **What the last scan changed**: `scan.yaml`'s `changes` (new, changed, gone, each a link to the item), its conflicts, quarantined text and failed items, and the reviews to check again.
- **Knowledge items** (`#/knowledge`): the items as people reviewed them, grouped by kind (requests and processes, standards and patterns, decisions and constraints, teams and vendors, products and projects), with a search and a kind filter. Rejected items are listed, marked, with their reason. Each item shows its fields, its quote, the page, heading and line it was read from, its links, and its review: the tick for verified or corrected (who, when), "check again" when stale, rejected with the reason.
  - **Verify** and **Reject** (the reason is required) run `atticus knowledge verify|reject`.
  - **Correct** offers only the fields the item's record kind allows (`correctableFields`): text as a box, lists as a list of entries, links as label and address. Only the fields the person changed are sent. Correcting an item again keeps what an earlier correction set, unless the person sets that field again; `atticus knowledge correct` (and so the VS Code extension) does the same.
  - Each writes `knowledge/reviews/<id>.yaml` through `reviewItem` and `writeReview`.
- **Search the wikis** (`#/wiki-search`): the plain page search (`searchPages`) runs at once and shows the pages and sections that mention the term or phrase. The AI step that reads them (`atticus knowledge find`) is shown as the command and `/atticus-find <phrase>` to copy. The saved searches list their candidates, new or already known; **Keep** offers the kinds the candidate's record can be and runs `keepCandidate`, making it an item the person verified.
- **Teams, vendors and products** (`#/parties`): the Party and Product items, with what each team owns and uses (from its own page and from the products that name it, by name, id or alias), who owns and uses each product, its vendor, and the other names people use.
- **Org pack from the wikis** (`#/orgpack-draft`): each platform's draft (`proposals/orgpack/<platform>.yaml`), each proposed system marked verified or not. **Draft from the wikis** runs `draftOrgPack`; **Accept the picked systems** runs `acceptOrgPackDraft` with `only`. The verified ones are picked to start with, as the plugin does.

### A change's needs, on the change's page

The Changes page and the Feature design, Stories and Tasks pages show **What this change needs**: `needs.yaml` grouped as `needs.md` is, each need with its lead time, who handles it, its catalogue item, links, rules, steps and why (the quoted words, with file and line), the tick when its item is verified and "not yet verified" otherwise. **Done** (with a note, such as the CTASK number), **Not needed** (the reason is required) and **Reopen** run `markNeed`. Without `needs.yaml`, the panel shows `atticus change needs <id>` and `/atticus-needs <id>` to copy.

### The local API (C4 2.7.0, additive)

| Call                                                          | Runs                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/knowledge/sources`                                  | `sources.yaml`, each source's newest `snapshot.yaml`, `scan.yaml`'s snapshots |
| `POST /api/knowledge/sources`                                 | `sourcesAdd` (`atticus sources add`)                                          |
| `POST /api/knowledge/sources/{sourceId}/sync`                 | `sourcesSync` (`atticus sources sync --source`)                               |
| `GET /api/knowledge/scan`                                     | `scan.yaml` and the stale reviews                                             |
| `GET /api/knowledge/items[?kind&tag]`                         | `readKnowledge`, rejected items included                                      |
| `POST /api/knowledge/items/{itemId}/review`                   | `reviewItem`, `writeReview`                                                   |
| `GET /api/knowledge/search?q[&source]`                        | `searchPages` over the newest snapshots                                       |
| `GET /api/knowledge/finds`, `GET /api/knowledge/finds/{slug}` | `readFinds`, `readFind`                                                       |
| `POST /api/knowledge/finds/{slug}/keep`                       | `keepCandidate`                                                               |
| `GET /api/changes/{changeId}/needs`                           | `readNeeds`, with each item's review                                          |
| `POST /api/changes/{changeId}/needs/{itemId}`                 | `markNeed`                                                                    |
| `GET /api/orgpack/draft`, `POST /api/orgpack/draft`           | the drafts in `proposals/orgpack/`, `draftOrgPack`                            |
| `POST /api/orgpack/draft/{platform}/accept`                   | `acceptOrgPackDraft` with `only`                                              |

The schemas are in `packages/core/src/api.ts` and the committed OpenAPI document. API_VERSION goes from 2.6.0 to 2.7.0: every call and field is new, so every existing client reads the same as before. The routes are in `packages/cli/src/ui-api-knowledge.ts`.

### What doesn't change

- **C1 and C6 are unchanged**: no record kind, field or org-pack schema is new. A review, a kept item, a need's status and an accepted system are the same files the command line writes.
- **The safety rules**: every write is a file in the metarepo the person commits through a pull request; merging it is the approval. The app runs no AI step: the knowledge scan, the AI search and the needs finder are shown as commands and slash commands. Atticus never raises a request for the developer.
- Syncing a git wiki from the app fetches it as the command line does (ADR 0101); nothing in the wiki is run.

## Consequences

- A person sees what the wikis say, marks it right, corrects or rejects it, and keeps what a search found, without a terminal.
- A developer sees on the change's page what the organisation needs from it, with each item's how-to and lead time, and records each need as they raise it.
- The org pack grows from the wikis in the app as it does on the command line.
- Not built: running the AI steps from the app (they need the assistant), editing a source's tags from the app (`atticus sources tag`), and the needs across all changes (`atticus needs --all`) as a page of their own.
