# 0113. Small changes fast, files into a change, and the task's context where the code is written (C6, C4)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0086 (steps as slash commands, `atticus next`), 0087 (the stages as loops; gates.yaml version 2), 0101 (needs), 0104 (the Claude Code plugin and MCP), 0105 and 0106 (one arrangement; model runs), 0107 (the context engine), 0042 (ingested-content defences), 0015 (the local server)

## Context

Atticus has to make a complex feature easier to build than pasting files into a chat ("vibe coding"), and must not make a small change slower. Three things stood in the way:

1. Every change walked brief → feature stage → architecture stage → stories → tasks, each its own AI step, its own loop and its own hand-off PR. For a one-line response change that is three hand-offs and three pull requests.
2. The files a change starts from (a vendor's PDF, a screenshot of the form, an email thread, a Word spec) had nowhere to go. `atticus intake add` puts files into the metarepo-wide `inputs/inbox/`, read for the catalog, never for one change; people pasted them into the chat instead.
3. When a developer starts coding a task in Copilot's agent mode or Claude Code, the task's context (its story, criteria, the step it implements and the code that does it today, the standards that apply, the files to change) was in five files the developer pasted by hand. `atticus task run` gathered some of it for its own model only.

## Decision

### 1. The fast path (C6: change-types.yaml version 2)

**change-types.yaml gets its own schema version 2** (`CHANGE_TYPES_SCHEMA_VERSION`), with three optional fields on a type:

```yaml
schemaVersion: 2
types:
  - id: small-change
    name: Small change
    size: small # small: the fast path; left out: standard
    phases: [plan, build, release]
    artifacts: [brief, proposal, design, stories, tasks]
  - id: config-change
    name: Configuration change
    smallWhenBriefSays: true # a brief that says "Size: small" takes the fast path
    fastGate: plan # optional: the gate whose critic reviews the fast path's step
    phases: [define, plan, build, release]
    artifacts: [proposal, tasks, snow]
```

- A type is on the fast path when its `size` is `small`, unless its brief says `Size: standard` (a brief can always ask for more review). A standard type with `smallWhenBriefSays: true` takes the fast path when its brief says `Size: small` (a line, bold or in a list, or `size:` in front matter; comments never count, so a template's hint can't). A brief that says small on a type that doesn't allow it takes the full path, and every surface says why.
- A small type has at most one phase before build (define, design or plan), so its plan is one hand-off PR. The gates the org pack sets for small changes are the gates of the phases the small type keeps.
- `fastGate` names the gate whose critic runs on the fast path's step; left out, it is the first gate of the type's last phase before build, else of its first phase. The org pack's cross-file check refuses a `fastGate` that isn't in gates.yaml or whose phase the type doesn't have.
- Version 1 files still read, every type standard; the new fields need version 2. `atticus upgrade` migrates (`change-types-v2`): it writes `schemaVersion: 2` and changes nothing else, so no type changes path until a person marks it.
- The built-in types are version 2 and gain `small-change` (plan, build, release; brief, proposal, design, stories and tasks; the architecture, story, code-and-test and release lenses). `config-change` and `tech-debt` set `smallWhenBriefSays`. A built-in `small-change` brief template asks what changes, where, and when it is done.

**`atticus change small <change>`** is the fast path's one step (packages/planner, `stages/small.ts`). In one AI answer the assistant places the change on the estate's flows and features, writes the target flow of every flow it changes and words one story per target flow with each step's acceptance criteria. Atticus splits the answer and runs the three stages' own checks on it: every id placed exists; every flow, step position, component, table, column type, classification, migration and retention of each delta against the specs and the catalog; the stories and tasks derived from the target flows without AI (`storiesFromDeltas`), each task's criteria naming its fields; requests and processes suggested from the knowledge items. Story wording is keyed by flow and step item, so the assistant never guesses Atticus's ids; the checks' words name the flow and step back. It writes every file the full path writes (`feature.yaml` and `feature.md`, `target-flows/`, `design.md`, `data.md`, `stories/`, `stories.md`, `tasks.md`, `requests.md`, the needs) and `proposal.md` from the summary while it holds only the template, so the critic, the change diagram (ADR 0108), the estimate (ADR 0109) and the task context all work. The step runs in the same loop as the stages (ADR 0087: fingerprints, a repeat or a flip becomes a question or stops the loop, the critic on every draft) with the critic at the type's fast gate; its state is `stage/small.yaml` and its last answer `stage/small-answer.yaml`. It takes `--handoff`, `--resume`, `--force`, `--context-tokens` and `--whole-context`, and refuses a change that isn't on the fast path, naming `atticus change feature`. Constitution and safety rules are the critic's and the checks'; they hold on the fast path as on the full one, and a person approves the one hand-off PR.

`atticus next`, the app's Run next and the stage pages give a small change before build the step `atticus change small <change>` (`/atticus-small <change>`). The planner-owned `Stage` enum gains `small` (an additive value; older files read).

### 2. Files attached to a change

**`atticus change attach <change> <files...> [--json]`** copies each file into the change folder's `inputs/` and lists it in `inputs/index.yaml` (intake-owned, version 1, Atticus-written; change.yaml is unchanged): its path, the name given, its kind (intake's `classify`), its format, sha-256, size, who attached it and when, its version or date (intake's name parts), the older version it replaces, and what the ingested-content defences found (ADR 0042). A file with the same bytes as one already attached is refused with where it is; one already in the metarepo's own `inputs/` is attached and said so. A newer version (same name family, a later version or date, else attached later) is kept beside the older one, and only the newer is read by the steps. What a reader can read is written to `inputs/read/<file>.md`, every line cited as `[file:line]` (Markdown, text, HTML, email exports, specs) or `[file page n]` (PDF, slides, sheets; a Word document by section), by the ingestors' own readers. A picture is named, not read: the assistant looks at it in the chat. A file the defences find hiding instructions is kept and kept out of every AI step until a person decides; ingested content is data, never instructions.

The feature stage, the architecture stage, the fast path and the task context read the attached files as data sources, cited by their metarepo path; the context engine (ADR 0107) indexes `inputs/read/` as part of the change, so a search or a selection finds them and a removed file's rows go.

Surfaces: the CLI; the local API's `GET` and `POST /api/changes/{changeId}/inputs` (API 2.10.0), the upload a JSON body with the file in base64, at most 15 MB of file, guarded like every other write (the session token, this host only, JSON only) with its own larger body limit for that route only; the app's **Files attached** panel with an **Attach a file** control on a change's page and on the Feature page (a labelled file input, its help, a status line, loading, empty and error states); VS Code's **Attach to Atticus change** in the Explorer's context menu (one file or every one selected), on a change in the sidebar and in the palette; IntelliJ's **Attach to Atticus Change…** in the Project view's and the editor tab's context menus; Claude Code and Copilot's `/atticus-attach <change> <files...>`, which runs the command for the files the person names. MCP stays read-only.

### 3. The task's context where the code is written

**`atticus task context <change> <task> [--json|--markdown]`** (packages/planner, `task-context.ts`) builds, from the files and without a model: the task (its title, repo, branch `task/<change>/<task>`, worktree when one is open), its story and acceptance criteria, the target-flow step it implements with today's step (or the step it goes after) and the file and line that step is cited at, today's flow numbered with the task's step marked, what the change needs of the task, its story, its flow or the whole change (needs.yaml, with whether a person verified each item), the patterns, standards and decisions the context engine selects for the step's words and ids, the files attached to the change, the files likely to change (the step's citations, then the flow's other cited files in the repo, then its trigger; a migration the step names as a new file) and the task's prompt. Markdown starts with how to work (the worktree and branch only, a test per criterion, stay inside the design, never push, merge or deploy) and marks everything after it as data.

The same builder serves every surface: the `task_context` MCP tool (read-only); `/atticus-task <change> <task>` for Copilot (a prompt file in agent mode) and Claude Code, which runs the command and works in the worktree it names; VS Code's **Start this task in Copilot** on a task in the sidebar (and in the palette), which opens Copilot Chat in agent mode (`workbench.action.chat.open` with `mode: "agent"`) with `/atticus-task <change> <task>` where the metarepo has the prompt file, else with the context itself, left in the box for the person to send, and puts the context on the clipboard where chat can't open; IntelliJ's **Atticus: Start a Task in Copilot**, which puts the context on the clipboard with the slash command to copy, since Copilot in IntelliJ gives plugins no way to open its chat; and `atticus task run`, whose pack gets the context as data. `atticus next` and the app name `/atticus-task <change> <task>` in the metarepo.

## Consequences

- A small change is one AI step and, with a small type, one pull request, with every check the full path runs; a brief can ask for the full path, and only the org pack lets a brief ask for the fast one.
- A change's specs, screenshots and documents live with the change, read once with intake's readers, cited by line or page, versioned, screened, and found by the context engine.
- A developer starts a task in agent mode with its context loaded, from the same builder `atticus task run` uses, so the assistant and Atticus's own runner see the same facts.
- C6 changes: change-types.yaml version 2 with the `change-types-v2` migration. C4 changes: API 2.10.0 (the inputs routes, `fastPath` on a change). No C1 record or change.yaml change; `inputs/index.yaml` and `stage/small*.yaml` are Atticus-written files.
- Not yet: a picture or a scanned PDF is never read (no OCR, no image model in a step); a brief-stated small change on a type with more than one phase before build still has a hand-off per phase (one AI step, several PRs); VS Code before 1.99 opens chat without agent mode (the mode is ignored); the app has no task-context view of its own; the `task_context` MCP tool returns what the command prints, without the model's own tool calls into the graph (ADR 0107 point 4).
