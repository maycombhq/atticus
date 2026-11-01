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

### 2. The same on Map › Trust (C4 2.34.0, additive)

`GET /api/trust/fresh` answers the same view (`Api.FreshView`). The Trust tab gains a Freshness section above the repos: the repos that moved, most stale first, as a table (repo, state, facts at, clone at, files cited that changed, facts to read again, carried, and the command and slash command to copy), with the fresh repos counted and the unread ones left to Home and `atticus next`. Empty, loading and error states as every section has.

This is the first app route that runs git. It is allowed because it is the same read-only query `atticus verify` runs (`git diff --name-status` between two commits in a local clone, and nothing else): no network, no write, no command a person didn't ask for beyond opening the tab. `GET /api/trust` itself still runs nothing.

### 3. The onboarding queue: callees and gateways first

`atticus next` offers the repos not mapped yet in the onboarding queue's order (`onboardingQueue`, cli `onboarding-queue.ts`), which rests on what the files say, and says so per repo:

1. **started**: a read under way (facts on file, or parts of its read plan done) is finished first;
2. **called**: the estate join (`joinFacts`, the same rules as `atticus join`) is run over every facts file on file, with the repos not read as ends that have no entries yet; a call it leaves waiting on one of them (naming its repo or component, or a host and base path its manifest lists) counts that repo as called by the calling repo. The repos called by the most read repos come first, a gateway first among the same;
3. **gateway**: a repo whose manifest type is a gateway (`gateway`, `gateway-external`, `gateway-internal`), so the calls through it join once it is read;
4. **next**: the rest, in the manifests' order.

The facts are read whether or not they are verified: this ranks the queue and writes nothing. The map step's why says a called repo's callers or a gateway's role, and the estimated cost when the read plan has one. `atticus next --queue [--json]` prints the whole queue, each repo with its reason and cost, then the repos read with what each took.

**A mapped repo is never offered again unless it is stale.** `atticus next` took a repo for mapped only when its spec header's template was `facts@1`; a header an earlier `spec draft` left keeps its own template through `verify --write`, so a mapped repo was offered `atticus verify <repo> --write` (or the reader path) for ever. A repo is now mapped when the catalog holds records from its facts too (`catalogSources`, the count the Trust tab shows). A mapped repo whose clone has moved past its facts' commit (the verifier's report against the clone's HEAD, read from its `.git` files) gets one `reread` step: `atticus map <repo>`, pointing to `atticus estate fresh` for the count.

### 4. What a read cost, recorded honestly (read plan schema 2)

The reader runs in the person's assistant (Copilot agent mode, Claude Code), so Atticus can't meter its tokens. The read plan (`facts/<repo>.read-plan.yaml`, addendum A-ledger) records what Atticus can know, each kept apart and said for what it is:

- `estimate` (written by `--estimate` for every repo, one session or many): the source files and tokens of the read as counted from the source (`estimateTokens`, an estimate), the sessions planned (the parts, or one), and `reread: true` when the read is of the changed files only. A repo one session reads now has a plan with no parts: it has no ledger, and `atticus next` and `--estimate` say nothing of parts for it, as before.
- `parts[].read` and `read`: when `atticus verify` first found a part (or, for one session, the read's kept facts) accounted for in the facts, and at which commit; `read.sessions` is the parts it took as planned. A stamp is never moved; a plan of another commit is not stamped.
- `reported`: what the reader or the person says the read took, `atticus map <repo> --spent <tokens> [--sessions n] [--part n]`, each with when, the plan's commit and `--by`. Never summed with the estimate; a re-plan keeps them under the commit they were of.

`readCostOf` sums them and `readCostWords` says them: "estimated about 90K tokens in 2 sessions; 1 of 2 parts read; reported 84K tokens in 2 sessions".

**The schema goes to 2, with a migration.** The plan is a facts companion Atticus writes (A-ledger), not one of C1 to C6 nor the facts file, but its parser is strict, so an older Atticus would refuse a file with the new fields. `schemaVersion: 2` says so, `migrateReadPlan` reads a v1 file as v2 with nothing recorded, and the next `--estimate` writes it as v2 keeping its parts, numbering and `plannedAt`. The `/atticus-map` steps are unchanged: recording a report is a command a person or the assistant may run, never a step the reading rules require.

## Consequences

- The estate's freshness is one command and one section, not forty estimates.
- The queue reads callees and gateways first, so fewer calls wait unjoined while the estate is read; a mapped repo is offered again only when it moved.
- Every estimated repo has its estimate on file, every read its stamps, and what the reader reports sits beside them; nothing is presented as metered.
- Contracts: C4 goes to 2.34.0 (additive). The read plan, an Atticus-written companion, goes to schema 2 with a migration. C1 to C3, C5, C6 and the facts file are unchanged.
