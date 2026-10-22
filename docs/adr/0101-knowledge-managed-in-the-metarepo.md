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

## Consequences

- An organisation's wikis and docs repos are read straight from git, pinned when it wants them pinned, with the commit each snapshot read.
