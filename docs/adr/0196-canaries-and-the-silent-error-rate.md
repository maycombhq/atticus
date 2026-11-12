# 0196. Canaries, and the silent error rate with the sample audit

- Status: accepted (pending review by the product owner); revised on independent review (2026-11-11, see "Review")
- Date: 2026-11-11
- Builds on: ADR 0074 (the AI reads, deterministic code verifies), 0118 (the model searches the code), 0124 (facts the assistant writes; the verifier checks the claim on the line), 0148 and 0149 (the sample audit, P3); the Jarvis plan's item Z2, "The one rule" and build order step 1
- Contracts: C4 3.12.0, additive (`GET /api/trust/canaries`). C1, C2, C3, C5, C6 and the facts file unchanged. The verifier's check of `cite.with` parts is stricter (§6, "Review"): a rule of C3's checking, not its schema.

## Context

The plan's one rule is that no claim reaches a person or a builder AI without saying how it is known. The number that says whether it holds is the **silent error rate**: wrong claims graded as backed (Proved, Agreed or Confirmed). Wrong claims graded Flagged are the system working. Build order step 1 asks for that number on the organisation's own code before anything else changes, so every later step can show whether it fell.

The verifier proves a claim is written on its line; it can't prove the line was read right. The sample audit (ADR 0148) measures that: a person answers a random sample of kept facts and links, which gives precision on real lines. It can't measure two things: what a read misses (recall), and a claim about something that isn't there but looks as if it were (a fabrication the verifier lets through). Nobody can label those on a real repo at scale.

## Decision

### 1. A canary is a planted copy, read by the person's own assistant

`atticus canary plant <repo> [--seed s] [--size n]` copies the repo's checkout to a run folder, plants a few synthetic items in the copy, comments out a few real lines, and writes a prompt. The person opens the run folder itself as their assistant's workspace (`code <run>` for Copilot in agent mode, `cd <run> && claude` for Claude Code), so the assistant asks about no file outside it, and gives it the prompt in a new chat; it reads the copy exactly as `/atticus-map` reads a repo and writes a facts file in the run folder. `atticus canary check <repo>`, run there, is the read's own verify loop against the copy (it exits 1 while a fact is rejected or a line of the facts file doesn't read, and writes the run's `rejected.jsonl`); it needs no metarepo, so the prompt names none. From the metarepo, `atticus canary check <repo>` checks the same run through its key. `atticus canary score <repo>` verifies the facts against the copy, scores them against the key and writes the report.

Atticus never runs the repo's code, deploys or pushes, and calls no model: the read is the person's assistant's, as every read is (ADR 0124 §4). `--facts <file>` on check and score takes a facts file from anywhere, for a read pasted by hand.

The prompt is built from `/atticus-map`'s own protocol (`MAP_PURPOSE`, `MAP_OUTLINE`, `MAP_READ_WHOLE`, `mapWriteStep` with the facts' shape and rules, `mapVerifyStep`, in `@maycombhq/assistant-files`), aimed at the copy, so the canary measures the read the map makes. It names the copy, the facts file and the commit; it says nothing of what was planted or taken out, of a copy or of a measurement, and names no metarepo. It tells the assistant not to run `atticus map` or `atticus verify` (those write to the metarepo) and to write no questions. The parts of the map's protocol that rest on `atticus map --estimate` (frameworks taught, notes, model classes, parts) are left out: a canary has no estimate.

### 2. What is planted: one template per stack the readers cover, only what the repo can serve

