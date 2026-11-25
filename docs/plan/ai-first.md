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
| 7   | **The deterministic readers off by default.** A repo is read by its recipe or the model. The package stays one more release, then is deleted (24,187 lines); the join is deleted when item 4 scores above it on the fixture and the public estates.                                                                                                                                                                                                                                                  | no           | a default        |
| 8   | **Smaller.** The size check turns from "at most 3,500 more" to "no more than the last release".                                                                                                                                                                                                                                                                                                                                                                                                      | no           | a number         |

Items 2, 3, 6, 7 and 8 need no model and are built first. Items 4 and 5 are proven in CI with the
recorded model, and on the fixture and public code with a strong and a small model.

## Reviewed 2026-11-24: what the eight items leave undone

The eight items make the map AI first: reading, pairing and writing. They are not the whole of
what the owner asked for. Measured on main:

| Asked for                    | What the eight items do                                              | What is left                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing blocks at every step | The map's write: four of seven refusals go                           | The change path: `packages/changes` and `packages/planner` speak of refusing in 148 lines, and the naysayers and hand-offs block at their gates. Untouched. |
| Much less code               | About 1,200 lines added; the readers only switched off               | The 24,187 lines of readers and the 5,424 of the join are deleted a release later. beta.33 is at best a little smaller.                                     |
| The ease of OpenSpec         | Nothing                                                              | 286 commands. No single path from a repo to a drawn map.                                                                                                    |
| Efficient                    | A budget for tokens                                                  | The guards' hash (22 s) and the intake (14 s) of each Apply on an estate of 41 repos.                                                                       |
| Proven                       | Public Spring services, read by the model this plan was written with | The gateway shape (item 0's fixture), larger public repos, and a small model as well as a strong one.                                                       |

So four more items, after the eight:

| #   | What                                                                                                                                                                                           | Model needed |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 9   | **The change path doesn't block either.** A count of every gate on the way from a request to merged tasks, each kept (hard rule 6) or turned into a listed item. The ADR of item 1 names them. | no           |
| 10  | **One command.** `atticus sync`: read what changed (recipe, then model), verify, write, pair, say what is open. Every other map command keeps working and leaves the first page of help.       | no           |
| 11  | **The two slow steps of an Apply** (the guards' hash and the intake), measured and fixed on the generated 60-repo estate on Windows CI.                                                        | no           |
| 12  | **Delete the readers in this release**, not the next, if the suites hold with them off (item 7). Seven files import them.                                                                      | no           |

Nothing in this plan depends on one user's machine, estate or assistant quota: Atticus is a
product for any estate. Every proof runs on invented fixtures and public code, in CI and a cloud
workspace, with a strong model and the smallest one available. A user's own estate is that
user's acceptance, not a step of this plan.

## Every surface each item changes

An item is not done until every cell of its row is done. Found by search on main; the paths are
under `packages/`. `copy.ts`, the changelog, `docs/build-status.md` and `docs/codebase-map.md`
change with every item and are not repeated.

| #   | Command line                                                                                                                                   | The app (`ui/src`)                                                                                                                                                                                           | VS Code and IntelliJ                                              | Contracts and upgrade                                                                                                                                                                     | Tests and guides                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 2   | `--allow-removals` and `--discard-edits` go from every command, the help and the generated command pages                                       | The confirm steps in `app/upgrade.tsx`, `app/propose.tsx`, `screens/know/Know.tsx`, `screens/setup/CatalogBuild.tsx` go; what was refused is shown as a list with Undo; the "newer Atticus" words in 6 files | The upgrade prompts (4 and 3 files): an upgrade runs in the write | C4: the refusal fields stay in the answers and are no longer set, a minor version; no schema change                                                                                       | 54 test files and 6 guides and journeys name the two flags: each rewritten to the list, none deleted |
| 3   | `atticus impact` and `ask` say the same reason                                                                                                 | `screens/architecture/Connect.tsx`, `EditMap.tsx`, `WhyLinked.tsx`, `links.ts`, `screens/map/Outside.tsx`                                                                                                    | none                                                              | C4: one optional field on the answer                                                                                                                                                      | A journey on item 0's fixture                                                                        |
| 4   | Apply's lines say what was paired and what it cost                                                                                             | `screens/architecture/Match.tsx` stays as the run by hand; `screens/map/Decisions.tsx` and `app/decisions.tsx` show the pairs Apply made                                                                     | The Apply job's lines                                             | `runtime.yaml`: whether Apply pairs (C5, optional, default on where AI is allowed)                                                                                                        | The recorded model in CI; the public estates scored                                                  |
| 5   | `atticus rules` shows a rule's recipe, its proof and what it read; `map --estimate` says which files the recipe reads and which the model does | `screens/map/Decisions.tsx`, `app/decisions.tsx`, `screens/architecture/Connect.tsx`, `ConnectAB.tsx`: a rule's recipe, shown and switched off like any rule                                                 | none                                                              | C6 reading rules schema 3 with a migration; the reader's prompt gains the recipe step, so its hash changes: a top-up under way is carried over, not planned again (the review of beta.32) | Golden files for the engine; the three public services; the org pack guide                           |
| 6   | Every model run's first line; `atticus doctor`                                                                                                 | The run panel's start line; the setting on the setup screen                                                                                                                                                  | The same line in the job                                          | `runtime.yaml`: the budget (C5, optional)                                                                                                                                                 | A run stopped by its budget, in CI                                                                   |
| 7   | `atticus framework`, `dialect` and `onboard` say the readers are off and how to turn them on                                                   | The setup screens that offer them                                                                                                                                                                            | none                                                              | Org pack: one default                                                                                                                                                                     | The suites run with the readers off                                                                  |
| 9   | Each gate's command                                                                                                                            | Each gate's screen: named by the count that opens the item                                                                                                                                                   | The same                                                          | Named by the ADR                                                                                                                                                                          | Each gate's journey                                                                                  |
| 10  | `atticus sync`; the help's first page                                                                                                          | The home page's next step and the map's Apply button run it                                                                                                                                                  | One palette command and one tool-window action                    | The surface count                                                                                                                                                                         | One journey from a new repo to a drawn arrow; the first-run guide                                    |
| 11  | none                                                                                                                                           | none                                                                                                                                                                                                         | none                                                              | none                                                                                                                                                                                      | The speed test's budget                                                                              |
| 12  | `framework`, `dialect`, `onboard` and what else only the readers serve: removed, with their help and pages                                     | Their screens removed                                                                                                                                                                                        | Their commands removed                                            | C2 (dialect rules) is a contract: its removal is in the ADR or item 12 waits                                                                                                              | Their tests removed with them; the surface count falls                                               |

Before the release is cut: a search for every word and flag this plan removes returns nothing in
the app, both editors, the help, the guides (25) and the copy file; every new or changed panel
has its empty, loading and error states; the surface count is run.

What is still not known, said plainly: item 9's list. Nobody has counted the gates of the
change path, so its row above is a promise to count, not a list. Until that count is in this
file, this plan can't claim nothing is left out there.

## The last review before the build (2026-11-24): six corrections

These replace what the tables above say where they differ.

| Found                                                                                           | Now                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keeping a hand edit by itself could turn a change of line endings into a decision on every file | The write goes ahead; the edited text is saved and listed with the one command that makes it a decision. Whether the guard ignores line endings today is not checked yet.                                                                            |
| Writing removals was unsafe: a model can leave a fact out on a second read                      | A fact that still holds on its line is kept when a new read leaves it out; a fact goes only when its line no longer holds. Then the removals guard is not needed.                                                                                    |
| A recipe proven on the repo it was written from proves nothing                                  | Active once it reproduces the model's verified facts of two repos it was not written from. An estate already read has those facts, so proving costs no new read: one session a kind of repo, to write the recipe.                                    |
| Some assistants are billed by the prompt, not the token                                         | Item 6's budget is each user's, in requests or tokens as their provider bills, and a read packs more files into a prompt. How many prompts a repo's read sends today is measured first.                                                              |
| Repo types are detected by the readers package (`scanner/src/repo-types.ts`)                    | Item 12 moves that out first, or waits.                                                                                                                                                                                                              |
| The change path's gates were a promise to count                                                 | Five places decide what blocks: the naysayers' findings at each gate, the plan hand-off's checks, `changes/src/lifecycle.ts`, `planner/src/stages/accept.ts`, `knowledge/src/standard-checks.ts`. The ADR lists every gate. Constitution rules stay. |

The order to build in: 0, 1, 2, 3, 9, 6, 10, 11, 7, then 4, 5, 12, 8.

## Item 0's results (2026-11-24): the gateway shape, a small model, and the cost of a check

Fresh agents with none of the answers, on `fixtures/gateway-shape` and public code. "Small" is
the smallest model available in the workspace. Tokens are each run's report less an empty run's
61,000: rough.

| Run                                                                                                                      | Strong model                                                       | Small model                                        |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------- |
| Gate A: pair the proxy's 5 requests from source (two modules on one path; one target with no host)                       | 5 of 5, the hostless one left unpaired, every line held            | 5 of 5, the same                                   |
| Gate B: a recipe from one module, run on the other                                                                       | Lines right; 1 path wrong (a literal `/accounts` in the template)  | Lines right; 3 paths wrong (the rest path dropped) |
| The misses given back once, with the engine's block scopes added                                                         | 12 of 12 on the unseen module                                      | 12 of 12                                           |
| Check a recipe's output for what it missed, against a full read (`spring-petclinic-rest`, 125 files, 10 facts held back) | Check: about 34,000 tokens, 8 of 10 found. Full read: about 10,000 | not run                                            |

What this decides:

1. **Item 4 stands.** Pairing from source held with the small model on the shape that fails a
   path match.
2. **Item 5 is "recipe first, model on request"** (the fallback the risks named). A check cost
   three times a read and still missed two facts, so no routine model check follows a recipe.
   A repo with an active recipe is read by it alone; the model reads a repo when its type has no
   recipe, when a person asks, or when the join's misses name that repo. The files no rule
   matched are counted and shown, not sent.
3. **A composed value is made only of cited captures.** Both first recipes passed every line
   check with wrong paths; a value built from parts each cited on its line catches all four.
   The engine has no uncited capture: the file-wide `prefix` of the experiment goes, block
   scopes (the nearest match above, cited) replace it.
4. **A recipe is proven on repos it wasn't written from**, against their model-read facts, as
   planned: the line check alone passed both wrong recipes.

Two unknowns closed: the edit guard already hashes text with its line ends as LF
(`scanner/src/build.ts`), so a Windows checkout makes no hand edit; and a read with no model
limit set is cut into prompts of about 12,000 tokens (`EXAMPLE_LIMIT`, `cli/src/map-commands.ts`),
one session each, so item 6's estimate counts sessions, and a larger limit cuts them.

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
