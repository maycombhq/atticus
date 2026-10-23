# 0111. Checks that tie each value to its source (C5, C6, stage files)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0074 (every fact cites its code), 0075 (scan settings), 0083 (the knowledge scan), 0087 (flow deltas), 0095 (target flows beside today's), 0101 (what a change needs), 0103 (quotes forgiven only what a model adds)

## Context

Atticus checks that an anchor is real: a cited line exists, a quote is on its page word for word, an id is in the catalog. It did not check that the value written beside the anchor is what the anchor says. A knowledge item could quote one true sentence and carry a lead time from another section. A need could quote "the". A scan settings file could exclude `src/**` citing any line, or set a prefix that differs from the value it cites. An empty survey answer, the cheapest one, always passed. A call-out could name an endpoint the callee doesn't have. A target flow addressed today's steps by position, so a spec drafted again silently re-targeted it. A critic finding passed with a line number and no quote.

## Decision

Every value a step writes is tied to the words it cites, by a deterministic check. What fails goes back to the model as a problem, like the existing quote checks.

1. **Knowledge items (scan and find).** Text is folded to tokens: lower case; runs of letters or digits; an ordinal is its number; the number words zero to twenty, the tens to ninety, and a tens-unit pair ("twenty-one") are digits; minute, hour, day, week, month and year lose a plural "s". Nothing else is forgiven: "working days" is not "business days", and "days" is not "working days". Then:
   - `lead_time`: each token, apart from filler words (a, the, within, about, up to, at least, allow and the like), is in one of the item's quotes (its source quote and its `also_on` quotes).
   - `handled_by`, `owned_by`: the name's tokens are a run in one quote, or the name is the page's own front-matter `owner`.
   - `dates`: each `YYYY-MM-DD` is in a quote as written, or as its day, month name (or its first three letters) and year in any order.
   - `status`: a quote holds a word for it: mandated (must, shall, required, mandatory, always, only, every), banned (banned, never, must not, may not, cannot, not allowed, prohibited, do not, no), retiring (retiring, deprecated, sunset, decommissioned, switched off, phased out, end of life, withdrawn, replaced).
   - `rules`, `applies_when`, `inputs`, `steps` are the model's summary, so their words aren't checked; each number they state is on one of the item's pages.
     When the sentence that states a value isn't the source quote, the model adds it under `also_on`, which may name the same page. The bench reference does this for its three lead times stated in their own section.
2. **Needs.** A need's `because` quote has at least 12 letters and at least one word of three or more letters that isn't a stop word. Its `when` is worked out from the item's lead time where it reads as a duration: 20 working days or more is needed before design, 5 or more before build, less before release (a week is 5 working days, a month 21, calendar days count five in seven). Without one, the model's word stands. The stories stage's requests get the same.
3. **Scan settings** (checked whenever settings are read: the survey, scan verify's fixes and every scan):
   - An exclude's cited file is inside the excluded paths, or its cited line names the folder (the glob's longest literal segment).
   - An exclude is refused when it leaves out more than half the repo's code files (by extension, build output aside), or every code file of the repo's main source folder (the one top-level folder holding more code than any other), unless the cited file is a build or config file (by extension or name) whose cited line names the folder.
   - A prefix is the value on its line with one slash in front and none at the end, a URL's path, or a placeholder's default (`${NAME:/default}`).
   - An answer with every list empty and no question passes only when the built-in readers find no entry point and no call without a host, or when it says why under `nothing_to_set` with the lines read for it, each checked to exist. `nothing_to_set` is part of the survey's answer, not of the settings file.
4. **Target flows.** A call's `to.entry` is resolved against the catalog's endpoints of the target component (or of every component of a target system), when the catalog has any: an entry without `new` must exist; `new: true` on an entry that exists is refused. `store.new` on a table the catalog has is refused. A read or lookup names columns the table has, or that a write in the same change adds with a type. Each target-flow file records `base.steps`, the sha-256 of today's flow's steps (kind, what, to, store, in order; citations left out), when Atticus writes it; the assistant never sets it. The merge says "today's flow changed since this target was written" when it differs, and the stage's check blocks such a delta. The flow delta gets its own version, `FLOW_DELTA_SCHEMA_VERSION` 2; version 1 files still read, carry no base and are flagged as not pinned. The other stage files stay at version 1; they didn't change.
5. **Critic evidence.** An evidence entry needs a quote of at least 12 characters on the line it cites; a quote on another line counts only when it is on exactly one line of the file. A line number alone no longer passes. The prompt already asked for the quote, so recordings are unchanged.

## Consequences

- A value a model brings from another section, page or its own knowledge goes back with the words to quote. Lead times, owners, dates and statuses in the catalog of knowledge each rest on quoted words.
- The rules are exact on purpose; a page that states a value in words the folding doesn't cover ("a fortnight") needs the model to quote it as written. That is handed back, never guessed.
- `nothing_to_set` is a claim with lines, not a proof: a person still reads the survey's pull request.
- A merge still draws a stale target flow (so the picture shows), with the problem beside it; re-running the architecture stage re-pins it.
- The thresholds (half the code, 20 and 5 working days) are constants in the code for now; moving them to the org pack is a C6 change for a later ADR.

## Addendum (2026-10-23): what a live run with Copilot found

A small change on NadiEngine ("show when a chat was last renamed") was planned through the fast path with Copilot's GPT-4o mini, the weakest model a Copilot user may have. Its first plan passed every check and was wrong: it returned a renamed time it never stored. What changed:

- **Checks that catch what was left out.** A field a changed step newly returns must come from a step of the flow (received, read, written, sent, worked out, or returned by a call or lookup) or be a column of a table the flow uses (`delta.field-from-nowhere`). A write that sends a field it stores in no column is handed back (`delta.sent-not-stored`). A read, lookup or write names its table under `store`, never a component under `to` (`delta.to-on-store-step`).
- **Values checked against the catalog and the org pack.** A column added in other casing than the table's own (`updatedAt` for `updated_at`, `delta.column-name`); a classification that isn't one of the org pack's levels (`delta.bad-classification`); a migration named as the store's Flyway migrations aren't, with the next number given (`delta.bad-migration`).
- **Hand-backs a small model can act on.** An endpoint named as a flow is told the flow it starts; a table named as a component is told the `store` form; an entry written `METHOD /path` is told to write the method; the entries listed are the nearest to the path written, not the first eight. The prompts show a concrete `GET /orders/{id}` and say which steps take `to` and which `store`.
- **No rewriting of a draft.** A citation of a data block (`atticus-data:brief.md:5`) is read as that block's file, since the id is Atticus's own. Every other mistake is handed back for the model to fix: a first version that rewrote drafts to what Atticus thought they meant (a table under `to`, an endpoint as a flow, a column's casing, one classification level for every column) was taken out the same night. Judgments about meaning belong to the model, checked against the catalog, not to patterns in code (the product owner's direction; a judge step and stored judgments come next).
- **Questions only a person can answer.** A draft's question that cites no file and line is left out, and said. A reference error (a read of a flow that isn't there, something marked new that exists, the wrong repo, a missing type, migration or columns) is the draft's to fix, never a person's question. A column's classification is a person's decision: the question asks it plainly ("How is the new column renamedAt of nadiengine-db.chat classified?") with the org pack's levels as its choices. Each question is filed under its own repo.
- **A lost hand-off.** A stage run again while its run waits offers that run again (`--handoff` names it); a stage whose waiting run is gone drafts again, and one whose answer was checked but never read in reads it in.

The first plan's gap is the kind every model makes; a stronger model is held to the same checks and needs fewer rounds.