Planting is by template, never by parsing (the plan's "What not to build"). A stack is found by the copy's files: **Spring** (a `.java` source naming `org.springframework`), **Node** (a `package.json` and TypeScript or JavaScript sources), **Python** (`.py` sources). These are the stacks the readers, the reachability rules and the Forge fixtures already cover. For each stack found, up to five items:

| Item                | Reader should write   | Spring                                                               | Node                 | Python                        |
| ------------------- | --------------------- | -------------------------------------------------------------------- | -------------------- | ----------------------------- |
| a route served      | `entry` (rest)        | `@GetMapping` in a new `@RestController`                             | `<app>.get(...)`     | `@<router>.get(...)`          |
| a call made         | `call` (rest)         | `RestTemplate.getForObject`                                          | `fetch`              | `httpx.get` or `requests.get` |
| a topic listened to | `entry` (event-topic) | `@KafkaListener` in a new `@Component`                               | `consumer.subscribe` | `KafkaConsumer(...)`          |
| a topic published   | `call` (event-topic)  | `KafkaTemplate.send`                                                 | `producer.send`      | `producer.send`               |
| a config key        | `config`              | appended to `application.yml`/`.properties` (else the `@Value` line) | `process.env.X`      | `os.environ.get("X")`         |

An item is planted only when the repo can serve it (review): with a library its build files already declare, so the plant is no code the repo couldn't run.

- **Spring:** the new classes go beside the `@SpringBootApplication` class, in its package, so its component scan finds them; with no such class, none is planted (only the config key, in the application config file). The route and the call need a Spring web library (`spring-web`, `spring-boot-starter-web`, `-webflux`, `spring-webmvc`) in a `pom.xml` or `build.gradle`; the topics need `spring-kafka`.
- **Node:** a route only on an `express()` or `express.Router()` the repo makes at a module's top level, and only when a `package.json` declares `express`: a browser app (no server declared) gets no route. The topics need `kafkajs`. `fetch` and `process.env` need nothing. With no app or router, the call, the topics and the key go in a new module beside a source.
- **Python:** a route only on an app or router (`APIRouter(`, `FastAPI(`, `Flask(`, `Blueprint(`) whose framework the build files (`pyproject.toml`, `requirements*.txt`, `setup.py`, `setup.cfg`, `Pipfile`) declare, in its own words (`{item_id}` for FastAPI, `<item_id>` for Flask); the call with the HTTP client they declare (`httpx`, else `requests`); the topics with `kafka-python`.

An item not planted is recorded with its reason (`skipped`), in the key, the plant's output, the report and Map › Trust, so each number says which stacks and items it covers. In Node and Python the plant goes at the end of the file that makes the app or router, on that variable, so it is served as the repo's own routes are. The names are pairs of plain words (`spruce-umber`, `saffron.lumen.updated`, `BIRCH_REED_URL`) drawn by seed from a fixed list, never a word any fact of the repo uses, never a hint of a test. A repo where nothing can be planted is refused.

### 3. What is taken out: real lines the verified facts cite

`--size` (default 3) of the repo's verified facts (`verified` not `none`, not a person's, of kind entry, call or config) have their cited line commented out in place (`//` or `#` by extension, the indentation kept, so no line number moves). Drawn by seed across the kinds. A line is drawn only if it can stand commented alone (its brackets balance; a YAML key with a scalar value; a properties line), is not already a comment, is not in a file the copy leaves out (§5), is not the line that makes the app or router a plant goes on, and claims a path or key no other fact of its kind claims (else a read naming it would be right).

### 4. Deterministic from a seed, and the seed drawn at random

