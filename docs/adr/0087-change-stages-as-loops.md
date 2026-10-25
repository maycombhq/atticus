# 0087. The change lifecycle as three stage loops: feature, architecture, stories (C6)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0070 (change draft), ADR 0078 (questions as files), ADR 0079 (flows and repo specs), ADR 0083 (knowledge items), ADR 0086 (`--handoff` and the step slash commands), revamp plan 4.4, Phase 5 and principles 4, 7 and 8

## Context

A change went from brief to tasks through `change draft` (a proposal and spec from words in the brief), the critic (at most two rounds a gate, then a person) and `plan stories` (stories from the spec and interfaces.md). None of it used the repo specs of flows: the draft found the catalog records the brief's words named, not the flows the change touches, and stories had no tie to the steps that change. A loop ended on a count, not on whether the problem was going away.

## Decision

**Three stages, one change folder.** Each stage is a command, drafted through the AI runtime (hand-off by default), and each writes files into `openspec/changes/<change>/`:

| Stage        | Command                                                       | Reads                                                                                                | Writes                                                     |
| ------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Feature      | `atticus change feature <change> [--from-figma f.json]`       | `brief.md`, or the person-written `stories/*.md`, or an exported Figma file (copied to `design/`)    | `feature.yaml`, `feature.md`                               |
| Architecture | `atticus change architecture <change>`                        | `feature.yaml`, the touched flows (`specs/<repo>/`), patterns and decisions from the knowledge items | `target-flows/<flow>.yaml`, `design.md`, `data.md`         |
| Stories      | `atticus plan stories <change>` (when `target-flows/` exists) | the flow deltas, the process and request knowledge items                                             | `stories/<id>.md`, `stories.md`, `tasks.md`, `requests.md` |

- **Feature.** The assistant reads a compact index of every flow (with step positions and fields), feature, component, endpoint and table, and picks by meaning. Every id it names is checked: a feature is a Capability, a flow is in a repo's spec, a new flow's repo exists. Conflicts with other open changes come from their files (their `feature.yaml` flows and `target-flows/`, and their systems), without AI.
- **Figma.** A deterministic reader turns `GET /v1/files/:key` JSON into screens (frames), fields (inputs, selects, toggles, badges, read-only values, table headers, tabs, titles) and actions (buttons), by component name and node name, so a house design system needs no code. The assistant maps each field (existing with what backs it, new, or unbacked) and action (the endpoint it calls, `none` for navigation, or the gap). The checks require every field and action the reader found to be mapped or set aside with a reason, a gap for every new or unbacked field, and only endpoints the estate serves. A field with no backing becomes a feature gap.
- **Architecture.** A flow delta (schema below) per flow touched or added. The checks: the flow exists (or is new and has a name, trigger and steps), step positions exist, an added call-out or publish has a target, components and tables exist or are marked new, every step that moves data names its fields, a new column has a type and a classification, a schema change names its migration, a new table its retention, and every flow the feature changes has a delta. Interface and data changes are read off the deltas into `design.md` and `data.md` (the shape the critic and the story planner already read), unless a person wrote those files.
- **Stories.** One story per flow delta, per repo; one task per step added, changed or removed, with its fields, the evidence of today's step (repo:path:line) and a prompt for Copilot or Claude Code. These are decided without AI; the assistant words the stories and writes each task's acceptance criteria, which must name the task's fields. Requests and processes are suggested from the knowledge items without AI: a step whose kind and target (a vendor system, a new topic, a new column, personal data) meet an item's applies-when suggests it; the assistant may add more, each citing a real item and step. `requests.md` lists each with the item's quote (source, page, line, snapshot) and the step; the tasks it holds up say they wait for it. A person raises them (principle 7).

