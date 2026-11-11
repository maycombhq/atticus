# 0196. Canaries, and the silent error rate with the sample audit

- Status: accepted (pending review by the product owner)
- Date: 2026-11-11
- Builds on: ADR 0074 (the AI reads, deterministic code verifies), 0118 (the model searches the code), 0124 (facts the assistant writes; the verifier checks the claim on the line), 0148 and 0149 (the sample audit, P3); the Jarvis plan's item Z2, "The one rule" and build order step 1
- Contracts: C4 3.12.0, additive (`GET /api/trust/canaries`). C1, C2, C3, C5, C6 and the facts file unchanged.

## Context

The plan's one rule is that no claim reaches a person or a builder AI without saying how it is known. The number that says whether it holds is the **silent error rate**: wrong claims graded as backed (Proved, Agreed or Confirmed). Wrong claims graded Flagged are the system working. Build order step 1 asks for that number on the organisation's own code before anything else changes, so every later step can show whether it fell.

The verifier proves a claim is written on its line; it can't prove the line was read right. The sample audit (ADR 0148) measures that: a person answers a random sample of kept facts and links, which gives precision on real lines. It can't measure two things: what a read misses (recall), and a claim about something that isn't there but looks as if it were (a fabrication the verifier lets through). Nobody can label those on a real repo at scale.

## Decision

### 1. A canary is a planted copy, read by the person's own assistant