The plan is a pure function of the copy's files, the repo's facts and the seed (`planCanary` in `@maycombhq/verify`, using the sample audit's seeded shuffle). The seed is drawn at random (`crypto`) unless `--seed` gives one (review): a seed a read could work out (the repo and commit, as first written) would let it work out the plant. The seed is kept in the key and the report; the same seed, checkout and facts plant the same bytes on any machine.

### 5. Where things are, and how they are kept apart

- **The run folder** (the copy, the prompt, the facts file the assistant writes, `rejected.jsonl`): `atticus-canary-<repo>-XXXXXX` right in the system's temporary folder. Outside the metarepo and outside the repo; no `.git` is copied, so it is never a checkout. A plant is refused when the temporary folder is inside a git work tree, where a copy could be committed or pushed.
- **What is copied:** the checkout's files as the verifier lists them (nothing ignored, no `.git`), plain files only: no link, and no file with a second name (a hard link may be to any file on the disk, and can't be told from the repo's own; such files are left out as a precaution). Never a file of secrets or credentials: those `isSecretPath` names (no map quotes them) and, stricter, the canary's own list (`canaryNeverCopied`): `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.htpasswd`, `kubeconfig`, `.kube/config`, `.docker/config.json`, any `*.env`, `secrets.y*ml` and `*-secrets.y*ml`, `service-account*.json`, `*.tfvars`, `*.tfstate*`, `*.p8`, `*.p12`, `*.pfx`, `*.kdbx`, `*.keystore`, `*.jks`. The list is the canary's, not `isSecretPath`'s: a map may cite, say, a `.tfvars` file a deploy is set by, and widening `isSecretPath` would reject such facts in every read.
- **The key** (what was planted and taken out, what wasn't and why): `<user state>/metarepos/<hash>/canaries/<repo>.json` (`metarepoStateDir`, ADR 0186), 0600, apart from the copy so the read can't see it. It names the run folder by its **base name only**; its path is rebuilt under the temporary folder, and nothing in it is read, written or deleted unless the name is this repo's run folder's, the folder is real (not a link) and right in the temporary folder by both real paths, and the copy in it is a real folder. `rejected.jsonl` is written by rename, never through a link; a facts file in the run that is a link is refused.
- **Names:** a repo's name is checked once, in the dispatcher, before any path is made from it: letters, digits, `.`, `_`, `-`, starting with a letter or digit, never `..`, and a repo of this metarepo's (in a manifest, with facts, or with a key planted). Each command checks the name again, and no key path is made from any other.
- **Cleaning:** `score` deletes the run folder and the key once it has facts to score, whether it scores or fails (`finally`); when nothing in the facts file reads, nothing is scored and the copy is kept for the read to be fixed. A `plant` that fails deletes what it made. A second `plant` of the same repo replaces the first. `atticus canary clean [<repo>]` deletes a planted canary without scoring it; a key that doesn't read (or names no run folder of its repo's) is deleted with that repo's run folders in the temporary folder, each checked as above, and `clean` says so. A score with no facts file yet keeps the copy for the read.
- **The checkout:** `plant` notes when the checkout isn't at the facts' commit, or has changes not committed; the copy is of the checkout as it is.

### 6. How it is scored

Each fact the read wrote is checked by `verifyFacts` against the copy: kept or rejected. A line of the facts file that doesn't read as a fact is counted (`unread`), named by `check` and `score`, and left out.

- **Planted:** found when a kept fact of the item's kind holds the item's words in its claim (path, key, topic, cited value, folded); rejected when only a refused fact does; else missed. **Recall** = found / planted.
- **Taken out:** claimed when a fact of its kind cites the commented line or one either side, by its cite or a `cite.with` part, with the same path or key (parameters left out) or the removed fact's value in its claim. A fact with the same path or key that cites neither the line nor one beside it is `elsewhere` (review): it may well be about another line, so it is counted apart, in neither rate. **Fabrication** = claimed / (taken out less elsewhere), the reader's rate. **Passed** = claimed by a kept fact / (taken out less elsewhere): graded as backed, and wrong. A claim the verifier refused (`claim-in-comment`, `claim-not-on-line`) is caught: Flagged, no silent error.
- **One to one** (review): a fact answers for one item at most. Items are matched in order, each to the first fact not yet taken.

Each with its count and Wilson interval at 95%, as the audit gives.

### 7. How often a claim graded as backed is wrong: two numbers, side by side

As first written, one pooled rate: `(audit wrong + canary passed) / (audit answered + canary found + canary passed)`. Review found the pool unsound: a canary's found plants are right by construction, so they padded the denominator, and the two samples are of different things. It is replaced by **two numbers side by side**, each with its count and interval, never added up:

- **The audit misread rate**: the sample audit's answered facts, and its answered links joined by something other than a guess, answered wrong, of those answered. A link joined by path, label, a platform-wide setting, a folder's name, a service's name, despite a conflict, by path overlap or by the AI (`JOIN_GUESS_FLAGS`, ADR 0181) is graded inferred, so its wrong answer is no silent error. Unsure and open answers are left out, as in the audit.
- **The canary pass-through rate**: over the latest canary of each repo, lines taken out that a read still claimed at their place and the verifier kept, of the lines taken out (less those named only elsewhere). With it: recall, fabrication, the lines the verifier caught, those named only elsewhere, and what the canaries cover (each stack, with the items planted there).

Each says when under 30 claims are measured. `atticus canary score` prints them after the run, `atticus canary report [--json]` prints the latest canary of each repo and the two numbers, and `atticus verify audit --report` (the estate) adds them when a canary is on file, from the estate's audit it has just counted (`estateAuditPrecision`, once). The app reads the files only, counting a link answer as given, as Trust always has; it names the two numbers as the CLI does, with or without a canary on file.

**For the owner to decide:** whether to add a pooled bound beside the two numbers (say, an upper bound on the share of backed claims wrong, from both samples' intervals). It is left out until a rule for it is chosen.

### 8. What is recorded

One report per run in the metarepo, `reports/canaries/<date>-<repo>.yaml` (`.atticus/reports/canaries/` when adopted; `-2`, `-3` for a second run that day), committed in a pull request beside the audit: schema 1, repo, commit, seed, when, who, the stacks, the read's counts (facts, kept, rejected, unread), each planted item by an opaque id (`plant:<n>`) with its kind, what it stood for, its stack and its result, the items not planted with their reasons, each removed one (the fact id, its file, line and claim as the facts already state it, its result), and the three rates. No planted item's words, file or line are in it (review: a report on file must teach no later read what a canary plants), no quote and no line of the repo's code; those stay in the key, on the machine, and go with it. The report is the only thing a canary writes in the metarepo.

### 9. In the app: Map › Trust

A panel, "Canaries and the silent error rate", beside the sample audit's rows: the audit misread rate and the canary pass-through rate side by side, each with its range, what the canaries cover, recall and fabrication, a row per repo's latest canary (what it covers and what it couldn't plant, planted found, taken out but claimed, kept by the verifier with a warning sign that has a text alternative, the report's file), the canaries planted on this machine waiting for a score with the command, and the commands to run one. Each number is shown once. Empty, loading and error states; words from `copy.ts`. From `GET /api/trust/canaries` (`CanaryView`), which reads files only; the app runs nothing (B1).

### 10. How often

On a few repos per release, not on every read: the read costs a session per repo. The person picks repos of each stack in the estate.

## Consequences

- How often a claim graded as backed is wrong is two numbers with intervals on the organisation's own code, with no reference written by hand; every later step of the plan reports whether they fell.
- The first run, on the Forge fixtures with a read written by hand (`fixtures/canaries/reads/forge-portal-bff.s1.jsonl`, since no model runs here), found what a canary is for: a fact whose `cite.with` part names a value found only on a commented-out line beside it was kept by the verifier (`claim-in-comment` checked the main cite, not the parts). **Fixed on review:** a part whose value only comment lines beside it name is refused as `claim-in-comment`, comment lines are never lines a claim with parts is put together from, and with parts a claim named only on a comment line beside the main cite is refused the same way (`checkCite` in `packages/verify/src/verify.ts`; Netlify's `_redirects` aside, where `/*` is no comment). The same read now has its three claims about taken-out lines all caught: the pass-through rate is 0 of 3.
- C4 goes to 3.12.0, additive; `docs/api/openapi.json` and `docs/spec` regenerated. 3.12.0 was not released before the review, so its `CanaryView` is revised in place (`rates` for the two numbers, `covers`, `skipped`, `unread` and `elsewhere`), not bumped again. Five commands join the census (`canary plant`, `check`, `score`, `report`, `clean`).

**Not done here:**

- No real baseline. The fixture run shows the computation path only; real numbers need the owner's assistant to read real repos.
- The paste-only tier (ADR 0124 §4, tier 3) has no batched canary prompt: `--facts` scores a read pasted into a file, but the prompt assumes an assistant that opens files.
- The key sits in the user's state folder, outside the copy and the workspace; an assistant told to read only the workspace could still open it. Blind by instruction and by workspace, not by permission. The word list the names are drawn from is in Atticus's source: a read that knew it could tell a planted name from the repo's own (the seed, now random, says only which).
- A key that doesn't read is cleaned with every run folder of its repo's name in the temporary folder: another metarepo's unscored canary of a repo of the same name, on the same machine, would go with it.
- No template for Go, .NET, Kotlin-only code, or a browser app's route.
- The app has no button to plant or score: it shows the commands.

## Review (2026-11-11)

An independent review of the first version found, and this revision fixes, each with tests: a repo name could climb out of the key folder (`atticus canary clean ../../victim/package` deleted a file); a key edited by hand could make `clean`, `check` or `score` delete or write outside the temporary folder; files of credentials were copied (§5); the verifier gap above; the plant was learnable (a seed from the repo and commit, and the planted words in the committed report: §4, §8); a fact naming a removed path anywhere counted as passed (§6); the pooled rate (§7); the prompt was not the map's (§1); items were planted that the repo couldn't serve (§2); and lines of the facts file that didn't read were silent (§6).

Decisions for the owner: the pooled bound (§7); whether the canary's list of files never copied should also be the map's (`isSecretPath`), which would refuse facts some reads now cite; and whether a key that doesn't read should clean only run folders that hold a copy and prompt of the same shape, to spare another metarepo's canary of a repo of the same name.