**The loop (principle 4).** Every stage runs the same loop (`packages/planner/src/stages/loop.ts`): draft; the stage's checks; a critic round at the gate of the stage's phase (define, design, plan), its rules and, when the runtime can run them here, its AI lenses; back to the assistant with the blocking findings and the people's answers; no cap on model calls. Each finding has a fingerprint, sha-256 of rule, target and evidence (the critic's own fingerprint for its findings). A blocking finding found in three drafts in a row (it came back unchanged twice), or found again after a draft without it (it flipped), becomes a question (ADR 0078, step `change-<stage>`, the stage command as its rerun) and the loop stops. The assistant's own questions are raised too, when their evidence is a line in the metarepo. A stage is done when no blocking finding is open (a finding whose question a person answered no longer blocks) and no question it raised is open; the command then prints `atticus change handoff <change> --approve`, the stage's PR, for a person to approve. A rerun of a done stage checks its files without AI, and drafts again only if they changed or `--force`.

In hand-off mode each draft is a hand-off run: `--handoff` prints the prompt, the result file and the two finishing commands; a draft with findings hands off again with them. The critic runs its rules on every iteration; its AI lenses run through `/atticus-critic` (`atticus critic <change> --mode hand-off`) before the stage's PR, because two hand-offs at once would need two answers per iteration. (Changed by ADR 0115: the stage now hands each AI lens off in turn after a draft that passes the rules, and the lenses' findings join the draft's.)

**The round limit is a setting (C6).** `gates.yaml` gets its own schema version 2. A gate's `maxAuthorRounds` is a number or `unlimited`; left out, it is unlimited in version 2 and two in version 1, as before. The built-in gates are version 2, so a pack without `gates.yaml` has no limit. `atticus upgrade` migrates a version 1 file (`gates-v2`): it writes `maxAuthorRounds: 2` on every gate that left it out, so nothing loosens until a person deletes the line.

**New change-folder files** (planner-owned schemas, `packages/planner/src/stages/schema.ts`, version 1):

```yaml
# feature.yaml
schemaVersion: 1
change: add-fraud-check
entry: brief | stories | figma
summary: <plain words>
features: [{ id: <Capability id>, why }]
flows: [{ id: <Flow id>, how: changed | read, why }]
newFlows: [{ name, repo, why }]
gaps: [{ what, why, from?: <design element> }]
conflicts: [{ change, flows: [], systems: [], why }] # Atticus fills these
design?:
  {
    file,
    screens:
      [
        {
          figmaId,
          name,
          flow?,
          fields: [{ figmaId, label, backing, mapsTo?, refs: [], gap? }],
          actions: [{ figmaId, label, does?, endpoint?, flow?, gap? }],
        },
      ],
    ignored: [{ figmaId, why }],
  }
questions: [] # raised to questions/, not kept here

# target-flows/<flow>.yaml
schemaVersion: 1
flow: forge-orders.place-order
repo: forge-orders
change: modify | new | remove
name?: <new flows>
trigger?: { kind, what, entry? } # new flows
why: <one sentence>
steps:
  - op: add | change | remove
    step?: <position in today's flow, from 1> # change, remove
    after?: <position it follows, 0 for first> # add
    kind?: <a Flow step kind>
    what?: <one sentence>
    to?: { component, entry, new } # call-out, publish
    store?: { table, columns, new, types?, classification?, migration?, retention? }
    fields?: { sends, returns, reads, checks, from, to }
    why?: <one sentence>
```

`stage/<stage>.yaml` keeps the loop's state: drafts so far, every finding with its fingerprint and the drafts it was found in, the questions raised, the answers read and the critic rounds run. `stage/stories-answer.yaml` keeps the story writer's last answer.

**Slash commands (ADR 0086).** `/atticus-feature` now drives `atticus change feature`; `/atticus-architecture` is new; `/atticus-stories` drives the stories loop. Each loops through `--handoff`, stops at a question, and ends with the PR command for a person. `atticus next` and the app's Run next name the new commands.

