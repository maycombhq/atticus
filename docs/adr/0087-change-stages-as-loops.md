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
