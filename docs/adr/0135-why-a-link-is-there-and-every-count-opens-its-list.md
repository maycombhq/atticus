# 0135. Why a link is there, every count opens its list, and saying a link is wrong

- Status: accepted (pending review by the product owner)
- Date: 2026-10-31
- Builds on: ADR 0081 (the Architecture workspace), 0124 (facts the assistant writes; addenda C-join, A-gateway, A-callers, D-app, F2), 0024 (the local API, C4)

## Context

The estate canvas draws a line between two services wherever the join tied a call to an entry that serves it. A person looking at a line could see its citations but not why it was drawn: was the callee named by a person, by the call, by a host the manifest lists, or guessed from a path? F2 made a guessed join `inferred` with a flag (`joined-by-path`, `joined-by-label`), but a join nobody had to guess carried no word of how it was made, so the app couldn't tell an answer from a named target from a host from the Interface record.

Each repo on Map › Trust shows counts (facts kept and rejected, files read, not read and excluded, records from facts and from readers), and only the files not read open a list. A person reported a repo that "always shows 1 missing item" with nowhere to see which.

When a line is wrong (the call goes to another repo, to an outside system, or isn't a call at all), the means to say so exist: a correction of the call's fact in the caller's repo's corrections file, which `atticus verify` applies before every check (ADR 0124 addendum D-app). There was no screen for it from the line, and a person's target outside the estate didn't outrank every join rule: a call whose host a repo lists was joined by the host again, and one with no host by its path.

## Decision

### 1. Every Interface says how it was joined (C1 content, no schema change)

`joinRecords` writes one flag on every Interface it makes, from `FactJoin.how`: `joined-by-answer` (a person's answer to a targets question), `joined-by-name` (the call's `to` names the component), `joined-by-repo` (it names the repo), `joined-by-host` (a host the manifest lists). The guesses keep their F2 flags, alone. A publish joined to its listener carries none: its `via` (`event-bus`, `mq`) says it. A gateway join is `via: gateway` with the flag of how its first hop was found.

`flags` is the optional string array every record already has, so C1's schema is unchanged; a catalog written before this reads as `how: unknown` until the caller's repo is verified with `--write` again. `JOIN_HOW_FLAGS` (core) lists the flags that say how and nothing more — these four and A-callers' `declared-caller` — and the hierarchy never counts them as gaps; the guesses still are.

### 2. A graph edge lists its calls (C4 2.32.0, additive)

`HierEdge.joins` (GET /api/graph/node and /api/graph/focus) lists the Interfaces merged into the edge, at most 20 by id (`count` says how many in all), each with `how` (`answer`, `named`, `repo`, `host`, `declared`, `topic`, `path`, `label`, `unknown`), `gateway`, `verified` (the Interface's confidence), method and path, and its cited lines by side: `caller` (the call and the config that ties it), `callee`, `hops` (each gateway hop) and `other` (lines a built-in reader's record doesn't place).

The details panel's link list opens, per link, Why is this linked?: each call with its how in words, verified or inferred, and each line as a citation with Correct this.

### 3. Every count on a repo opens its list (C4 2.32.0, additive)

`TrustRepo.lists` (GET /api/trust) holds what the counts count, each with the action that closes it:

- `rejected`: each rejected fact from `<repo>.rejected.jsonl` — its id, kind, file and line, the verifier's code and message — and every other refused line (a question, a reviewed entry, a line that isn't a fact). Closed by the reader fixing it from the rejected file (`/atticus-map <repo>`) and `atticus verify <repo>`.
- `excluded`: the files excluded by `org-pack/scan/<repo>.yaml` (the first 50). Closed by taking the exclusion out, if it shouldn't be one.
- `asked`: the open questions about the repo with the lines they read. Closed by answering each.
- `unverified`: the facts not checked yet (the first 50). Closed by `atticus verify <repo>`.

Not read (`unknownFiles`) was there already; its action is now said beside it. Kept facts open as the repo's facts with their citations (GET /api/facts/{repo}); the catalog's records open the repo on the estate canvas. Each count is a disclosure with its list; a count of zero says so and opens nothing.

### 4. This link is wrong

From Why is this linked?, each call has This link is wrong, with three choices: it calls another repo or component of the estate, it calls an outside system, or it isn't a call. The app finds the call fact on the caller's cited line in the repo's facts and writes the correction through the existing POST /api/facts/{repo}/corrections: `edit` with `set.to` for the first two, `wrong` with a reason for the third. It then says what `atticus verify <repo> --write` will change (the call moves to the named target; goes outside the estate; or is dropped), shows that command and the git command for the file, and asks for a pull request. It runs neither (build-status B1). When the catalog changes, the panel says what moved: each corrected call's link before and after, or that it is on none.

A target a person set outranks every join rule after an answer: in `joinFacts`, a call fact `by: person` whose `to` names nothing in the estate is outside it: it is never asked about (not even which of several environments' hosts is meant), never joined by its host, a host's label or its path, and the join lists it in `outside` with the person's target, as it lists a person's answer that names a vendor. A `to` that names a repo or component is joined by that name, as before, ahead of the host.

## Consequences

- Catalogs written from facts gain one flag per Interface the next time a repo is verified with `--write`; the golden estate gained two. Nothing reads these flags as a gap.
- C4 goes to 2.32.0, additive only.
- An assistant-written call whose `to` names a vendor and whose host a repo lists is unchanged (joined by host); only a person's word outranks the host.
