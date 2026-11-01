# 0148. A sample audit gives precision on the real estate

- Status: accepted (pending review by the product owner)
- Date: 2026-10-31
- Builds on: ADR 0124 (facts the assistant writes; `verified: sample` in the facts schema), 0135 (how a link was joined, and This link is wrong), 0024 (the local API, C4); plan items P1 and R5 (`atticus join measure`)

## Context

The verifier proves that a claim is written on its line. It can't prove the claim is the right reading of the code: that a route is really served, that a call really reaches the repo the join tied it to. `atticus join measure` (R5) scores the map against a reference a person writes by hand for a few repos they know, which is thorough but slow to start. Nothing gave a cheap, honest number for the whole estate, and `verified: sample` had been in the facts schema since ADR 0124 with nothing that set it (the verifier writes `line` on every fact a reader made, deliberately: a reader can't vouch for itself).

## Decision

### 1. `atticus verify audit <repo> [--size n] [--seed s]`

A subcommand of `verify` (the area it measures), not a thirteenth top command. It draws `size` (default 10) of the repo's kept facts a reader wrote and `size` of the links the estate join makes from the repo, at random but reproducibly: the same seed, facts and links draw the same sample on any machine, whatever order they come in. The default seed is `<repo>@<commit>`. A person's own facts (corrections) and facts not yet verified are never drawn; a repo with unverified facts is refused, as the join leaves it out.

Each item is shown with every line it rests on, read from the checkout: a fact's cite and `cite.with` parts; a link's call, its tie and placeholder settings, the exposure facts, each gateway hop's route and forwarding call, and the callee's entry, each prefixed by its repo. A link says how it was joined (`joined-by-answer`, `-name`, `-repo`, `-host`, the guesses `joined-by-path`, `-label`, or `topic`), from the same `joinFlagsOf` that writes the Interface's flags.

On a terminal it asks right, wrong or unsure (Enter skips, q stops), and for a wrong one a line of why. Off a terminal (an agent, a test) it asks nothing: answers come from `--answers <file>` (YAML or JSON mapping item ids to an answer, or `{answer, note}`) or `--right`, `--wrong` and `--unsure` lists of ids; with none, it prints the sample and says how to answer it. An id not in the sample is refused.

A wrong answer points the person to the existing correction flow: for a fact, Correct this on the Map (a line in `<repo>.corrections.jsonl`); for a link, Why is this linked? › This link is wrong (ADR 0135). The audit never writes a correction itself.

### 2. The audit file is a person's record

`facts/<repo>.audit.yaml` (`.atticus/facts/` when adopted; a companion in `FACTS_COMPANIONS`, so it follows a rename and is never taken for a repo): schema 1, the draws (seed, size, commit, when) and the items with their answers, who gave them and when. A new draw adds only new items; answers on file stay. It is committed in a pull request like any file of the metarepo, and nothing is sent anywhere.

### 3. Precision, honest about the sample's size

`atticus verify audit <repo> --report` gives, for facts (and per kind) and for links (and per how they were joined), the share right of those answered right or wrong, with the count and the Wilson score interval at 95%, which stays honest at small samples and at 0 or 1, where p ± 2σ does not. Unsure and open items are counted apart, never in the share. Under 30 answers the report says the sample is small and to read the interval. An answer stops counting (gone) when the fact no longer cites the line and value the person saw, or the link no longer reaches the repo it did. `atticus verify audit --report` with no repo gives every repo audited and the estate's sum.

### 4. `verified: sample` where the facts are read, not in the facts file

The facts file stays the verifier's: `atticus verify` writes `line` on every reader's fact, and an audit doesn't change that (the brief's "where the facts file allows it": it doesn't). Instead, GET /api/facts/{repo} gives `verified: sample` for a fact answered right that still cites the line the person saw. This keeps the facts file reproducible from the read alone (hard rule 4) and the person's word in their own file.

### 5. Map › Trust (C4 2.37.0, additive)

`TrustRepo.audit` holds the path and the facts', per kind and links' tallies; the Trust card shows a Sample audit row (facts and links as a percentage with their range, the small-sample warning) or the command to start one. Trust reads files only, so a link answer there is counted as given; the CLI report, which runs the join, also drops a link answer that no longer holds.

## Consequences

- `verified: sample` is set for the first time, as a view, never in the facts file.
- C4 goes to 2.37.0, additive only; `docs/api/openapi.json` regenerated.
- One more command in the census (`verify audit`); `audit` as a repo id still verifies, unless a second word or `--report` follows it.
- Not done: the app has no screen to answer an audit (the CLI does it); the Trust tab doesn't show the per-kind or per-how breakdown, which the report and the API hold.
