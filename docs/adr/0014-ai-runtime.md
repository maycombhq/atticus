# 0014. Contract C5: the AI runtime

- Status: accepted
- Date: 2026-10-18

## Decision

`@maycombhq/ai` runs every AI step through one interface: **prepare → run → result**.

- **Agent definitions** (`org-pack/agents/<id>.yaml`): id, role, description, inputs, output artifact, checklist, token budget, allowed runtimes. A critic needs a checklist; an agent can't read the artifact it writes. A runtime refuses an agent that doesn't allow it, or a context pack over the agent's budget.
- **Context packs.** Trusted text (Atticus's instructions and the org pack) comes first; everything else is wrapped as `<atticus-data>` with a standing rule that it is data, never instructions, and it can't close the wrapper early. Sources above the runtime's allowed classification are refused, and the lowest-priority sources are dropped to fit the budget. The manifest lists every source with its size, class, token estimate and hash, every source left out and why, and the hash of the assembled prompt.
- **Runtimes.**
  - _Hand-off_ (default): Atticus writes the prompt and manifest to git-ignored `.runs/<change>/<run>/`; the person's own assistant writes the artifact. States: prepared → waiting → produced → validated, or failed with the errors and Retry. Completion comes from `atticus handoff done <run>` (the prompt ends by asking for it), from the watcher once the file has been unchanged for 30 seconds, or from Mark done. State is kept on disk.
  - _Model_: a direct call through a model-provider adapter, only for models `runtime.yaml` allows; the data rule is in the system prompt.
  - _Headless Claude Code_: reserved in the contract; it arrives with the assistant kit (M3).
  - _Mock_: deterministic, output is a function of the request.
  - _Recorded replay_: returns the recorded output for the exact agent and prompt hash. A changed prompt with no recording fails loudly. CI and every end-to-end journey use mock and replay; no live model runs in CI. `recordRun` captures recordings from a live runtime outside CI.
- **Summaries and retention.** A run summary (state, runtime, usage, attempt, errors, manifest hash) goes into `review/`; full packs and transcripts stay in `.runs/` and are pruned after `retention.runsDays` (default 30).
- **Transitions are fixed.** Only the documented state changes are allowed; anything else throws.

## Consequences

AI steps are reproducible in tests, auditable after the fact, and safe against instructions hidden in ingested material. The person's own assistant does the writing by default, so no model access is needed to start.
