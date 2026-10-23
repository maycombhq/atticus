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