`atticus canary plant <repo> [--seed s] [--size n]` copies the repo's checkout to a scratch folder, plants a few synthetic items in the copy, comments out a few real lines, and writes a prompt. The person gives the prompt to their assistant in a new chat (Claude Code, or Copilot in agent mode), which reads the copy exactly as `/atticus-map` reads a repo and writes a facts file in the run folder. `atticus canary check <repo>` is the read's own verify loop against the copy (it exits 1 while a fact is rejected, and writes the run's `rejected.jsonl`). `atticus canary score <repo>` verifies the facts against the copy, scores them against the key and writes the report.

Atticus never runs the repo's code, deploys or pushes, and calls no model: the read is the person's assistant's, as every read is (ADR 0124 §4). `--facts <file>` on check and score takes a facts file from anywhere, for a read pasted by hand.

The prompt names the copy, the facts file and the commit, carries the map's own facts shape and rules (`factsReference`, `FACT_RULES`), and says nothing of what was planted or taken out. It tells the assistant not to run `atticus map` or `atticus verify` (those write to the metarepo) and to write no questions.

### 2. What is planted: one template per stack the readers cover

Planting is by template, never by parsing (the plan's "What not to build"). A stack is found by the copy's files: **Spring** (a `.java` source naming `org.springframework`), **Node** (a `package.json` and TypeScript or JavaScript sources), **Python** (`.py` sources). These are the stacks the readers, the reachability rules and the Forge fixtures already cover. For each stack found, five items:

| Item                | Reader should write   | Spring                                                               | Node                 | Python                |
| ------------------- | --------------------- | -------------------------------------------------------------------- | -------------------- | --------------------- |
| a route served      | `entry` (rest)        | `@GetMapping` in a new `@RestController` beside a Spring source      | `<app>.get(...)`     | `@<router>.get(...)`  |
| a call made         | `call` (rest)         | `RestTemplate.getForObject`                                          | `fetch`              | `httpx.get`           |
| a topic listened to | `entry` (event-topic) | `@KafkaListener` in a new `@Component`                               | `consumer.subscribe` | `KafkaConsumer(...)`  |
| a topic published   | `call` (event-topic)  | `KafkaTemplate.send`                                                 | `producer.send`      | `producer.send`       |
| a config key        | `config`              | appended to `application.yml`/`.properties` (else the `@Value` line) | `process.env.X`      | `os.environ.get("X")` |

In Node and Python the plant goes at the end of the file that makes the app or a router (`express()`, `express.Router()`, `APIRouter(`, `FastAPI(`, `Flask(`, `Blueprint(`), on that variable, so it is served as the repo's own routes are; with none, a new file beside a source. The names are pairs of plain words (`spruce-umber`, `saffron.lumen.updated`, `BIRCH_REED_URL`) drawn by seed from a fixed list, never a word any fact of the repo uses, never a hint of a test. A repo of no stack with a template is refused.

### 3. What is taken out: real lines the verified facts cite

`--size` (default 3) of the repo's verified facts (`verified` not `none`, not a person's, of kind entry, call or config) have their cited line commented out in place (`//` or `#` by extension, the indentation kept, so no line number moves). Drawn by seed across the kinds. A line is drawn only if it can stand commented alone (its brackets balance; a YAML key with a scalar value; a properties line), is not already a comment, is not a secret's file, is not the line that makes the app or router a plant goes on, and claims a path or key no other fact of its kind claims (else a read naming it would be right).

### 4. Deterministic from a seed

The plan is a pure function of the copy's files, the repo's facts and the seed (`planCanary` in `@maycombhq/verify`, using the sample audit's seeded shuffle). The default seed is `<repo>@<commit>`, as the audit's. The same three plant the same bytes on any machine; the seed is in the report.

### 5. Where things are, and how they are cleaned

- **The run folder** (the copy, the prompt, the facts file the assistant writes, `rejected.jsonl`): `atticus-canary-<repo>-XXXXXX` under the system's temporary folder. Outside the metarepo and outside the repo; no `.git` is copied, so it is never a checkout and can't be committed or pushed. A secret's file (`isSecretPath`) is never copied.
- **The key** (what was planted and taken out, with the run's paths): `<user state>/metarepos/<hash>/canaries/<repo>.json` (`metarepoStateDir`, ADR 0186), 0600, apart from the copy so the read can't see it.
- **Cleaning:** `score` deletes the run folder and the key once it has a facts file to read, whether it scores, refuses the file or fails (`finally`). A `plant` that fails deletes what it made. A second `plant` of the same repo replaces the first. `atticus canary clean [<repo>]` deletes a planted canary without scoring it. A score with no facts file yet keeps the copy for the read.

### 6. How it is scored

Each fact the read wrote is checked by `verifyFacts` against the copy: kept or rejected.

- **Planted:** found when a kept fact of the item's kind holds the item's words in its claim (path, key, topic, cited value, folded); rejected when only a refused fact does; else missed. **Recall** = found / planted.
- **Taken out:** claimed when a fact of its kind has the same path or key (parameters left out), or is cited on the commented line or one either side with its value. **Fabrication** = claimed / taken out (the reader's rate). **Passed** = claimed by a kept fact / taken out: graded as backed, and wrong. A claim the verifier refused (`claim-in-comment`, `claim-not-on-line`) is caught: Flagged, no silent error.

Each with its count and Wilson interval at 95%, as the audit gives.

### 7. The silent error rate

Pooled over the latest canary of each repo and the sample audit's standing answers:

```
silent = (audit wrong + canary passed) / (audit answered + canary found + canary passed)
```

The audit's part is its answered facts and its answered links joined by something other than a guess: a link joined by path, label, a platform-wide setting, a folder's name, a service's name, despite a conflict, by path overlap or by the AI (`JOIN_GUESS_FLAGS`, ADR 0181) is graded inferred, so its wrong answer is no silent error. Unsure and open answers are left out, as in the audit. A planted item missed is a recall gap, not a claim. The report shows each part with its interval and says when under 30 claims are measured.

`atticus canary score` prints it after the run, `atticus canary report [--json]` prints the latest canary of each repo and the rate, and `atticus verify audit --report` (the estate) adds the rate when a canary is on file. The CLI takes the audit's part from `estateAuditPrecision` (the report's own, with the join); the app reads the files only, counting a link answer as given, as Trust always has.

### 8. What is recorded

One report per run in the metarepo, `reports/canaries/<date>-<repo>.yaml` (`.atticus/reports/canaries/` when adopted; `-2`, `-3` for a second run that day), committed in a pull request beside the audit: schema 1, repo, commit, seed, when, who, the stacks, the read's counts, each planted item (its synthetic file, line, claim and result, and the reader's fact id) and each removed one (the fact id, its file, line and claim as the facts already state it, its result), and the three rates. No quote and no line of the repo's code is copied into it; the words drawn (the key's needles) stay on the machine. The report is the only thing a canary writes in the metarepo.

### 9. In the app: Map › Trust

A panel, "Canaries and the silent error rate", beside the sample audit's rows: the rate and its range, its three parts, a row per repo's latest canary (planted found, taken out but claimed, kept by the verifier, the report's file), the canaries planted on this machine waiting for a score with the command, and the commands to run one. Empty, loading and error states; words from `copy.ts`. From `GET /api/trust/canaries` (`CanaryView`), which reads files only; the app runs nothing (B1).

### 10. How often

On a few repos per release, not on every read: the read costs a session per repo. The person picks repos of each stack in the estate.

## Consequences

- The silent error rate is a number with an interval on the organisation's own code, with no reference written by hand; every later step of the plan reports whether it fell.
- The first run, on the Forge fixtures with a read written by hand (`fixtures/canaries/reads/forge-portal-bff.s1.jsonl`, since no model runs here), found what a canary is for: a fact whose `cite.with` part names a value found only on a commented-out line beside it is kept by the verifier (`claim-in-comment` checks the main cite, not the parts). Recorded as a finding for the verifier, not fixed here.
- C4 goes to 3.12.0, additive; `docs/api/openapi.json` and `docs/spec` regenerated. Five commands join the census (`canary plant`, `check`, `score`, `report`, `clean`).

**Not done here:**

- No real baseline. The fixture run shows the computation path only; a real number needs the owner's assistant to read real repos.
- The paste-only tier (ADR 0124 §4, tier 3) has no batched canary prompt: `--facts` scores a read pasted into a file, but the prompt assumes an assistant that opens files.
- Copilot in agent mode may ask before it opens a folder outside the workspace; the copy is under the temporary folder.
- The key sits in the user's state folder, outside the copy; an assistant told to read only the copy could still open it. Blind by instruction, not by permission.
- No template for Go, .NET, Kotlin-only or browser-only code; a browser app gets the Node template in a new file.
- The app has no button to plant or score: it shows the commands.
