# 0167. A top-up for reading rules added since a read

- Status: accepted (pending review by the product owner)
- Date: 2026-11-02
- Builds on: ADR 0124 (facts the assistant writes; addenda A-lean, A-ledger, A-incremental), 0141 (the estate's freshness, the read plan's ledger), 0157 (a second pass on the gaps), 0161 (the whole estate in one command), 0163 (terms, a call's cited auth and TLS), 0164 (field types, mappings, message types)

## Context

2.0.0-beta.11 added reading rules: a body's fields with their type and whether they are required, envelopes, mappers and gateway reshapes read as mappings, the message type a publish or listener names (ADR 0164), `term` facts with the repo type's notes and a call's cited auth and TLS (ADR 0163). Its release notes told people to run `atticus map --all --stale` so repos read before pick them up. But `--stale` covers only clones that moved past their facts' commit (ADR 0141), so on an estate whose clones hadn't moved every repo was skipped: "nothing to read". Nothing recorded which rules a read was given, so nothing could tell a repo read under older rules from one read under these, and the only way to give it the new rules was to read it whole again.

## Decision

### 1. A read records the rules it was given

The read plan (`facts/<repo>.read-plan.yaml`, ADR 0124 A-ledger, 0141) gains an optional `rules`: the sha256 of FACT_RULES (`FACT_RULES_HASH`, the hash `packages/assistant-files/test/map.test.ts` pins) and the **rule sets** it carried. A rule set is a coarse tag on the rule parts (`RulePart.set`, `RULE_SETS` in @maycombhq/assistant-files) a read made without can be topped up with: `field-types`, `mappings`, `message-types`, `terms`, `call-auth` so far. Tagging changed no word of the rules; the hash is the same.

- `atticus map <repo> --estimate` records the rules now for a first read (no facts yet); a re-read (only what changed) and a plan made again over facts already read keep what the plan on file records.
- A batched read (`atticus map <repo>` on a runtime) that finishes with nothing rejected records the rules now, unless it was a re-read.
- A plan with no `rules` was read before 2.0.0-beta.12: it is taken to lack the sets beta.11 added (`UNRECORDED_LACKS`), which are all the sets so far.

What a read lacks (`rulesLacking`) is nothing when its hash is the hash now; else the sets now that its record doesn't list. A change of words alone (another hash, every set listed) lacks nothing: rewording a rule is no reason to read an estate again. A rule part a read made without should be read again for gets a set of its own.

The read plan is the CLI's own file, not a contract; both fields are optional, and an older plan reads as before.

### 2. A state of its own: `rules-changed`

`atticus estate fresh` gives a repo whose facts are all of its clone's commit, but whose read lacks a set, the state `rules-changed` (after `moved`, before `no-checkout`), with `rulesLacking`, the command `atticus map <repo> --rules` and the slash command `/atticus-map <repo> --rules`. `atticus next` gives it a step `rules` (an AI step of class `read`), and `atticus doctor --counts` counts it among the states (counts only, nothing named).

The local API's GET /api/trust/fresh keeps its states as they are (2.34.0): there a `rules-changed` repo is `fresh`, which is what its commit says. No API version is bumped; the app showing the rules state is left for later.

### 3. The top-up

`atticus map --all --stale` and plain `atticus map --all` plan a `rules` item for each `rules-changed` repo (a read still under way is carried on instead). It is not a whole read. Like the gaps pass (ADR 0157), it is a fresh session per part, each given:

- **only the rule parts the read lacked**: the core (shape, ids, citation, references, secrets, questions, data-not-instructions) and the parts of its sets (`factRulesFor(kinds, frameworks, sets)`), with what a field fact belongs to carried beside the sets that write fields;
- **the files those rules apply to**, chosen by what the batch planner already gives a path, never a parser: the file's kinds (`fileKinds`) and reading rank (`readingRank`: 1 config, 2 entry points, 3 boundaries such as DTOs, models, mappers, clients, publishers and contract files), and the kinds of fact citing it. Field types and message types: entry points and boundaries of code, any code file a route, call or field fact cites, and contract files. Mappings: a gateway's files. Terms: settings, deploy and gateway files that aren't code. A call's auth and TLS: clients and settings in code, any file a call fact cites, settings and gateway files. Tests never;
- **the facts already kept, by id** (those citing the session's files), with "don't write them again": a fact the new rules add to (a field's type, a call's `auth`) is written again whole under its id;
- sized to the session (`sessionTokensFor` at the limit), a file bigger than one in line ranges.

Under Copilot the line is `/atticus-map <repo> --rules`, which runs `atticus map <repo> --rules`: the next session's prompt is written beside the facts as `<repo>.rules.md` (paths, facts' ids and the org notes in `<atticus-data>` blocks), and the session is stamped `given` in the plan's `topUp`. In model mode, `atticus map <repo> --rules` on a runtime reads the same files in batches whose prompts carry only those sets (`mapBatchInstructions({ sets })`, which says it is a top-up). `map --all` saves the top-up's plan at its limit before it gives the first line, so the session the reader gets is the part it waits for; it resumes as the rest of `map --all` does, read back from the plan.

### 4. Done once verified

`atticus verify <repo>` that passes at the top-up's commit marks the sessions given before it done; after the last, the read records the rules now (`rules`) and the top-up (`topUp`) is gone, and the repo is fresh again. A clone that moved past its facts is re-read first (`stale`, as before); the re-read keeps the record, so a repo read before beta.12 is then `rules-changed` and topped up.

## Consequences

- The beta.11 release note's command does what it said, and an estate isn't read whole again for five rule parts.
- The next release that adds a rule part a read should be topped up for tags it with a set; one that only rewords leaves reads alone.
- A verify run by hand after a top-up session was given, without the reader having read it, marks it done: the session is the reader's, and the stamp is in the plan for a person to see.
- The app's freshness page still says `fresh` for a `rules-changed` repo; the CLI, `next` and `doctor --counts` say more.
