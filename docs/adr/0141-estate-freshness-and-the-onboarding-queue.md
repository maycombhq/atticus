# 0141. The estate's freshness, and the onboarding queue with what each read cost

- Status: accepted (pending review by the product owner)
- Date: 2026-10-31
- Builds on: ADR 0124 (facts the assistant writes; addenda A-incremental, A-ledger, A-big, A-gateway), 0086 (`atticus next`), 0024 (the local API, C4)

## Context

A person who maps about forty repos has two questions Atticus answered only one repo at a time.

**Which maps are out of date?** `atticus map <repo> --estimate` and `atticus verify <repo>` already work out, for one repo, what changed since the commit its facts were read at: the files changed (`git diff --name-status` between two commits the clone has), the facts citing a changed file to read again, and the facts carried as they are (addendum A-incremental). The Trust tab says per repo whether the facts' commit is the checkout's, but not how much reading it again costs, and nothing lists the estate at once. Finding the stale repos meant running `--estimate` forty times.

**Which repo to read next, and what does a read cost?** `atticus next` lists the repos not read in the manifest's order, so a service many others call, or a gateway proxy, was read after its callers, and their calls stayed unjoined until it was. A user also saw it recommend repos already mapped. And nothing recorded what a read took: the read plan (A-ledger) holds each part's estimated tokens, but a repo that fits one session has no plan at all, and the sessions a read took and anything the reader could report were never written down.

## Decision

### 1. `atticus estate fresh`: every repo's freshness at once

`estateFreshness` (cli, `estate-fresh.ts`) takes the per-repo re-read plan (`rereadPlan`, A-incremental) over every repo the manifests list and any the facts folder names. Per repo: the commits its facts were read at, the commit the clone is at (read from its `.git` files), the files changed since that its facts cite, the facts to read again (citing a changed file, or of a commit the clone doesn't have), the facts carried, the source files a re-read opens, and the command to run. A repo is `stale` (facts or source to read again: `atticus map <repo>`, `/atticus-map <repo>`), `unknown-commit` (the clone lacks the facts' commit: `atticus workspace sync`, or read it again whole), `moved` (the clone moved but nothing cited and no source changed: `atticus verify <repo> --write` carries every fact), `no-checkout`, `fresh` or `not-read`. Sorted most stale first: by state, then facts to read again, then files cited that changed.

`atticus estate fresh [--all] [--json]` prints it as a table, with a sentence per repo that moved; `--all` lists the fresh ones too. Clones are compared four at a time; each comparison is one `git diff --name-status` per distinct commit the facts name, so forty repos take seconds.

It reads the local clones only: local git between two commits they already have, never the working tree, never a fetch, never a write. Nothing about a repo's facts changes.

### 2. The same on Map › Trust (C4 2.33.0, additive)

`GET /api/trust/fresh` answers the same view (`Api.FreshView`). The Trust tab gains a Freshness section above the repos: the repos that moved, most stale first, as a table (repo, state, facts at, clone at, files cited that changed, facts to read again, carried, and the command and slash command to copy), with the fresh repos counted and the unread ones left to Home and `atticus next`. Empty, loading and error states as every section has.

This is the first app route that runs git. It is allowed because it is the same read-only query `atticus verify` runs (`git diff --name-status` between two commits in a local clone, and nothing else): no network, no write, no command a person didn't ask for beyond opening the tab. `GET /api/trust` itself still runs nothing.

## Consequences

- The estate's freshness is one command and one section, not forty estimates.
- No contract other than C4 changes: the view is computed from the facts, the clones and the scan settings as they are.
