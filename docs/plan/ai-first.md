# AI first: the plan for 2.0.0-beta.33

Status: the plan to build, 2026-11-24. The owner asked for it for "v32"; 2.0.0-beta.32 was
published that morning, so it is the next release. It changes hard rule 4 of `CLAUDE.md` ("no
scanner is generated") and the C6 reading rules, so it starts with one new ADR.

## Why

Two days on the owner's estate with beta.31 and beta.32: each step tried met a refusal or an
arrow that didn't draw, and each was answered with more code. On main: about 458,000 lines of
source, 24,187 of them the deterministic readers (`packages/extractors`), 5,424 the estate join.
The verifier (11,722) is the deterministic part that earns its place: it is why a person can
trust what a model wrote.

## The four rules

1. **The model reads and the model joins.** An arrow is a claim: "this call in A reaches this
   entry in B", citing a line on both sides. The verifier checks both lines.
2. **A recipe per kind of repo, written by the model, that gets better.** The first repo of a
   kind is read by the model, which also writes a recipe. The next repo of the kind is read by
   the recipe, for no tokens. A miss goes back to the model, which corrects the recipe; it is
   proven again on every repo it has read before it replaces the old one. A recipe is data run
   by one small engine, never generated code run on the machine.
3. **Nothing blocks but a safety rule.** A write writes what holds and lists what doesn't.
4. **Each release is smaller than the last.**

## What is already there, and is used as it is

| Need                                    | Already built                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A model's pairing, checked on its lines | Match with Copilot and `decideLinks` (ADR 0178): a proposal that passes the citation check is written as the AI's |
| Rules in layers, reviewed like code     | Reading rules: `org`, `types/<type>`, `repos/<repo>` (ADR 0176)                                                   |
| A rule proven before it is active       | `learned.proof` and Learn from my corrections (ADR 0208)                                                          |
| A fact not written by the model         | `by: "reader"` in the facts file: no change to that contract                                                      |
| A write that leaves out what fails      | verify's partial write (beta.28)                                                                                  |
| Why a call joined nothing               | The join's `misses`, each with its reason                                                                         |
| One undo for a write                    | `atticus catalog undo`                                                                                            |

## Work, in order

Each is its own pull request: fixtures and failing tests first, a separate reviewer, then merged.
Sizes are estimates.

| #   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Model needed | Lines            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------- |
| 0   | **The shape that failed, as a fixture.** Invented Forge repos: a gateway proxy whose target is a named server with no host and a rewritten path, in front of an integration module whose routes sit under a context path, with a second module as a decoy. Gates A and B run on it here before anything below is built on them.                                                                                                                                                                      | here only    | fixtures         |
| 1   | **The ADR.** The four rules; a reading rule's optional `extract` (C6 schema 3, a version 2 file reads as it did); which refusals stay.                                                                                                                                                                                                                                                                                                                                                               | no           | a document       |
| 2   | **Writes that don't block.** Of the build's seven refusals, four go: a hand edit is kept and listed; removals are written and listed (one undo takes them back); an upgrade owed runs inside the write. Three stay: nothing was read, the build is empty, a newer Atticus wrote the files. A fact with a field no Atticus writes is read without the field and listed. `--allow-removals` and `--discard-edits` go.                                                                                  | no           | fewer than today |
| 3   | **Why there is no arrow.** The panel that says "found no call" says which: no call fact in the caller, a call with no host, or no entry with its path, from the join's own misses.                                                                                                                                                                                                                                                                                                                   | no           | about 150        |
| 4   | **The model pairs what is loose, as part of Apply.** After a write, the calls the join left loose go to the model with the candidate repos' entries; a pairing that passes the citation check on both lines is drawn, marked as the AI's, and a person can move it. Stored per commit: a call is paired again only when a file it cites changes. With AI off or the budget spent, the calls stay listed and nothing fails.                                                                           | yes          | about 300        |
| 5   | **Recipes.** One engine in core (the experiment's is 47 lines) applies a rule's `extract`: a file glob, a pattern, the fact's fields, or every leaf key of a YAML file. Its facts are `by: reader` and pass the same verifier. A model read ends by writing or correcting the type's recipe; it is active once it reproduces the verified facts of every repo of the type already read. A repo of a type with an active recipe is read by it, and the model is given only the files no rule matched. | yes          | about 600        |
| 6   | **A budget, said before it is spent.** `runtime.yaml` names how much a run may use; every run that calls the model says first what it will cost and checks that its result can be written (no upgrade owed, no lock, the facts read) before the first request.                                                                                                                                                                                                                                       | no           | about 150        |
| 7   | **The deterministic readers off by default.** A repo is read by its recipe or the model. The package stays one more release, then is deleted (24,187 lines); the join is deleted when item 4 scores above it on the owner's estate.                                                                                                                                                                                                                                                                  | no           | a default        |
| 8   | **Smaller.** The size check turns from "at most 3,500 more" to "no more than the last release".                                                                                                                                                                                                                                                                                                                                                                                                      | no           | a number         |

Items 2, 3, 6, 7 and 8 need no model and are built first. Items 4 and 5 are tested in CI with the
recorded model and on public code here; on the owner's estate they wait for his quota.

## What does not change

Every fact cites file, line, value and quote, and the verifier checks it. Results are stored
per commit. Hard rule 6, whole. C1. A learned rule's proof and its fail-closed checks (ADR
0208). A hand-edited `build.json` that doesn't read still refuses: there is nothing to keep.

## Done when

- On the fixture of item 0: the arrow is drawn with no person's help, and the panel says why
  when the proxy's target is taken away.
- On the public gateway estate: 14 of 14 arrows, none false.
- A second repo of a type is read by its recipe, and the model is asked only about files no
  rule matched.
- An Apply on a metarepo with a hand edit, a removal, an upgrade owed and a made-up field
  writes, lists the four, and one undo takes it back.
- The release has fewer lines of source than beta.32.
- CI on Linux and Windows.

## Risks

- **Tokens.** Gate B's saving is proven only for the recipe's own run. What the model must still
  read to know a recipe missed nothing is measured in item 0, on larger repos; if a second repo
  costs more than half the first, item 5 is cut back to "recipe first, model on request".
- **A recipe that is wrong the same way everywhere.** Its facts pass the verifier line by line,
  but a pattern can cite the wrong line faithfully. So a recipe is proven against a model's read
  of each repo, never against its own output, and the public estates are scored in CI.
- **A removal written that should not have been.** One undo; and the three refusals that stay
  are the ones that guard against a read that failed.
- **One release, eight items.** Each merges on its own; the release is cut when the "done when"
  list holds, with whatever of 4 and 5 is proven.

## First results (2026-11-24, in a cloud workspace, on public code)

The model was a fresh agent each time, with none of the answers in its context. Tokens are what
each run reported less an empty run's 61,000, so they are rough. The scripts are not in the repo
yet: an engine of 47 lines that applies a recipe, and a checker.

| Gate | Run                                                                                                                                                                                                                   | Result                                                                                                                | Tokens (about) |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------- |
| A    | `fixtures/oss-estate`: pair the front end's 31 call facts with the REST API's 37 entry facts, from the facts alone                                                                                                    | 31 of 31 right, none wrong (the join: 31 of 31)                                                                       | 8,000          |
| A    | `spring-petclinic-microservices` at `81152fa`: from source, every request its gateway and front end make that reaches one of three services, through routes that name a service, not a host, and strip two path parts | 14 of 14 true arrows, both ends and the route quoted on their lines, none false. The join was not run on this estate. | 19,000         |
| B    | Read the customers service with the model, and have it write a recipe                                                                                                                                                 | 15 facts, all on their lines; the recipe reproduces all 15                                                            | 10,000         |
| B    | That recipe on the vets and visits services, which its writer never saw                                                                                                                                               | 15 of the 17 facts a separate model read found; none wrong, none extra                                                | 0              |
| B    | The two misses (nested YAML keys) given back to the model                                                                                                                                                             | It replaced four rules with one; then 32 of 32 across the three services                                              | 2,000          |

What this does and doesn't show:

- Pairing by the model, checked on its lines, held on a gateway that routes by name and rewrites
  paths: the shape the join needs a host for.
- A recipe written from one repo read two siblings for no tokens, and the model improved it from
  its misses. The first fix needed one new rule type in the engine (YAML keys, 12 lines, written
  by hand); the recipe change was the model's.
- These are small, tidy Spring services. None makes an outbound call, so the recipe's call rules
  are untested. No gateway-proxy or integration-module repo was read: a Forge fixture of that
  shape is still to be written.
- Gate B's "a fifth of the tokens" is not settled: a recipe run costs nothing, but what a model
  must still read to know a recipe missed nothing was not measured, and repos this small are
  mostly fixed overhead.
- Gate C was not run: it needs the estate's size and the quota's figure.
