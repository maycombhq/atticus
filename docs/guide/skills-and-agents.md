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

| Source       | Claude Code                                                                                      | Copilot                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| a skill      | `.claude/skills/<name>/`                                                                         | `.github/prompts/<name>.prompt.md`                                                                      |
| an agent     | `.claude/agents/<name>.md`                                                                       | `.github/agents/<name>.agent.md`                                                                        |
| instructions | an `@` import in CLAUDE.md for your own; another team's are listed there to bring in when wanted | `.github/instructions/<name>.instructions.md`, applied by itself only where its source's `applyTo` says (your own; another team's never apply by themselves: a person attaches them) |

Your own skills and agents go in `org-pack/skills/<name>/SKILL.md`, `org-pack/agents/<name>.md` and `org-pack/instructions/<name>.md`, and are written the same way. `atticus skills write --check` exits 1 when a written file is behind its source; `atticus skills list` shows each and where it goes.

## Your edits are kept

A written file you edit, or an imported copy you change, is left as it is on the next write or import, and Atticus says so. `--replace` on import takes theirs.
