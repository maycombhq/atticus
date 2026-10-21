# What we know about the bank, and what's still open

For the revamp plan (`docs/plan/revamp.md`). Nothing here is sent to anyone: the product owner answers from what they know, and the plan follows the answers. No names of the bank, its systems or its people go in this repo.

## Answered (2026-10-21)

| Question                                          | Answer                                      | What it changes                                                                                                            |
| ------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Which AI assistant may developers use?            | GitHub Copilot, in IntelliJ IDEA or VS Code | Every AI step at the bank runs in Copilot's agent mode from a prompt file (plan principle 8, section 4.8)                  |
| Is there a model API a tool could call by itself? | No, Copilot only                            | Atticus calls no model at the bank; headless Claude Code is for development on public repos and the author's own repo only |
| How would Atticus be installed?                   | Through npm, probably                       | Publish to the bank's internal npm registry; Node 22 must be on laptops (Phase 8)                                          |

## Still open

Ask these only when they block something; each says what waits on it.

1. **MCP in Copilot:** may Copilot talk to a local MCP server on the laptop? Waits on it: the MCP server in Phase 6. Without it, prompt files and commands do the same job.
2. **Extensions:** may developers install an editor extension from a file, or only from the marketplace or an approved list? Waits on it: an `@atticus` chat participant, optional.
3. **Copilot's agent mode in IntelliJ IDEA:** is it enabled at the bank, and may it run terminal commands? Waits on it: the Phase 2a exit run in IntelliJ IDEA. If not, IntelliJ users copy commands from the prompt.
4. **What may be in a prompt:** any limits on which code, documents or data Copilot may be given (for example personal data, or code from certain systems)? Waits on it: the context Atticus gathers for each prompt.
5. **Diagram libraries' licences:** are MIT and EPL-2.0 libraries allowed in an internal tool (React Flow, dagre and sigma.js are MIT; ELK.js is EPL-2.0)? Waits on it: the layout engine choice after the Phase 1 spike; dagre is the fallback.
6. **Node 22 on laptops**, and is a local web server on localhost allowed? Waits on it: Phase 8 packaging.
7. **Git host, work items and service desk:** which systems, and may a tool use a person's own token to list repos and draft items? Waits on it: onboarding's repo list and the request suggestions in the stories stage.
8. **The pilot:** a team, 5 to 10 connected repos, and who would score the output. Waits on it: Phase 7.
