# The map your personas ask

A persona is an agent file for one role: a product owner, an architect, QA. A naysayer is a second persona whose only job is to ask what the first got wrong. Many teams already have them and reach an OpenSpec change that way. What they lack is something true to ask. Atticus's map is that: every system, call, topic and table read from the code, each with its file and line (ADR 0201).

This page is for two kinds of team: one that keeps its own personas and only wants the map, and one that starts from the personas Atticus ships.

## You have your own personas: add the map

The map is a read-only MCP server, `atticus mcp`. It reads the metarepo and writes nothing.

1. In the metarepo, run `atticus skills write`. It writes `.vscode/mcp.json` with the `atticus` server when there is no such file, adds the server when the file has others, and leaves a file alone that has an `atticus` server already or that doesn't read as JSON (it says so, with the lines to add by hand).
2. In Claude Code, the Atticus plugin brings the same server; without the plugin, add it once: `claude mcp add atticus -- atticus mcp`.
3. Give each persona the tools it may call. In an agent file kept in `org-pack/agents/`, write `atticus/<tool>` and `atticus skills write` names it the way each assistant wants. In a file you keep elsewhere, the names are `mcp__atticus__<tool>` in Claude Code and `atticus/<tool>` in Copilot.

The tools a persona asks most:

| Tool            | What it answers                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ask`           | A plain question: "who calls ledger-api?", "who consumes the topic transfers.completed?". It says how it read the question. |
| `impact`        | What a change to one record reaches, hop by hop, with owners.                                                               |
| `walk`          | What one id is linked to, and how each link was made.                                                                       |
| `show`          | One record in full, with the file it was read from and whether it was verified.                                             |
| `show_code`     | The lines of code a fact cites.                                                                                             |
| `search`        | Records, knowledge, flows, changes and wiki pages by words and meaning.                                                     |
| `similar`       | What reads like one id. A hint where to look, never a fact.                                                                 |
| `conflicts`     | Open changes that overlap; with an id, only the overlaps that id is in.                                                     |
| `features`      | The features the estate has, with their entry points.                                                                       |
| `knowledge_ask` | The organisation's own standards, processes and decisions that may answer a question, each with its page.                   |

Two answers are worth teaching your personas:

- **"`<id>` is not in the map: planned or not read."** `impact`, `show` and `walk` say this of an id the map lacks. It is an answer, not an error: the change plans the thing, or nobody has read that repo yet. A persona that gets it must not describe how the thing behaves.
- **An overlap from `conflicts`** is an answer too. On the command line `atticus change conflicts` exits 1 when changes overlap; the tool just tells you.

To hold a requirements file to the map without the starter personas, keep each role's questions in a table with the six columns Question, Evidence, Asked by, Answered by, Answer and State under that role's `## ` heading, and run `atticus change new --from requirements.md --check`. It refuses an open question and an evidence id that is neither in the map nor listed under `## Planned`.

## Start from the personas Atticus ships

`atticus init` writes them into a new org pack, and `atticus upgrade` adds them once to an existing one, never over a file of yours:

- `org-pack/agents/`: `product-owner`, `ux-analyst`, `application-architect`, `domain-architect`, `security`, `developer` and `qa`, and `<name>-naysayer` for each. `domain-architect` is a template: its first lines say how to copy it for your own domain, for example a payments architect.
- `org-pack/skills/define-change/SKILL.md`: the order they run in and the loop.

They are yours from then on: change the words, the tools and the order by pull request. Run `atticus skills write` and each is written where Claude Code and Copilot read it; `atticus skills write --check` says when a written file is behind.

Then, in your assistant, run `/define-change` on a requirements file. For each role in turn:

1. The persona writes its section of the file, `## <Role>`, asking the map before it states anything about the estate.
2. Its naysayer asks at most five questions about that section. Each carries what the map says (an id, with the file and line) or says that the map has nothing.
3. A person in that role answers each one, or accepts going on without an answer and says why.
4. The next persona starts.

When every role has had its turn, `atticus change new --from requirements.md --check` says whether the file passes, and the same command without `--check` makes the change. The personas then write its proposal, spec deltas, design and tasks, and a person raises the hand-off. Nothing here approves anything: merging the hand-off's pull request does.

In Copilot each persona has a button that hands to the next, which a person presses. Where an assistant has no hand-off, or your organisation turns it off, the skill runs the personas in turn in one session.

### What a persona's file holds

```markdown
---
name: ledger-architect
description: Writes the ledger architect's section from the map.
role: architect
owns: Ledger architect
tools: [read, search, edit, atticus/ask, atticus/impact, atticus/conflicts]
handoffs:
  - to: ledger-architect-naysayer
    label: Challenge this section
    prompt: Challenge the "Ledger architect" section of the requirements file.
---

You write the `## Ledger architect` section…
```

| Field      | What it is                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `role`     | Who answers its naysayer: a role of `roles.yaml` where one fits, else your own words.                                     |
| `owns`     | The `## <Role>` heading it writes. A naysayer owns the table under the same heading.                                      |
| `tools`    | `read`, `search`, `edit`, and map tools as `atticus/<tool>`. With no list, the agent has every tool the assistant offers. |
| `handoffs` | Agent names, or `{ to, label, prompt }`. A person presses each hand-off.                                                  |

`atticus skills write` says by name what it left out: a map tool `atticus mcp` doesn't serve, a hand-off to an agent the org pack lacks, and a tool Copilot has no name for.

## Add a persona: two files and one line

1. `org-pack/agents/<name>.md`: copy the starter nearest to it. Set `name`, `owns` and what its section says.
2. `org-pack/agents/<name>-naysayer.md`: copy any starter naysayer. Set `name`, the same `owns`, and what it looks for. Keep its rules: few questions, each with evidence, nothing trivial.
3. One line in the order of `org-pack/skills/define-change/SKILL.md`, and the hand-offs of the personas before and after it.

Then `atticus skills write`.

## Limits

- The map grounds what is written. It doesn't prove an answer is right, and the door check doesn't open the file and line a row cites.
- Whether a persona asks good questions is read by a person. Change the words when it doesn't.
- The names the assistants give a map tool are as their documentation had them at 2.0.0-beta.30.