**The design bench.** `atticus bench design [--mode m] [--resume run]` reads `bench/design/vaccinations.figma.json` with the same reader and checks, has the assistant map it against the petclinic estate (the bench's flows and references), and scores it against `bench/design/reference.yaml`: screens found, fields found (precision, recall), backing right (a reading that falls into a listed trap is wrong), actions mapped, gaps flagged (`packages/evals/src/design-bench.ts`). The bench stops after three drafts.

## Consequences

- One loop rule for every stage, measured by fingerprints; the critic no longer stops at two rounds unless a gate says so.
- C6 changes: `gates.yaml` version 2 with the migration above. The change-folder files are new and Atticus-written; no record (C1), plugin or API (C4) schema changes.
- `change draft` (ADR 0070) stays for proposal and spec drafting; `plan stories` without target flows works as before.
- Not yet: the feature view on the diagram, the data, integration and infrastructure lenses as critic lenses, the patterns and standards check of each changed step (the architect reads them, nothing checks it), existing stories read into flows beyond giving them to the assistant, a spec delta back to the repo specs once the change is released, and an AI judge for the design bench's gap wording (gaps are matched by shared words).

## Addendum (2026-10-24): the lifecycle follows the stage path

A live run on a real metarepo found `atticus change status` asking a change on the stage path for `proposal.md` and `specs/<capability>/spec.md` after its feature stage was done. The lifecycle read the change type's artifacts for the phase, which are the change-draft path's (ADR 0070), and the stages never write those files. The hand-off PR would have been refused for the same reason, and wouldn't have carried `feature.yaml`.

- **The stage path is configuration.** The change policy (`org-pack/process/change-policy.yaml`, still version 1: the section is optional and new) gains `stages`: for each stage its phase, the loop state it keeps, the command that runs it, the files it writes and the type's artifacts it writes. The built-in list is feature (define, `stage/feature.yaml`, writes `feature.yaml`, `feature.md`, `design/`), architecture (design, `stage/architecture.yaml`, writes `target-flows/`, and the `design` and `data` artifacts) and stories (plan, `stage/stories.yaml`, writes `requests.md` and the `stories` and `tasks` artifacts). A team's list replaces it, so an org pack that wants `snow.md` at plan on the stage path lists it there.
- **A change is on the stage path** once its folder holds any stage's loop state. On it, a phase is due its stage's loop `done` (`stage-not-done` names the stage and its command otherwise, and says whether it stopped, waits for answers or is with the assistant), the files the stage writes, and only those of the type's artifacts the stage writes. The gate's findings and mandatory rounds are checked as before. A change with no stage loop state is on the change-draft path, unchanged.
- `assess` does this, so `change status`, `canAdvance`, `change handoff` and the app read it the same way. The hand-off PR carries the stage's files and its loop state.
- No contract changes: the change policy is Atticus's own file and the section is optional; `ReasonCode` gains `stage-not-done`.

## Addendum (2026-10-24): a person's fix is never drafted over, and one stop gives one message

A live run of `atticus change architecture` (headless Claude Code, a chat app that adds a table) found two failures of the loop. The fixtures retell them on Forge (`fixtures/stages/pin-table/`).

1. **A person's fix was overwritten.** The stage stopped on drafting findings and said "Fix target-flows/ … then run atticus change architecture again. Atticus checks your fix before it drafts again". A person hand-edited three steps and ran it again. The stopped path did check the files on disk (`spec.current()` reads `target-flows/`). But when the check still failed, the loop went on drafting, and each draft's `spec.write` replaced the person's files. Three drafts later the stage stopped with the same findings, and the edits were gone. The same happened on a done stage whose files a person changed ("The stage's files changed since it was done; drafting again").
   - **What a person changed is a fact.** Every write of a stage's files records each file's sha-256 in `stage/<stage>.yaml` (`written`, optional). On the next run, a file whose hash differs, a written file that is gone, or a file under the stage's source that Atticus didn't write is a person's edit. A loop file from before the hashes falls back to file times: a source file changed after the loop file was last written.
   - **Their version is the stage's draft.** Before anything is written, the edited files are copied to `stage/<stage>-by-person/<n>/`. The draft is recorded as a person's (`byPerson`: iteration, time, files, the copy, and `checked` or `redrafted`). Then the files are read back (`spec.current()`, and `spec.currentProblems()` for a file that doesn't read) and checked. If they pass, the critic reviews them as the person's draft (`review.by: person` while lenses are out). If that passes too, the stage is done; no draft is made.
   - **What still fails stops, with the file and line.** A failure of the checks, of the critic's rules or of a lens stops the stage with each finding at its place (`spec.locate`; for target flows the step's line, read off the YAML syntax tree). It never drafts over the files. Running it again with nothing changed stops again.
   - **A redraft only when a person asks.** `--force` drafts again, as does a question answered since the stop. The assistant then gets the person's files as the current draft, in a data block (`current-draft`), with the instruction to keep every change the person made. The copy is kept as before.
   - This is in the loop, so it holds for every stage: feature, architecture, stories and the fast path.
2. **Two stop messages for one stop.** A draft can come back with both a decision finding (it becomes a question) and a drafting finding the assistant kept getting wrong. The loop put the drafting stop in the notes, and the command then printed "stopped for a person … N questions". Both were true, but they read as two different stops. Now the result carries the drafting findings (`StageResult.stopped`: the findings and the file to fix), and `stageEnd` gives one end report. It names the questions first, because a person's answers change the next draft. Then come the findings the assistant kept getting wrong, then one next step: answer, then run the stage again. The next draft gets the answers and those findings, or a person fixes the file instead. The command, its `--json` result and the extension read the same result.

No contract changes: `stage/<stage>.yaml` gains optional `written`, `byPerson` and `review.by` (no version bump); `StageResult` gains `stopped`; `StageSpec` gains optional `currentProblems` and `locate`.

## Addendum (2026-10-24, pin a message): an answer that doesn't read, a person's fix of it, and the words after a stage

A live run on a real metarepo (a chat app; the change pins a message) found these. The tests retell them on Forge (`packages/planner/test/stage-answers.test.ts`, `packages/naysayer/test/gate-words.test.ts`, `packages/cli/test/stage-messages.test.ts`).

1. **The stop named the wrong file (S5).** The stories stage said "Fix stage/stories-answer.yaml", but that file held an earlier, valid draft. The failing answer was in the run's folder. Now, when the loop stops on an answer that didn't read, it copies that answer into the change folder at `stage/<output>` (`failedAnswerRel`: `stage/stories-answer.yaml`, `stage/architecture-answer.yaml`) and records it (`failedAnswer` in `stage/<stage>.yaml`, optional). When that path is the stage's own answer file, the valid answer is kept aside first, in `stage/<stage>-answer.last-valid.yaml`, and the stop says where. The stop names the copied file with each problem's line (`in <file>:<line>`). The message quotes the failing line and its number: "The answer isn't YAML: Missing , or : between flow sequence items, at line 1: relies_on_gaps: [...]. Quote any value containing { } [ ] : or # in double quotes."
2. **A YAML slip spends no draft.** An answer that isn't YAML at all goes back to the drafter once before it counts as a draft, with the problem, its line and how to quote (`READ_AGAIN_RULE`, the same read-again as the lenses in naysayer's `ai.ts`). The problem and the answer go as data (`last-answer`). In hand-off mode the read-again is a hand-off of its own (`readAgain` in the loop file). Its answer is the draft, whatever it is.
3. **The stop says what the drafts kept failing on.** Below the findings it stopped on, the stop lists the other rules whose blocking findings came back in two or more drafts (`repeatedFindings`). Each line gives the drafts, the count and one finding's words as an example. For the judge's covers-field refusals, the example quotes the criterion.
4. **Why `relies_on_gaps` appeared.** The stories prompt asks for it whenever the step has gaps (the context's gap rule, ADR 0107 point 5). Its flow-list example (`[<name>, ...]`) led to unquoted braces when a gap was an endpoint. The gap rule now shows a block list with each name in double quotes, and says to leave the key out when no gap is needed. The answer's reader (`parseYamlAs`) already set the key aside. The stories stage now reads its own answer file with that same reader, so a file with `relies_on_gaps` reads.
5. **A person's fix of the named file is their draft (S6).** A person put the failing draft into `stage/stories-answer.yaml` with its line fixed. The rerun said only "stage/stories-answer.yaml: nothing in it reads", for two reasons: the stage's result had never been written, and the stage's own reader refused the top-level `relies_on_gaps`.
   - Now the person-edit path reads the copied answer if the person changed it, or the stage's answer file when the stage's result doesn't read. It uses the same reader and the same checks as the model's answer.
   - If they pass, the stage writes the result as the person's draft (`byPerson`, `checked`) and the critic reviews it. If not, the stage stops with each problem at its file and line.
   - "Nothing in it reads" is gone. When a stage can't take the edit, it says to run it with `--force`, which drafts again from the person's files.
   - The whole path is tested end to end for the stories and architecture stages: stop, fix the named file, run again, checked, done.
6. **Smaller.**
   - `atticus finding … edit-and-apply` names the files the person changed, read off the stages' write hashes (`written`), else the finding's artifact. It no longer says "Recorded your edit to design.md" for an edit of `target-flows/`.
   - A stage's write says what changed, by the hashes (`StageResult.changed`). It prints "Wrote <the files that changed> (<the rest> are as they were)", or "Kept your target flows: nothing changed." for a person's files (`byPerson`), or "Kept the target flows: nothing changed."
   - **An open gap waits on its owner.** `atticus change status` said "The design gate is closed (0 blocking, 1 open gap) … a person decides now", while the stage said it was done. Both followed the rules as written. A stage is done when nothing blocking is open (a knowledge gap doesn't hold the stage or the next stage, ADR 0115 addendum), and the gate's hand-off needs no open gap (the lifecycle's check). The gap is an owner question, so it waits on its owner, not on a person's decision about the draft. `gateStatus.humanDecides` is now false in that case, and both places print the same line (`ownerWaitsLine`): "Nothing blocking is open at the design gate; 1 open gap waits on its owner, so the design hand-off waits until it is answered: route it to its owner (… ask --asked-of <owner>), or write the fact in and record it (… edit-and-apply --reason …)."
   - **The checking round in one sentence.** A stop said "run architecture again for one more checking round", while the status said the checking round was used. Both were true: a person acted again, so a further round ran. Every message now states the rule the same way (`checkRoundRule`): "a person acted since round N, so one more checking round is due". This covers the stage's stop, `atticus finding`, `atticus critic`, `atticus findings` and `atticus change status`.
7. **The stories stage drafts with the estate (T1, U1).** The stories stage selected 0 records on every path ("0 records selected from the index"). It gave the context engine no estate, so the selection held only processes. It now selects from the estate too, with the brief, the target flows and the design as its input and the changed flows' ids. When the engine is off, it sends the whole estate index. This is tested for a first draft, `--force`, and a redraft from a person's edit.

No contract shape changes: `stage/<stage>.yaml` gains optional `failedAnswer` and `readAgain`; `StageResult` gains `changed`, `byPerson` and `moreQuestions`; `StageIssue` gains optional `syntax`, `line`, `holdOnce` and `locateText`; `StageSpec` gains optional `reviewSources`.

## Addendum (2026-10-24, two live changes): the drafter checks its own draft

In 20 runs over two real changes, neither change reached stories without a person who could read the planner's code. The checks were right, but the drafter couldn't meet them, and each failure cost a whole draft. Checking is now part of the drafter's work, not a gate after it. Tested in `packages/planner/test/self-check.test.ts`, `packages/ai/test/handoff-layout.test.ts`, `packages/cli/test/stage-messages.test.ts` and `packages/changes/test/mandatory-gates.test.ts`.

1. **The drafter checks its own draft (W3a).** Each draft's request carries `selfCheck` (C5 `AiRequest`, additive): the command that runs the stage's checks on a file (`atticus stage check <change> <stage>`), and how many checks a draft may have (the change policy's `draftSelfChecks`, default 3; C6, additive). The checks are the stage's own reader and deterministic checks on the draft's text (`checkStageDraft`, the loop's `checkDraft` option). Nothing is written, and no model is asked. The problems come back in the hand-back wording, each with its line where known, in a few short lines (`formatDraftProblems`). Every drafter's instructions say to check before handing in (`SELF_CHECK_RULE`).
   - **Model mode:** the runtime offers a read-only `check_draft` tool beside the context tools (`draftCheckBox`; the CLI loads it on first call). Its calls count against the run's tool rounds, as the context tools' do. After the limit it says to hand the answer in as it is.
   - **Headless Claude Code:** the prompt ends "Before you finish, check the file: run atticus stage check … <file>. Fix each problem it lists and run it again, until it says the file is clean (at most N times)", and only that command is added to Claude Code's allowed tools.
   - **Hand-off (Copilot):** `atticus handoff done <run>` runs the same checks on the result file and lists the problems with their lines. The run stays open, as with a linter, and the prompt's finishing step says to fix and run it again. A stage run again while that run is being fixed waits on it and doesn't draft again. After the limit the file is handed in as it is, and the stage hands its problems back with the next draft.
   - A draft counts as a draft when it is handed in clean, or as it is after its self-checks.
2. **The critic ran on a draft its stage had refused (W4).** Design gate round 1 had blocking findings (`data-change-has-migration`, `new-column-complete`) on a draft the stage had refused. They repeated the stage's own findings and then needed a person. The loop's own critic rounds run only on a draft that passes the stage's checks. The other path was a person sent to `atticus critic`:
   - `change status` said a mandatory gate "hasn't been reviewed: run atticus critic", while the phase's stage was stopped on its draft. On the stage path that reason now waits until the stage is done; the stage runs the round itself.
   - `atticus critic` refuses while the phase's stage stopped on its own draft, and says to fix it and run the stage.
3. **`edit-and-apply` with only a reason (W6)** said "Recorded your edit to feature.yaml" when no file was edited. With no stage file changed, it says "Recorded what you did: <reason>."
4. **The change's own new names (V).** An endpoint the change's target flows declare new is no longer listed under "Names the change uses that nothing in the index has"; the line leaves out every name the context knows otherwise (`known`).

## Addendum (2026-10-25): drafted against merged, measured, and fed back (H1 to H3)

A stage closes when its hand-off PR merges, and until now Atticus forgot what it had drafted the moment people changed it in the PR. "More accurate with every correction" needs the corrections kept, counted and used. Tested on Forge in `packages/changes/test/drafted.test.ts` (a change through a mocked Git host, a bare repository as the host's copy, and a reviewer's commit on the hand-off branch merged with a merge commit), `packages/changes/test/learn.test.ts`, `packages/planner/test/past-corrections.test.ts` and `packages/cli/test/change-learn-cli.test.ts`; fixtures in `fixtures/stages/corrections/`.

1. **What was drafted is kept beside what was merged (H1).** When `atticus change sync` finds a stage's hand-off PR merged (the existing `syncHandoff` path, whether the host merged it or Atticus did with `--approve`), it writes, in the change folder:
   - `stage/<stage>.drafted/`: the stage's files as the draft commit had them;
   - `stage/<stage>.merged/`: the same files as the merge commit has them, with any a person added;
   - `stage/<stage>.capture.yaml`: the PR, the branch, the base, both commits, how the merge was found, and each file's status (same, edited, added, removed) and sha-256.
   - **Which files.** The stage's files are those the stage path names (its `writes` and `artifacts`); on the change-draft path, the phase's artifacts. The brief, `change.yaml`, the loop state, the reviews, questions, inputs and the design export are never part of the draft. A change with no stage loop state is captured under the phase's name.
   - **From the clone's git only.** No fetch, and no Git host call beyond the `getPullRequest` the sync already makes, so the adapter's mock covers it. The draft commit is the newest commit on `handoff/<change>/<phase>` (the local branch the publisher sets, the remote-tracking one, or a merge commit's second parent once the host deleted the branch) whose files have the sha-256s `change.yaml` recorded at hand-off (C1's existing `artifacts`). Line endings don't count. Failing that, the working tree is the draft if its files still have those hashes. The merge commit is the oldest commit on the base branch's first-parent line whose message names the branch or the PR number (`#n`, `!n`, `PR n`), else the first one that descends from the draft commit.
   - **A merge not in the clone yet** is recorded as `waiting-for-merge`, with "pull <base>, then run atticus change learn". A draft no commit or file has any more is `no-draft`. Neither fails the sync, and a metarepo that isn't a git clone keeps nothing.
   - **The pairs reach the metarepo by a PR.** The next phase's hand-off carries the kept pairs (`stage/*.capture.yaml`, `stage/*.drafted/`, `stage/*.merged/`), so they are reviewed like every other file.
2. **Measured (H3).** `atticus change learn [--json]` (under `change`; the top level stays at twelve) first completes any capture whose merge is now in the clone, and any merged hand-off kept before this existed, then reads every pair, open and archived changes alike. It is deterministic: the same pairs give the same report.
   - **Per merged change and stage:** for each file the lines drafted and merged, and the lines added, removed and changed. A line diff pairs a removed and an added line in the same place as one changed line. The stage's edit rate is the lines touched over the larger of the drafted and merged counts.
   - **Per story file:** criteria added and removed (the story's Acceptance criteria, else its tasks'), fields added and removed (each task's `Fields:` and the interface and data tables), and the parts reworded (title, statement and sections).
   - **The trend over time:** points ordered by merge date, per stage and over all stages. With fewer than three it says so ("a trend needs 3"). Otherwise it compares the mean edit rate of the earlier half with the later half: falling or rising when they differ by two points or more, else flat.
   - **Pending:** the captures still waiting for a merge, or with no draft, are listed apart and not counted.
3. **Past corrections in future drafts (H2).** The feature, architecture and stories stages' prompts get the closest past pairs of the same stage, from other changes. "Closest" means sharing a repo, table, flow or system with what the new change touches, or its entry. The feature stage knows the change's systems, declared touches and entry before placement; the architecture stage knows the placed flows' repos and tables; the stories stage knows the target flows' repos, flows and tables. A shared repo, table, flow or system counts twice as much as the entry. Ties go to the most recent. At most two pairs, and only pairs people changed. Each hunk is quoted in its place: "feature.yaml, line 14: the draft said … the team changed it to …".
   - **Within the budget.** They are one untrusted data source (`past-corrections`, priority 60, below the estate), cut to 5% of the stage's budget (`stageBudget`, so a `--max-tokens` limit fits too). A hunk longer than eight lines a side is cut and says how many lines more. They are placed beside the other sources before the estate is selected, so the estate's room counts them. The instructions gain one trusted line asking the drafter not to repeat a mistake the team corrected.
   - **Opt-in by data.** With no past pair, or none that differs, there is no source and no added line, so the prompt is byte for byte what it was. The test pins the three stages' prompt sha-256 from before this change, so recorded replays keep matching.
4. **Not yet.** H4 (repeated corrections become proposed critic rules) is not built. The trend means something only once real changes have merged with kept drafts. With none it says there is nothing yet, and with fewer than three per stage it says a trend needs three. Nothing ranks pairs by meaning; they are matched by shared ids. `change draft` and `plan stories` on the change-draft path don't get past corrections (their recorded replays are unchanged); only the three stages do.

No contract changes: the capture is Atticus's own file in the change folder (changes-owned schema, version 1). C1's `ChangeHandoff.artifacts`, already recorded at hand-off, identifies the draft. `SyncOptions` gains optional `git` and `remote`, and `SyncResult` gains optional `capture`. The stages' prompts change only when pairs exist.

## Addendum (2026-10-25): what a real change's run through feature, architecture and stories hit

A real change went through the three stages and the critic. Each problem it hit is retold on the invented Forge estates in `packages/planner/test/carry-findings.test.ts` (fixtures `fixtures/stages/carry/` and `fixtures/estate-facts/outside/`), with `packages/core/test/answered-by.test.ts`, `packages/naysayer/test/units.test.ts`, `packages/cli/test/questions-cli.test.ts` and `packages/cli/test/next-cli.test.ts`.

1. **The critic's finding goes to the next draft with what to fix.** The critic found a real bug (a cache key missing a data version) in the round in which the assistant also asked a question. Once the question was answered, the next draft wasn't told about the finding: a stop for questions handed back only the drafting findings it stopped on. Now it hands back, with the answers, every problem of the last draft that no question carries: every blocking finding without a question, and the critic's risks. A critic finding's message carries its fix ("What to fix: …", or its why when it has none), so the hand-backs and the stops say it.
2. **Risks get one more draft, and a fix lands in the source.**
   - The critic's risk findings (not those linked to a person's answer) come back to the stage as non-blocking issues (`LoopFinding.risk`). A draft with no blocking finding left but a risk not yet handed back goes back once, with the risk and its fix, while the gate has a critic round left. The hand-off is keyed by rule and file, not words, so it is bounded. A risk never blocks: one that comes back after its draft stays a finding for a person.
   - The loop file names the stage's source (`StageLoop.source`: feature.yaml, target-flows/ or stage/stories-answer.yaml). Every other file the stage wrote (`written`) is rendered from it. `apply` or `edit-and-apply` with a patch to a rendered file is refused, and so is recording an `edit-and-apply` when the only files a person edited are rendered ones. The refusal names the source and the stage's rerun: "stories/s1.md is written by the stories stage from stage/stories-answer.yaml, so a fix there is lost the next time the stage writes it."
3. **A held-back question is weighed only against answered questions about the same target** (ADR 0117 addendum, same date).
4. **Questions over the stop's cap are kept and shown.** The loop file keeps the questions due that a stop didn't ask, by their words and evidence (`StageLoop.waiting`); the stage's own questions were otherwise only in the run, under the gitignored `.runs/`. The stop names them, and `atticus questions list` lists them after the open ones, by change and stage, with the rerun that asks them (`--json`: `waiting`). The cap stays: `questionsPerStop` is the org's choice (C6), and answers to the first questions often change or remove the later ones.
   - A question filed under a change's id says "Proposed scope: this change (<id>)", not "this repo".
5. **An outside system is a call-out's target.** The model provider (`llm`) was in the specs, but the architecture check refused component `llm`, so the call had to be drafted as a transform. A target a call fact names (its Interface's `to`), or a spec flow's call-out names, that is no Component or System of the catalog is an outside system (`outsideSystems`): a delta may call it. The entries those calls give confirm the entry; any other entry is `delta.entry-uncited`, shown, not blocking. The estate index lists each outside system the scoped components call ("outside system llm: called by customers-api at POST /v1/messages"); with none, the index is as it was.
6. **design.md labels a call to an entry that exists today `existing`, not `planned-new`.** `planned-new` is for an entry the change adds (`new: true`); a changed step stays `planned-modify` and a removed one `planned-retire`.
7. **A critic finding is never dropped silently** (ADR 0111 and 0115 addenda, same date). A short quote counts on its own line; whatever the critic leaves out of a round is said in the stage's notes.
8. **A standard is followed, not raised.** The stories prompt's requests line says a standard is named in a story's context, never listed there. A standard listed as a request is `stories.standard-as-request` (drafting), with that message, not "isn't a process or request". Only a process or request joins `needs.yaml` from the stories stage.
9. **`atticus next` starts with the change in hand** (ADR 0086 addendum, same date).

The stage files (`StageLoop.source`, `StageLoop.waiting`, `LoopFinding.risk`) are the planner's, schema 1, optional fields. `StageResult.queued` is added. No contract (C1 to C6) changes. The stories prompt changed by its one requests line (its pinned sha-256 is re-pinned in `past-corrections.test.ts`); the feature and architecture prompts didn't change.
