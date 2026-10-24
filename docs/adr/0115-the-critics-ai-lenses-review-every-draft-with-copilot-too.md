# 0115. The critic's AI lenses review every draft, with Copilot too

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0074 (AI → deterministic → AI), 0086 (`--handoff`), 0087 (the stages as loops), 0090 (the VS Code runner and `--handoff --json`), 0106 addendum (the critic's lenses handed off one at a time), 0113 (the fast path)

## Context

Each stage (feature, architecture, stories, and the small-change fast path) drafts through the AI runtime, checks the draft with its own rules and runs a critic round on every draft (ADR 0087). With a model runtime the round runs the critic's AI lenses too. In hand-off mode, which is how the VS Code extension runs every AI step with Copilot (`atticus <step> --handoff --json`, one prompt per round), the round ran its rules only. Its lenses were recorded as not run (`lenses: []` in `review/<gate>/<n>/meta/round.yaml`) with a note sending the person to `/atticus-critic`. So with Copilot no model ever reviewed a draft. The scan's second AI pass (rule 4) was missing from the stages.

A live run on a real metarepo showed what that costs. A feature placement for "mute a room" marked the post-message flow as only read, although nothing in the estate sends notifications. No rule can catch that. It takes a reading of the draft against the estate and the brief, which is the architecture or business lens's job.

The lenses also didn't see the draft. The critic reads the change folder's artifacts (brief, proposal, design and so on). `feature.md`, `feature.yaml` and `target-flows/` aren't artifacts, so a define-gate lens reviewed the brief and not the placement drafted from it.

## Decision

1. **Hand-off lenses are further hand-offs of the stage.** The stage loop gives the critic the stage's own runtime for its lenses, hand-off included (`criticRuntime: null` still means rules only). When the round's lenses go to the person's assistant, the stage's step ends in state `waiting` on the first lens's run, with its prompt and result file (`findings-<lens>.yaml` in the run's folder). After `atticus handoff done <run>`, which reads that lens into the round as it does for `atticus critic`, the stage's resume offers the next lens still out, oldest first. When every lens is in, the round's open blocking findings join what the stage's checks and the critic's rules found in that draft. They then follow the loop's usual rules: a blocking finding goes back with the next draft, a repeat or a flip becomes a question (ADR 0087), and the critic's knowledge gaps become questions as they do now. The loop keeps the waiting draft in `stage/<stage>.yaml` (`review`: the gate, round, the draft's run and files, and what it had found), so a resume picks up where it was. A lens answer that `handoff done` validated but didn't read in is read in by the resume.
2. **The lenses review the draft against the estate and the brief.** The critic takes the stage's draft (`review` in `runCritic`): the files the stage wrote (`feature.md`, `feature.yaml`, `target-flows/<flow>.yaml`, and the artifacts it writes) join each lens's documents, which it may cite as it cites the artifacts, and the estate the drafter read joins as data, below the artifacts. Each lens prompt says it reviews the draft against the estate and the brief, including what the draft left out. A finding must still name a rule the lens was given and quote the line it cites (ADR 0111). `completeLensRun` reads a draft file it cites from the change folder.
3. **Bounded as before.** Which lenses run at which gate comes from the org pack: the gate's checklists, the change type's lenses and each rule's artifacts. A gate with no AI rule offers no lens. The stage's loop rules still apply, and so do the gate's round limit and the AI-off setting (`runtime.yaml ai: off` records the lenses as not run). Lenses run only on a draft that passed the stage's checks. A draft with a blocking finding of its own goes back to the assistant first, with its lenses recorded as skipped.
4. **The protocol.** `--handoff --json` adds `lens` to a hand-off that is one of the critic's lenses. For the stage steps, as for `critic`, a resume whose run was read in offers the change's next waiting lens run. The VS Code runner follows `resumeArgs` as before. A lens's first offer doesn't count toward its hand-off limit (eight by default), because the limit bounds drafts and each draft brings a lens or two. A lens offered again (its answer didn't pass) does count, so a lens can't loop for ever. Without `--json`, the stage says which lens it handed off.

## Consequences

- With Copilot, every draft that passes the rules is reviewed by a model before the next draft or the stage's PR. The loop is AI → deterministic → AI again.
- Each lens is one more prompt per draft. With the default feature type and an org pack with AI rules at every lens, that is up to six. Each lens prompt carries the draft and the estate, so it is bigger than a critic lens's prompt on artifacts alone.
- No contract changes: the C3 finding and the round meta keep their shapes (a lens's `artifacts` may now name a draft file), C5 is unchanged, and `stage/<stage>.yaml` gains an optional field (no version bump). The `--handoff --json` output gains an optional field.
- Not built: a lens that judges a draft without an AI rule in the org pack (the built-in constitution has only deterministic rules, so a pack with no AI rule gets no lens review; changed by ADR 0120: every new metarepo gets a starter review of AI rules), and the IntelliJ plugin, which runs no hand-off loop of its own.

## Addendum (2026-10-23): what an adversarial review found

An adversarial review of the loop found these failures. The fixes keep the decision above. They make each failure fail closed, and they carry the step's facts as data.

1. **A lens that didn't review is not a review.** A lens answer without a `findings` list (empty, a refusal, prose) fails `handoff done` (`yamlAnswerProblems`), and is offered again. In model mode `parseLensOutput` returns `malformed` and the lens is recorded `failed`. A failed lens in the newest round of a gate is a hand-off reason (`lens-failed`), as a waiting one is. A lens whose run is gone or was cancelled is recorded `failed` (`failLens`).
2. **The stage stops instead of reporting done** when a lens of the draft's round didn't review, or when the gate's round limit leaves the draft without a critic round. Running the stage again from a stop re-checks the draft on file and opens a new critic round on it. The stage's own blocking findings go back before any critic round, so a round is used only on a draft worth reviewing.
3. **The draft's own round.** `loop.review` is dropped whenever a fresh draft starts. A resume must name a lens of that round, or this stage's own draft (`request.change` and `outputPath`). Anything else is refused. `waitingLenses` takes the round.
4. **Ids, not words.** The loop links a finding to the question it became by id (`raiseQuestions`' `of`, ADR 0117). ADR 0117's judge decides which questions are the same. A finding answered and back in a draft that was given the answer stops the loop. `--handoff --json` offers the run the step reports through `Output.report` (`{ handoff: { runId, lens } }`), filtered to the step's change. A batched scan reports `pagesLeft`, and the end JSON carries it.
5. **Data, not instructions.** The last draft's findings and the answers people gave go in an untrusted `hand-backs` source. The trusted instructions only point to it.
6. **The text a lens saw.** The draft is copied into the lens run's folder (`draft/`) at the hand-off, and `completeLensRun` checks quotes against that copy.
7. **Checked again once merged.** `StageSpec.check(answer, { onFile })`: a done stage's result is checked again with `onFile`. A migration the catalog now has under the same file name, and a table or entry the delta marked new, are the change's own.

No contract shape changes: `ReasonCode` gains `lens-failed`, and the `--handoff --json` end object may carry `pagesLeft`.
