# 0114. Does the code do what the design says? A branch checked against its target flows (C3, C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0074 (the AI reads, every fact cites its code), 0030 (Run with AI), 0039 (built-in gates), 0087 (flow deltas), 0095 (target flows beside today's), 0108 (a change drawn from its target flows)

## Context

A task run ends "built" when the repo's build passes. Nothing checks that the code does what the approved design says: that the call a step adds is made, that the column a migration adds is there, that the call a step removes is gone, or that the task didn't add a call, endpoint or table the design never mentions. "Stay inside the approved design" is only a sentence in the task prompt. A person who writes the code on the task or change branch gets no check at all.

The pieces to check it exist. The target flows say, step by step, what each flow gains and loses (ADR 0087, 0095). The scanner reads a repo at a commit into catalog records, every one citing its file and line, and caches the result per commit (ADR 0074).

## Decision

1. **Scan the branch, not the working copy.** For each repo the change's target flows name, Atticus resolves the branch (the change branch `change/<id>`, a task's `task/<id>/<task>`, or `--ref`) in the base clone the workspace keeps, and the base it was cut from (where it meets the base clone's own branch). It checks each commit out into a detached worktree under `.index/conform/`, scans it with the scanner and its cache (the same commit is read once), and removes the worktree. Nobody's working copy is touched. A planned record (a Spec Kit plan's) is the design, never code, so it is left out.
2. **Compare with the target flows, deterministically** (planner `conform`). For each step:
   - a call-out or publish a step adds or changes: an Interface from the flow's component to the step's component and entry (`METHOD /path`, an Endpoint id, or a topic; a publish not yet joined to its listener counts);
   - a store: the migration the step names is a file of the repo; a new table is a Table record; each column is a Column record of the table;
   - a new flow's endpoint or listener trigger: an Endpoint of the component;
   - a removed step's call, a removed flow's calls and endpoint, and today's call of a step that now goes elsewhere: gone, unless another step still makes it;
   - a branch, transform, validate, log or respond step names nothing a scan records: it is listed as not checked, for a person or a test.

   What the branch adds over its base that no target flow names (an outbound call or publish, an endpoint, a table, a column) is out of scope. A table no step names covers its own columns.

3. **Every item cites its line**: what is there cites the new code; what is missing cites the target-flow file and the step's line.
4. **Findings (C3), on a new built-in gate, `conform`.** Missing (`conform.missing`) and still there (`conform.still-there`) are blocking and waivable; not in the design (`conform.unexpected`) is a risk. The rules are built in (`packages/taskrun/rules/conform.yaml`, org layer). The gate joins drift, hand-up and trace (ADR 0039): its open blocking findings hold back the Build, QA and Go/no-go hand-offs. A person dismisses one as not relevant, with a reason, as with any finding; the same item keeps its id, so a dismissal survives the next check. Each repo's newest result is kept at `conform/<repo>.yaml` in the change folder; the gate's round holds every repo's newest findings.
5. **A task scope.** With a task, only the steps the stories say the task builds are checked (`- Step: ..., item <n> of target-flows/<flow>.yaml` under `### Task <id>`); what nothing in the change names is still reported. A task the stories don't map is checked against every step of its repo, and the result says so.
6. **Where it runs and shows.**
   - `atticus change conform <change> [--repo r] [--ref branch] [--task t] [--latest] [--json]`; `--latest` reads the stored result and scans nothing.
   - At the end of `atticus task run` (and `atticus handoff done` for a task run) when the build passes: the task branch's commit, the task's steps. The outcome is a note on the run; a check that can't run is a note, never a failed run.
   - The local API: `GET /api/changes/{changeId}/conformance` (API 2.11.0), the stored results with each finding's state.
   - The app: **Code against design** (More, Build; `#/conformance?change=`), linked from the Tasks stage.
   - Claude Code: the read-only `change_conformance` MCP tool.
7. **No other contract changes.** The C3 finding shape is unchanged; the gate list gains `conform`. No catalog or org-pack schema changes.

## Consequences

- "Built" now says whether the code has what the design adds and nothing it doesn't, with the line to look at, before a reviewer opens the diff.
- It is as good as the scan: a call the scanner can't read (a framework no dialect or model covers) shows as missing, which points at onboarding, not at the developer. The check says what it found and where, so a person can tell.
- Not built yet: checking the entailment of a step (a branch's condition, a transform's fields), tests added or weakened, a step's request and response fields against the code, and the IDE plugins' views (VS Code, IntelliJ). A removed column or table is not yet asked to go.
