# AI first: a plan (draft for the owner, not decided)

Status: a proposal, 2026-11-24. Nothing here is built. It changes hard rule 4 of `CLAUDE.md`
("no scanner is generated") and so needs one ADR before any code.

## Why

Two days on the owner's estate with beta.31 and beta.32: every step tried met a refusal or a
join that didn't draw, and each was answered with more code. The numbers on main today:

| What                                              | Lines of source |
| ------------------------------------------------- | --------------- |
| All packages                                      | about 458,000   |
| `packages/extractors` (the deterministic readers) | 24,187          |
| The estate join (`core/src/facts-join*.ts`)       | 5,424 (frozen)  |
| `packages/verify` (checks a claim on its line)    | 11,722          |

Lines in `packages/*/src` that speak of refusing: 1,349. `return 1` in `packages/cli/src`: 249.

The verifier is the one deterministic part that earns its place: it is what lets a person trust
what a model wrote. The rest of the deterministic path is where the bugs and the blocks are.

## The idea in four rules

1. **The model reads and the model joins.** A box-to-box arrow is a claim like any other fact:
   the model says "this call in A reaches this entry in B" and cites the line on both sides. The
   verifier checks both lines. No host tables, no path matching in code. The frozen join stays
   as a free first pass until rule 2 covers what it covers, then it is deleted.
2. **A recipe per kind of repo, written by the model, that gets better.** The first repo of a
   kind (a gateway proxy, an integration module, a Spring service) is read by the model. From
   that read it writes a recipe: where this kind of repo keeps its entries, calls and config.
   The next repo of the kind is read with the recipe: no tokens where the recipe is enough, the
   model only for what it leaves over. A recipe that misses is corrected by the model from the
   miss, re-proven on the repos it already read, and replaced. This is ADR 0208's reading rules
   and Learn carried one step further, not a new subsystem. A recipe is data run by one small
   engine, never generated code run on the machine.
3. **Nothing blocks but a safety rule.** Hard rule 6 stays as it is. Every other refusal becomes
   "write what holds, list what doesn't": an unknown field is dropped and noted, an upgrade owed
   is run as part of the write (one undo), a fact that fails its line is left out and listed, a
   hand edit is kept. One list of open items, worked when the person chooses. The model for
   this is OpenSpec's: files, an advisory check, no gates.
4. **Each release is smaller than the last.** The size budget turns from "+3,500" to "below the
   last release". The extractors stop running by default in the first release and are deleted
   once recipes cover the owner's estate.

## What stays

Facts with file, line, value and quote. The verifier. Results stored per commit. The catalog
contract C1. Provenance on every fact. A person approves every write to a shared system. No
network but the model provider.

## The risk that decides it: tokens

The owner's monthly assistant quota ran out on 2026-11-24, mid-fix. AI first reads more with a
model, not less, unless rule 2 works. So rule 2 is proven first, on public code, before
anything is built on it.

## Gates

| Gate | What                                                                                                                                                                           | Passes when                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| A    | On `fixtures/oss-estate` and a Forge fixture shaped like the arrow that wouldn't draw (a gateway proxy in front of an integration module): the model pairs, citing both sides. | It draws the 31 true arrows at least as well as the join does, and the fixture's arrow, with no false arrow verified. |
| B    | Recipes: read the first repo of a kind with the model, the second with its recipe.                                                                                             | The second repo costs under a fifth of the first's tokens, for the same verified facts.                               |
| C    | Count what an Apply on the owner's estate would cost a month at gate B's rate.                                                                                                 | It fits the owner's quota with half to spare. If not, stop here.                                                      |

Gates A and B need a model key in CI's own sandbox or the owner's own machine at home; they use
no office quota. Nothing below starts until all three pass.

## Then, in order (each a release, each smaller than the last)

1. **Non-blocking writes.** Rule 3 for verify, Apply and the map's Apply. No model needed, so it
   can ship while the quota is out. Mostly deleting refusals.
2. **The model's pairing as a claim** (rule 1), behind the join. One ADR; the pairing fact is an
   additive field on what Match already writes.
3. **Recipes** (rule 2) on reading rules. The same ADR.
4. **Delete:** the extractors off by default, then gone; the join gone once step 2 scores above
   it on the owner's estate.

## Open, for the owner

- Which model runs gates A and B (they must not use the office quota).
- Whether step 1 ships alone as beta.33 while the quota is out. Recommended: yes.

## Not verified yet

- Whether reading rules today can run without a model at all (rule 2 assumes a small engine
  can apply one; to be read in `cli/src/reading-rules.ts` before the ADR).
- How many of the 1,349 refusal lines are safety rules. A count by kind comes before step 1.
