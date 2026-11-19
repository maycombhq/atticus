# Skills and agents from other teams, for Claude and Copilot

Other product teams keep skills and agents (a product owner, an architect, an event-hub publish) in their own repos. Take them into your metarepo once, review them, and they work in Claude Code and Copilot alike (ADR 0177).

## Import

```
atticus skills import ../harbor-metarepo --team harbor --at v2.1
atticus skills import ../harbor-metarepo --team harbor --at v2.1 --only eeh-publish,harbor-architect
```

Atticus reads their `.claude/skills/<name>/`, `.claude/agents/`, `.github/agents/` and `.github/instructions/` as the tag has them, copies them into `org-pack/{skills,agents,instructions}/imported/harbor/`, and records where they came from in `org-pack/imported/harbor.yaml`. It says which skills carry scripts (review them; nothing runs during an import) and which state things about the estate with no `atticus` command to check them. Nothing is written for the assistants yet: commit the copy and review it in a pull request, then run `atticus skills write`. An update is a new import, seen as a diff. A link in their repo to a file elsewhere is never copied.

## Where they are written

`atticus skills write` writes each one where each assistant looks:

| Source       | Claude Code                                                                                      | Copilot                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a skill      | `.claude/skills/<name>/`                                                                         | `.github/prompts/<name>.prompt.md`                                                                                                                                                   |
| an agent     | `.claude/agents/<name>.md`                                                                       | `.github/agents/<name>.agent.md`                                                                                                                                                     |
| instructions | an `@` import in CLAUDE.md for your own; another team's are listed there to bring in when wanted | `.github/instructions/<name>.instructions.md`, applied by itself only where its source's `applyTo` says (your own; another team's never apply by themselves: a person attaches them) |

Your own skills and agents go in `org-pack/skills/<name>/SKILL.md`, `org-pack/agents/<name>.md` and `org-pack/instructions/<name>.md`, and are written the same way. `atticus skills write --check` exits 1 when a written file is behind its source; `atticus skills list` shows each and where it goes.

## Your own agent's tools and hand-offs

An agent of your own may list `tools` and `handoffs` (ADR 0201). Each is written the way each assistant takes it; `role` and `owns` are for the [define-change loop](the-map-your-personas-ask.md) and are written to neither.

| Source                  | `.claude/agents/<name>.md`                                      | `.github/agents/<name>.agent.md`                                                    |
| ----------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `tools: read`           | `Read`                                                          | `read`                                                                              |
| `tools: search`         | `Grep, Glob`                                                    | `search`                                                                            |
| `tools: edit`           | `Edit, Write`                                                   | `edit`                                                                              |
| `tools: atticus/<tool>` | `mcp__atticus__<tool>`                                          | `atticus/<tool>`                                                                    |
| any other tool          | as written                                                      | `Read` as `read`, `Grep` and `Glob` as `search`; else left out, and said            |
| `handoffs`              | a last line of the body: "When you are done, hand to: <names>." | `handoffs: [{ label, agent, prompt, send: false }]`; a person presses each hand-off |

An agent that lists no tools is written as before. One that lists them has only those in Copilot from now on, so `atticus skills write --check` reports its files as behind once after the upgrade. A map tool `atticus mcp` doesn't serve and a hand-off to an agent the org pack lacks are left out and named. `atticus skills write` also writes the metarepo's `.vscode/mcp.json` with the `atticus` server: a new file where there is none, the server added where the file has others, nothing where it has one or doesn't read as JSON.

## Your edits are kept

A written file you edit, or an imported copy you change, is left as it is on the next write or import, and Atticus says so. `--replace` on import takes theirs.

## What another team's files may set here

A copy of another team's file is written for the assistants with only the frontmatter that describes it (`name`, `description`). Their agent reads only, in Claude (`tools: Read, Grep, Glob`, or fewer if it names fewer) and in Copilot (`tools: [read, search]`), whatever tools it asks for, and their skill is run only by a person: `disable-model-invocation: true` in its SKILL.md (Claude Code and VS Code both read skills there and honour it), and an `ask` prompt in Copilot. Anything else (`allowed-tools`, `hooks`, `model`, `permissionMode`, an instructions file's `applyTo`) is left out, and `atticus skills import` names what it left out. To give one of theirs more, copy it into your own skills or agents and set it there, in a reviewed change.

Each imported item records where it came from (their remote, never a folder on this machine) and the tag it came at.
