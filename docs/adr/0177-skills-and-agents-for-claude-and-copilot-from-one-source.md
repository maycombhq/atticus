# 0177. Skills, agents and team instructions from other teams, for Claude and Copilot from one source

- Status: accepted (pending review by the product owner)
- Date: 2026-11-06
- Builds on: ADR 0104 and 0105 (Atticus's own slash commands, agents and skills for each assistant), 0176 (reading rules)
- Contracts: C6 gains `org-pack/skills/`, `org-pack/agents/`, `org-pack/instructions/` (each with `imported/<team>/`) and `org-pack/imported/<team>.yaml` (where a team's copy came from); additive, no migration (new folders)

## Context

Other product teams keep skills and agents (product owner, architect, analyst, developer; an event-hub publish, a file transfer) in their own repos, as Markdown for Claude Code or Copilot. A team wants to take them into its metarepo and have them work in whichever assistant a person uses, without copying each by hand into `.claude/` and `.github/` and without losing its own edits on the next copy. A skill or an agent is instructions: it doesn't make an answer true.

## Decision

1. **One source in the org pack, reviewed.** `atticus skills import <their repo> --team <team> --at <tag> [--only <names>]` takes a pinned copy (their files as the tag has them, read from their repo's history) of their `.claude/skills/<name>/`, `.claude/agents/`, `.github/agents/` (or older chat modes) and `.github/instructions/`, into `org-pack/{skills,agents,instructions}/imported/<team>/`, and records where it came from in `org-pack/imported/<team>.yaml`. An update is a new import, seen as a diff in the PR. An import writes nothing for the assistants: that waits for the review (step 2). A link in their repo to a file elsewhere is never followed or copied. The organisation's own (QE's included) live in the same folders without `imported/`.
2. **Two outputs, written from it.** `atticus skills write` writes, from each source: a skill to `.claude/skills/<name>/` and `.github/prompts/<name>.prompt.md`; an agent to `.claude/agents/<name>.md` and `.github/agents/<name>.agent.md`; instructions to `.github/instructions/<name>.instructions.md`, applied by themselves only where their source says (`applyTo`), and, for the organisation's own, an `@` import in a marked block of CLAUDE.md (another team's are listed there for a person to bring in, never loaded into every session). Each written file says what it was written from. `--check` exits 1 when one is behind.
3. **A local edit is kept.** A written file edited in the metarepo, or an imported copy edited since its import, is left as it is and said, never overwritten (`--replace` takes theirs on import).
4. **Grounded, not just imported.** An imported skill that states things about the estate (topics, fields, routes) with no `atticus` command to get them is flagged for the reviewer; a skill's files that may run (scripts) are listed for review, and nothing runs during an import.
5. **Never Atticus's own prompts.** Imported text is installed for people's own assistants after review; Atticus's readers never get it (CLAUDE.md rule 6: ingested content is data, never instructions).

## Consequences

- A team's practice travels between metarepos as reviewed files, in both assistants.
- Copilot reads the skills as prompt files; when an installed Copilot reads `.github/skills/` itself, a later release can write there too from the same source.
