# 0185. A stage's critic lenses in one hand-off

- Status: proposed (built from the eighth UX walk, 2026-11-08; for the product owner to accept)
- Date: 2026-11-08
- Builds on: ADR 0014 (C5, the AI runtime and its hand-off), ADR 0115 (a stage's draft is reviewed by the critic's lenses), ADR 0124 addendum, Part 4 (one lens per question), ADR 0086 (`--handoff` and `atticus handoff done`), ADR 0121 addendum (the step's class picks the model)
- Contracts: C5 run record version 5 → 6 (`batch`, `parts`; a version 5 record reads as version 6 without them). C4 local API 2.75.0 → 2.76.0 (`parts`, `batch` on a run). Additive. No catalog, rule, finding or org-pack schema changes.

## Context

The eighth UX walk ran a change through feature design, architecture and stories in hand-off mode, from the app. In that mode the person's own assistant answers each prompt: Prepare, open the run, copy the prompt, paste it, Done, then "Next prompt". Every model call was its own hand-off. A stage round was the draft plus one prompt for each of the critic's AI lenses. The walk counted 4 runs for the feature stage, 5 for architecture and 6 for stories. Most of them were lenses: short reviews of the same draft, each with its own copy, paste and Done.

The lenses don't depend on each other. In model and Copilot modes they already run one after another without a person.

## Decision

1. **One prompt for the lenses that wait together.** When a stage's critic round hands two or more AI lenses to the person's assistant, the hand-off runtime also writes one **batch** run (agent `critic-lenses`, class critic). Its prompt asks for one file, `answers.md` in the batch's run folder, with one section per lens. A section starts with a line that holds only `=== <lens>`, then that lens's answer, exactly as the lens asks for it. Under a short header, the prompt holds each lens's own prompt, whole and in order. A lens's instructions, its rules, its data blocks and the data rule are as they are when the lens is asked alone. A round with one lens waiting gets no batch.
2. **Each lens keeps its own run.** Each lens is still prepared as its own run, with its own `prompt.md`, context pack, manifest and prompt hash. These are the same as before, so recordings and evals keyed by the prompt hash still match. The lens's run record names the batch (`batch`). The batch's record lists its lenses (`parts`: name and run id). The round's `round.yaml` names the batch beside each lens's run. Each lens's run summary in `review/<gate>/<round>/meta/runs/` is written from its own run, and so are its kept prompt and answer. Evals, Runs and audits see one run per lens, as before.
3. **Done checks each section on its own.** `atticus handoff done <batch>` (Done in the app, or the watcher) splits the answer at its `=== <lens>` lines. Text before the first section is left out. It writes each section to that lens's own answer file and checks it with that lens's own check, the one Done gives a lens answered alone: YAML with a findings list. Each lens that passes is read into the round by the critic's parser, with the same evidence bounds.
4. **A partial answer fails only the parts that are out.** A missing section, a section given twice, or a section that fails its check fails that lens's run, with why. The other lenses go in. The batch fails too, and lists each lens that is out. Done on the batch again checks only the lenses still out. A lens can also be answered alone from its own run, as before. The batch passes once every lens is in. An answer with no section of any lens fails the batch and leaves every lens waiting.
5. **The draft's next prompt is the batch.** A stage waits on the batch rather than on its first lens. The draft's Done therefore offers the batch as the next prompt (`next` in `POST /api/runs/{runId}/done`; the `--handoff` JSON's run, with `lenses`). While a lens of the batch is out and the batch hasn't passed, the stage keeps offering the batch. A lens left out of a batch that passed, or one never batched, is offered alone. A stage round in hand-off mode is two pastes: the draft, then all its lenses.
6. **Only a stage's round, and only the hand-off runtime, batch.** A stage's critic round asks for it (`runCritic({ batchLenses: true })`). The critic run on its own (`atticus critic --mode hand-off`, Run the critic in the app) still hands its lenses off one prompt each. The runtime must batch too: the CLI and the app turn it on (`HandoffRuntime({ batch: true })`, from the runtime factory); a runtime built by hand keeps one prompt per lens. Model, headless Claude Code and Copilot modes run each lens themselves, as before. Their prompts are unchanged.
7. **A batch has a size limit.** A batch is made only while its lenses' prompts add up to at most 60,000 tokens (`batchMaxTokens`). Above that, each lens is its own prompt, as before, so a batch never outgrows an assistant's context window.

## Clicks for a stage round in hand-off mode (from the app's Runs page)

| Stage        | Pastes before (draft + lenses) | Pastes after | Moves before\* | Moves after\* |
| ------------ | ------------------------------ | ------------ | -------------- | ------------- |
| Feature      | 4 (1 + 3)                      | 2            | 17             | 9             |
| Architecture | 5 (1 + 4)                      | 2            | 21             | 9             |
| Stories      | 6 (1 + 5)                      | 2            | 25             | 9             |

\* Prepare once, then four moves for each prompt: open it (the first from Prepare, the rest from "Next prompt"), Copy, paste into the assistant, and Done. The walk's counts include one lens per question its gate's AI rules ask, so a stage with fewer AI rules has fewer lenses; after this ADR it is two pastes either way.

## Consequences

- One stage round costs two pastes whatever the number of lenses. The assistant answers several short reviews in one conversation, each from its own instructions and data.
- An assistant that drops or mangles one lens's section costs a Done again on the batch, or that one lens alone. It never costs the others.
- The run record is at version 6. Version 1 to 5 records read as version 6 without `batch` and `parts`. Nothing else reads or writes them.
- Runs lists the batch as one run. Its page lists its lenses, each with a link to its own run and that run's state. A lens's page links back to the batch it was asked in.
- Product owner to decide:
  - whether the batch should be offered again with only the lenses still out, rather than the whole batch prompt as built (today a fixed section is checked alone, but the prompt still lists every lens);
  - whether the critic run on its own (`atticus critic --mode hand-off`, and Run the critic in the app) should batch too; it stays one prompt per lens here, since its `--handoff` flow offers lenses one at a time;
  - whether 60,000 tokens is the right size limit, or it should be an org-pack setting (a C6 change).
