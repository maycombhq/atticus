# 0159. IntelliJ catches up with beta.10: an action per new job, the questions' owners and proposals, the reading order

- Status: accepted (pending review by the product owner)
- Date: 2026-11-01
- Builds on: ADR 0105 addendum 2 (an action per job, the parity table), ADR 0121 addendum 2 (AI steps in IntelliJ go to Copilot Chat on the clipboard), ADR 0140, 0141, 0144, 0146, 0148, 0151, 0153, 0156, 0157 (what beta.10 added to the command line)

## Context

2.0.0-beta.10 added commands to the command line (`estate fresh`, `next --queue`, `map <repo> --gaps`, `join measure`, `verify audit --report`, `change impact`, `spec seed` and `spec accept`, `questions sheet` and `--apply`, `questions proposed`, `intake traffic`, `repo rename`), the `/atticus-propose` slash command, and to the questions an owner, an order, `--mine`, a checked proposal (`--accept-proposal`) and an answer by rule (`--match`). The app has all of it, and the IntelliJ tool window embeds the app. The plugin's own tabs and Tools → Atticus had none of it, and IntelliJ with Copilot Chat in agent mode is where the product owner works.

ADR 0105 addendum 2's parity table is keyed by VS Code's commands: every VS Code command has a place in IntelliJ, and a test fails otherwise. When this was written VS Code had no command for the beta.10 jobs; its catch-up (`packages/vscode/src/jobs.ts`) landed beside this one, and each job's command is now a key of the table. Its test also showed one VS Code command unplaced: `atticus.runInCopilotAgent`, the next step handed to Copilot's agent mode.

## Decision

1. **An action per new job, in the parity table.** `Steps.ESTATE` (packages/intellij, core) lists them, each with the VS Code command of the same job (`atticus.estateFresh` and the rest), so each is a `Parity.MAP` key; `atticus.propose`, `atticus.acceptProposal`, `atticus.questionsMine` and `atticus.questionsAll` (one toggle here) and `atticus.openChatStep` (the agent-mode action) are placed too. The Run a Command budget is untouched. Each is in Tools → Atticus and Find Action by its own words, and `ParityTest` checks each is declared in plugin.xml. They run as they stand (`direct`), in the background with their output in the Output tab, not through the catalogue's questions: the catalogue read some of these usages loosely when this was written (fixed since), and none of them needs more than its target asked. A file target (`join measure`, `questions sheet --apply`, `intake traffic`) is asked with a file picker.
2. **What ends in Copilot Chat goes on the clipboard.** `map <repo> --gaps` runs here, then `/atticus-map <repo> --gaps` goes on the clipboard for a new chat, with the gaps prompt to open. `/atticus-propose` has no command line to hand off: it goes on the clipboard with Check the Proposed Answers beside it. Both use the AI steps' notice (Open Copilot Chat where its action is registered, Claude Code in a terminal, the prompt files when missing).
3. **The Waiting tab reads `questions list --state open [--mine] --json`.** The questions keep the command line's order and show the owner, the changes resting on them and the calls their answer joins; a change's own question sits under its change. My Teams' Questions Only is a remembered toggle. A checked proposal is a row under its question; Accept as My Answer and the answer dialog's first choice run `--accept-proposal`; a target or hosts question's dialog has a rule field (`--match`). Nothing is answered for the person: every answer is the person's click, and the command line checks a proposal again when it is accepted.
4. **The Next tab** shows each step's reason under it, the near id `atticus next` names (with the rename, after a yes), and the reading order and costs of `next --queue --json`, estimates and reported tokens said for what they are. `accept-seed` is its own action: open the seed, then accept it, then offer the change's stories stage again. `reread` runs as a map step.
5. **The agent-mode step is placed.** `Atticus.RunInCopilotAgent` uses VS Code's agent table (seven agents, `atticus-question-proposer` among them) (held to it by `AgentsTest`): the step's slash command, or VS Code's spelled-out prompt where no prompt file is written, goes on the clipboard and the notice names the custom agent to pick. Copilot's IntelliJ plugin lets no plugin open its chat in a mode, so that is the whole of it. Without the agent file, the step goes to Copilot Chat as any AI step.
6. The plugin is 0.3.0. No contract changes: the plugin reads the command line's JSON as it is.

## Consequences

- `repo rename` and `spec accept` write files in the metarepo, so each asks first; neither commits or pushes.
- None of it was clicked through in an IDE when it was written: `./gradlew test buildPlugin` ran offline, against a cached IntelliJ IDEA.
