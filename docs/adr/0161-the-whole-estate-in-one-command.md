# 0161. The whole estate in one command

- Status: accepted (pending review by the product owner)
- Date: 2026-11-01
- Builds on: ADR 0124 (facts the assistant writes) and its addenda A-ledger, A-budget and A-incremental, ADR 0121 addenda 2 and 3 (Copilot in IntelliJ, and its agent mode), ADR 0133 (prototypes), ADR 0141 (freshness, the onboarding queue, what a read cost), ADR 0157 (a second pass on the gaps), ADR 0159 (IntelliJ catches up)

## Context

The product owner maps about 40 Java, Spring Boot, Apigee and OpenShift repos on Windows, with GitHub Copilot Chat in agent mode in IntelliJ. Every piece of a read exists (`map --estimate` plans the parts, `/atticus-map` reads one, `verify --write` keeps it, `next --queue` orders the repos, `estate fresh` says what moved, `map --gaps` plans the second pass), but they are run by hand, repo by repo and part by part, and a person keeps the list. They are happy to leave one command open all day.

Two facts shape what that command can do:

1. **Copilot in IntelliJ has no API.** GitHub's IntelliJ plugin publishes no extension point, service or API that another plugin or a command line can call (ADR 0121 addendum 2, item 3). Atticus can't open a chat with a prompt in it, send a prompt, read an answer or tell when Copilot finished. So with Copilot as the reader, a person pastes one line per part into Copilot Chat. That is the only manual step; everything around it can be automatic.
2. **Copilot sometimes fails partway through a long chat.** A part read halfway leaves good facts in the facts file and no word that it stopped.

## Decision

### 1. `atticus map --all`

One command plans the estate, reads it one part at a time and joins it once at the end (`packages/cli/src/map-all.ts`).

- **The plan.** Every repo of the manifests (or of `--repos a,b`): the estate's repos in the onboarding queue's order (ADR 0141: reads under way, called repos, gateways, deploy and config repos, the rest), then the prototypes, read but never joined (ADR 0133). Each repo's parts are the read plan `map <repo> --estimate` writes, at the model's limit. A repo whose read is complete and fresh is skipped; a repo whose clone moved past its facts is re-read (only what changed, A-incremental); one whose clone moved but whose cited files didn't is carried by verify. `--stale` takes only the moved repos; `--gaps` gives every read repo the R2 second pass (`map <repo> --gaps`) instead of a read. `--dry-run` prints the plan (parts and estimated tokens) and stops.
- **The limit is known or it doesn't start.** `--max-tokens`, else `runtime.yaml`'s `maxInput`, else what `atticus probe` measured. With none, it refuses and says to pass `--max-tokens`: the 150K default `--estimate` falls back to would plan parts that overflow the reader.
- **Copilot (the hand-off).** For each part it prints a block (the repo, part n of N, "In a NEW Copilot Chat (agent mode), run: /atticus-map <repo>" or the gaps variant), puts that line on the clipboard (Windows `clip`, macOS `pbcopy`, Linux `wl-copy` or `xclip` when present, else it just prints) and waits. It polls the facts on disk: the part is accounted for once the read plan says so (a part's folders are in the facts, A-ledger; for a repo one session reads, its facts) and the reader's own `atticus verify` has run since its last write and passed. Then it runs what `atticus verify <repo> --write` runs, prints a paragraph (kept, rejected, coverage, links, questions) and moves on. While it waits, `s` + Enter skips the part, `q` + Enter or Ctrl+C stops, and a reminder line is printed every 10 minutes. There is no timeout: it waits as long as the read takes.
- **Model mode.** Where `runtime.yaml` allows model mode and names a provider (as `atticus next --json`'s `modelMode` says), the same plan runs on the model, unattended: each repo is `atticus map <repo>`'s batched read, then verify. `--max-parts n` (prompts) and `--budget-tokens n` (the runtime's count, else each prompt's estimate) cap it; the cap stops cleanly and the next run carries on. `--mode hand-off` takes the Copilot path even where model mode is allowed. The gaps pass is a session for an assistant that opens files, so `--gaps` is refused in model mode.
- **The end.** After every repo it runs `atticus verify --all --write` once, so every link is joined with the whole estate read, and prints a summary: repos and parts read, facts rejected, links added and removed (J2's counts), questions open, each part that is incomplete, skipped or failed with the command that finishes it, and the next commands (`atticus questions list --mine`, `atticus estate fresh`).

### 2. A part that fails midway is a normal case

- **Partial facts are kept.** The good facts a stopped read wrote are verified with the same code as `verify --write`; the read plan stamps only what the facts account for, so a part is never marked done unless it is.
- **Stuck is said.** When the facts, the reviewed lines and the verify report have stood still for 15 minutes (`--idle <minutes>`) and the part isn't accounted for, it says: "Copilot seems to have stopped on <repo> part n. r + Enter: verify what it wrote and give the prompt again for what's left, in a NEW chat; s: skip; q: stop." `r` works at any time.
- **A retry reads only what is left.** `r` verifies what is there, then plans the rest of the part the way R2 plans the gaps: `atticus map <repo> --part n --gaps` (new) takes the part's folders and its line ranges nothing accounts for, keeps the files the last verify lists as unknown (no kept fact cites them, no reviewed line names them) and plans them into sessions of `sessionTokensFor` the limit, writing the prompt to `<repo>.gaps.md` as `--gaps` does. The line is `/atticus-map <repo> --part n --gaps` (it still ends with `--gaps`, so `/atticus-map`'s steps run it unchanged). A file the read finished is never in it. For a repo one session reads, the rest is the plain gaps pass. Retries are counted per part; after three it suggests a smaller `--max-tokens`, which re-plans the repo into smaller parts.
- **Crash-safe.** Where the run is (each part's state and retries, a gaps pass done) is written atomically after every step to `.atticus/map-all/state.json`, on this machine only (in `LOCAL_ONLY`, so `.atticus/.gitignore` keeps it out of Git; a metarepo's `.gitignore` already ignores `/.atticus/*`). It is never trusted alone: each run re-plans from the facts on disk, so a killed terminal, a reboot or Ctrl+C at any moment resumes cleanly, and a state file cut short reads as none. Nothing else is written but what map and verify already write.
- **Model mode** retries a part that fails (a provider error, a timeout, a prompt with no answer) from where it stopped (`map <repo> --next`), three times with a doubling pause, then moves on and lists the part as failed.

### 3. The editors

- **IntelliJ:** Tools → Atticus → Map the Estate… asks for the model's limit (pre-filled from `runtime.yaml`'s `maxInput`) and runs `atticus map --all --max-tokens n` in a run console, like the plugin's other long-running commands, so the person sees each block, gets the line on the clipboard and types `s`, `r` or `q` into the console. The plugin can't drive Copilot (item 1 of the context), so it doesn't try: it opens no chat and claims nothing about one.
- **VS Code:** Atticus: Map the estate, one part at a time (map --all) asks the same and runs it in a terminal. Both are in the parity table.

## Consequences

- Mapping the estate is one command left open, and a paste per part; under model mode, none.
- A failed Copilot chat costs the rest of a part, never the part.
- The state file is a convenience: delete it and the run starts from what the facts say, losing only the retry counts and which gaps passes were done.
- The tokens it prints are estimates from the source (ADR 0141); model mode's budget is the runtime's count where it reports one.
- No contract changes: the facts file, the read plan (schema 2) and the gaps prompt are as they were; `--part` is a new option of `map --gaps`.
